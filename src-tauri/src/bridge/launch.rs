//! The app's side of a bridged stage: which stage tabs launch with the
//! bridge, the run folder files written before the launch, and the three
//! command-line additions for `claude` (ADR-015 §1):
//!
//! `--allowedTools mcp__dcterminal__submit_result --mcp-config <json> --settings <json>`
//!
//! `--settings` is the launch's one settings value: the bridge's hooks
//! merged with H5's usage status line when that applies (Claude Code reads
//! only the last `--settings`). `--allowedTools` and `--mcp-config` take
//! several values, so they come right before `--settings` (one value), and
//! the startup prompt stays last. Hooks
//! and the MCP server are this executable run as `dcterminal bridge`, given
//! as an `args` array so nothing is shell-quoted (D38). A Planner stage gets
//! `--settings` only: it reports through ExitPlanMode (D11), so it has no
//! tool to allow or serve.
//!
//! Bridged stages of an engine-2 run: a reviewer (a stage whose kind is
//! `reviewer`, H4's `StageKind`, with no parallel reviewers, V2a), the
//! Planner and the Implementer (V2b), each by its stage kind. A pipeline
//! with any other stage (parallel reviewers, a generic stage) gives its runs
//! engine 1 ([`engine_for`]), so the run actor (V3) only ever drives runs it
//! can follow end to end. An engine-1 run is manual only (V6).

use super::folder::{
    self, read_mode, read_result, read_stage, stage_dirs, write_mode, BridgeTurn, ResultKind, StageInfo,
    StageMode, TurnOutcome, SCHEMA,
};
use super::schema::{FULL_TOOL_NAME, SERVER_NAME};
use crate::pipelines::autopilot::stage_key;
use crate::pipelines::{PipelineDef, StageKind};
use crate::store::{ChainRef, PipelineRun};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// The engine new runs get (D19). Runs saved before it read as 1.
pub const ENGINE_V2: u32 = 2;

/// The engine a new run of `def` gets: 2 when every stage reports through
/// the bridge, so the run actor can follow the whole run (V3); else 1, and
/// the run is manual only (V6): a stage with parallel reviewers, or a role
/// that is none of Planner, reviewer and Implementer.
pub fn engine_for(def: &PipelineDef) -> u32 {
    if def.stages.iter().all(|stage| stage_kind(stage).is_some()) {
        ENGINE_V2
    } else {
        1
    }
}

/// A bridged stage, decided before its tab starts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BridgePlan {
    pub run_id: String,
    pub stage_id: String,
    pub role_id: String,
    pub lane: Option<String>,
    pub stage_key: String,
    pub kind: ResultKind,
    /// Autopilot is on for the run, so the bridge enforces a result.
    pub autopilot: bool,
}

/// On a tab: the bridged stage it holds (`runs/<runId>/stages/<stage>`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeTag {
    pub run_id: String,
    pub stage: String,
}

/// Whether `role_id` starting at `chain`'s step of `run` launches bridged.
pub fn plan_for(run: &PipelineRun, def: &PipelineDef, chain: &ChainRef, role_id: &str) -> Option<BridgePlan> {
    if run.engine < ENGINE_V2 {
        return None;
    }
    let lane = chain.lane.clone().filter(|id| run.lane(id).is_some());
    let autopilot = run.autopilot.as_ref().is_some_and(|a| a.enabled);
    stage_plan(&run.id, def, chain, role_id, lane, autopilot)
}

/// The chain a launch starts (Eagle mode's first stage), before its run
/// exists: the app makes the run (engine 2, autopilot off) just before the
/// spawn, so the first stage launches bridged like the later ones.
pub fn new_chain(def: &PipelineDef, chain_kind: &str, now_ms: i64) -> ChainRef {
    ChainRef {
        chain_id: format!("ee_{now_ms}"),
        kind: chain_kind.to_string(),
        step: 1,
        total: def.stages.len() as u32,
        round: 1,
        lane: None,
    }
}

/// [`plan_for`] for the first stage of a run [`new_chain`] starts, when
/// that run will be engine 2 ([`engine_for`]).
pub fn plan_for_new_run(def: &PipelineDef, chain: &ChainRef, role_id: &str) -> Option<BridgePlan> {
    if engine_for(def) < ENGINE_V2 {
        return None;
    }
    stage_plan(&chain.chain_id, def, chain, role_id, None, false)
}

fn stage_plan(
    run_id: &str,
    def: &PipelineDef,
    chain: &ChainRef,
    role_id: &str,
    lane: Option<String>,
    autopilot: bool,
) -> Option<BridgePlan> {
    if !folder::valid_run_id(run_id) {
        return None;
    }
    let stage = def.stages.get((chain.step as usize).checked_sub(1)?)?;
    if stage.role_id != role_id {
        return None;
    }
    let kind = stage_kind(stage)?;
    let key = stage_key(&stage.id, lane.as_deref());
    folder::valid_stage_key(&key).then(|| BridgePlan {
        run_id: run_id.to_string(),
        stage_id: stage.id.clone(),
        role_id: stage.role_id.clone(),
        lane,
        stage_key: key,
        kind,
        autopilot,
    })
}

/// The result a stage reports with, when it launches bridged: by its kind
/// (H4's `StageKind`), so a copied Planner, Implementer or reviewer role is
/// bridged exactly like the built-in one. A reviewer stage with parallel
/// reviewers and a generic stage keep the v1 path.
fn stage_kind(stage: &crate::pipelines::StageDef) -> Option<ResultKind> {
    match stage.kind() {
        StageKind::Planner => Some(ResultKind::Planner),
        StageKind::Implementer => Some(ResultKind::Implementer),
        StageKind::Reviewer => stage.also_reviewers.is_empty().then_some(ResultKind::Reviewer),
        StageKind::Generic => None,
    }
}

/// `<app data>/runs`.
pub fn runs_root(data_dir: &Path) -> PathBuf {
    data_dir.join(folder::RUNS_DIR)
}

fn mode_for(autopilot: bool) -> StageMode {
    if autopilot {
        StageMode::Autopilot
    } else {
        StageMode::Manual
    }
}

/// Write the stage's folder for `tab_id` (the tab that now owns it) before
/// the launch. Returns the run folder.
pub fn prepare_stage(runs_root: &Path, plan: &BridgePlan, tab_id: &str) -> Result<PathBuf, String> {
    if !folder::valid_tab_id(tab_id) {
        return Err(format!("not a tab id: {tab_id:?}"));
    }
    let run_dir = folder::run_dir(runs_root, &plan.run_id).ok_or_else(|| format!("not a run id: {}", plan.run_id))?;
    let info = StageInfo {
        schema: SCHEMA,
        run_id: plan.run_id.clone(),
        stage_key: plan.stage_key.clone(),
        stage_id: plan.stage_id.clone(),
        role_id: plan.role_id.clone(),
        lane: plan.lane.clone(),
        tab_id: tab_id.to_string(),
        result: plan.kind,
    };
    folder::write_stage(&run_dir, &info, mode_for(plan.autopilot))
        .map_err(|err| format!("could not prepare the run folder {}: {err}", run_dir.display()))?;
    Ok(run_dir)
}

/// Write Settings › Repos into the run folder (`repos.json`, L1) as a
/// stage launches, after [`prepare_stage`]: the bridge checks a Planner
/// task's `repo` against these names, and it only sees the run folder.
/// Written at every bridged launch, so a re-plan sees the list as it is now.
pub fn write_run_repos(run_dir: &Path, repos: &[crate::store::RepoEntry]) -> Result<(), String> {
    let repos: Vec<folder::RunRepo> = repos
        .iter()
        .map(|repo| folder::RunRepo {
            name: repo.name.clone(),
            folder: repo.folder.clone(),
        })
        .collect();
    folder::write_repos(run_dir, &repos).map_err(|err| format!("could not write {}: {err}", run_dir.join(folder::REPOS_FILE).display()))
}

fn bridge_args(mode: &str, run_dir: &Path, run_id: &str, stage_key: &str, tab_id: &str) -> Vec<String> {
    [
        "bridge",
        mode,
        "--run-dir",
        &run_dir.display().to_string(),
        "--run",
        run_id,
        "--stage",
        stage_key,
        "--tab",
        tab_id,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

fn hook(program: &Path, run_dir: &Path, run_id: &str, stage_key: &str, tab_id: &str, event: &str) -> Value {
    let mut args = bridge_args("hook", run_dir, run_id, stage_key, tab_id);
    args.extend(["--event".to_string(), event.to_string()]);
    json!({ "type": "command", "command": program.display().to_string(), "args": args })
}

/// The inline `--settings`: UserPromptSubmit and Stop for every turn;
/// PreToolUse answering `allow` for `submit_result` (D12), or on a Planner
/// taking its plan from ExitPlanMode (D11); PermissionRequest and
/// Notification for Needs you (D22).
pub fn hook_settings(
    kind: ResultKind,
    program: &Path,
    run_dir: &Path,
    run_id: &str,
    stage_key: &str,
    tab_id: &str,
) -> Value {
    let on = |event: &str| hook(program, run_dir, run_id, stage_key, tab_id, event);
    let pre_tool = match kind {
        ResultKind::Planner => "ExitPlanMode",
        ResultKind::Reviewer | ResultKind::Implementer => FULL_TOOL_NAME,
    };
    json!({
        "hooks": {
            "UserPromptSubmit": [{ "hooks": [on("UserPromptSubmit")] }],
            "Stop": [{ "hooks": [on("Stop")] }],
            "PreToolUse": [{ "matcher": pre_tool, "hooks": [on("PreToolUse")] }],
            "PermissionRequest": [{ "hooks": [on("PermissionRequest")] }],
            "Notification": [{ "hooks": [on("Notification")] }],
        }
    })
}

/// The inline `--mcp-config` with the one stdio server.
pub fn mcp_config(program: &Path, run_dir: &Path, run_id: &str, stage_key: &str, tab_id: &str) -> Value {
    json!({
        "mcpServers": {
            SERVER_NAME: {
                "type": "stdio",
                "command": program.display().to_string(),
                "args": bridge_args("mcp", run_dir, run_id, stage_key, tab_id),
            }
        }
    })
}

/// What a bridged stage adds to its `claude`: `--allowedTools` and
/// `--mcp-config` (`args`, empty for a Planner, which reports through
/// ExitPlanMode), and the hooks, which go into the launch's one
/// `--settings` value next to H5's status line (`merge_settings`).
#[derive(Debug, Clone, PartialEq)]
pub struct BridgeFlags {
    pub args: Vec<String>,
    pub hooks: Value,
}

/// The bridge's flags for one stage tab.
pub fn launch_flags(
    kind: ResultKind,
    program: &Path,
    run_dir: &Path,
    run_id: &str,
    stage_key: &str,
    tab_id: &str,
) -> BridgeFlags {
    BridgeFlags {
        args: if kind == ResultKind::Planner {
            Vec::new()
        } else {
            vec![
            "--allowedTools".to_string(),
            FULL_TOOL_NAME.to_string(),
            "--mcp-config".to_string(),
            mcp_config(program, run_dir, run_id, stage_key, tab_id).to_string(),
            ]
        },
        hooks: hook_settings(kind, program, run_dir, run_id, stage_key, tab_id),
    }
}

/// A bridged tab relaunching (Restart, resume): the same flags, while the
/// tab still owns its stage. `None` when it does not, or the folder is gone.
pub fn relaunch_flags(runs_root: &Path, tag: &BridgeTag, tab_id: &str, program: &Path) -> Option<BridgeFlags> {
    let run_dir = folder::run_dir(runs_root, &tag.run_id)?;
    let dir = folder::stage_dir_path(&run_dir, &tag.stage)?;
    let (info, _) = read_stage(&dir)?;
    (info.run_id == tag.run_id && info.tab_id == tab_id)
        .then(|| launch_flags(info.result, program, &run_dir, &tag.run_id, &tag.stage, tab_id))
}

/// A stage about to be resumed (V4): its last turn was handed on, so it
/// reads as working (not idle, and an exit before its next turn ends is
/// news) until the resumed session's first prompt writes a new turn. Does
/// nothing when `tab_id` no longer owns the stage. Returns what was cleared,
/// for [`restore_stage_turn`] when the resume then fails.
pub fn clear_stage_turn(runs_root: &Path, tag: &BridgeTag, tab_id: &str) -> Result<Option<Vec<u8>>, String> {
    let Some(dir) = owned_stage_dir(runs_root, tag, tab_id) else {
        return Ok(None);
    };
    let saved = std::fs::read(dir.join(folder::TURN_FILE)).ok();
    folder::clear_turn(&dir).map_err(|err| format!("{}: {err}", dir.display()))?;
    Ok(saved)
}

/// A resume failed: put back the turn [`clear_stage_turn`] cleared, unless
/// the stage wrote a newer one meanwhile or `tab_id` no longer owns it.
pub fn restore_stage_turn(runs_root: &Path, tag: &BridgeTag, tab_id: &str, saved: &[u8]) -> Result<(), String> {
    let Some(dir) = owned_stage_dir(runs_root, tag, tab_id) else {
        return Ok(());
    };
    let file = dir.join(folder::TURN_FILE);
    if file.exists() {
        return Ok(());
    }
    folder::write_atomic(&file, saved).map_err(|err| format!("{}: {err}", file.display()))
}

/// `tag`'s stage folder, while `tab_id` holds that stage.
fn owned_stage_dir(runs_root: &Path, tag: &BridgeTag, tab_id: &str) -> Option<PathBuf> {
    let dir = folder::run_dir(runs_root, &tag.run_id).and_then(|run| folder::stage_dir_path(&run, &tag.stage))?;
    match read_stage(&dir) {
        Some((info, _)) if info.run_id == tag.run_id && info.tab_id == tab_id => Some(dir),
        _ => None,
    }
}

/// The run's `tasks.json`: the tasks of its Planner's latest plan, which
/// fan-out reads directly. `None` before a bridged Planner handed one over.
pub fn read_run_tasks(runs_root: &Path, run_id: &str) -> Option<folder::RunTasks> {
    let run_dir = folder::run_dir(runs_root, run_id)?;
    folder::read_tasks(&run_dir).filter(|tasks| tasks.run_id == run_id)
}

/// One `--settings` value: the launch's own (H5's status line, when it
/// applies) with the bridge's `hooks` added. Claude Code reads only the
/// last `--settings`, so two flags would lose one of them.
pub fn merge_settings(own: Option<Value>, hooks: &Value) -> Value {
    let mut merged = match own {
        Some(Value::Object(map)) => map,
        _ => serde_json::Map::new(),
    };
    if let Some(hooks) = hooks.get("hooks") {
        merged.insert("hooks".to_string(), hooks.clone());
    }
    Value::Object(merged)
}

/// The command for a launch, bridged when `flags` is set: the hooks join
/// `request.settings` (one `--settings`), and `--allowedTools` /
/// `--mcp-config`, which take several values, go right before `--settings`
/// so the startup prompt stays positional and last. `build` is the
/// provider's `terminal_command`.
pub fn bridged_command(
    mut request: crate::provider::TerminalLaunch,
    flags: Option<BridgeFlags>,
    build: impl FnOnce(&crate::provider::TerminalLaunch) -> Result<crate::provider::ProgramArgs, String>,
) -> Result<crate::provider::ProgramArgs, String> {
    let Some(flags) = flags else {
        return build(&request);
    };
    request.settings = Some(merge_settings(request.settings.take(), &flags.hooks));
    let mut command = build(&request)?;
    let at = command
        .args
        .iter()
        .position(|arg| arg == "--settings")
        .ok_or_else(|| "the bridged launch lost its --settings flag".to_string())?;
    command.args.splice(at..at, flags.args);
    Ok(command)
}

/// The executable hooks and the MCP server run: this one (D38).
pub fn bridge_program() -> Option<PathBuf> {
    std::env::current_exe().ok()
}

/// Autopilot was turned on or off: every stage of the run enforces (or
/// stops enforcing) from its next stop. A taken-over stage is left alone.
pub fn set_run_mode(runs_root: &Path, run_id: &str, autopilot: bool) -> Result<(), String> {
    set_run_mode_to(runs_root, run_id, mode_for(autopilot))
}

/// [`set_run_mode`] with the mode given (the run actor stopping writes `manual`).
pub fn set_run_mode_to(runs_root: &Path, run_id: &str, mode: StageMode) -> Result<(), String> {
    let Some(run_dir) = folder::run_dir(runs_root, run_id) else {
        return Ok(());
    };
    for dir in stage_dirs(&run_dir) {
        if read_mode(&dir) == StageMode::Takeover {
            continue;
        }
        write_mode(&dir, mode).map_err(|err| format!("{}: {err}", dir.display()))?;
    }
    Ok(())
}

/// The run went to engine 1 mid-run and is manual for good (V2a's
/// `make_manual`): every stage folder says `manual`, a stage you took over
/// too (V5), since nothing is taken over on a manual run.
pub fn set_run_manual_for_good(runs_root: &Path, run_id: &str) -> Result<(), String> {
    let Some(run_dir) = folder::run_dir(runs_root, run_id) else {
        return Ok(());
    };
    for dir in stage_dirs(&run_dir) {
        write_mode(&dir, StageMode::Manual).map_err(|err| format!("{}: {err}", dir.display()))?;
    }
    Ok(())
}

/// A bridged tab's stage folder (`runs/<run>/stages/<stage>`), when the ids are valid.
pub fn stage_dir_of(runs_root: &Path, tag: &BridgeTag) -> Option<PathBuf> {
    let run_dir = folder::run_dir(runs_root, &tag.run_id)?;
    folder::stage_dir_path(&run_dir, &tag.stage)
}

/// You took a stage over, or handed it back (V5, D28): its `mode` file,
/// which the bridge reads at each stop and the terminal at each keystroke.
/// False (nothing written) when `tab_id` no longer owns the stage.
pub fn set_stage_mode(runs_root: &Path, tag: &BridgeTag, tab_id: &str, mode: StageMode) -> Result<bool, String> {
    let Some(dir) = stage_dir_of(runs_root, tag) else {
        return Ok(false);
    };
    match read_stage(&dir) {
        Some((info, _)) if info.run_id == tag.run_id && info.tab_id == tab_id => {
            write_mode(&dir, mode).map_err(|err| format!("{}: {err}", dir.display()))?;
            Ok(true)
        }
        _ => Ok(false),
    }
}

/// The stage's latest finished turn, read back from `turn.json` (Continue
/// after a restart). `None` while a turn runs, before the first one, after
/// an abandoned one, or when `tab_id` no longer owns the stage.
pub fn read_stage_turn(runs_root: &Path, tag: &BridgeTag, tab_id: &str) -> Option<BridgeTurn> {
    let run_dir = folder::run_dir(runs_root, &tag.run_id)?;
    let dir = folder::stage_dir_path(&run_dir, &tag.stage)?;
    let (info, turn) = read_stage(&dir)?;
    if info.run_id != tag.run_id || info.tab_id != tab_id {
        return None;
    }
    let turn = turn?;
    // An abandoned turn (D9a) is never read back: autopilot never acts on it.
    let end = turn.ended.clone().filter(|end| end.outcome != TurnOutcome::Abandoned)?;
    let result = read_result(&dir, &turn.turn).map(|stored| stored.result);
    Some(BridgeTurn::new(&info, &turn, &end, result))
}

/// The stage's latest turn id, open or ended, from `turn.json` (restart
/// recovery keys a bridged tab's decided turn on it). `None` before the
/// first turn, or when `tab_id` no longer owns the stage.
pub fn stage_turn_id(runs_root: &Path, tag: &BridgeTag, tab_id: &str) -> Option<String> {
    let run_dir = folder::run_dir(runs_root, &tag.run_id)?;
    let dir = folder::stage_dir_path(&run_dir, &tag.stage)?;
    let (info, turn) = read_stage(&dir)?;
    (info.run_id == tag.run_id && info.tab_id == tab_id).then_some(turn?.turn)
}
