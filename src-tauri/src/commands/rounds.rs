//! QA rounds (Track R). R1: a Triage run's round as the chain overview
//! shows it (`round.json` and `round.md` from its run folder).

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
