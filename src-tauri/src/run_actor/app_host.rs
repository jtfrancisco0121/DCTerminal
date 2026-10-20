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

    fn bridge_gate(&self, run_id: &str, stage_key: &str, cwd: &Path) -> Result<bool, String> {
        crate::pty::actor_stage_gate(&self.app, run_id, stage_key, cwd)
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
            GateDef::Command { run, timeout_secs, optional } => GateResult {
                optional: *optional,
                ..crate::pipelines::run_command_gate(folder, run, timeout_secs.map(Duration::from_secs))
            },
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
        known_usage_percent(&snapshot.windows, chrono::Utc::now().timestamp_millis())
    }

    /// The tab's session log summary (`terminal_session_log`), read the
    /// same way: store and PTY locks only to find the file.
    fn rate_limit(&self, tab_id: &str) -> Option<String> {
        crate::commands::session_log::session_log_blocking(
            tab_id.to_string(),
            self.app.state(),
            self.app.state(),
            self.app.state(),
        )
        .ok()
        .flatten()
        .and_then(|log| log.rate_limit)
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

/// The highest current window in percent, `None` when unknown: no reading,
/// no percent, or every reading stale (H5, `knownUsagePercent` and
/// `isStale` in `src/usage/limits.ts`). Never 0 for unknown.
pub(crate) fn known_usage_percent(windows: &[crate::usage::RateWindow], now_ms: i64) -> Option<u8> {
    windows
        .iter()
        .filter(|window| !stale(window, now_ms))
        .filter_map(|window| window.utilization)
        .filter(|value| value.is_finite())
        .fold(None, |max: Option<f64>, value| Some(max.map_or(value, |m| m.max(value))))
        .map(|value| value.round().clamp(0.0, 255.0) as u8)
}

/// The window reset since this reading, or (with no reset time) the reading
/// is older than its window's length.
fn stale(window: &crate::usage::RateWindow, now_ms: i64) -> bool {
    if let Some(resets_at) = window.resets_at {
        return resets_at.saturating_mul(1000) <= now_ms;
    }
    let length_ms: Option<i64> = match window.rate_limit_type.as_str() {
        "five_hour" => Some(5 * 3_600_000),
        "seven_day" => Some(7 * 24 * 3_600_000),
        _ => None,
    };
    length_ms.is_some_and(|length| now_ms - window.seen_at_ms > length)
}

#[cfg(test)]
mod tests {
    use super::known_usage_percent;
    use crate::usage::RateWindow;

    fn window(kind: &str, utilization: Option<f64>, resets_at: Option<i64>, seen_at_ms: i64) -> RateWindow {
        RateWindow {
            rate_limit_type: kind.into(),
            label: kind.into(),
            utilization,
            resets_at,
            status: "allowed".into(),
            seen_at_ms,
        }
    }

    /// H5: usage that is missing or stale reads as unknown, never as a
    /// percent that pauses the run (`knownUsagePercent` in `src/usage/limits.ts`).
    #[test]
    fn stale_or_missing_usage_is_unknown_to_the_run_actor() {
        let now_ms = 1_800_000_000_000;
        let now = now_ms / 1000;
        let hour = 3_600_000;
        assert_eq!(known_usage_percent(&[], now_ms), None);
        assert_eq!(known_usage_percent(&[window("five_hour", None, Some(now + 60), now_ms)], now_ms), None);
        // Current: the highest window counts.
        let current = [window("five_hour", Some(42.4), Some(now + 60), now_ms), window("seven_day", Some(61.6), Some(now + 600), now_ms)];
        assert_eq!(known_usage_percent(&current, now_ms), Some(62));
        // The window reset since the reading: its 95% no longer applies.
        let reset = [window("five_hour", Some(95.0), Some(now - 1), now_ms - hour), window("seven_day", Some(30.0), Some(now + 600), now_ms)];
        assert_eq!(known_usage_percent(&reset, now_ms), Some(30));
        // No reset time: a reading older than its window is stale.
        let old = [window("five_hour", Some(95.0), None, now_ms - 6 * hour)];
        assert_eq!(known_usage_percent(&old, now_ms), None);
        let fresh = [window("five_hour", Some(95.0), None, now_ms - hour)];
        assert_eq!(known_usage_percent(&fresh, now_ms), Some(95));
    }
}
