//! Restart recovery and the stall watchdog (Track H3, decisions D29, D30,
//! D9a). Pure over a run, its pipeline and its stages' session logs, so every
//! rule is unit-tested; `commands::run_recovery` feeds them, once at startup
//! and on the watchdog's timer thread, and saves.
//!
//! - Restart (D29): a `running` run whose current stage finished a turn that
//!   no decision covers goes to `waiting` with `app_restarted`. Autopilot
//!   never acts on that turn by itself: Continue (`pipeline_continue`) runs
//!   the run again and the turn is decided then (by the frontend on an
//!   engine-1 run, by the run actor on an engine-2 run). A turn the quit
//!   cut off is only noted: the run keeps running and the stage's next
//!   finished turn is decided as usual.
//! - Stall (D30, D9a): while a current stage is Working (a prompt with no
//!   finished turn, which also covers a turn abandoned without a Stop), no
//!   terminal output and no log growth for the pipeline's
//!   `autopilot.stallMinutes` puts the run in `waiting` with `stalled`.

use super::{PipelineDef, StageDef, StageKind, DEFAULT_STALL_MINUTES, MAX_STALL_MINUTES};
use crate::claude_session_log::TerminalSessionLog;
use crate::store::{PipelineRun, RunStatus, StopReason};
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

/// A terminal of the stage a run (or one of its active lanes) is on now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StageTab {
    pub stage_id: String,
    pub stage_title: String,
    pub role_id: String,
    /// The stage's kind (H4): a `planner` stage, a copied Planner included,
    /// waits on its plan approval.
    pub kind: StageKind,
    pub tab_id: String,
    pub lane: Option<String>,
    /// The stage's own role, not a parallel reviewer. Autopilot keys its
    /// decisions on this tab's turns.
    pub own: bool,
}

fn stage_tabs_of(stage: &StageDef, tab_ids: &HashMap<String, String>, lane: Option<&str>) -> Vec<StageTab> {
    stage
        .roles()
        .into_iter()
        .filter_map(|role| {
            let tab_id = tab_ids.get(&role)?.clone();
            Some(StageTab {
                stage_id: stage.id.clone(),
                stage_title: stage.title.clone(),
                own: role == stage.role_id,
                role_id: role,
                kind: stage.kind(),
                tab_id,
                lane: lane.map(str::to_string),
            })
        })
        .collect()
}

/// The terminals of the stage the run is on: each active lane's stage once
/// the run fanned out, else the run's own stage.
pub fn current_stage_tabs(def: &PipelineDef, run: &PipelineRun) -> Vec<StageTab> {
    if !run.lanes.is_empty() {
        return run
            .lanes
            .iter()
            .filter(|lane| lane.status == "active")
            .filter_map(|lane| Some(stage_tabs_of(def.stage(&lane.stage)?, &lane.tab_ids, Some(&lane.id))))
            .flatten()
            .collect();
    }
    def.stage(&run.stage)
        .map(|stage| stage_tabs_of(stage, &run.tab_ids, None))
        .unwrap_or_default()
}

/// The log holds a turn autopilot would act on: done and not interrupted, or
/// a `planner` stage (by kind, so a copied Planner too) waiting on its plan
/// approval (`finishedTurn` in `src/pipeline/autopilot.ts`).
pub fn finished_turn(kind: StageKind, log: &TerminalSessionLog) -> bool {
    if log.turn_done {
        return !log.interrupted;
    }
    kind == StageKind::Planner
        && log.open_tool.as_ref().is_some_and(|tool| tool.name == "ExitPlanMode")
        && log.plan.as_deref().is_some_and(|plan| !plan.trim().is_empty())
}

/// A prompt was sent and its turn has not finished (or been interrupted).
pub fn working(kind: StageKind, log: &TerminalSessionLog) -> bool {
    log.last_prompt_at.is_some() && !log.turn_done && !finished_turn(kind, log)
}

/// The turn's key, `tab|session|prompt`, as autopilot records decided turns
/// (`turnId` in `src/pipeline/autopilot.ts`).
pub fn turn_key(tab_id: &str, log: &TerminalSessionLog) -> String {
    format!("{tab_id}|{}|{}", log.session_id, log.last_prompt_at.as_deref().unwrap_or(""))
}

/// A bridged (engine-2) turn's key, `tab|bridge|<turn id>`, as autopilot
/// records it (`onBridgeTurn` in `src/pipeline/useAutopilot.ts`).
pub fn bridge_turn_key(tab_id: &str, turn: &str) -> String {
    format!("{tab_id}|bridge|{turn}")
}

/// What a startup reconcile did to a run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reconciled {
    /// A finished turn nobody decided: the run waits with `app_restarted`.
    Waiting { tab_id: String, why: String },
    /// A turn the quit cut off: noted; the run keeps running.
    CutOff,
}

/// Startup: check a `running` run against its current stage's logs (by tab
/// id). Records what it found in the run and its ledger; the caller saves.
pub fn reconcile_run(
    def: &PipelineDef,
    run: &mut PipelineRun,
    logs: &HashMap<String, TerminalSessionLog>,
) -> Option<Reconciled> {
    reconcile_run_with(def, run, logs, &HashMap::new())
}

/// [`reconcile_run`], where `bridge_turns` gives each bridged tab's latest
/// turn id (its stage's `turn.json`): that tab's turn counts as decided by
/// its bridge key, the way autopilot records it.
pub fn reconcile_run_with(
    def: &PipelineDef,
    run: &mut PipelineRun,
    logs: &HashMap<String, TerminalSessionLog>,
    bridge_turns: &HashMap<String, String>,
) -> Option<Reconciled> {
    let enabled = run.autopilot.as_ref().is_some_and(|a| a.enabled);
    if run.status != RunStatus::Running || !enabled {
        return None;
    }
    let decided: HashSet<&str> = run
        .autopilot
        .as_ref()
        .map(|a| a.decided.iter().map(String::as_str).collect())
        .unwrap_or_default();
    let tabs = current_stage_tabs(def, run);
    let finished = tabs.iter().find(|tab| {
        tab.own
            && logs.get(&tab.tab_id).is_some_and(|log| {
                let key = match bridge_turns.get(&tab.tab_id) {
                    Some(turn) => bridge_turn_key(&tab.tab_id, turn),
                    None => turn_key(&tab.tab_id, log),
                };
                finished_turn(tab.kind, log) && !decided.contains(key.as_str())
            })
    });
    if let Some(tab) = finished.cloned() {
        let why = format!(
            "{} finished while the app was closed. Press Continue to let autopilot act on it.",
            stage_name(run, &tab)
        );
        run.set_waiting(StopReason::AppRestarted, why.clone());
        log_for(run, "stop", &tab, why.clone());
        return Some(Reconciled::Waiting { tab_id: tab.tab_id, why });
    }
    let cut_off = tabs
        .iter()
        .find(|tab| logs.get(&tab.tab_id).is_some_and(|log| working(tab.kind, log)))
        .cloned()?;
    let note = format!(
        "{}'s turn was cut off when the app closed. Autopilot acts on its next finished turn.",
        stage_name(run, &cut_off)
    );
    log_for(run, "note", &cut_off, note);
    Some(Reconciled::CutOff)
}

/// "Implementer", or "PR1 — API: Implementer" in a lane.
fn stage_name(run: &PipelineRun, tab: &StageTab) -> String {
    match tab.lane.as_deref().and_then(|id| run.lane(id)) {
        Some(lane) => format!("{}: {}", lane.title, tab.stage_title),
        None => tab.stage_title.clone(),
    }
}

fn log_for(run: &mut PipelineRun, kind: &str, tab: &StageTab, summary: String) {
    run.log_in_lane(
        kind,
        Some(&tab.stage_id),
        Some(&tab.role_id),
        tab.lane.as_deref(),
        summary,
        None,
        None,
    );
}

/// How long a Working stage may stay quiet: the pipeline's `stallMinutes`.
/// pipelines.json loads without validation, so a value outside 1 to 1440
/// (only checked on save) counts as the default of 30; the file is left as is.
pub fn stall_limit(def: &PipelineDef) -> Duration {
    let minutes = def.autopilot.stall_minutes;
    let minutes = if (1..=MAX_STALL_MINUTES).contains(&minutes) { minutes } else { DEFAULT_STALL_MINUTES };
    Duration::from_secs(u64::from(minutes) * 60)
}

/// One look at a stage terminal, for `StallWatch::observe`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StallObservation {
    /// `working` over its session log.
    pub working: bool,
    /// The log file's size, if it exists.
    pub log_len: Option<u64>,
    /// Time since its terminal last printed anything; `None` without a live
    /// terminal (which prints nothing).
    pub pty_quiet: Option<Duration>,
}

#[derive(Debug, Clone, Copy)]
struct Watched {
    since: Instant,
    log_len: Option<u64>,
    log_changed: Instant,
}

/// The watchdog's memory between ticks: when it first saw each stage
/// terminal Working and when its log last grew. Quiet is counted only from
/// the first sighting, so turning autopilot back on (or a fresh start)
/// never stops a run at once for quiet from before.
#[derive(Debug, Default)]
pub struct StallWatch {
    tabs: HashMap<String, Watched>,
}

impl StallWatch {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record one look at `key` (`run|tab`). How long it has been quiet,
    /// once that reaches `limit` while it is Working.
    pub fn observe(&mut self, key: &str, now: Instant, seen: StallObservation, limit: Duration) -> Option<Duration> {
        if !seen.working {
            self.tabs.remove(key);
            return None;
        }
        let watched = self.tabs.entry(key.to_string()).or_insert(Watched {
            since: now,
            log_len: seen.log_len,
            log_changed: now,
        });
        if watched.log_len != seen.log_len {
            watched.log_len = seen.log_len;
            watched.log_changed = now;
        }
        let since_first = now.saturating_duration_since(watched.since);
        let log_quiet = now.saturating_duration_since(watched.log_changed);
        let pty_quiet = seen.pty_quiet.map_or(since_first, |quiet| quiet.min(since_first));
        let quiet = log_quiet.min(pty_quiet);
        (quiet >= limit).then_some(quiet)
    }

    /// Forget every key not in `keep` (runs no longer running, stages moved on).
    pub fn retain(&mut self, keep: &HashSet<String>) {
        self.tabs.retain(|key, _| keep.contains(key));
    }

    pub fn len(&self) -> usize {
        self.tabs.len()
    }

    pub fn is_empty(&self) -> bool {
        self.tabs.is_empty()
    }
}

/// "30 minutes", "1 minute", or seconds under a minute.
fn quiet_text(quiet: Duration) -> String {
    let secs = quiet.as_secs();
    match secs / 60 {
        0 if secs == 1 => "1 second".to_string(),
        0 => format!("{secs} seconds"),
        1 => "1 minute".to_string(),
        minutes => format!("{minutes} minutes"),
    }
}

/// The watchdog found `tab` quiet for `quiet` while Working: the run waits
/// with `stalled`. Only a `running` run stops; returns the sentence it
/// stopped with.
pub fn stop_stalled(run: &mut PipelineRun, tab: &StageTab, quiet: Duration) -> Option<String> {
    if run.status != RunStatus::Running {
        return None;
    }
    let why = format!(
        "{} has been quiet for {}: no terminal output and no log growth while it was working. Check its tab; once its turn ends, hand it on yourself.",
        stage_name(run, tab),
        quiet_text(quiet)
    );
    run.set_waiting(StopReason::Stalled, why.clone());
    log_for(run, "stop", tab, why.clone());
    Some(why)
}

#[cfg(test)]
#[path = "recovery_tests.rs"]
mod tests;
