//! The round runner's rules (R2), pure over a round and its plan runs, so
//! every rule is unit-tested:
//!
//! - A plan run's state follows its run: complete is `done`; running, or
//!   waiting for you at a checkpoint (a plan checkpoint, a verify gate, a
//!   story checkpoint), after a restart or on a stage you took over, is
//!   `running`; any other stop is `stopped`.
//! - A wave's plans start only when every plan of the earlier waves that
//!   is in the round (not parked or deferred) is `done`, so a stopped plan
//!   holds the later waves until it is resolved; parked and deferred plans
//!   hold nothing.
//! - No more than `runsAtOnce` plan runs are `running`, and nothing past
//!   **Commit up to wave N** starts.

use super::types::{PlanRunState, QaRound, RoundPlanRun};
use crate::pipelines::PipelineDef;
use crate::store::{PipelineRun, RunStatus, StopReason};
use serde::Serialize;

/// Plan runs at once: the default, and the range you can set.
pub const DEFAULT_RUNS_AT_ONCE: u32 = 2;
pub const MAX_RUNS_AT_ONCE: u32 = 8;

/// What a plan's run says about the plan, and why when it stopped.
pub fn run_state(run: Option<&PipelineRun>) -> (PlanRunState, Option<String>) {
    let Some(run) = run else {
        return (PlanRunState::Stopped, Some("Its run is gone (deleted?).".to_string()));
    };
    let waiting = run.autopilot.as_ref().and_then(|a| a.waiting.clone());
    match run.status {
        RunStatus::Complete => (PlanRunState::Done, None),
        RunStatus::Running => (PlanRunState::Running, None),
        RunStatus::Waiting
            if matches!(
                run.stop_reason,
                Some(StopReason::Checkpoint | StopReason::AppRestarted | StopReason::TakenOver)
            ) =>
        {
            (PlanRunState::Running, waiting)
        }
        RunStatus::Waiting => (PlanRunState::Stopped, waiting.or_else(|| Some("Its run stopped.".to_string()))),
        RunStatus::Stopped => (
            PlanRunState::Stopped,
            waiting.or_else(|| Some("Its run is stopped (autopilot is off).".to_string())),
        ),
    }
}

/// Bring each started plan's state up to date with its run (`run_of`).
/// `done` is final. Returns whether anything changed.
pub fn sync<'a>(round: &mut QaRound, run_of: impl Fn(&str) -> Option<&'a PipelineRun>) -> bool {
    let mut changed = false;
    for plan in round.plans.iter_mut() {
        if !matches!(plan.state, PlanRunState::Running | PlanRunState::Stopped) {
            continue;
        }
        let Some(run_id) = plan.run_id.clone() else {
            // A start that failed: it stays stopped, with its note, until you retry it.
            continue;
        };
        let (state, note) = run_state(run_of(&run_id));
        if plan.state != state || plan.note != note {
            plan.state = state;
            plan.note = note;
            changed = true;
        }
    }
    changed
}

/// The plans that hold up `wave`: plans of earlier waves in the round that
/// are not done yet.
fn earlier_not_done(round: &QaRound, wave: u32) -> Vec<&RoundPlanRun> {
    round
        .plans
        .iter()
        .filter(|plan| plan.wave.is_some_and(|w| w < wave))
        .filter(|plan| !matches!(plan.state, PlanRunState::Done | PlanRunState::Parked | PlanRunState::Deferred))
        .collect()
}

fn running(round: &QaRound) -> usize {
    round.plans.iter().filter(|plan| plan.state == PlanRunState::Running).count()
}

fn plan_number(id: &str) -> u32 {
    id.trim_start_matches("plan").parse().unwrap_or(u32::MAX)
}

/// The ready plans in the order they start: by wave, then by number.
fn ready(round: &QaRound) -> Vec<&RoundPlanRun> {
    let mut ready: Vec<&RoundPlanRun> = round.plans.iter().filter(|plan| plan.state == PlanRunState::Ready).collect();
    ready.sort_by_key(|plan| (plan.wave.unwrap_or(u32::MAX), plan_number(&plan.plan_id)));
    ready
}

/// The plans to start now, in order: ready plans of waves up to **Commit up
/// to wave N** whose earlier waves are all done, while fewer than
/// `runsAtOnce` plan runs are running.
pub fn next_to_start(round: &QaRound) -> Vec<String> {
    let cap = round.runs_at_once.clamp(1, MAX_RUNS_AT_ONCE) as usize;
    let free = cap.saturating_sub(running(round));
    ready(round)
        .into_iter()
        .filter(|plan| plan.wave.is_some_and(|w| w <= round.commit_up_to_wave && earlier_not_done(round, w).is_empty()))
        .take(free)
        .map(|plan| plan.plan_id.clone())
        .collect()
}

/// Why a ready plan has not started, for the round view.
pub fn waiting_reason(round: &QaRound, plan: &RoundPlanRun) -> Option<String> {
    if plan.state != PlanRunState::Ready {
        return None;
    }
    let Some(wave) = plan.wave else {
        return Some("It has no wave.".to_string());
    };
    if wave > round.commit_up_to_wave {
        return Some(format!(
            "Held: the round is committed up to wave {}. Raise Commit up to wave to start it.",
            round.commit_up_to_wave
        ));
    }
    let holding = earlier_not_done(round, wave);
    if !holding.is_empty() {
        let names: Vec<String> = holding.iter().map(|p| format!("{} ({})", p.plan_id, p.state.label())).collect();
        return Some(format!("Waits for the earlier waves: {}.", names.join(", ")));
    }
    Some(format!(
        "Waits for a free slot: {} of {} plan runs at once are running.",
        running(round),
        round.runs_at_once
    ))
}

/// A plan run waiting at its plan checkpoint (R2's **Approve all
/// checkpoints**): what Approve sends, as your Send to the actor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanCheckpoint {
    pub plan_id: String,
    pub run_id: String,
    /// The stage that waits to start (`Implementer`).
    pub stage_title: String,
    /// The stage tab whose turn Approve hands on (the Plan Reviewer's).
    pub source_tab_id: String,
    /// The role Approve starts.
    pub target_role_id: String,
    /// What the run says it waits for.
    pub waiting: String,
}

/// The checkpoint `run` waits at, when it waits before a stage marked
/// `checkpoint` that it has not passed (Eagle-Eye 1's Implementer): the
/// latest stop on the run names that stage. A verify gate or a story
/// checkpoint is not a plan checkpoint.
pub fn plan_checkpoint(def: &PipelineDef, run: &PipelineRun, plan_id: &str) -> Option<PlanCheckpoint> {
    if run.status != RunStatus::Waiting || run.stop_reason != Some(StopReason::Checkpoint) {
        return None;
    }
    let autopilot = run.autopilot.as_ref()?;
    if autopilot.verify.is_some() || autopilot.story_wait.is_some() {
        return None;
    }
    let stop = run.events.iter().rev().find(|e| e.kind == "stop")?;
    let stage_id = stop.stage_id.as_deref()?;
    let index = def.stage_index(stage_id)?;
    let stage = &def.stages[index];
    if !stage.checkpoint || autopilot.passed_checkpoints.iter().any(|id| id == stage_id) || index == 0 {
        return None;
    }
    let source_role = &def.stages[index - 1].role_id;
    let source_tab_id = run.tab_ids.get(source_role)?.clone();
    Some(PlanCheckpoint {
        plan_id: plan_id.to_string(),
        run_id: run.id.clone(),
        stage_title: stage.title.clone(),
        source_tab_id,
        target_role_id: stage.role_id.clone(),
        waiting: autopilot.waiting.clone().unwrap_or_default(),
    })
}
