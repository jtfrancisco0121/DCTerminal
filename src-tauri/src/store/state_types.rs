use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const STATE_SCHEMA_VERSION: u32 = 1;
pub const MAIN_WINDOW_ID: &str = "main";

pub fn default_window_id() -> String {
    MAIN_WINDOW_ID.to_string()
}

/// A tab belongs to `window_id`. Blank ids are the original window.
pub fn window_matches(tab_window: &str, window_id: &str) -> bool {
    let tab_window = if tab_window.trim().is_empty() {
        MAIN_WINDOW_ID
    } else {
        tab_window
    };
    let window_id = if window_id.trim().is_empty() {
        MAIN_WINDOW_ID
    } else {
        window_id
    };
    tab_window == window_id
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStateFile {
    pub schema_version: u32,
    pub active_tab_id: Option<String>,
    pub tabs: Vec<TabRecord>,
    #[serde(default)]
    pub closed_tabs: Vec<ClosedTabRecord>,
    #[serde(default)]
    pub layout: LayoutState,
    #[serde(default)]
    pub pipeline_runs: Vec<PipelineRun>,
    /// One-time migrations. Missing on old files, so `claude_first` starts false.
    #[serde(default)]
    pub migrations: Migrations,
    /// Windows and the Claude account each one uses. Missing on old files.
    #[serde(default)]
    pub windows: Vec<WindowRecord>,
    /// Windows closed while another stayed open, newest first. Their tabs
    /// wait in `closed_tabs` for File > Reopen Closed Window.
    #[serde(default)]
    pub archived_windows: Vec<ArchivedWindow>,
}

/// One top-level window bound to a Claude account.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WindowRecord {
    pub id: String,
    /// `providers.claude.accounts[].id`.
    pub account_id: String,
    #[serde(default)]
    pub active_tab_id: Option<String>,
    #[serde(default)]
    pub layout: LayoutState,
}

/// A window closed while another stayed open, kept with its account so it
/// can be reopened as it was.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ArchivedWindow {
    #[serde(flatten)]
    pub window: WindowRecord,
    /// The tabs open when it closed, in tab order.
    #[serde(default)]
    pub tab_ids: Vec<String>,
    pub closed_at: String,
}

/// Eagle-Eye position on a tab or a hand-off (Phase 9).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChainRef {
    pub chain_id: String,
    /// `eagle1` or `eagle2`.
    pub kind: String,
    pub step: u32,
    pub total: u32,
    /// Review round. Starts at 1; each loop-back (reviewer → earlier stage) adds one.
    #[serde(default = "first_round", skip_serializing_if = "is_first_round")]
    pub round: u32,
    /// Lane id (`pr1`) when the run fanned out by pull request (ADR-014 phase 3).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lane: Option<String>,
}

pub fn first_round() -> u32 {
    1
}

fn is_first_round(round: &u32) -> bool {
    *round <= 1
}

/// Flags for one-time data migrations. `Default` is all false so an old
/// file that omits the object still migrates. A brand-new file sets
/// `claude_first` itself.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Migrations {
    #[serde(default)]
    pub claude_first: bool,
    /// Tabs and layout moved onto per-window records.
    #[serde(default)]
    pub windows: bool,
    /// Pipeline runs given a `status` and `stop_reason` from their older fields.
    #[serde(default)]
    pub run_status: bool,
}

/// Linked multi-tab pipeline (eagle-eye overview + stage worker tabs).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PipelineRun {
    pub id: String,
    /// `full` (plan + review) or `execute` (approved plan only).
    pub kind: String,
    pub cwd: String,
    /// Coarse stage id, e.g. `planner`, `plan_reviewer`, `implementer`, `pr_reviewer`.
    pub stage: String,
    /// Overview tab id for this run. Empty until a chain's overview is opened.
    #[serde(default)]
    pub overview_tab_id: String,
    /// `role_id` → worker tab id.
    pub tab_ids: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidate_plan: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approved_plan: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub original_request: Option<String>,
    pub created_at: String,
    /// Eagle-Eye chain this run follows. `None` on palette preset runs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chain_id: Option<String>,
    /// `role_id` → the text a hand-off along the chain sent into that stage.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub handoffs: HashMap<String, StageHandoff>,
    /// Last chain step recorded. Pruning keeps the most recent runs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    /// Chain round; see `ChainRef::round`.
    #[serde(default = "first_round")]
    pub round: u32,
    /// Reviewer verdicts recorded when a round was sent back, oldest first.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub verdicts: Vec<StageVerdict>,
    /// The run ledger: what happened, oldest first (ADR-014). Capped.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub events: Vec<RunEvent>,
    /// Latest gate results per stage id.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub gates: HashMap<String, StageGates>,
    /// Opt-in autopilot for this run. `None` (or off) means manual.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub autopilot: Option<RunAutopilot>,
    /// One lane per pull request once the run fanned out; empty otherwise.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub lanes: Vec<RunLane>,
    /// The stage where the lanes start (the Implementer's).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fan_out_stage: Option<String>,
    /// Hand-offs on and send-backs already made, newest last, so the same
    /// one is never made twice, by you or by autopilot. Capped.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub claims: Vec<HandoffClaim>,
    /// Where the run stands. Missing on files saved before it existed:
    /// `migrate_run_status` fills it from the fields above on load.
    #[serde(default, deserialize_with = "lenient_status")]
    pub status: RunStatus,
    /// Why the run is `waiting` (or `stopped`, when you turned autopilot off).
    #[serde(default, deserialize_with = "lenient_stop_reason", skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<StopReason>,
}

/// Where a run stands (Track H2).
///
/// - `running`: autopilot is on and acts on each finished turn.
/// - `waiting`: autopilot stopped for you (`stop_reason` says why). Finished
///   turns are left alone until you hand on, send back, approve, or turn
///   autopilot on again.
/// - `stopped`: autopilot is off; every hand-off is yours.
/// - `complete`: the run is done. Final: later turns are ignored.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Running,
    Waiting,
    Complete,
    #[default]
    Stopped,
}

/// Why a run stopped. Every stop carries one (plan "Stop reason codes").
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    /// A checkpoint stage you have not passed yet.
    Checkpoint,
    /// A check failed after its retries.
    GateFailed,
    /// An `auto` check found nothing to run.
    NoCheckFound,
    /// The reply still lacked its result (v1: HANDOFF sections) after one re-ask.
    NoResult,
    /// No verdict could be read from a reviewer's reply.
    NoVerdict,
    /// The reviewer asked for changes, or approved with findings at the threshold.
    BlockingFindings,
    /// A loop-back reached its round cap.
    RoundCap,
    /// Claude usage is at the pause threshold.
    UsageLimit,
    /// A stage stopped producing output.
    Stalled,
    /// A turn finished while the app was closed.
    AppRestarted,
    /// Autopilot decided, but could not carry the decision out.
    CarryOutFailed,
    /// You took over the stage.
    TakenOver,
    /// You turned autopilot off.
    PausedByYou,
}

/// A status written by a newer build reads as `stopped`, never a failed load.
fn lenient_status<'de, D: serde::Deserializer<'de>>(de: D) -> Result<RunStatus, D::Error> {
    let value = serde_json::Value::deserialize(de)?;
    Ok(serde_json::from_value(value).unwrap_or_default())
}

/// A reason code written by a newer build reads as none, never a failed load.
fn lenient_stop_reason<'de, D: serde::Deserializer<'de>>(de: D) -> Result<Option<StopReason>, D::Error> {
    let value = serde_json::Value::deserialize(de)?;
    Ok(serde_json::from_value(value).ok())
}

/// Most hand-off claims a run keeps; older ones are dropped first.
pub const MAX_RUN_CLAIMS: usize = 200;

/// One hand-off on (`advance`) or send-back (`back`) from a stage in one
/// round (and lane), and the turn whose reply it carried.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HandoffClaim {
    /// `advance:<stage>#<round>` or `back:<stage>#<round>`, plus `@<lane>`.
    pub key: String,
    /// The source tab's turn (`tab|session|prompt`), when it is known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn: Option<String>,
    /// `you` or `autopilot`.
    pub by: String,
    pub at: String,
}

/// Key of a hand-off claim: `kind` from `stage_id` in `round`, in `lane`.
pub fn claim_key(kind: &str, stage_id: &str, round: u32, lane: Option<&str>) -> String {
    match lane {
        Some(lane) => format!("{kind}:{stage_id}#{round}@{lane}"),
        None => format!("{kind}:{stage_id}#{round}"),
    }
}

/// One pull request's own Implementer → PR Reviewer track after a fan-out.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunLane {
    /// `pr1`.
    pub id: String,
    /// "PR1 — Token refresh".
    pub title: String,
    /// Lane ids that must be approved before this one starts.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub depends_on: Vec<String>,
    /// `waiting` (for its dependencies), `active`, `approved`.
    pub status: String,
    #[serde(default)]
    pub stage: String,
    #[serde(default = "first_round")]
    pub round: u32,
    /// `role_id` → tab id in this lane.
    #[serde(default)]
    pub tab_ids: HashMap<String, String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub handoffs: HashMap<String, StageHandoff>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub verdicts: Vec<StageVerdict>,
}

impl PipelineRun {
    pub fn lane(&self, id: &str) -> Option<&RunLane> {
        self.lanes.iter().find(|lane| lane.id == id)
    }

    pub fn lane_mut(&mut self, id: &str) -> Option<&mut RunLane> {
        self.lanes.iter_mut().find(|lane| lane.id == id)
    }

    /// The round a stage is on: its lane's, else the run's.
    /// The claim already made for `key`, or for the same source `turn`.
    pub fn claim_for(&self, key: &str, turn: Option<&str>) -> Option<&HandoffClaim> {
        self.claims.iter().rev().find(|claim| {
            claim.key == key || turn.is_some_and(|turn| claim.turn.as_deref() == Some(turn))
        })
    }

    /// Record a claim (replacing one with the same key), dropping the oldest past the cap.
    pub fn add_claim(&mut self, key: String, turn: Option<String>, by: &str) {
        self.claims.retain(|claim| claim.key != key);
        self.claims.push(HandoffClaim {
            key,
            turn,
            by: by.to_string(),
            at: chrono::Utc::now().to_rfc3339(),
        });
        if self.claims.len() > MAX_RUN_CLAIMS {
            let drop = self.claims.len() - MAX_RUN_CLAIMS;
            self.claims.drain(..drop);
        }
    }

    pub fn round_for(&self, lane: Option<&str>) -> u32 {
        lane.and_then(|id| self.lane(id))
            .map(|lane| lane.round)
            .unwrap_or(self.round)
            .max(1)
    }

    /// Waiting lanes whose dependencies are all approved now.
    pub fn unblocked_lanes(&self) -> Vec<String> {
        let approved = |id: &String| self.lane(id).is_some_and(|l| l.status == "approved");
        self.lanes
            .iter()
            .filter(|lane| lane.status == "waiting" && lane.depends_on.iter().all(approved))
            .map(|lane| lane.id.clone())
            .collect()
    }
}

/// Most ledger events a run keeps; older ones are dropped first.
pub const MAX_RUN_EVENTS: usize = 300;
/// Longest event detail kept (gate output, findings).
pub const MAX_EVENT_DETAIL_CHARS: usize = 8_000;

/// One line of the run ledger.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunEvent {
    pub at: String,
    /// `handoff`, `loopBack`, `gate`, `autopilot`, `stop`, `complete`,
    /// `note`, `turn` (a stage's terminal finished a turn).
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role_id: Option<String>,
    pub round: u32,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Machine-readable result, for the run lanes: a gate's `passed` /
    /// `failed` / `skipped`, an autopilot decision's action, a turn's
    /// verdict. Missing on older events.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
    /// The fanned-out pull request (lane) the event is about. Missing on
    /// older events, whose summary starts with the lane's title instead.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lane_id: Option<String>,
}

/// A stage's latest gate results.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StageGates {
    pub round: u32,
    pub at: String,
    pub results: Vec<crate::pipelines::GateResult>,
}

/// Autopilot state of one run.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunAutopilot {
    pub enabled: bool,
    /// Why autopilot last stopped and is waiting for you, if it is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub waiting: Option<String>,
    /// Checkpoint stages you have already passed (sent into yourself).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub passed_checkpoints: Vec<String>,
    /// `stage@round` keys already re-asked for missing HANDOFF sections.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reasked: Vec<String>,
    /// Failed-gate retries per stage in the current round.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub gate_retries: HashMap<String, u32>,
    /// Turns (`tab|session|prompt`) already decided on, newest last, so a
    /// reply is acted on once even when it is read again. Capped.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub decided: Vec<String>,
}

/// Most decided turns autopilot remembers per run.
pub const MAX_DECIDED_TURNS: usize = 100;

impl PipelineRun {
    /// Autopilot stops for you: `waiting`, with the reason code and the
    /// sentence the overview shows. A complete run stays complete, and a run
    /// with autopilot off stays `stopped`: only autopilot waits for you.
    pub fn set_waiting(&mut self, reason: StopReason, why: impl Into<String>) {
        let enabled = self.autopilot.as_ref().is_some_and(|a| a.enabled);
        if self.status == RunStatus::Complete || !enabled {
            return;
        }
        self.autopilot.get_or_insert_with(RunAutopilot::default).waiting = Some(why.into());
        self.status = RunStatus::Waiting;
        self.stop_reason = Some(reason);
    }

    /// Autopilot acts again: `running` while it is on. Clears what it was
    /// waiting for. A complete run stays complete; a run with autopilot off
    /// stays stopped.
    pub fn set_running(&mut self) {
        if let Some(autopilot) = self.autopilot.as_mut() {
            autopilot.waiting = None;
        }
        let enabled = self.autopilot.as_ref().is_some_and(|a| a.enabled);
        if enabled && self.status != RunStatus::Complete {
            self.status = RunStatus::Running;
            self.stop_reason = None;
        }
    }

    /// You acted on the run (a hand-off, a send-back, an approval): a
    /// waiting run carries on from the next turn.
    pub fn resume_after_you(&mut self) {
        if let Some(autopilot) = self.autopilot.as_mut() {
            autopilot.waiting = None;
        }
        if self.status == RunStatus::Waiting {
            self.set_running();
        }
    }

    /// You sent work back or handed it on yourself on a complete run: it is
    /// in play again, `running` when autopilot is on, else `stopped` (paused
    /// by you when you had turned autopilot off). Matches `migrated_status`,
    /// which reads a hand-off or send-back after the last `complete` event as
    /// not complete. Late turns with no such action from you leave a complete
    /// run complete.
    pub fn reopen_after_you(&mut self) {
        if self.status != RunStatus::Complete {
            return;
        }
        (self.status, self.stop_reason) = match self.autopilot.as_ref() {
            Some(a) if a.enabled => (RunStatus::Running, None),
            // Turned off by you before: still paused by you.
            Some(_) => (RunStatus::Stopped, Some(StopReason::PausedByYou)),
            None => (RunStatus::Stopped, None),
        };
    }

    /// Autopilot turned on (`running`) or off (`stopped`, paused by you).
    /// A complete run stays complete.
    pub fn set_autopilot_enabled(&mut self, enabled: bool) {
        let autopilot = self.autopilot.get_or_insert_with(RunAutopilot::default);
        autopilot.enabled = enabled;
        autopilot.waiting = None;
        if self.status == RunStatus::Complete {
            return;
        }
        if enabled {
            self.status = RunStatus::Running;
            self.stop_reason = None;
        } else {
            self.status = RunStatus::Stopped;
            self.stop_reason = Some(StopReason::PausedByYou);
        }
    }

    /// The run is done. Final.
    pub fn set_complete(&mut self) {
        if let Some(autopilot) = self.autopilot.as_mut() {
            autopilot.waiting = None;
        }
        self.status = RunStatus::Complete;
        self.stop_reason = None;
    }

    /// `status` and `stop_reason` for a run saved before they existed:
    /// complete when its last `complete` event came after its last hand-off
    /// or send-back; else waiting when autopilot was waiting (the reason read
    /// from its sentence); else running when autopilot was on; else stopped
    /// (paused by you when autopilot had been turned on before).
    pub fn migrated_status(&self) -> (RunStatus, Option<StopReason>) {
        let last = |kinds: &[&str]| self.events.iter().rposition(|e| kinds.contains(&e.kind.as_str()));
        if let Some(done) = last(&["complete"]) {
            if last(&["handoff", "loopBack"]).is_none_or(|moved| moved < done) {
                return (RunStatus::Complete, None);
            }
        }
        match self.autopilot.as_ref() {
            Some(a) if a.enabled => match a.waiting.as_deref() {
                Some(why) => (RunStatus::Waiting, Some(stop_reason_from_sentence(why))),
                None => (RunStatus::Running, None),
            },
            Some(_) => (RunStatus::Stopped, Some(StopReason::PausedByYou)),
            None => (RunStatus::Stopped, None),
        }
    }
}

/// The reason code behind a waiting sentence saved before codes existed.
/// Anything not recognised was autopilot failing to carry a decision out.
fn stop_reason_from_sentence(why: &str) -> StopReason {
    let has = |text: &str| why.contains(text);
    if why.starts_with("Checkpoint before") {
        StopReason::Checkpoint
    } else if why.starts_with("Round cap reached") {
        StopReason::RoundCap
    } else if why.starts_with("Paused: Claude usage") {
        StopReason::UsageLimit
    } else if has("lacks HANDOFF sections") {
        StopReason::NoResult
    } else if has("No verdict could be read") {
        StopReason::NoVerdict
    } else if has(" check failed ") {
        StopReason::GateFailed
    } else if has("finding(s) at") || has("asked for changes, but") {
        StopReason::BlockingFindings
    } else {
        StopReason::CarryOutFailed
    }
}

/// Gives every run of a file saved before run status existed its `status`
/// and `stop_reason` (`PipelineRun::migrated_status`). Once per file; the
/// next save keeps them. Returns whether it ran.
pub fn migrate_run_status(data: &mut AppStateFile) -> bool {
    if data.migrations.run_status {
        return false;
    }
    for run in &mut data.pipeline_runs {
        (run.status, run.stop_reason) = run.migrated_status();
    }
    data.migrations.run_status = true;
    true
}

impl PipelineRun {
    /// Append to the ledger (detail capped, oldest events dropped past the cap).
    pub fn log(
        &mut self,
        kind: &str,
        stage_id: Option<&str>,
        role_id: Option<&str>,
        summary: impl Into<String>,
        detail: Option<String>,
    ) {
        self.log_outcome(kind, stage_id, role_id, summary, detail, None);
    }

    /// `log` with a machine-readable `outcome` (see `RunEvent::outcome`).
    pub fn log_outcome(
        &mut self,
        kind: &str,
        stage_id: Option<&str>,
        role_id: Option<&str>,
        summary: impl Into<String>,
        detail: Option<String>,
        outcome: Option<String>,
    ) {
        self.log_in_lane(kind, stage_id, role_id, None, summary, detail, outcome);
    }

    /// `log_outcome` for an event about one lane (see `RunEvent::lane_id`).
    #[allow(clippy::too_many_arguments)]
    pub fn log_in_lane(
        &mut self,
        kind: &str,
        stage_id: Option<&str>,
        role_id: Option<&str>,
        lane_id: Option<&str>,
        summary: impl Into<String>,
        detail: Option<String>,
        outcome: Option<String>,
    ) {
        let detail = detail.map(|text| {
            let chars = text.chars().count();
            if chars > MAX_EVENT_DETAIL_CHARS {
                let kept: String = text.chars().take(MAX_EVENT_DETAIL_CHARS).collect();
                format!("{kept}\n… ({} more characters)", chars - MAX_EVENT_DETAIL_CHARS)
            } else {
                text
            }
        });
        self.events.push(RunEvent {
            at: chrono::Utc::now().to_rfc3339(),
            kind: kind.to_string(),
            stage_id: stage_id.map(str::to_string),
            role_id: role_id.map(str::to_string),
            round: self.round.max(1),
            summary: summary.into(),
            detail: detail.filter(|text| !text.trim().is_empty()),
            outcome: outcome.filter(|text| !text.trim().is_empty()),
            lane_id: lane_id.map(str::to_string),
        });
        if self.events.len() > MAX_RUN_EVENTS {
            let drop = self.events.len() - MAX_RUN_EVENTS;
            self.events.drain(..drop);
        }
    }
}

/// A reviewer's verdict at the end of one round.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StageVerdict {
    pub role_id: String,
    pub round: u32,
    /// `None` when the reply had no verdict.
    #[serde(default)]
    pub verdict: Option<String>,
    pub at: String,
}

/// Text handed into one stage of a chain run.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StageHandoff {
    pub text: String,
    pub at: String,
}

/// `(stage id, role id)` for each stage of a run kind or chain kind, from
/// the pipeline definitions (`crate::pipelines`). Unknown kinds read as
/// Eagle-Eye 1 (`full`).
pub fn pipeline_stages(kind: &str) -> Vec<(String, String)> {
    crate::pipelines::stages(kind)
}

/// Run kind of a chain: `eagle1` → `full`, `eagle2` → `execute`, a user
/// pipeline → its id. None for an unknown pipeline.
pub fn run_kind_for_chain(chain_kind: &str) -> Option<String> {
    crate::pipelines::run_kind_for_chain(chain_kind)
}

/// Split view and file panel. Restored on relaunch.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LayoutState {
    /// `single`, `horizontal`, `vertical`, or `grid`.
    #[serde(default = "default_split_mode")]
    pub split_mode: String,
    #[serde(default)]
    pub secondary_tab_id: Option<String>,
    /// Tabs pinned to the grid, in cell order (`grid` mode only).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub grid_tab_ids: Vec<String>,
    /// Size of the main pane, in percent.
    #[serde(default = "default_split_size")]
    pub primary_size: f64,
    #[serde(default)]
    pub file_panel_open: bool,
    /// File panel width, in pixels.
    #[serde(default = "default_file_panel_width")]
    pub file_panel_width: f64,
}

fn default_split_mode() -> String {
    "single".to_string()
}

fn default_split_size() -> f64 {
    50.0
}

fn default_file_panel_width() -> f64 {
    280.0
}

/// Most tabs a grid shows at once.
pub const GRID_MAX_TABS: usize = 6;

impl Default for LayoutState {
    fn default() -> Self {
        Self {
            split_mode: default_split_mode(),
            secondary_tab_id: None,
            grid_tab_ids: Vec::new(),
            primary_size: default_split_size(),
            file_panel_open: false,
            file_panel_width: default_file_panel_width(),
        }
    }
}

impl LayoutState {
    pub fn sanitized(mut self) -> Self {
        if !matches!(
            self.split_mode.as_str(),
            "single" | "horizontal" | "vertical" | "grid"
        ) {
            self.split_mode = default_split_mode();
        }
        if self.split_mode == "grid" {
            let mut seen = std::collections::HashSet::new();
            self.grid_tab_ids
                .retain(|id| !id.trim().is_empty() && seen.insert(id.clone()));
            self.grid_tab_ids.truncate(GRID_MAX_TABS);
            self.secondary_tab_id = None;
            if self.grid_tab_ids.len() < 2 {
                self.grid_tab_ids.clear();
                self.split_mode = default_split_mode();
            }
        } else {
            self.grid_tab_ids.clear();
            if self.split_mode == "single" {
                self.secondary_tab_id = None;
            }
            if self.secondary_tab_id.is_none() {
                self.split_mode = default_split_mode();
            }
        }
        if !self.primary_size.is_finite() {
            self.primary_size = default_split_size();
        }
        self.primary_size = self.primary_size.clamp(15.0, 85.0);
        if !self.file_panel_width.is_finite() {
            self.file_panel_width = default_file_panel_width();
        }
        self.file_panel_width = self.file_panel_width.clamp(160.0, 900.0);
        self
    }
}

impl Default for AppStateFile {
    fn default() -> Self {
        Self {
            schema_version: STATE_SCHEMA_VERSION,
            active_tab_id: None,
            tabs: Vec::new(),
            closed_tabs: Vec::new(),
            layout: LayoutState::default(),
            pipeline_runs: Vec::new(),
            // Nothing to migrate in a file we are creating now.
            migrations: Migrations {
                claude_first: true,
                windows: true,
                run_status: true,
            },
            windows: vec![WindowRecord {
                id: MAIN_WINDOW_ID.to_string(),
                account_id: "default".to_string(),
                active_tab_id: None,
                layout: LayoutState::default(),
            }],
            archived_windows: Vec::new(),
        }
    }
}

/// A closed tab can be reopened without its agent process.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosedTabRecord {
    pub id: String,
    pub label: String,
    pub role_id: String,
    pub role_snapshot: RoleSnapshot,
    pub cwd: String,
    pub answers: HashMap<String, String>,
    #[serde(default)]
    pub color: Option<String>,
    pub merged_prompt: String,
    pub merged_prompt_hash: String,
    pub startup_prompt_sent: bool,
    pub closed_at: String,
    /// `role` for a chat tab. `terminal` for a shell, Cursor CLI, or role terminal.
    #[serde(default = "default_tab_kind")]
    pub kind: String,
    /// `shell`, `cursor-cli`, or `role`. Empty on chat tabs.
    #[serde(default)]
    pub terminal_launch: String,
    /// Kept so a reopened tab can `session/load` the same ACP thread.
    #[serde(default)]
    pub acp_session_id: Option<String>,
    #[serde(default)]
    pub mode_id: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub custom_label: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<crate::worktree::WorktreeRef>,
    /// Provider of this tab. `None` = saved before providers existed
    /// (resolves to Cursor until the Task 6.3 migration).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<crate::provider::ProviderId>,
    /// Session id per provider (the legacy single id lands in `cursor`).
    #[serde(default, skip_serializing_if = "crate::provider::ProviderSessions::is_empty")]
    pub sessions: crate::provider::ProviderSessions,
    /// Shown once, then cleared. Migration and config-dir mismatch use this.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_notice: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chain: Option<ChainRef>,
    /// Set when Claude could not use the role's permission mode.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_note: Option<String>,
    /// Window this tab belongs to. Old files are the original window.
    #[serde(default = "default_window_id")]
    pub window_id: String,
    /// Pipeline run of an overview or pipeline stage tab, so a reopened
    /// overview still renders its run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pipeline_run_id: Option<String>,
}

/// Persisted tab snapshot (blueprint §17.2 `state.json`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabRecord {
    pub id: String,
    pub label: String,
    pub role_id: String,
    pub role_snapshot: RoleSnapshot,
    pub cwd: String,
    pub answers: HashMap<String, String>,
    pub merged_prompt: String,
    pub merged_prompt_hash: String,
    /// `awaitingInput` | `running` (MVP; full FSM later).
    pub phase: String,
    pub order: u32,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<TabSessionRef>,
    /// Read-only scrollback after Stop (MVP transcript persist).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcript: Option<String>,
    /// Startup prompt was already sent for this tab (do not re-inject on Continue).
    #[serde(default)]
    pub startup_prompt_sent: bool,
    /// Optional chip color. Falls back to the role color in the UI.
    #[serde(default)]
    pub color: Option<String>,
    /// `role` for a chat tab. `terminal` for a shell, Cursor CLI, or role terminal.
    #[serde(default = "default_tab_kind")]
    pub kind: String,
    /// `shell`, `cursor-cli`, or `role`. Empty on chat tabs.
    #[serde(default)]
    pub terminal_launch: String,
    /// Per-tab model override. `None` uses the role default, then the global one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// The user renamed this tab. Form edits and session starts keep the name.
    #[serde(default)]
    pub custom_label: bool,
    /// Set when the tab was opened with "New tab in worktree…".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<crate::worktree::WorktreeRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pipeline_run_id: Option<String>,
    /// Provider of this tab. `None` = saved before providers existed
    /// (resolves to Cursor until the Task 6.3 migration).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<crate::provider::ProviderId>,
    /// Session id per provider (the legacy single id lands in `cursor`).
    #[serde(default, skip_serializing_if = "crate::provider::ProviderSessions::is_empty")]
    pub sessions: crate::provider::ProviderSessions,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_notice: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chain: Option<ChainRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_note: Option<String>,
    /// Window this tab belongs to. Old files are the original window.
    #[serde(default = "default_window_id")]
    pub window_id: String,
}

pub fn default_tab_kind() -> String {
    "role".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RoleSnapshot {
    pub name: String,
    pub template_version: u32,
    pub mode: String,
    pub injection: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabSessionRef {
    pub acp_session_id: String,
    pub mode_id: String,
    pub injection_pending: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub injected_at: Option<String>,
}
