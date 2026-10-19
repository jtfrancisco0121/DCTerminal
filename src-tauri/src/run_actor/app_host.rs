//! The app's [`Host`]: the managed stores, the PTY registry (stage
//! terminals start with no view and a view attaches later, see
//! `pty::start_actor_stage`), the real gates, Claude usage, and the events
//! the frontend listens to:
//!
//! - `chain-run-updated`: an overview refetches the run.
//! - `pipeline-stage-opened` (`{runId, tabId}`): the actor opened a stage
//!   terminal, or resumed one (V4); the frontend lists the tab and attaches
//!   to its output (again, when its view saw the old program exit).
//! - `autopilot-stopped`: the run stopped; you get a toast and a notification.
//! - `pipeline-notice` (`{runId, title, body}`): the run is complete.
//!
//! It also feeds the actors: [`deliver_inbox`] hands the watcher's finished
//! turns to them (V2a/V2b sent those to the frontend's executor).

use super::{ActorMsg, Host, RunActors, StageLaunch};
use crate::bridge::watch::{InboxEvent, BRIDGE_NEEDS_EVENT};
use crate::commands::chain_events::ChainEvents;
use crate::commands::run_recovery::{AutopilotStopped, AUTOPILOT_STOPPED_EVENT};
use crate::pipelines::{GateDef, GateResult};
use crate::pty::PtyRegistry;
use crate::roles::Role;
use crate::store::{RolesStore, SettingsStore, StateStore, StopReason};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

pub const STAGE_OPENED_EVENT: &str = "pipeline-stage-opened";
pub const PIPELINE_NOTICE_EVENT: &str = "pipeline-notice";

/// The actors the app runs.
pub type AppActors = RunActors<AppHost>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StageOpened<'a> {
    run_id: &'a str,
    tab_id: &'a str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PipelineNotice<'a> {
    run_id: &'a str,
    title: &'a str,
    body: &'a str,
}

pub struct AppHost {
    app: AppHandle,
}

impl AppHost {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }

    /// A stage terminal's exit goes to its run's actor.
    fn on_exit(&self, launch: &StageLaunch) -> crate::pty::OnExit {
        let app = self.app.clone();
        let (run_id, tab_id) = (launch.run_id.clone(), launch.tab_id.clone());
        Box::new(move |code: Option<i32>| {
            if let Some(actors) = app.try_state::<AppActors>() {
                actors.send(&run_id, ActorMsg::Exited { tab_id, code });
            }
        })
    }
}

impl Host for AppHost {
    fn store(&self) -> &Mutex<StateStore> {
        self.app.state::<Mutex<StateStore>>().inner()
    }

    fn runs_root(&self) -> PathBuf {
        crate::bridge::launch::runs_root(&crate::data_dir::app_data_dir(&self.app).path)
    }

    fn bridge_program(&self) -> Option<PathBuf> {
        crate::bridge::launch::bridge_program()
    }

    fn role(&self, role_id: &str) -> Option<Role> {
        let roles = self.app.state::<Mutex<RolesStore>>();
        let roles = roles.lock().ok()?;
        roles.role_by_id(role_id).cloned()
    }

    fn spawn_stage(&self, launch: &StageLaunch) -> Result<(), String> {
        crate::pty::start_actor_stage(&self.app, launch, false, self.on_exit(launch))
    }

    fn resume_stage(&self, launch: &StageLaunch) -> Result<(), String> {
        crate::pty::start_actor_stage(&self.app, launch, true, self.on_exit(launch))
    }

    fn paste(&self, tab_id: &str, text: &str) -> Result<(), String> {
        let registry = self.app.state::<Mutex<PtyRegistry>>();
        let registry = registry.lock().map_err(|err| err.to_string())?;
        registry.paste(tab_id, text)
    }

    fn terminal_live(&self, tab_id: &str) -> bool {
        let registry = self.app.state::<Mutex<PtyRegistry>>();
        let live = registry.lock().is_ok_and(|registry| registry.running(tab_id));
        live
    }

    fn run_gate(&self, gate: &GateDef, folder: &Path, pr_urls: &[String]) -> GateResult {
        match gate {
            GateDef::Command { run, timeout_secs } => {
                crate::pipelines::run_command_gate(folder, run, timeout_secs.map(Duration::from_secs))
            }
            GateDef::PullRequest => crate::pipelines::run_pull_request_gate(folder, pr_urls),
        }
    }

    /// The run's account's usage (the highest window), as the overview shows it.
    fn usage_percent(&self, run_id: &str) -> Option<u8> {
        let account = {
            let store = self.store().lock().ok()?;
            let run = store.pipeline_run_by_id(run_id)?;
            let tab = run.tab_ids.values().next().cloned();
            store.account_for_tab(tab.as_deref())
        };
        let dir = {
            let settings = self.app.state::<Mutex<SettingsStore>>();
            let settings = settings.lock().ok()?;
            crate::store::settings_store::resolved_account_config(&settings.providers().claude, &account)
        };
        let usage = self.app.state::<Mutex<crate::usage::UsageStore>>();
        let snapshot = usage.lock().ok()?.snapshot(&dir.path);
        snapshot
            .windows
            .iter()
            .filter_map(|window| window.utilization)
            .filter(|value| value.is_finite())
            .fold(None, |max: Option<f64>, value| Some(max.map_or(value, |m| m.max(value))))
            .map(|value| value.round().clamp(0.0, 255.0) as u8)
    }

    fn run_changed(&self, run_id: &str) {
        self.app.chain_run_updated(run_id);
    }

    fn tab_opened(&self, run_id: &str, tab_id: &str) {
        let _ = self.app.emit(STAGE_OPENED_EVENT, StageOpened { run_id, tab_id });
    }

    fn stopped(&self, run_id: &str, tab_id: Option<&str>, reason: StopReason, summary: &str) {
        let _ = self.app.emit(
            AUTOPILOT_STOPPED_EVENT,
            AutopilotStopped {
                run_id: run_id.to_string(),
                tab_id: tab_id.unwrap_or_default().to_string(),
                reason,
                summary: summary.to_string(),
            },
        );
    }

    fn notice(&self, run_id: &str, title: &str, body: &str) {
        let _ = self.app.emit(PIPELINE_NOTICE_EVENT, PipelineNotice { run_id, title, body });
    }
}

/// The inbox watcher's delivery: finished turns to their run's actor,
/// Needs you to the frontend.
pub fn deliver_inbox(app: AppHandle) -> impl FnMut(InboxEvent) + Send + 'static {
    move |event| match event {
        InboxEvent::Turn(turn) => {
            if let Some(actors) = app.try_state::<AppActors>() {
                let run_id = turn.run_id.clone();
                actors.send(&run_id, ActorMsg::Turn(turn));
            }
        }
        InboxEvent::Needs(needs) => {
            let _ = app.emit(BRIDGE_NEEDS_EVENT, needs);
        }
    }
}
