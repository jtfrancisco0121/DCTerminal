//! A round's files (R2). `rounds/<roundId>/` in app data holds copies of
//! the Triage run's `tickets.json`, `round.json` and `round.md`, taken when
//! the round starts so a later Triage round changes nothing under it, and
//! `runs.json`, the plan runs it started. Each plan run's folder gets
//! `round-plan.json` (its plan of the round, linking back to the round) and
//! a `tickets.json` with only that plan's tickets, so ClickUp intake and
//! write-back (C2, C3) work per plan as for any run.

use crate::bridge::folder::{read_json, write_atomic, write_json, SCHEMA, TICKETS_FILE};
use crate::bridge::round::{RoundPlan, RunRound, ROUND_FILE, ROUND_MD_FILE};
use crate::clickup::intake::TicketsSnapshot;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Folder under app data that holds one folder per round.
pub const ROUNDS_DIR: &str = "rounds";
/// The plan runs a round started.
pub const RUNS_FILE: &str = "runs.json";
/// In a plan run's folder: its plan of the round.
pub const ROUND_PLAN_FILE: &str = "round-plan.json";

/// `<app data>/rounds`, next to `<app data>/runs`.
pub fn rounds_root(runs_root: &Path) -> PathBuf {
    runs_root.parent().unwrap_or(runs_root).join(ROUNDS_DIR)
}

/// A round id is one path part: letters, digits, `-` and `_`.
pub fn round_dir(rounds_root: &Path, round_id: &str) -> Option<PathBuf> {
    crate::bridge::folder::valid_run_id(round_id).then(|| rounds_root.join(round_id))
}

/// `runs.json`: the plan runs of a round, by plan.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundRuns {
    pub schema: u32,
    pub round_id: String,
    pub triage_run_id: String,
    /// Plan id → run id.
    pub runs: BTreeMap<String, String>,
}

/// `round-plan.json` in a plan run's folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundPlanFile {
    pub schema: u32,
    pub round_id: String,
    pub triage_run_id: String,
    /// The round's folder (`rounds/<roundId>/`), with `round.md` and `round.json`.
    pub round_folder: String,
    pub plan: RoundPlan,
    /// Why the plan's wave goes together.
    #[serde(default)]
    pub wave_why: String,
    /// Each of the plan's repos' merge order (plan ids), from `round.json`.
    #[serde(default)]
    pub merge_order: BTreeMap<String, Vec<String>>,
}

/// What the round folder copies from the Triage run's folder.
pub struct TriageFiles {
    pub round: RunRound,
    pub markdown: String,
    pub tickets: Option<TicketsSnapshot>,
}

/// Read the Triage run's round, its document and its tickets.
pub fn read_triage(triage_dir: &Path) -> Result<TriageFiles, String> {
    let round: RunRound = read_json(&triage_dir.join(ROUND_FILE))
        .ok_or_else(|| "This run has no round.json: its Triage has not handed a round over.".to_string())?;
    let markdown = std::fs::read_to_string(triage_dir.join(ROUND_MD_FILE)).unwrap_or_default();
    let tickets = match triage_dir.join(TICKETS_FILE) {
        path if path.is_file() => Some(
            read_json::<TicketsSnapshot>(&path).ok_or_else(|| "This run's tickets.json could not be read.".to_string())?,
        ),
        _ => None,
    };
    Ok(TriageFiles { round, markdown, tickets })
}

/// Write the round folder's copies (and an empty `runs.json`).
pub fn write_round_folder(dir: &Path, round_id: &str, files: &TriageFiles) -> Result<(), String> {
    let fail = |what: &str, err: std::io::Error| format!("could not write {} in {}: {err}", what, dir.display());
    std::fs::create_dir_all(dir).map_err(|err| fail("the round folder", err))?;
    write_json(&dir.join(ROUND_FILE), &files.round).map_err(|err| fail(ROUND_FILE, err))?;
    write_atomic(&dir.join(ROUND_MD_FILE), files.markdown.as_bytes()).map_err(|err| fail(ROUND_MD_FILE, err))?;
    if let Some(tickets) = &files.tickets {
        write_json(&dir.join(TICKETS_FILE), tickets).map_err(|err| fail(TICKETS_FILE, err))?;
    }
    let runs = RoundRuns {
        schema: SCHEMA,
        round_id: round_id.to_string(),
        triage_run_id: files.round.run_id.clone(),
        runs: BTreeMap::new(),
    };
    write_json(&dir.join(RUNS_FILE), &runs).map_err(|err| fail(RUNS_FILE, err))
}

/// The round's copy of `round.json`.
pub fn read_round_copy(dir: &Path) -> Option<RunRound> {
    read_json(&dir.join(ROUND_FILE))
}

/// The round's copy of `tickets.json`, when the Triage run had one.
pub fn read_tickets_copy(dir: &Path) -> Option<TicketsSnapshot> {
    read_json(&dir.join(TICKETS_FILE))
}

/// Record a plan's run in `runs.json`.
pub fn record_run(dir: &Path, plan_id: &str, run_id: &str) -> Result<(), String> {
    let path = dir.join(RUNS_FILE);
    let mut runs: RoundRuns = read_json(&path).unwrap_or_default();
    runs.schema = SCHEMA;
    runs.runs.insert(plan_id.to_string(), run_id.to_string());
    write_json(&path, &runs).map_err(|err| format!("could not write {}: {err}", path.display()))
}

/// The snapshot with only `plan`'s tickets (by id or custom id, any case).
/// Tickets excluded at intake belong to no plan, so the copy has none.
pub fn plan_tickets(snapshot: &TicketsSnapshot, plan: &RoundPlan) -> TicketsSnapshot {
    let named = |id: &str, custom: Option<&str>| {
        plan.tickets
            .iter()
            .any(|t| t.eq_ignore_ascii_case(id) || custom.is_some_and(|c| c.eq_ignore_ascii_case(t)))
    };
    let mut copy = snapshot.clone();
    copy.tickets.retain(|ticket| named(&ticket.row.id, ticket.row.custom_id.as_deref()));
    copy.excluded.clear();
    copy.pulls.clear();
    copy
}

/// The plan's entry for its run folder.
pub fn plan_file(round_id: &str, round_folder: &Path, round: &RunRound, plan: &RoundPlan) -> RoundPlanFile {
    let wave_why = plan
        .wave
        .and_then(|n| round.round.waves.iter().find(|w| w.n == n))
        .map(|w| w.why.clone())
        .unwrap_or_default();
    let merge_order = plan
        .repos
        .iter()
        .filter_map(|repo| round.round.merge_order.get(repo).map(|ids| (repo.clone(), ids.clone())))
        .collect();
    RoundPlanFile {
        schema: SCHEMA,
        round_id: round_id.to_string(),
        triage_run_id: round.run_id.clone(),
        round_folder: round_folder.display().to_string(),
        plan: plan.clone(),
        wave_why,
        merge_order,
    }
}

/// Write the plan run's `round-plan.json` and, with a snapshot, its own `tickets.json`.
pub fn write_plan_run_files(run_dir: &Path, plan: &RoundPlanFile, tickets: Option<&TicketsSnapshot>) -> Result<(), String> {
    std::fs::create_dir_all(run_dir).map_err(|err| err.to_string())?;
    write_json(&run_dir.join(ROUND_PLAN_FILE), plan)
        .map_err(|err| format!("could not write {}: {err}", run_dir.join(ROUND_PLAN_FILE).display()))?;
    if let Some(tickets) = tickets {
        crate::commands::clickup_intake::write_snapshot(run_dir, tickets)?;
    }
    Ok(())
}
