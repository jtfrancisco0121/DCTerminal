//! The app's side of a bridged stage: which stage tabs launch with the
//! bridge, the run folder files written before the launch, and the three
//! command-line additions for `claude` (ADR-015 §1):
//!
//! `--allowedTools mcp__dcterminal__submit_result --mcp-config <json> --settings <json>`
//!
//! `--allowedTools` and `--mcp-config` take several values, so they come
//! before `--settings` (one value), and the startup prompt stays last. Hooks
//! and the MCP server are this executable run as `dcterminal bridge`, given
//! as an `args` array so nothing is shell-quoted (D38).
//!
//! V2a bridges reviewer stages only: the stage of an engine-2 run that has a
//! loop-back and no parallel reviewers. Planner and Implementer stages keep
//! the v1 path until V2b, and so does a stage with parallel reviewers, whose
//! merge stays in the frontend until the run actor (V3).

use super::folder::{
    self, read_mode, read_result, read_stage, stage_dirs, write_mode, BridgeTurn, ResultKind, StageInfo,
    StageMode, SCHEMA,
};
use super::schema::{FULL_TOOL_NAME, SERVER_NAME};
use crate::pipelines::autopilot::stage_key;
use crate::pipelines::PipelineDef;
use crate::store::{ChainRef, PipelineRun};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// The engine new runs get (D19). Runs saved before it read as 1.
pub const ENGINE_V2: u32 = 2;

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
    if run.engine < ENGINE_V2 || !folder::valid_run_id(&run.id) {
        return None;
    }
    let stage = def.stages.get((chain.step as usize).checked_sub(1)?)?;
    if stage.role_id != role_id || stage.loop_back.is_none() || !stage.also_reviewers.is_empty() {
        return None;
    }
    let lane = chain.lane.clone().filter(|id| run.lane(id).is_some());
    let key = stage_key(&stage.id, lane.as_deref());
    folder::valid_stage_key(&key).then(|| BridgePlan {
        run_id: run.id.clone(),
        stage_id: stage.id.clone(),
        role_id: stage.role_id.clone(),
        lane,
        stage_key: key,
        kind: ResultKind::Reviewer,
        autopilot: run.autopilot.as_ref().is_some_and(|a| a.enabled),
    })
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

/// The inline `--settings`: UserPromptSubmit and Stop for every turn, and
/// PreToolUse answering `allow` for `submit_result` (D12).
pub fn hook_settings(program: &Path, run_dir: &Path, run_id: &str, stage_key: &str, tab_id: &str) -> Value {
    let on = |event: &str| hook(program, run_dir, run_id, stage_key, tab_id, event);
    json!({
        "hooks": {
            "UserPromptSubmit": [{ "hooks": [on("UserPromptSubmit")] }],
            "Stop": [{ "hooks": [on("Stop")] }],
            "PreToolUse": [{ "matcher": FULL_TOOL_NAME, "hooks": [on("PreToolUse")] }],
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

/// The flags added to a bridged stage's `claude`, in an order that keeps
/// the startup prompt positional (see the module header).
pub fn launch_args(program: &Path, run_dir: &Path, run_id: &str, stage_key: &str, tab_id: &str) -> Vec<String> {
    vec![
        "--allowedTools".to_string(),
        FULL_TOOL_NAME.to_string(),
        "--mcp-config".to_string(),
        mcp_config(program, run_dir, run_id, stage_key, tab_id).to_string(),
        "--settings".to_string(),
        hook_settings(program, run_dir, run_id, stage_key, tab_id).to_string(),
    ]
}

/// A bridged tab relaunching (Restart, resume): the same flags, while the
/// tab still owns its stage. `None` when it does not, or the folder is gone.
pub fn relaunch_args(runs_root: &Path, tag: &BridgeTag, tab_id: &str, program: &Path) -> Option<Vec<String>> {
    let run_dir = folder::run_dir(runs_root, &tag.run_id)?;
    let dir = folder::stage_dir_path(&run_dir, &tag.stage)?;
    let (info, _) = read_stage(&dir)?;
    (info.run_id == tag.run_id && info.tab_id == tab_id)
        .then(|| launch_args(program, &run_dir, &tag.run_id, &tag.stage, tab_id))
}

/// Put `extra` before the trailing startup prompt (when there is one).
pub fn insert_before_prompt(args: &mut Vec<String>, has_prompt: bool, extra: Vec<String>) {
    let at = if has_prompt { args.len().saturating_sub(1) } else { args.len() };
    args.splice(at..at, extra);
}

/// The executable hooks and the MCP server run: this one (D38).
pub fn bridge_program() -> Option<PathBuf> {
    std::env::current_exe().ok()
}

/// Autopilot was turned on or off: every stage of the run enforces (or
/// stops enforcing) from its next stop. A taken-over stage is left alone.
pub fn set_run_mode(runs_root: &Path, run_id: &str, autopilot: bool) -> Result<(), String> {
    let Some(run_dir) = folder::run_dir(runs_root, run_id) else {
        return Ok(());
    };
    for dir in stage_dirs(&run_dir) {
        if read_mode(&dir) == StageMode::Takeover {
            continue;
        }
        write_mode(&dir, mode_for(autopilot)).map_err(|err| format!("{}: {err}", dir.display()))?;
    }
    Ok(())
}

/// The stage's latest finished turn, read back from `turn.json` (Continue
/// after a restart). `None` while a turn runs, before the first one, or
/// when `tab_id` no longer owns the stage.
pub fn read_stage_turn(runs_root: &Path, tag: &BridgeTag, tab_id: &str) -> Option<BridgeTurn> {
    let run_dir = folder::run_dir(runs_root, &tag.run_id)?;
    let dir = folder::stage_dir_path(&run_dir, &tag.stage)?;
    let (info, turn) = read_stage(&dir)?;
    if info.run_id != tag.run_id || info.tab_id != tab_id {
        return None;
    }
    let turn = turn?;
    let end = turn.ended.clone()?;
    let result = read_result(&dir, &turn.turn).map(|stored| stored.result);
    Some(BridgeTurn::new(&info, &turn, &end, result))
}
