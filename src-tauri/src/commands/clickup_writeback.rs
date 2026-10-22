//! ClickUp write-back (C3) for the chain overview and Settings › Integrations.
//!
//! - [`load`] (`clickup_writeback_load`) builds the run's proposals from its
//!   files once they are due (a lane marked verified, or the run complete),
//!   keeps what you did to them, and writes `writeback.json`. A run with no
//!   `tickets.json` gets nothing, and no file.
//! - [`edit`] (`clickup_writeback_edit`) ticks, skips or edits one row.
//! - [`send`] (`clickup_writeback_send`) posts the ticked rows with the
//!   account and workspace the tickets were taken with (E2a), and refuses
//!   when the window's account is another, or that account's workspace has
//!   changed since. Each result goes in `writeback.json` and on the
//!   Timeline.
//! - The "verified" status of each list is mapped once, from the list's
//!   real statuses ([`list_statuses`], [`set_status_map`]).
//!
//! Network calls run on the blocking pool with no store lock held: each
//! command copies what it needs, unlocks, calls ClickUp, then locks to save.

use super::clickup::{account_of, with_deps, Deps};
use super::clickup_intake::{access, lock, now_text, read_snapshot, window_account};
use crate::bridge::folder::{self, RunPrs, TASKS_FILE, WRITEBACK_FILE};
use crate::clickup::intake::TicketsSnapshot;
use crate::clickup::writeback::{
    self, LaneFacts, PrLink, Proposal, RowEdit, RowStore, RunFacts, RunMemory, SendReport, SendRequest,
    VerifyFacts, Writeback, WRITEBACK_SCHEMA,
};
use crate::clickup::{valid_id, ClickUp};
use crate::commands::chain_events::ChainEvents;
use crate::store::settings_store::ClickUpStatusMap;
use crate::store::{PipelineRun, RunLane, RunStatus, SettingsStore, StateStore};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

/// Keeps two writers of one `writeback.json` apart, and a send from edits.
#[derive(Default)]
pub struct WritebackState {
    /// Held around each read-modify-write of a `writeback.json` (file work
    /// only, never a network call).
    file: Mutex<()>,
    /// Runs whose send is under way: edits wait for it.
    sending: Mutex<HashSet<String>>,
    /// Per run: the ticks you gave and the comments that may have been
    /// posted, kept here because anything that can write the run folder
    /// could forge them in `writeback.json`. Locked after `file`, never
    /// before it. Lost on restart, on purpose: you tick again. Entries are
    /// small and not dropped while the app runs; runs have no delete path
    /// yet to drop them from.
    memory: Mutex<HashMap<String, RunMemory>>,
}

/// One list's mapping, to show.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ListMapping {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verified: Option<String>,
}

/// The chain overview's "ClickUp updates".
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WritebackView {
    pub run_id: String,
    /// The Claude account the tickets were taken with; sends use it (E2a).
    pub account_id: String,
    pub account_name: String,
    pub proposals: Vec<Proposal>,
    /// The lists the tickets are in, with their mapping.
    pub lists: Vec<ListMapping>,
    /// A send for this run is under way.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub sending: bool,
}

/// What Send did.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WritebackSent {
    pub view: WritebackView,
    pub sent: usize,
    pub failed: usize,
    /// Rows you ticked that were not sent, with why.
    pub not_sent: Vec<NotSent>,
}

/// One status of a list, to pick from.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ListStatus {
    pub status: String,
    /// `open`, `custom`, `done` or `closed`.
    pub kind: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub color: String,
}

/// A list's real statuses (`GET /list/{id}`).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ListStatuses {
    pub id: String,
    pub name: String,
    pub statuses: Vec<ListStatus>,
}

/// One Claude account's list mappings, for Settings › Integrations.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccountMappings {
    pub account_id: String,
    pub account_name: String,
    pub lists: Vec<ListMapping>,
}

fn read_writeback(run_dir: &Path) -> Result<Option<Writeback>, String> {
    let path = run_dir.join(WRITEBACK_FILE);
    if !path.is_file() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let wb: Writeback = serde_json::from_str(&text)
        .map_err(|_| "This run's writeback.json could not be read.".to_string())?;
    if wb.schema != WRITEBACK_SCHEMA {
        return Err(format!(
            "This run's writeback.json is schema {}, which this version cannot read.",
            wb.schema
        ));
    }
    Ok(Some(wb))
}

/// Writes `writeback.json` as the app writes `tickets.json` (atomic, inside
/// the run folder only).
fn write_writeback(run_dir: &Path, wb: &Writeback) -> Result<PathBuf, String> {
    let path = run_dir.join(WRITEBACK_FILE);
    folder::write_json(&path, wb).map_err(|err| format!("could not write {}: {err}", path.display()))?;
    Ok(path)
}

/// The labels of the command checks that passed last for `lane`, in a fixed
/// order.
fn checks_passed(run: &PipelineRun, lane: Option<&str>) -> Vec<String> {
    let mut keys: Vec<&String> = run
        .gates
        .keys()
        .filter(|key| key.split_once('@').map(|(_, l)| l) == lane)
        .collect();
    keys.sort();
    let mut labels: Vec<String> = Vec::new();
    for key in keys {
        for result in &run.gates[key].results {
            if result.kind == "command" && result.passed() && !labels.contains(&result.label) {
                labels.push(result.label.clone());
            }
        }
    }
    labels
}

fn lane_facts(run: &PipelineRun, run_dir: &Path, lane: Option<&RunLane>) -> LaneFacts {
    let id = lane.map(|l| l.id.clone());
    let prs: Option<RunPrs> = folder::read_json(&run_dir.join(folder::prs_file_name(id.as_deref())));
    let text = |value: &serde_json::Value, key: &str| {
        value.get(key).and_then(|v| v.as_str()).map(str::trim).unwrap_or_default().to_string()
    };
    let links = prs
        .as_ref()
        .and_then(|p| p.result.get("prs"))
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .map(|pr| PrLink { title: text(pr, "title"), url: text(pr, "url") })
                .filter(|pr| !pr.url.is_empty())
                .collect()
        })
        .unwrap_or_default();
    LaneFacts {
        title: lane.map(|l| l.title.clone()).unwrap_or_default(),
        prs: links,
        summary: prs.as_ref().map(|p| text(&p.result, "summary")).filter(|s| !s.is_empty()),
        verification: run.latest_verification(id.as_deref()).map(|record| VerifyFacts {
            verified: record.verified(),
            steps: record.steps.clone(),
            note: record.note.clone(),
            at: record.at.clone(),
        }),
        checks_passed: checks_passed(run, id.as_deref()),
        id,
    }
}

/// The ticket ids each task of `tasks.json` names: its own `tickets`, and
/// its stories' `tickets` once the plan has stories. Read loosely, so a
/// task with neither (every plan before C3) names none.
fn task_tickets(run_dir: &Path) -> BTreeMap<String, Vec<String>> {
    let Some(tasks) = folder::read_json::<serde_json::Value>(&run_dir.join(TASKS_FILE)) else {
        return BTreeMap::new();
    };
    let names = |value: Option<&serde_json::Value>| -> Vec<String> {
        value
            .and_then(|v| v.as_array())
            .map(|items| items.iter().filter_map(|t| t.as_str()).map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).collect())
            .unwrap_or_default()
    };
    let mut out = BTreeMap::new();
    for task in tasks.get("tasks").and_then(|t| t.as_array()).into_iter().flatten() {
        let Some(id) = task.get("id").and_then(|v| v.as_str()) else { continue };
        let mut tickets = names(task.get("tickets"));
        for story in task.get("stories").and_then(|s| s.as_array()).into_iter().flatten() {
            for ticket in names(story.get("tickets")) {
                if !tickets.contains(&ticket) {
                    tickets.push(ticket);
                }
            }
        }
        out.insert(id.trim().to_ascii_lowercase(), tickets);
    }
    out
}

/// What the builder reads about `run`, from the run and its folder.
pub(crate) fn facts_of(run: &PipelineRun, run_dir: &Path) -> RunFacts {
    RunFacts {
        run_id: run.id.clone(),
        complete: run.status == RunStatus::Complete,
        lanes: run.lanes.iter().map(|lane| lane_facts(run, run_dir, Some(lane))).collect(),
        own: lane_facts(run, run_dir, None),
        task_tickets: task_tickets(run_dir),
    }
}

fn account_name(settings: &Mutex<SettingsStore>, account_id: &str) -> String {
    account_of(settings, account_id).map(|a| a.name).unwrap_or_else(|_| account_id.to_string())
}

fn maps_of(settings: &Mutex<SettingsStore>, account_id: &str) -> Result<BTreeMap<String, ClickUpStatusMap>, String> {
    Ok(lock(settings)?.clickup_status_maps(account_id))
}

fn view_of(
    settings: &Mutex<SettingsStore>,
    state: &WritebackState,
    snapshot: &TicketsSnapshot,
    wb: Writeback,
) -> Result<WritebackView, String> {
    let account_id = snapshot.source.account_id.clone();
    let maps = maps_of(settings, &account_id)?;
    let mut lists: Vec<ListMapping> = Vec::new();
    for list in snapshot.tickets.iter().filter_map(|t| t.list.as_ref()) {
        if !lists.iter().any(|l| l.id == list.id) {
            lists.push(ListMapping {
                id: list.id.clone(),
                name: writeback::list_label(list).to_string(),
                verified: maps.get(&list.id).map(|m| m.verified.clone()),
            });
        }
    }
    Ok(WritebackView {
        sending: lock(&state.sending)?.contains(&wb.run_id),
        run_id: wb.run_id,
        account_name: account_name(settings, &account_id),
        account_id,
        // Only the run's own tickets are shown: a row written into the file
        // for any other id is never offered.
        proposals: wb
            .proposals
            .into_iter()
            .filter(|p| snapshot.tickets.iter().any(|t| t.row.id == p.ticket.id))
            .collect(),
        lists,
    })
}

/// The run's proposals, rebuilt from its files and merged with what you
/// did; `None` when the run has no `tickets.json`, or none are due yet.
pub(crate) fn load(
    settings: &Mutex<SettingsStore>,
    store: &Mutex<StateStore>,
    state: &WritebackState,
    runs_root: &Path,
    run_id: &str,
) -> Result<Option<WritebackView>, String> {
    let Some((run_dir, snapshot)) = read_snapshot(runs_root, run_id)? else {
        return Ok(None);
    };
    // R1: a Triage run fixes nothing; each plan's own run proposes its updates.
    if run_dir.join(crate::bridge::round::ROUND_FILE).is_file() {
        return Ok(None);
    }
    let Some(run) = lock(store)?.pipeline_run_by_id(run_id).cloned() else {
        return Ok(None);
    };
    let maps = maps_of(settings, &snapshot.source.account_id)?;
    let fresh = writeback::build(&snapshot, &facts_of(&run, &run_dir), &maps);
    let wb = {
        let _file = lock(&state.file)?;
        let old = read_writeback(&run_dir)?;
        let sending = lock(&state.sending)?.contains(run_id);
        let mut memories = lock(&state.memory)?;
        let memory = memories.entry(run_id.to_string()).or_default();
        match old {
            None if fresh.is_empty() => return Ok(None),
            // While a send is under way, the file is the send's; what you
            // see still carries only the ticks you gave.
            Some(mut old) if sending => {
                writeback::sanitize(&mut old.proposals, &mut memory.clone());
                old
            }
            old => {
                let proposals = if fresh.is_empty() {
                    let mut rows = old.as_ref().map(|o| o.proposals.clone()).unwrap_or_default();
                    writeback::sanitize(&mut rows, memory);
                    rows
                } else {
                    writeback::merge(old.as_ref(), fresh, memory)
                };
                let next = Writeback {
                    schema: WRITEBACK_SCHEMA,
                    run_id: run_id.to_string(),
                    proposals,
                };
                if old.as_ref() != Some(&next) {
                    write_writeback(&run_dir, &next)?;
                }
                next
            }
        }
    };
    view_of(settings, state, &snapshot, wb).map(Some)
}

/// Ticks, skips or edits one row. Refused while a send is under way,
/// checked with the file held so a send cannot start in between.
pub(crate) fn edit(
    settings: &Mutex<SettingsStore>,
    state: &WritebackState,
    runs_root: &Path,
    run_id: &str,
    ticket_id: &str,
    change: &RowEdit,
) -> Result<WritebackView, String> {
    let (run_dir, snapshot) =
        read_snapshot(runs_root, run_id)?.ok_or("This run did not start from ClickUp tickets.")?;
    if !snapshot.tickets.iter().any(|t| t.row.id == ticket_id) {
        return Err("That ticket is not in this run's tickets.json.".into());
    }
    let wb = {
        let _file = lock(&state.file)?;
        if lock(&state.sending)?.contains(run_id) {
            return Err("The ClickUp updates are being sent. Wait for that to finish.".into());
        }
        let mut wb = read_writeback(&run_dir)?.ok_or("This run has no ClickUp updates yet.")?;
        let mut memories = lock(&state.memory)?;
        let memory = memories.entry(run_id.to_string()).or_default();
        writeback::edit_row(&mut wb, memory, ticket_id, change)?;
        write_writeback(&run_dir, &wb)?;
        wb
    };
    view_of(settings, state, &snapshot, wb)
}

/// Marks `run_id` as sending until dropped.
struct Sending<'a> {
    state: &'a WritebackState,
    run_id: String,
}

impl Drop for Sending<'_> {
    fn drop(&mut self) {
        self.state.sending.lock().unwrap_or_else(|e| e.into_inner()).remove(&self.run_id);
    }
}

fn claim_send<'a>(state: &'a WritebackState, run_id: &str) -> Result<Sending<'a>, String> {
    if !lock(&state.sending)?.insert(run_id.to_string()) {
        return Err("These ClickUp updates are already being sent.".into());
    }
    Ok(Sending { state, run_id: run_id.to_string() })
}

/// The run's `writeback.json` as a send reads and saves it: each step
/// takes the file lock, reads, writes when asked, then lets go.
struct FileRows<'a> {
    state: &'a WritebackState,
    run_dir: &'a Path,
    run_id: &'a str,
}

impl RowStore for FileRows<'_> {
    fn with(&mut self, f: &mut dyn FnMut(&mut Writeback, &mut RunMemory) -> bool) -> Result<(), String> {
        let _file = lock(&self.state.file)?;
        let mut wb = read_writeback(self.run_dir)?.ok_or("This run has no ClickUp updates yet.")?;
        let mut memories = lock(&self.state.memory)?;
        let memory = memories.entry(self.run_id.to_string()).or_default();
        if f(&mut wb, memory) {
            write_writeback(self.run_dir, &wb)?;
        }
        Ok(())
    }
}

/// One ticked row that was not sent, and why. No call was made for it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotSent {
    pub ticket_id: String,
    pub reason: String,
}

/// The Timeline lines for one send.
fn timeline_lines(report: &SendReport) -> Vec<(String, Option<String>)> {
    let mut lines = Vec::new();
    if !report.sent.is_empty() {
        let parts: Vec<String> = report.sent.iter().map(|(id, what)| format!("{id} ({what})")).collect();
        let count = report.sent.len();
        lines.push((
            format!(
                "Sent {count} ClickUp update{}: {}",
                if count == 1 { "" } else { "s" },
                parts.join("; ")
            ),
            Some(parts.join("\n")),
        ));
    }
    for (id, err) in &report.failed {
        lines.push((format!("ClickUp update for {id} failed: {err}"), None));
    }
    lines
}

/// Send: posts the rows you ticked, as you saw them (`requests`), with the
/// account and workspace the tickets were taken with. A row goes only when
/// `writeback.json` still says exactly what you saw and its ticket is in
/// `tickets.json`; its result is saved before the next row is sent, and
/// noted on the Timeline. `window_account_id` is the Claude account of the
/// window that asked; another account's window is refused before any call.
#[allow(clippy::too_many_arguments)]
pub(crate) fn send(
    deps: &Deps,
    state: &WritebackState,
    store: &Mutex<StateStore>,
    events: &dyn ChainEvents,
    runs_root: &Path,
    run_id: &str,
    window_account_id: &str,
    requests: &[SendRequest],
) -> Result<WritebackSent, String> {
    let (run_dir, snapshot) =
        read_snapshot(runs_root, run_id)?.ok_or("This run did not start from ClickUp tickets.")?;
    let source = &snapshot.source;
    if window_account_id != source.account_id {
        return Err(format!(
            "This run's tickets were taken with the Claude account \"{}\". Send its ClickUp updates from a window of that account.",
            account_name(deps.settings, &source.account_id)
        ));
    }
    if requests.is_empty() {
        return Err("Tick at least one update to send. Nothing is sent without a tick.".into());
    }
    let (token, workspace) = access(deps, &source.account_id)?;
    if workspace != source.workspace_id {
        return Err(format!(
            "The ClickUp workspace of \"{}\" changed since these tickets were taken, so nothing was sent. Pick the workspace again under Settings › Integrations.",
            account_name(deps.settings, &source.account_id)
        ));
    }
    let tickets: HashSet<String> = snapshot.tickets.iter().map(|t| t.row.id.clone()).collect();
    let sending = claim_send(state, run_id)?;
    let client = ClickUp::with(deps.transport, &token, deps.gate, deps.clock);
    let mut rows = FileRows { state, run_dir: &run_dir, run_id };
    let (report, saved) = match writeback::send_requests(&client, &mut rows, &tickets, requests, &now_text) {
        Ok(report) => (report, Ok(())),
        Err((report, err)) => (report, Err(err)),
    };
    // The Timeline gets what was sent even when a save failed.
    {
        let mut store = lock(store)?;
        if store.pipeline_run_by_id(run_id).is_some() {
            for (summary, detail) in timeline_lines(&report) {
                if let Err(err) = crate::commands::pipeline::note(&mut store, run_id, None, &summary, detail, false, None) {
                    eprintln!("DCTerminal: run {run_id}: a ClickUp send was not noted: {err}");
                }
            }
        }
    }
    events.chain_run_updated(run_id);
    drop(sending);
    if let Err(err) = saved {
        return Err(format!(
            "Could not save the ClickUp results ({err}), so sending stopped. Check the tickets in ClickUp before sending again."
        ));
    }
    let wb = {
        let _file = lock(&state.file)?;
        read_writeback(&run_dir)?.ok_or("This run has no ClickUp updates yet.")?
    };
    Ok(WritebackSent {
        sent: report.sent.len(),
        failed: report.failed.len(),
        not_sent: report
            .not_sent
            .iter()
            .map(|(id, reason)| NotSent { ticket_id: id.clone(), reason: reason.clone() })
            .collect(),
        view: view_of(deps.settings, state, &snapshot, wb)?,
    })
}

/// A list's real statuses, read with `account_id`'s token.
pub(crate) fn list_statuses(deps: &Deps, account_id: &str, list_id: &str) -> Result<ListStatuses, String> {
    if !valid_id(list_id) {
        return Err("That is not a ClickUp list id.".into());
    }
    let (token, _) = access(deps, account_id)?;
    let list = ClickUp::with(deps.transport, &token, deps.gate, deps.clock).list(list_id)?;
    Ok(ListStatuses {
        id: list.id,
        name: list.name.trim().to_string(),
        statuses: list
            .statuses
            .into_iter()
            .filter(|s| !s.status.trim().is_empty())
            .map(|s| ListStatus { status: s.status, kind: s.kind, color: s.color })
            .collect(),
    })
}

/// Every list mapping `account_id` has.
fn mappings_of(settings: &Mutex<SettingsStore>, account_id: &str) -> Result<Vec<ListMapping>, String> {
    Ok(maps_of(settings, account_id)?
        .into_iter()
        .map(|(id, map)| ListMapping {
            name: if map.list_name.is_empty() { id.clone() } else { map.list_name },
            id,
            verified: Some(map.verified),
        })
        .collect())
}

/// Maps `account_id`'s list `list_id`: "verified" → `verified`, which must be
/// one of the list's real statuses (read now). `None` forgets the mapping.
pub(crate) fn set_status_map(
    deps: &Deps,
    account_id: &str,
    list_id: &str,
    verified: Option<&str>,
) -> Result<Vec<ListMapping>, String> {
    account_of(deps.settings, account_id)?;
    if !valid_id(list_id) {
        return Err("That is not a ClickUp list id.".into());
    }
    let map = match verified.map(str::trim).filter(|s| !s.is_empty()) {
        None => None,
        Some(wanted) => {
            let list = list_statuses(deps, account_id, list_id)?;
            let status = list
                .statuses
                .iter()
                .find(|s| s.status.trim().eq_ignore_ascii_case(wanted))
                .ok_or_else(|| format!("The list \"{}\" has no status \"{wanted}\".", list.name))?;
            Some(ClickUpStatusMap { verified: status.status.clone(), list_name: list.name.clone() })
        }
    };
    lock(deps.settings)?.set_clickup_status_map(account_id, list_id, map)?;
    mappings_of(deps.settings, account_id)
}

/// Every Claude account's list mappings, for Settings › Integrations.
pub(crate) fn all_mappings(settings: &Mutex<SettingsStore>) -> Result<Vec<AccountMappings>, String> {
    let accounts: Vec<(String, String)> = lock(settings)?
        .providers()
        .claude
        .accounts
        .iter()
        .map(|a| (a.id.clone(), a.name.clone()))
        .collect();
    accounts
        .into_iter()
        .map(|(account_id, account_name)| {
            Ok(AccountMappings { lists: mappings_of(settings, &account_id)?, account_id, account_name })
        })
        .collect()
}

fn runs_root(app: &AppHandle) -> PathBuf {
    crate::bridge::launch::runs_root(&crate::data_dir::app_data_dir(app).path)
}

/// The run's ClickUp updates; `null` when it has none (no `tickets.json`, or
/// nothing verified or complete yet).
#[tauri::command]
pub async fn clickup_writeback_load(app: AppHandle, run_id: String) -> Result<Option<WritebackView>, String> {
    let runs = runs_root(&app);
    tauri::async_runtime::spawn_blocking(move || {
        load(
            app.state::<Mutex<SettingsStore>>().inner(),
            app.state::<Mutex<StateStore>>().inner(),
            app.state::<WritebackState>().inner(),
            &runs,
            run_id.trim(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Ticks, skips or edits one row of the run's ClickUp updates.
#[tauri::command]
pub async fn clickup_writeback_edit(
    app: AppHandle,
    run_id: String,
    ticket_id: String,
    edit: RowEdit,
) -> Result<WritebackView, String> {
    let runs = runs_root(&app);
    tauri::async_runtime::spawn_blocking(move || {
        self::edit(
            app.state::<Mutex<SettingsStore>>().inner(),
            app.state::<WritebackState>().inner(),
            &runs,
            run_id.trim(),
            ticket_id.trim(),
            &edit,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Send ticked: posts only the ticked rows, with the run's own account.
#[tauri::command]
pub async fn clickup_writeback_send(
    app: AppHandle,
    window_id: String,
    run_id: String,
    rows: Vec<SendRequest>,
) -> Result<WritebackSent, String> {
    let account = window_account(app.state::<Mutex<StateStore>>().inner(), &window_id)?;
    let runs = runs_root(&app);
    let handle = app.clone();
    with_deps(app, move |deps| {
        send(
            deps,
            handle.state::<WritebackState>().inner(),
            handle.state::<Mutex<StateStore>>().inner(),
            &handle,
            &runs,
            run_id.trim(),
            &account,
            &rows,
        )
    })
    .await
}

/// A ClickUp list's real statuses, read with that account's token.
#[tauri::command]
pub async fn clickup_list_statuses(
    app: AppHandle,
    account_id: String,
    list_id: String,
) -> Result<ListStatuses, String> {
    with_deps(app, move |deps| list_statuses(deps, &account_id, list_id.trim())).await
}

/// Maps a list's "verified" status (or, with `null`, forgets it).
#[tauri::command]
pub async fn clickup_status_map_set(
    app: AppHandle,
    account_id: String,
    list_id: String,
    verified: Option<String>,
) -> Result<Vec<ListMapping>, String> {
    with_deps(app, move |deps| set_status_map(deps, &account_id, list_id.trim(), verified.as_deref())).await
}

/// Every Claude account's list mappings.
#[tauri::command]
pub async fn clickup_status_maps(app: AppHandle) -> Result<Vec<AccountMappings>, String> {
    tauri::async_runtime::spawn_blocking(move || all_mappings(app.state::<Mutex<SettingsStore>>().inner()))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
#[path = "clickup_writeback_tests.rs"]
mod tests;
