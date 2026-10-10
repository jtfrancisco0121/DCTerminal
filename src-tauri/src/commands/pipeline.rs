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
