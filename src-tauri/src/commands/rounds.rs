//! QA rounds (Track R). R1: a Triage run's round as the chain overview
//! shows it (`round.json` and `round.md` from its run folder). R2: the
//! round view and its buttons, which go to the round runner.

use crate::bridge::round::{read_round, RunRound, ROUND_MD_FILE};
use serde::Serialize;
use std::path::Path;

/// A Triage run's round (R1): the checked `round.json` and the round
/// document Triage wrote (`round.md`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRoundView {
    pub round: RunRound,
    pub markdown: String,
    /// Where `round.md` is, to open it whole.
    pub markdown_path: String,
}

/// The round of `run_id`, when its Triage handed one over. Reads two files; takes no lock.
pub fn run_round(runs_root: &Path, run_id: &str) -> Option<RunRoundView> {
    let run_dir = crate::bridge::folder::run_dir(runs_root, run_id.trim())?;
    let round = read_round(&run_dir).filter(|round| round.run_id == run_id.trim())?;
    let path = run_dir.join(ROUND_MD_FILE);
    Some(RunRoundView {
        round,
        markdown: std::fs::read_to_string(&path).unwrap_or_default(),
        markdown_path: path.display().to_string(),
    })
}

/// R1: the round a Triage run handed over, for the chain overview's round
/// summary. `None` for any other run.
#[tauri::command]
pub fn pipeline_run_round(app: tauri::AppHandle, run_id: String) -> Result<Option<RunRoundView>, String> {
    let runs = crate::bridge::launch::runs_root(&crate::data_dir::app_data_dir(&app).path);
    Ok(run_round(&runs, &run_id))
}

/// How long a round button waits for the runner (it may be starting a run).
const ROUND_REPLY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// R2: the round `key` names (its id, its Triage run, or one of its plan
/// runs), as the round view shows it; `None` when there is none.
#[tauri::command]
pub fn round_get(
    app: tauri::AppHandle,
    key: String,
    store: tauri::State<std::sync::Mutex<crate::store::StateStore>>,
) -> Result<Option<crate::rounds::RoundView>, String> {
    let runs = crate::bridge::launch::runs_root(&crate::data_dir::app_data_dir(&app).path);
    let rounds_root = crate::rounds::files::rounds_root(&runs);
    let store = store.lock().map_err(|e| e.to_string())?;
    Ok(crate::rounds::view(&store, &rounds_root, &key))
}

/// R2: a round button (**Start round**, the cap, **Commit up to wave N**,
/// **Unpark**, **Retry**): a message to the round runner, which owns every
/// round. Waits for its answer on a blocking thread, then returns the round.
#[tauri::command]
pub async fn round_action(
    app: tauri::AppHandle,
    action: crate::rounds::RoundAction,
) -> Result<crate::rounds::RoundView, String> {
    use tauri::Manager;
    let rounds = app.state::<crate::rounds::AppRounds>().inner().clone();
    let id = tauri::async_runtime::spawn_blocking(move || rounds.ask(action, ROUND_REPLY_TIMEOUT))
        .await
        .map_err(|e| e.to_string())??;
    let runs = crate::bridge::launch::runs_root(&crate::data_dir::app_data_dir(&app).path);
    let rounds_root = crate::rounds::files::rounds_root(&runs);
    let store = app.state::<std::sync::Mutex<crate::store::StateStore>>();
    let store = store.lock().map_err(|e| e.to_string())?;
    crate::rounds::view(&store, &rounds_root, &id).ok_or_else(|| format!("unknown round: {id}"))
}
