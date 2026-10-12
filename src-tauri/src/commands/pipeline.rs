use crate::commands::chain_events::ChainEvents;
use crate::store::{PipelineRun, StateStore};
use serde::Serialize;
use std::sync::Mutex;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineRunView {
    pub run: PipelineRun,
    /// Step-1 form task type, for stages whose source form has none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_type: Option<String>,
}

#[tauri::command]
pub fn get_pipeline_run(
    run_id: String,
    store: State<Mutex<StateStore>>,
) -> Result<PipelineRunView, String> {
    let store = store.lock().map_err(|e| e.to_string())?;
    let mut run = store
        .pipeline_run_by_id(run_id.trim())
        .cloned()
        .ok_or_else(|| format!("unknown pipeline run: {run_id}"))?;
    // A chain's Planner form may have been filled after the run was made.
    if run.original_request.is_none() {
        run.original_request = store.chain_original_request(&run.id);
    }
    let task_type = store.chain_task_type(&run.id);
    Ok(PipelineRunView { run, task_type })
}

#[tauri::command]
pub fn pipeline_promote_plan(
    app: tauri::AppHandle,
    run_id: String,
    approved_plan: String,
    store: State<Mutex<StateStore>>,
) -> Result<(), String> {
    let mut store = store.lock().map_err(|e| e.to_string())?;
    store.pipeline_promote_plan(run_id.trim(), &approved_plan)?;
    app.chain_run_updated(run_id.trim());
    Ok(())
}

#[tauri::command]
pub fn pipeline_set_candidate_plan(
    app: tauri::AppHandle,
    run_id: String,
    candidate_plan: String,
    store: State<Mutex<StateStore>>,
) -> Result<(), String> {
    let mut store = store.lock().map_err(|e| e.to_string())?;
    store.pipeline_set_candidate_plan(run_id.trim(), &candidate_plan)?;
    app.chain_run_updated(run_id.trim());
    Ok(())
}

// ---- Pipeline definitions, gates and autopilot (ADR-014) ----

use crate::pipelines::autopilot::{decide, Decision, TurnReport};
use crate::pipelines::{GateDef, GateResult, PipelineDef};
use crate::store::{PipelineStore, RunAutopilot, StageGates};
use std::path::PathBuf;
use std::time::Duration;

/// Built-in pipelines, then the user's own.
#[tauri::command]
pub fn pipeline_defs_list() -> Vec<PipelineDef> {
    crate::pipelines::all()
}

/// Replace the user's pipelines (Settings › Pipelines). Returns every pipeline.
#[tauri::command]
pub fn pipeline_defs_save(
    pipelines: Vec<PipelineDef>,
    store: State<Mutex<PipelineStore>>,
) -> Result<Vec<PipelineDef>, String> {
    let mut store = store.lock().map_err(|e| e.to_string())?;
    store.save(pipelines)?;
    Ok(crate::pipelines::all())
}

/// The gates a stage of `run_id` runs, its folder, and the run's round.
fn stage_gates(
    store: &StateStore,
    run_id: &str,
    stage_id: &str,
    cwd: Option<&str>,
) -> Result<(Vec<GateDef>, PathBuf, u32), String> {
    let run = store
        .pipeline_run_by_id(run_id)
        .ok_or_else(|| format!("unknown pipeline run: {run_id}"))?;
    let def = crate::pipelines::find(&run.kind)
        .ok_or_else(|| format!("unknown pipeline: {}", run.kind))?;
    let stage = def
        .stage(stage_id)
        .ok_or_else(|| format!("{} has no stage \"{stage_id}\"", def.name))?;
    let folder = cwd
        .map(str::trim)
        .filter(|cwd| !cwd.is_empty())
        .unwrap_or(&run.cwd);
    Ok((stage.gates.clone(), PathBuf::from(folder), run.round.max(1)))
}

/// Run a stage's gates now (Run checks, or autopilot after the stage's
/// turn) and keep the results on the run. `cwd` is the stage tab's folder
/// (a worktree), else the run's. `pr_urls` are the pull requests the stage
/// reported. No store lock is held while the commands run.
#[tauri::command(async)]
pub fn pipeline_run_gates(
    app: tauri::AppHandle,
    run_id: String,
    stage_id: String,
    cwd: Option<String>,
    pr_urls: Vec<String>,
    store: State<Mutex<StateStore>>,
) -> Result<Vec<GateResult>, String> {
    let run_id = run_id.trim().to_string();
    let (gates, folder, round) = {
        let store = store.lock().map_err(|e| e.to_string())?;
        stage_gates(&store, &run_id, &stage_id, cwd.as_deref())?
    };
    let results: Vec<GateResult> = gates
        .iter()
        .map(|gate| match gate {
            GateDef::Command { run, timeout_secs } => crate::pipelines::run_command_gate(
                &folder,
                run,
                timeout_secs.map(Duration::from_secs),
            ),
            GateDef::PullRequest => crate::pipelines::run_pull_request_gate(&folder, &pr_urls),
        })
        .collect();
    let mut store = store.lock().map_err(|e| e.to_string())?;
    let run = store
        .pipeline_run_by_id_mut(&run_id)
        .ok_or_else(|| format!("unknown pipeline run: {run_id}"))?;
    for result in &results {
        run.log(
            "gate",
            Some(&stage_id),
            None,
            format!("{}: {}", result.label, result.summary),
            (!result.output.is_empty()).then(|| result.output.clone()),
        );
    }
    run.gates.insert(
        stage_id.clone(),
        StageGates {
            round,
            at: chrono::Utc::now().to_rfc3339(),
            results: results.clone(),
        },
    );
    store.save()?;
    app.chain_run_updated(&run_id);
    Ok(results)
}

/// Turn autopilot on or off for one run. Turning it on clears what it was
/// waiting for; checkpoints already passed stay passed.
#[tauri::command]
pub fn pipeline_set_autopilot(
    app: tauri::AppHandle,
    run_id: String,
    enabled: bool,
    store: State<Mutex<StateStore>>,
) -> Result<(), String> {
    let run_id = run_id.trim().to_string();
    let mut store = store.lock().map_err(|e| e.to_string())?;
    let run = store
        .pipeline_run_by_id_mut(&run_id)
        .ok_or_else(|| format!("unknown pipeline run: {run_id}"))?;
    let autopilot = run.autopilot.get_or_insert_with(RunAutopilot::default);
    if autopilot.enabled == enabled {
        return Ok(());
    }
    autopilot.enabled = enabled;
    autopilot.waiting = None;
    run.log(
        "autopilot",
        None,
        None,
        if enabled { "Autopilot on" } else { "Autopilot off" },
        None,
    );
    store.save()?;
    app.chain_run_updated(&run_id);
    Ok(())
}

/// After a stage's turn: what autopilot does next (`decide`). Recorded in
/// the run's ledger; the frontend carries it out.
#[tauri::command]
pub fn pipeline_decide(
    app: tauri::AppHandle,
    run_id: String,
    report: TurnReport,
    store: State<Mutex<StateStore>>,
) -> Result<Decision, String> {
    let run_id = run_id.trim().to_string();
    let mut store = store.lock().map_err(|e| e.to_string())?;
    let run = store
        .pipeline_run_by_id_mut(&run_id)
        .ok_or_else(|| format!("unknown pipeline run: {run_id}"))?;
    let def = crate::pipelines::find(&run.kind)
        .ok_or_else(|| format!("unknown pipeline: {}", run.kind))?;
    let decision = decide(&def, run, &report);
    store.save()?;
    app.chain_run_updated(&run_id);
    Ok(decision)
}

/// A line the frontend adds to the ledger, e.g. why autopilot could not
/// carry out a decision. `stop` also marks autopilot as waiting for you.
#[tauri::command]
pub fn pipeline_note(
    app: tauri::AppHandle,
    run_id: String,
    stage_id: Option<String>,
    summary: String,
    detail: Option<String>,
    stop: bool,
    store: State<Mutex<StateStore>>,
) -> Result<(), String> {
    let run_id = run_id.trim().to_string();
    let summary: String = summary.trim().chars().take(500).collect();
    if summary.is_empty() {
        return Err("empty note".into());
    }
    let mut store = store.lock().map_err(|e| e.to_string())?;
    let run = store
        .pipeline_run_by_id_mut(&run_id)
        .ok_or_else(|| format!("unknown pipeline run: {run_id}"))?;
    if stop {
        run.autopilot.get_or_insert_with(RunAutopilot::default).waiting = Some(summary.clone());
    }
    run.log(
        if stop { "stop" } else { "note" },
        stage_id.as_deref(),
        None,
        summary,
        detail,
    );
    store.save()?;
    app.chain_run_updated(&run_id);
    Ok(())
}
