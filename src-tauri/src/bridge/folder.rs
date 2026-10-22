//! The run folder (`<app data>/runs/<runId>/`) and the files in it. The app
//! writes `run.json`, `repos.json` (L1), `stages/<key>/stage.json` and
//! `stages/<key>/mode` when it launches a stage, and `tickets.json` when a run
//! starts from ClickUp tickets (C2) and `writeback.json` for its ClickUp
//! updates (C3), and the run actor writes each review round it sends
//! back as `findings-<stage>-r<N>.json` (V4); the bridge writes the rest,
//! including the run-level hand-off files: the Planner's `plan.md` and
//! `tasks.json`, and each Implementer's `prs.json` (`prs-<lane>.json` in a lane). Every write is
//! atomic (a temp file in the same folder, then a rename) and every path is
//! built from checked parts, so nothing lands outside the run folder (D37).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io;
use std::path::{Path, PathBuf};

/// Version of every file in the run folder.
pub const SCHEMA: u32 = 1;
/// Folder under app data that holds one folder per run.
pub const RUNS_DIR: &str = "runs";
pub(crate) const INBOX_DIR: &str = "inbox";
const RUN_FILE: &str = "run.json";
const STAGES_DIR: &str = "stages";
const STAGE_FILE: &str = "stage.json";
const MODE_FILE: &str = "mode";
pub(crate) const TURN_FILE: &str = "turn.json";
const RESULTS_DIR: &str = "results";
const PAYLOADS_DIR: &str = "payloads";
const LOG_FILE: &str = "bridge.log";
const NEEDS_FILE: &str = "needs.json";
/// The Planner's plan, as it handed it to ExitPlanMode.
pub const PLAN_FILE: &str = "plan.md";
/// The Planner's tasks (the plan's fenced JSON block); fan-out reads it.
pub const TASKS_FILE: &str = "tasks.json";
/// The ClickUp intake snapshot (C2). The app writes it before the first
/// stage starts and on Pull again; nothing else does.
pub const TICKETS_FILE: &str = "tickets.json";
/// ClickUp write-back (C3): the proposals, your ticks and edits, and what
/// was sent. Only the app writes it.
pub const WRITEBACK_FILE: &str = "writeback.json";
/// The repos of Settings › Repos when a stage launched (L1). The bridge is a
/// process of its own that sees only the run folder, so the app writes the
/// names here for the Planner's tasks check; the bridge never writes it.
pub const REPOS_FILE: &str = "repos.json";
/// `bridge.log` stops growing past this; the bridge never needs more to be debugged.
const MAX_LOG_BYTES: u64 = 256 * 1024;

fn id_chars(text: &str, max: usize, extra: &str) -> bool {
    !text.is_empty()
        && text.len() <= max
        && text
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || extra.contains(ch))
}

/// A run id is one path part: letters, digits, `-` and `_`.
pub fn valid_run_id(id: &str) -> bool {
    id_chars(id, 80, "")
}

/// A tab id: letters, digits, `-` and `_`.
pub fn valid_tab_id(id: &str) -> bool {
    id_chars(id, 120, "")
}

/// A stage key (`pr_reviewer`, `pr_reviewer@pr1`) is one path part that
/// cannot climb out of `stages/`.
pub fn valid_stage_key(key: &str) -> bool {
    id_chars(key, 160, ".@+") && !key.starts_with('.') && !key.contains("..")
}

/// The file name a turn's result is kept under. Claude's `prompt_id` is a
/// UUID; anything else is hashed so it can never name another path.
pub fn turn_file_name(turn: &str) -> String {
    if id_chars(turn, 100, "") {
        return format!("{turn}.json");
    }
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(turn.as_bytes());
    let hex: String = digest.iter().take(16).map(|b| format!("{b:02x}")).collect();
    format!("t-{hex}.json")
}

/// `run.json`: names the run the folder belongs to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunMarker {
    pub schema: u32,
    pub run_id: String,
}

/// Which result schema a stage reports with (`submit_result`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResultKind {
    /// Plan Reviewer and PR Reviewer: a verdict and findings.
    Reviewer,
    /// Planner: its plan and tasks, taken from its ExitPlanMode call (D11),
    /// not from `submit_result`.
    Planner,
    /// Implementer: its pull requests, a summary and the checks it ran.
    Implementer,
}

/// `stages/<key>/stage.json`, written by the app when the stage's tab starts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageInfo {
    pub schema: u32,
    pub run_id: String,
    pub stage_key: String,
    pub stage_id: String,
    pub role_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lane: Option<String>,
    /// The tab that owns the stage now. Hooks from any other tab are stale.
    pub tab_id: String,
    pub result: ResultKind,
}

/// `stages/<key>/mode`: whether the bridge enforces a result (D13).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StageMode {
    /// Autopilot is on: a stop with no result is blocked once.
    Autopilot,
    /// Autopilot is off: results are kept, nothing is enforced.
    Manual,
    /// You took the stage over (V5): nothing is enforced.
    Takeover,
}

impl StageMode {
    pub fn as_str(self) -> &'static str {
        match self {
            StageMode::Autopilot => "autopilot",
            StageMode::Manual => "manual",
            StageMode::Takeover => "takeover",
        }
    }

    /// Anything unreadable is `manual`: never enforce by mistake.
    pub fn parse(text: &str) -> Self {
        match text.trim() {
            "autopilot" => StageMode::Autopilot,
            "takeover" => StageMode::Takeover,
            _ => StageMode::Manual,
        }
    }
}

/// How a turn ended, from the bridge's point of view.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TurnOutcome {
    /// `submit_result` was called and accepted this turn.
    Result,
    /// The turn ended without an accepted `submit_result` (after the one
    /// block on autopilot).
    NoResult,
    /// No Stop came (Esc or a rejected permission) and an `idle_prompt`
    /// Notification closed the turn out (D9a). Kept in `turn.json` only:
    /// it is never posted to `inbox/` or read back, so autopilot never
    /// acts on it.
    Abandoned,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnEnd {
    pub at: String,
    pub outcome: TurnOutcome,
    #[serde(default)]
    pub last_assistant_message: String,
}

/// `stages/<key>/turn.json`: the stage's current turn (D9). A turn that has
/// a start and no end was interrupted or abandoned (D9a).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnState {
    pub schema: u32,
    /// Claude's `prompt_id`, the same in UserPromptSubmit and Stop.
    pub turn: String,
    pub started_at: String,
    /// The bridge blocked one stop of this turn already (D10).
    #[serde(default)]
    pub blocked: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended: Option<TurnEnd>,
}

impl TurnState {
    pub fn new(turn: &str) -> Self {
        Self {
            schema: SCHEMA,
            turn: turn.to_string(),
            started_at: now(),
            blocked: false,
            ended: None,
        }
    }
}

/// `stages/<key>/results/<turn>.json`: what `submit_result` accepted.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredResult {
    pub schema: u32,
    pub turn: String,
    pub at: String,
    /// The checked arguments, with only the schema's fields.
    pub result: Value,
}

/// A finished turn, as the app reads it: dropped in `inbox/` by the Stop
/// hook, and read back from `turn.json` for Continue.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeTurn {
    pub schema: u32,
    pub run_id: String,
    pub stage_key: String,
    pub stage_id: String,
    pub role_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lane: Option<String>,
    pub tab_id: String,
    pub turn: String,
    pub outcome: TurnOutcome,
    pub ended_at: String,
    #[serde(default)]
    pub last_assistant_message: String,
    /// The accepted `submit_result` arguments; `None` with `no_result`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    /// The bridge blocked one stop of this turn before it ended.
    #[serde(default)]
    pub blocked: bool,
}

impl BridgeTurn {
    pub fn new(info: &StageInfo, state: &TurnState, end: &TurnEnd, result: Option<Value>) -> Self {
        Self {
            schema: SCHEMA,
            run_id: info.run_id.clone(),
            stage_key: info.stage_key.clone(),
            stage_id: info.stage_id.clone(),
            role_id: info.role_id.clone(),
            lane: info.lane.clone(),
            tab_id: info.tab_id.clone(),
            turn: state.turn.clone(),
            outcome: end.outcome,
            ended_at: end.at.clone(),
            last_assistant_message: end.last_assistant_message.clone(),
            result,
            blocked: state.blocked,
        }
    }
}

/// What told the bridge a stage needs you (D22, V0 amendment).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NeedsSource {
    /// The PermissionRequest hook: the dialog is up now.
    PermissionRequest,
    /// The `permission_prompt` Notification, about 6 s late: the backup.
    PermissionPrompt,
}

/// A stage is waiting on a permission dialog: dropped in `inbox/` by the
/// PermissionRequest hook (or the Notification backup) for the app's
/// Needs you state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeNeeds {
    pub schema: u32,
    pub run_id: String,
    pub stage_key: String,
    pub stage_id: String,
    pub role_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lane: Option<String>,
    pub tab_id: String,
    /// Claude's `prompt_id` of the turn asking ("" when the payload had none).
    pub turn: String,
    pub source: NeedsSource,
    /// The tool the dialog asks about (PermissionRequest only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    /// The Notification's text (`Claude needs your permission`).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub message: String,
    pub at: String,
}

impl BridgeNeeds {
    pub fn new(info: &StageInfo, turn: &str, source: NeedsSource, tool: Option<String>, message: String) -> Self {
        Self {
            schema: SCHEMA,
            run_id: info.run_id.clone(),
            stage_key: info.stage_key.clone(),
            stage_id: info.stage_id.clone(),
            role_id: info.role_id.clone(),
            lane: info.lane.clone(),
            tab_id: info.tab_id.clone(),
            turn: turn.to_string(),
            source,
            tool,
            message,
            at: now(),
        }
    }
}

/// One task of the Planner's plan (plan "Result schemas"): one pull request,
/// or a manual step the Implementer leaves to you.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedTask {
    /// `pr1`, `pr2`, … (lower case).
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default)]
    pub manual: bool,
    pub summary: String,
    /// The repo (a name from Settings › Repos) the task's lane is made in
    /// (L1). Left out: the run's own folder, as before.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
}

/// `tasks.json`: the tasks of the Planner's latest plan. Fan-out reads it
/// directly instead of parsing a reply.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunTasks {
    pub schema: u32,
    pub run_id: String,
    pub stage_key: String,
    /// The Planner turn that handed the plan over.
    pub turn: String,
    pub at: String,
    pub tasks: Vec<PlannedTask>,
}

/// One repo of `repos.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRepo {
    pub name: String,
    pub folder: String,
}

/// `repos.json`: Settings › Repos as the app saw it at the latest launch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRepos {
    pub schema: u32,
    #[serde(default)]
    pub repos: Vec<RunRepo>,
}

/// `prs.json` (`prs-<lane>.json`): what an Implementer reported last.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunPrs {
    pub schema: u32,
    pub run_id: String,
    pub stage_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lane: Option<String>,
    pub turn: String,
    pub at: String,
    /// The checked `submit_result` arguments (`prs`, `summary`, `checks`).
    pub result: Value,
}

/// `needs.json`: the last Needs you a stage posted, so the late
/// Notification backup is not posted again for the same turn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NeedsMark {
    pub turn: String,
    pub source: NeedsSource,
    pub at: String,
}

/// The file an Implementer's pull requests go in: `prs.json`, or
/// `prs-<lane>.json` in a lane (lanes run at the same time).
pub fn prs_file_name(lane: Option<&str>) -> String {
    match lane.filter(|lane| id_chars(lane, 40, "")) {
        Some(lane) => format!("prs-{lane}.json"),
        None => "prs.json".to_string(),
    }
}

/// `findings-<stage>-r<N>.json`: a reviewer's round the run actor sent back
/// (V4). The stage it went back to is resumed with a prompt that points here.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunFindings {
    pub schema: u32,
    pub run_id: String,
    /// The reviewer's stage key (`pr_reviewer`, `pr_reviewer@pr1`).
    pub stage_key: String,
    /// The review round this was (`round N` in the prompt).
    pub round: u32,
    /// The reviewer turn that reported it.
    pub turn: String,
    pub at: String,
    /// `CHANGES_REQUIRED`, `APPROVED_WITH_CHANGES` or `APPROVED`.
    pub verdict: String,
    /// The reviewer's `findings[]`, as `submit_result` checked them.
    pub findings: Value,
}

/// The file a reviewer's round `round` goes in, when the key is valid.
pub fn findings_file_name(stage_key: &str, round: u32) -> Option<String> {
    valid_stage_key(stage_key).then(|| format!("findings-{stage_key}-r{round}.json"))
}

/// Write `findings` at the run's top; returns its path.
pub fn write_findings(run_dir: &Path, findings: &RunFindings) -> io::Result<PathBuf> {
    let name = findings_file_name(&findings.stage_key, findings.round)
        .ok_or_else(|| io::Error::other(format!("not a stage key: {:?}", findings.stage_key)))?;
    let path = run_dir.join(name);
    write_json(&path, findings)?;
    Ok(path)
}

/// Why a stage folder could not be used.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenError {
    /// The command line or the folder is wrong: nothing is written.
    Invalid(String),
    /// The stage belongs to another tab now (a newer round's): this tab's
    /// hooks are ignored.
    Stale,
}

/// One stage's folder, checked against the run id, stage key and tab the
/// bridge was started with.
#[derive(Debug, Clone)]
pub struct StageDir {
    run_dir: PathBuf,
    dir: PathBuf,
    pub info: StageInfo,
}

pub(crate) fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

impl StageDir {
    pub fn open(run_dir: &Path, run_id: &str, stage_key: &str, tab_id: &str) -> Result<Self, OpenError> {
        let invalid = |why: String| Err(OpenError::Invalid(why));
        if !valid_run_id(run_id) {
            return invalid(format!("not a run id: {run_id:?}"));
        }
        if !valid_stage_key(stage_key) {
            return invalid(format!("not a stage key: {stage_key:?}"));
        }
        if !valid_tab_id(tab_id) {
            return invalid(format!("not a tab id: {tab_id:?}"));
        }
        if run_dir.file_name().and_then(|name| name.to_str()) != Some(run_id) {
            return invalid(format!("{} is not the folder of run {run_id}", run_dir.display()));
        }
        match read_json::<RunMarker>(&run_dir.join(RUN_FILE)) {
            Some(marker) if marker.run_id == run_id => {}
            _ => return invalid(format!("{} has no run.json for run {run_id}", run_dir.display())),
        }
        let dir = run_dir.join(STAGES_DIR).join(stage_key);
        let Some(info) = read_json::<StageInfo>(&dir.join(STAGE_FILE)) else {
            return invalid(format!("run {run_id} has no stage {stage_key}"));
        };
        if info.run_id != run_id || info.stage_key != stage_key {
            return invalid(format!("stage.json of {stage_key} names another stage"));
        }
        if info.tab_id != tab_id {
            return Err(OpenError::Stale);
        }
        Ok(Self {
            run_dir: run_dir.to_path_buf(),
            dir,
            info,
        })
    }

    pub fn mode(&self) -> StageMode {
        read_mode(&self.dir)
    }

    pub fn turn(&self) -> Option<TurnState> {
        read_json(&self.dir.join(TURN_FILE))
    }

    pub fn write_turn(&self, state: &TurnState) -> io::Result<()> {
        write_json(&self.dir.join(TURN_FILE), state)
    }

    pub fn result(&self, turn: &str) -> Option<StoredResult> {
        read_result(&self.dir, turn)
    }

    pub fn write_result(&self, result: &StoredResult) -> io::Result<()> {
        let folder = self.dir.join(RESULTS_DIR);
        std::fs::create_dir_all(&folder)?;
        write_json(&folder.join(turn_file_name(&result.turn)), result)
    }

    /// Drop a finished turn in `inbox/` for the app's watcher.
    pub fn post(&self, turn: &BridgeTurn) -> io::Result<()> {
        let folder = self.run_dir.join(INBOX_DIR);
        std::fs::create_dir_all(&folder)?;
        let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%S%.6f");
        let name = format!("{stamp}-stop-{}", turn_file_name(&turn.turn));
        write_json(&folder.join(name), turn)
    }

    /// Drop a Needs you in `inbox/` for the app's watcher, and remember it.
    pub fn post_needs(&self, needs: &BridgeNeeds) -> io::Result<()> {
        let folder = self.run_dir.join(INBOX_DIR);
        std::fs::create_dir_all(&folder)?;
        let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%S%.6f");
        let name = format!("{stamp}-needs-{}", turn_file_name(&needs.turn));
        write_json(&folder.join(name), needs)?;
        let mark = NeedsMark {
            turn: needs.turn.clone(),
            source: needs.source,
            at: needs.at.clone(),
        };
        write_json(&self.dir.join(NEEDS_FILE), &mark)
    }

    /// The last Needs you this stage posted.
    pub fn needs_mark(&self) -> Option<NeedsMark> {
        read_json(&self.dir.join(NEEDS_FILE))
    }

    /// The Planner's hand-off: `plan.md` and `tasks.json` at the run's top.
    pub fn write_plan(&self, plan: &str, tasks: &RunTasks) -> io::Result<()> {
        write_atomic(&self.run_dir.join(PLAN_FILE), plan.as_bytes())?;
        write_json(&self.run_dir.join(TASKS_FILE), tasks)
    }

    /// The repo names the Planner's tasks may use (`repos.json`); none when
    /// the app wrote no file (a run folder from before L1).
    pub fn repo_names(&self) -> Vec<String> {
        read_repos(&self.run_dir).into_iter().map(|repo| repo.name).collect()
    }

    /// An Implementer's pull requests at the run's top.
    pub fn write_prs(&self, prs: &RunPrs) -> io::Result<()> {
        write_json(&self.run_dir.join(prs_file_name(prs.lane.as_deref())), prs)
    }

    /// Keep the newest raw payload of each hook event, so a changed payload
    /// can be looked at after the fact (D24).
    pub fn keep_payload(&self, event: &str, payload: &Value) {
        if !id_chars(event, 40, "") {
            return;
        }
        let folder = self.dir.join(PAYLOADS_DIR);
        let kept = std::fs::create_dir_all(&folder)
            .and_then(|_| write_json(&folder.join(format!("{event}.json")), payload));
        if let Err(err) = kept {
            self.log(&format!("could not keep the {event} payload: {err}"));
        }
    }

    /// One line in the run's `bridge.log`, which stops growing at its cap.
    pub fn log(&self, line: &str) {
        log_line(&self.run_dir, &format!("{} {line}", self.info.stage_key));
    }
}

/// Append a line to `<run_dir>/bridge.log`, best effort.
pub(crate) fn log_line(run_dir: &Path, line: &str) {
    use std::io::Write;
    let path = run_dir.join(LOG_FILE);
    if std::fs::metadata(&path).is_ok_and(|meta| meta.len() > MAX_LOG_BYTES) {
        return;
    }
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "{} {line}", now());
    }
}

pub(crate) fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub(crate) fn write_json<T: Serialize>(path: &Path, value: &T) -> io::Result<()> {
    let mut bytes = serde_json::to_vec_pretty(value).map_err(io::Error::other)?;
    bytes.push(b'\n');
    write_atomic(path, &bytes)
}

/// Write through a temp file in the same folder, then rename over `path`.
/// The temp name starts with `.` and ends `.tmp`, so the inbox watcher never
/// reads a half-written event, and carries the pid and time, so two bridge
/// processes never share one.
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| io::Error::other("path has no file name"))?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = path.with_file_name(format!(".{name}.{}.{nanos}.tmp", std::process::id()));
    std::fs::write(&tmp, bytes)?;
    #[cfg(windows)]
    if path.exists() {
        let _ = std::fs::remove_file(path);
    }
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

/// The app's side of a stage folder: what it writes at launch.
pub(crate) fn write_stage(run_dir: &Path, info: &StageInfo, mode: StageMode) -> io::Result<PathBuf> {
    let marker = RunMarker {
        schema: SCHEMA,
        run_id: info.run_id.clone(),
    };
    std::fs::create_dir_all(run_dir.join(INBOX_DIR))?;
    if read_json::<RunMarker>(&run_dir.join(RUN_FILE)).as_ref() != Some(&marker) {
        write_json(&run_dir.join(RUN_FILE), &marker)?;
    }
    let dir = run_dir.join(STAGES_DIR).join(&info.stage_key);
    std::fs::create_dir_all(dir.join(RESULTS_DIR))?;
    write_json(&dir.join(STAGE_FILE), info)?;
    write_atomic(&dir.join(MODE_FILE), mode.as_str().as_bytes())?;
    // A new tab starts with no turn: an older tab's ended turn is not its result.
    match std::fs::remove_file(dir.join(TURN_FILE)) {
        Err(err) if err.kind() != io::ErrorKind::NotFound => return Err(err),
        _ => {}
    }
    Ok(dir)
}

/// Forget the stage's last turn (`turn.json`); a missing one is fine.
pub(crate) fn clear_turn(stage_dir: &Path) -> io::Result<()> {
    match std::fs::remove_file(stage_dir.join(TURN_FILE)) {
        Err(err) if err.kind() != io::ErrorKind::NotFound => Err(err),
        _ => Ok(()),
    }
}

/// Every stage folder of a run.
pub(crate) fn stage_dirs(run_dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(run_dir.join(STAGES_DIR)) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.join(STAGE_FILE).is_file())
        .collect()
}

pub(crate) fn write_mode(stage_dir: &Path, mode: StageMode) -> io::Result<()> {
    write_atomic(&stage_dir.join(MODE_FILE), mode.as_str().as_bytes())
}

pub(crate) fn read_mode(stage_dir: &Path) -> StageMode {
    std::fs::read_to_string(stage_dir.join(MODE_FILE))
        .map(|text| StageMode::parse(&text))
        .unwrap_or(StageMode::Manual)
}

/// The run folder's path for `run_id` under `runs_root`, when the id is valid.
pub fn run_dir(runs_root: &Path, run_id: &str) -> Option<PathBuf> {
    valid_run_id(run_id).then(|| runs_root.join(run_id))
}

pub(crate) fn stage_dir_path(run_dir: &Path, stage_key: &str) -> Option<PathBuf> {
    valid_stage_key(stage_key).then(|| run_dir.join(STAGES_DIR).join(stage_key))
}

pub(crate) fn read_stage(stage_dir: &Path) -> Option<(StageInfo, Option<TurnState>)> {
    let info = read_json::<StageInfo>(&stage_dir.join(STAGE_FILE))?;
    Some((info, read_json(&stage_dir.join(TURN_FILE))))
}

/// The app's side of `repos.json`: Settings › Repos now.
pub(crate) fn write_repos(run_dir: &Path, repos: &[RunRepo]) -> io::Result<()> {
    std::fs::create_dir_all(run_dir)?;
    let file = RunRepos {
        schema: SCHEMA,
        repos: repos.to_vec(),
    };
    if read_json::<RunRepos>(&run_dir.join(REPOS_FILE)).as_ref() == Some(&file) {
        return Ok(());
    }
    write_json(&run_dir.join(REPOS_FILE), &file)
}

/// The run's `repos.json`; none when it has no such file.
pub(crate) fn read_repos(run_dir: &Path) -> Vec<RunRepo> {
    read_json::<RunRepos>(&run_dir.join(REPOS_FILE)).map(|file| file.repos).unwrap_or_default()
}

/// The run's `tasks.json`, when its Planner handed a plan over.
pub(crate) fn read_tasks(run_dir: &Path) -> Option<RunTasks> {
    read_json(&run_dir.join(TASKS_FILE))
}

pub(crate) fn read_result(stage_dir: &Path, turn: &str) -> Option<StoredResult> {
    read_json(&stage_dir.join(RESULTS_DIR).join(turn_file_name(turn)))
}
