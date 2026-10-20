//! Track H3 in the app: the startup reconcile, the stall watchdog and
//! Continue. `pipelines::recovery` holds the rules; this feeds them the
//! running autopilot runs, their current stage terminals' session logs and
//! how long each terminal has been quiet, and saves what they decide.
//!
//! Both run on one thread of their own (`spawn_run_recovery`), never the
//! main thread: the reconcile once at startup, then a watchdog tick every
//! `WATCHDOG_TICK`. Each step copies what it needs out under the store and
//! PTY locks (store first, as `session_log` takes them), drops them, reads
//! the logs, and locks the store again only to write the result back.

use crate::claude_session_log::reader::SessionLogReaders;
use crate::claude_session_log::TerminalSessionLog;
use crate::commands::chain_events::ChainEvents;
use crate::commands::session_log::tab_session_target;
use crate::pipelines::recovery::{
    current_stage_tabs, reconcile_run_with, stall_limit, stop_stalled, working, Reconciled, StageTab,
    StallObservation, StallWatch,
};
use crate::pipelines::PipelineDef;
use crate::pty::PtyRegistry;
use crate::store::{RunStatus, StateStore, StopReason};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

/// How often the watchdog looks. A stall is seen at most this late.
const WATCHDOG_TICK: Duration = Duration::from_secs(30);

/// `autopilot-stopped`: the core stopped a run by itself (a stall, or a turn
/// that finished while the app was closed). The frontend tells you, as it
/// does for a stop it carried out.
pub const AUTOPILOT_STOPPED_EVENT: &str = "autopilot-stopped";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutopilotStopped {
    pub run_id: String,
    pub tab_id: String,
    pub reason: StopReason,
    pub summary: String,
}

/// A current stage terminal of a running autopilot run, copied out of the stores.
struct Watched {
    run_id: String,
    tab: StageTab,
    /// The config folder and Claude session its log is under.
    target: Option<(PathBuf, String)>,
    pty_quiet: Option<Duration>,
    def: PipelineDef,
    /// The run-folder stage a bridged (engine-2) tab holds.
    bridge: Option<crate::bridge::BridgeTag>,
}

impl Watched {
    fn key(&self) -> String {
        format!("{}|{}", self.run_id, self.tab.tab_id)
    }
}

/// Every running autopilot run's current stage terminals.
fn running_stage_tabs(store: &Mutex<StateStore>, registry: &Mutex<PtyRegistry>) -> Result<Vec<Watched>, String> {
    let state = store.lock().map_err(|e| e.to_string())?;
    let registry = registry.lock().map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for run in &state.data.pipeline_runs {
        if run.status != RunStatus::Running || !run.autopilot.as_ref().is_some_and(|a| a.enabled) {
            continue;
        }
        let Some(def) = crate::pipelines::find(&run.kind) else {
            continue;
        };
        for tab in current_stage_tabs(&def, run) {
            out.push(Watched {
                run_id: run.id.clone(),
                target: tab_session_target(&state, &registry, &tab.tab_id),
                pty_quiet: registry.quiet_for(&tab.tab_id),
                def: def.clone(),
                bridge: state.tab_by_id(&tab.tab_id).and_then(|t| t.bridge.clone()),
                tab,
            });
        }
    }
    Ok(out)
}

/// The tab's session log and the file's size, read with no store lock held.
fn read_log(readers: &SessionLogReaders, watched: &Watched) -> Option<(TerminalSessionLog, Option<u64>)> {
    let (dir, session) = watched.target.as_ref()?;
    let reader = readers.tab_reader(&watched.tab.tab_id, dir, session)?;
    let reader = reader.lock().ok()?;
    let len = std::fs::metadata(reader.path()).ok().map(|meta| meta.len());
    Some((reader.summary(), len))
}

/// What a reconcile or a watchdog tick changed: runs to refresh, and the
/// stops to tell you about.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct RecoveryOutcome {
    pub changed: Vec<String>,
    pub stopped: Vec<AutopilotStopped>,
}

/// Startup: each running autopilot run against its current stage's logs
/// (`pipelines::recovery::reconcile_run_with`). A bridged tab's decided turn
/// is matched by its turn id from `<runs_root>/<run>/stages/<stage>/turn.json`.
pub(crate) fn reconcile_on_startup(
    store: &Mutex<StateStore>,
    registry: &Mutex<PtyRegistry>,
    readers: &SessionLogReaders,
    runs_root: &std::path::Path,
) -> Result<RecoveryOutcome, String> {
    let watched = running_stage_tabs(store, registry)?;
    let mut logs: HashMap<String, HashMap<String, TerminalSessionLog>> = HashMap::new();
    let mut bridge_turns: HashMap<String, String> = HashMap::new();
    for item in &watched {
        if let Some((log, _)) = read_log(readers, item) {
            logs.entry(item.run_id.clone()).or_default().insert(item.tab.tab_id.clone(), log);
        }
        let turn = item
            .bridge
            .as_ref()
            .and_then(|tag| crate::bridge::launch::stage_turn_id(runs_root, tag, &item.tab.tab_id));
        if let Some(turn) = turn {
            bridge_turns.insert(item.tab.tab_id.clone(), turn);
        }
    }
    let mut outcome = RecoveryOutcome::default();
    if logs.is_empty() {
        return Ok(outcome);
    }
    let mut state = store.lock().map_err(|e| e.to_string())?;
    for (run_id, run_logs) in &logs {
        let Some(def) = watched.iter().find(|w| &w.run_id == run_id).map(|w| w.def.clone()) else {
            continue;
        };
        let Some(run) = state.pipeline_run_by_id_mut(run_id) else {
            continue;
        };
        match reconcile_run_with(&def, run, run_logs, &bridge_turns) {
            None => {}
            Some(Reconciled::CutOff) => outcome.changed.push(run_id.clone()),
            Some(Reconciled::Waiting { tab_id, why }) => {
                outcome.changed.push(run_id.clone());
                outcome.stopped.push(AutopilotStopped {
                    run_id: run_id.clone(),
                    tab_id,
                    reason: StopReason::AppRestarted,
                    summary: why,
                });
            }
        }
    }
    if !outcome.changed.is_empty() {
        state.save()?;
    }
    Ok(outcome)
}

/// One watchdog look at every running autopilot run's Working stages.
/// `limit` gives each pipeline's stall limit (`stall_limit` in the app).
pub(crate) fn watchdog_tick(
    store: &Mutex<StateStore>,
    registry: &Mutex<PtyRegistry>,
    readers: &SessionLogReaders,
    watch: &mut StallWatch,
    now: Instant,
    limit: &dyn Fn(&PipelineDef) -> Duration,
) -> Result<RecoveryOutcome, String> {
    let watched = running_stage_tabs(store, registry)?;
    let mut keep = HashSet::new();
    let mut stalled: Vec<(&Watched, Duration)> = Vec::new();
    for item in &watched {
        let key = item.key();
        let log = read_log(readers, item);
        let seen = StallObservation {
            working: log.as_ref().is_some_and(|(log, _)| working(item.tab.kind, log)),
            log_len: log.as_ref().and_then(|(_, len)| *len),
            pty_quiet: item.pty_quiet,
        };
        if let Some(quiet) = watch.observe(&key, now, seen, limit(&item.def)) {
            stalled.push((item, quiet));
        }
        keep.insert(key);
    }
    watch.retain(&keep);
    let mut outcome = RecoveryOutcome::default();
    if stalled.is_empty() {
        return Ok(outcome);
    }
    let mut state = store.lock().map_err(|e| e.to_string())?;
    for (item, quiet) in stalled {
        let Some(run) = state.pipeline_run_by_id_mut(&item.run_id) else {
            continue;
        };
        // One stop per run: once waiting, its other stages are not stopped again.
        if let Some(why) = stop_stalled(run, &item.tab, quiet) {
            outcome.changed.push(item.run_id.clone());
            outcome.stopped.push(AutopilotStopped {
                run_id: item.run_id.clone(),
                tab_id: item.tab.tab_id.clone(),
                reason: StopReason::Stalled,
                summary: why,
            });
        }
    }
    if !outcome.changed.is_empty() {
        state.save()?;
    }
    Ok(outcome)
}

/// Stops the core made before the frontend listened. The startup reconcile
/// runs while the webview is still loading, so its `autopilot-stopped`
/// events would be lost: they are held here until a window, with its
/// listener attached and its tabs loaded, asks for the ones on its tabs
/// (`autopilot_pending_stops`). Stops on other windows' tabs stay held for
/// them. After the first ask every new stop is emitted at once, to every
/// window. One lock covers both, so a stop is either held or emitted, never
/// both and never neither.
#[derive(Default)]
pub struct StartupStops(Mutex<HeldStops>);

#[derive(Default)]
struct HeldStops {
    listening: bool,
    held: Vec<AutopilotStopped>,
}

impl StartupStops {
    /// Emit each stop, or hold it while the frontend is not listening yet.
    pub fn deliver(&self, stops: Vec<AutopilotStopped>, mut emit: impl FnMut(AutopilotStopped)) {
        let mut inner = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if inner.listening {
            stops.into_iter().for_each(&mut emit);
        } else {
            inner.held.extend(stops);
        }
    }

    /// A window listens now: hand over, once, the held stops on its tabs.
    pub fn take(&self, tab_ids: &[String]) -> Vec<AutopilotStopped> {
        let mut inner = self.0.lock().unwrap_or_else(|e| e.into_inner());
        inner.listening = true;
        let (mine, others) =
            std::mem::take(&mut inner.held).into_iter().partition(|stop| tab_ids.contains(&stop.tab_id));
        inner.held = others;
        mine
    }
}

fn announce(app: &AppHandle, outcome: RecoveryOutcome) {
    for run_id in &outcome.changed {
        app.chain_run_updated(run_id);
    }
    if outcome.stopped.is_empty() {
        return;
    }
    match app.try_state::<StartupStops>() {
        Some(stops) => stops.deliver(outcome.stopped, |stop| {
            let _ = app.emit(AUTOPILOT_STOPPED_EVENT, stop);
        }),
        None => {
            for stop in outcome.stopped {
                let _ = app.emit(AUTOPILOT_STOPPED_EVENT, stop);
            }
        }
    }
}

/// The startup reconcile, then the stall watchdog, on a thread of their own.
pub fn spawn_run_recovery(app: AppHandle) {
    let spawned = std::thread::Builder::new().name("run-recovery".into()).spawn(move || {
        let (Some(store), Some(registry), Some(readers)) = (
            app.try_state::<Mutex<StateStore>>(),
            app.try_state::<Mutex<PtyRegistry>>(),
            app.try_state::<SessionLogReaders>(),
        ) else {
            return;
        };
        let runs_root = crate::bridge::launch::runs_root(&crate::data_dir::app_data_dir(&app).path);
        match reconcile_on_startup(&store, &registry, &readers, &runs_root) {
            Ok(outcome) => announce(&app, outcome),
            Err(err) => eprintln!("DCTerminal: restart recovery failed: {err}"),
        }
        let mut watch = StallWatch::new();
        loop {
            std::thread::sleep(WATCHDOG_TICK);
            match watchdog_tick(&store, &registry, &readers, &mut watch, Instant::now(), &stall_limit) {
                Ok(outcome) => announce(&app, outcome),
                Err(err) => eprintln!("DCTerminal: stall watchdog: {err}"),
            }
        }
    });
    if let Err(err) = spawned {
        eprintln!("DCTerminal: could not start restart recovery: {err}");
    }
}

/// Continue after a restart: the run carries on (`running`), and the tabs of
/// its current stage are returned so the frontend decides the turn they
/// finished while the app was closed. Only a run waiting with
/// `app_restarted` continues this way.
pub fn continue_after_restart(store: &mut StateStore, run_id: &str) -> Result<Vec<String>, String> {
    let run = store
        .pipeline_run_by_id_mut(run_id)
        .ok_or_else(|| format!("unknown pipeline run: {run_id}"))?;
    if run.status != RunStatus::Waiting || run.stop_reason != Some(StopReason::AppRestarted) {
        return Err("This run is not waiting after a restart.".into());
    }
    let def = crate::pipelines::find(&run.kind).ok_or_else(|| format!("unknown pipeline: {}", run.kind))?;
    run.resume_after_you();
    run.log("autopilot", None, None, "Continued by you after the restart", None);
    let tabs = current_stage_tabs(&def, run).into_iter().map(|tab| tab.tab_id).collect();
    store.save()?;
    Ok(tabs)
}

#[tauri::command]
pub fn pipeline_continue(
    app: AppHandle,
    run_id: String,
    store: State<Mutex<StateStore>>,
) -> Result<Vec<String>, String> {
    let run_id = run_id.trim().to_string();
    let mut store = store.lock().map_err(|e| e.to_string())?;
    let tabs = continue_after_restart(&mut store, &run_id)?;
    app.chain_run_updated(&run_id);
    Ok(tabs)
}

/// The stops the core made before the frontend listened (`StartupStops`),
/// on the calling window's tabs. The frontend calls this once its
/// `autopilot-stopped` listener is attached and its tab list has loaded.
#[tauri::command]
pub fn autopilot_pending_stops(tab_ids: Vec<String>, stops: State<StartupStops>) -> Vec<AutopilotStopped> {
    stops.take(&tab_ids)
}

#[cfg(test)]
#[path = "run_recovery_tests.rs"]
mod tests;
