use crate::store::{PipelineRun, StateStore};
use serde::Serialize;
use std::sync::Mutex;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineRunView {
    pub run: PipelineRun,
}

#[tauri::command]
pub fn get_pipeline_run(
    run_id: String,
    store: State<Mutex<StateStore>>,
) -> Result<PipelineRunView, String> {
    let store = store.lock().map_err(|e| e.to_string())?;
    let run = store
        .pipeline_run_by_id(run_id.trim())
        .cloned()
        .ok_or_else(|| format!("unknown pipeline run: {run_id}"))?;
    Ok(PipelineRunView { run })
}

#[tauri::command]
pub fn pipeline_promote_plan(
    run_id: String,
    approved_plan: String,
    store: State<Mutex<StateStore>>,
) -> Result<(), String> {
    let mut store = store.lock().map_err(|e| e.to_string())?;
    store.pipeline_promote_plan(run_id.trim(), &approved_plan)?;
    Ok(())
}

#[tauri::command]
pub fn pipeline_set_candidate_plan(
    run_id: String,
    candidate_plan: String,
    store: State<Mutex<StateStore>>,
) -> Result<(), String> {
    let mut store = store.lock().map_err(|e| e.to_string())?;
    store.pipeline_set_candidate_plan(run_id.trim(), &candidate_plan)?;
    Ok(())
}
