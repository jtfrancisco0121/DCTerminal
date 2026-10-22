//! ClickUp intake (C2) for the start screen and the chain overview.
//!
//! - Fetch (`clickup_intake_preview`) reads what you pasted with the
//!   window's own Claude account's token and workspace (E2a), never another
//!   account's, and shows what a round would take.
//! - Start (`clickup_intake_snapshot`) reads them again with their comments
//!   and keeps the snapshot here until the start that uses it
//!   (`role_terminal_start`'s `intakeId`) writes it into the new run's folder
//!   as `tickets.json` ([`take_pending`], [`write_snapshot`]). The run id only
//!   exists once that start begins the chain, so the snapshot waits in memory
//!   for at most [`PENDING_FOR`].
//! - The chain overview asks [`clickup_intake_check`] which tickets ClickUp
//!   edited since intake, at most once every [`CHECK_EVERY`] per run, and
//!   **Pull again** (`clickup_intake_pull`) re-reads the ones you choose,
//!   rewrites `tickets.json` and adds a Timeline note. Running stages are
//!   never prompted again: the file changes, and the next stage reads it.
//!
//! Network calls run on the blocking pool with no store lock held: each
//! command copies what it needs, unlocks, calls ClickUp, then locks to save.

use super::clickup::{account_of, with_deps, Deps};
use crate::bridge::folder::{self, TICKETS_FILE};
use crate::clickup::intake::{
    self, ChangedTicket, IntakeFilters, IntakePreview, IntakeRef, RefProblem, TicketsSnapshot,
};
use crate::clickup::{ClickUp, ClickUpToken};
use crate::commands::chain_events::ChainEvents;
use crate::store::StateStore;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

/// A Start's snapshot waits this long for its start.
pub const PENDING_FOR: Duration = Duration::from_secs(30 * 60);
/// The change check calls ClickUp once per ticket, so it runs at most this
/// often per run; a check sooner returns the last answer.
pub const CHECK_EVERY: Duration = Duration::from_secs(5 * 60);
/// Snapshots kept waiting at once; the oldest goes first.
const MAX_PENDING: usize = 8;

/// The intake's memory: snapshots waiting for their start, and each run's
/// last change check.
#[derive(Default)]
pub struct IntakeState {
    pending: Mutex<HashMap<String, Pending>>,
    checks: Mutex<HashMap<String, CheckCache>>,
}

struct Pending {
    made: Instant,
    snapshot: TicketsSnapshot,
}

struct CheckCache {
    at: Instant,
    check: IntakeCheck,
}

/// Whether this window's Claude account can use intake. Never the token.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IntakeStatus {
    pub account_id: String,
    pub account_name: String,
    /// A token and a workspace are both set.
    pub configured: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_name: Option<String>,
}

/// What Start kept for the start that uses it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IntakeStaged {
    pub intake_id: String,
    pub tickets: usize,
    pub excluded: usize,
    pub problems: Vec<RefProblem>,
}

/// The tickets ClickUp edited since a run's intake.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IntakeCheck {
    /// RFC 3339.
    pub checked_at: String,
    /// Tickets in the snapshot.
    pub tickets: usize,
    pub changed: Vec<ChangedTicket>,
}

pub(crate) fn now_text() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub(crate) fn lock<T>(mutex: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>, String> {
    mutex.lock().map_err(|e| e.to_string())
}

/// The Claude account `window_id` uses.
pub(crate) fn window_account(store: &Mutex<StateStore>, window_id: &str) -> Result<String, String> {
    Ok(lock(store)?.account_for_window(window_id))
}

/// `account_id`'s token and workspace id, or why intake cannot use them.
pub(crate) fn access(deps: &Deps, account_id: &str) -> Result<(ClickUpToken, String), String> {
    let account = account_of(deps.settings, account_id)?;
    let (token, _) = deps.token(&account)?;
    let Some(token) = token else {
        return Err(format!(
            "ClickUp is not set up for the Claude account \"{}\". Add its token under Settings › Integrations.",
            account.name
        ));
    };
    let Some(workspace) = account.workspace else {
        return Err(format!(
            "Pick a ClickUp workspace for \"{}\" first: press Test under Settings › Integrations.",
            account.name
        ));
    };
    Ok((token, workspace.team_id))
}

fn client<'a>(deps: &'a Deps, token: &'a ClickUpToken) -> ClickUp<'a> {
    ClickUp::with(deps.transport, token, deps.gate, deps.clock)
}

pub(crate) fn status(deps: &Deps, account_id: &str) -> Result<IntakeStatus, String> {
    let account = account_of(deps.settings, account_id)?;
    let (token, _) = deps.token(&account)?;
    Ok(IntakeStatus {
        configured: token.is_some() && account.workspace.is_some(),
        workspace_name: account.workspace.map(|w| w.team_name),
        account_id: account.id,
        account_name: account.name,
    })
}

pub(crate) fn preview(
    deps: &Deps,
    account_id: &str,
    refs: &[IntakeRef],
    filters: &IntakeFilters,
) -> Result<IntakePreview, String> {
    let (token, workspace) = access(deps, account_id)?;
    intake::preview(&client(deps, &token), refs, filters, &workspace)
}

pub(crate) fn stage(
    deps: &Deps,
    state: &IntakeState,
    account_id: &str,
    refs: &[IntakeRef],
    filters: &IntakeFilters,
    ticket_ids: Option<&[String]>,
) -> Result<IntakeStaged, String> {
    let (token, workspace) = access(deps, account_id)?;
    let (snapshot, problems) = intake::snapshot(
        &client(deps, &token),
        account_id,
        &workspace,
        refs,
        filters,
        ticket_ids,
        &now_text(),
    )?;
    let staged = IntakeStaged {
        intake_id: format!("intake-{}", uuid::Uuid::new_v4()),
        tickets: snapshot.tickets.len(),
        excluded: snapshot.excluded.len(),
        problems,
    };
    let mut pending = lock(&state.pending)?;
    pending.retain(|_, p| p.made.elapsed() < PENDING_FOR);
    while pending.len() >= MAX_PENDING {
        let Some(oldest) = pending.iter().min_by_key(|(_, p)| p.made).map(|(id, _)| id.clone()) else { break };
        pending.remove(&oldest);
    }
    pending.insert(staged.intake_id.clone(), Pending { made: Instant::now(), snapshot });
    Ok(staged)
}

/// The snapshot Start kept under `intake_id`, for a start in a window of
/// `account_id`. Taken once: a second start needs a new Fetch. A start in
/// another account's window is refused, so one account's tickets never
/// start a run in the other's.
pub(crate) fn take_pending(state: &IntakeState, intake_id: &str, account_id: &str) -> Result<TicketsSnapshot, String> {
    let mut pending = lock(&state.pending)?;
    let gone = || "The ClickUp tickets for this start are no longer ready. Press Fetch again.".to_string();
    let entry = pending.get(intake_id).ok_or_else(gone)?;
    if entry.made.elapsed() >= PENDING_FOR {
        pending.remove(intake_id);
        return Err(gone());
    }
    if entry.snapshot.source.account_id != account_id {
        return Err("These ClickUp tickets were fetched for another Claude account's window.".into());
    }
    pending.remove(intake_id).map(|p| p.snapshot).ok_or_else(gone)
}

/// Writes `tickets.json` into `run_dir`, as the app writes `run.json`
/// (atomic, inside the run folder only).
pub(crate) fn write_snapshot(run_dir: &Path, snapshot: &TicketsSnapshot) -> Result<PathBuf, String> {
    std::fs::create_dir_all(run_dir).map_err(|e| e.to_string())?;
    let path = run_dir.join(TICKETS_FILE);
    folder::write_json(&path, snapshot)
        .map_err(|err| format!("could not write {}: {err}", path.display()))?;
    Ok(path)
}

/// What a start that carries tickets does with them (C2).
#[derive(Debug)]
pub(crate) struct IntakeLaunch {
    /// Text to add after the merged prompt, for a role with no field to
    /// hold the note.
    pub tail: String,
    /// The snapshot to write as the run's `tickets.json` before the launch.
    pub write: Option<TicketsSnapshot>,
    /// The note put in the form (or the tail), as written.
    note: String,
}

impl IntakeLaunch {
    /// L1: the start did not begin its run after all (the tab joined a
    /// chain meanwhile), so no `tickets.json` will be written. Returns the
    /// note that names it and the request summary to put in its place, and
    /// drops the file.
    pub(crate) fn without_run(&mut self) -> Option<(String, String)> {
        let snapshot = self.write.take()?;
        Some((self.note.clone(), intake::request_note(&snapshot)))
    }
}

/// Swaps `from` for `to` in a saved tab's form and merged prompt (L1).
pub(crate) fn swap_tab_note(store: &mut StateStore, tab_id: &str, from: &str, to: &str) -> Result<(), String> {
    let tab = store
        .data
        .tabs
        .iter_mut()
        .find(|tab| tab.id == tab_id)
        .ok_or_else(|| format!("unknown tab: {tab_id}"))?;
    for value in tab.answers.values_mut() {
        if value.contains(from) {
            *value = value.replacen(from, to, 1);
        }
    }
    if tab.merged_prompt.contains(from) {
        tab.merged_prompt = tab.merged_prompt.replacen(from, to, 1);
        tab.merged_prompt_hash = crate::template::template_hash(&tab.merged_prompt);
    }
    store.save()
}

/// Puts the tickets into a starting stage's form. `run_dir`: the new
/// engine-2 run's folder, when the first stage launches bridged; it gets
/// `tickets.json` and the stage's context a note pointing at it with one
/// line per ticket, so the request you typed or dictated stays as it is.
/// Any other start has no run folder to read: the summary, with each
/// ticket's link, goes into the request and no file is written.
pub(crate) fn intake_for_start(
    role: &crate::roles::Role,
    values: &mut HashMap<String, String>,
    snapshot: TicketsSnapshot,
    run_dir: Option<&Path>,
) -> IntakeLaunch {
    use crate::run_actor::prompts::{place_intake_note, IntakeSlot};
    let titles: Vec<String> = snapshot.tickets.iter().map(|t| t.row.title.trim().to_string()).collect();
    let (note, slots, write) = match run_dir {
        Some(dir) => {
            let path = dir.join(TICKETS_FILE).display().to_string();
            (intake::snapshot_note(&snapshot, &path), &[IntakeSlot::Context][..], Some(snapshot))
        }
        None => (intake::request_note(&snapshot), &[IntakeSlot::Request, IntakeSlot::Context][..], None),
    };
    let placed = place_intake_note(role, values, &note, slots);
    fill_required_from_tickets(role, values, &titles);
    let note = note.trim().to_string();
    IntakeLaunch { tail: if placed { String::new() } else { note.clone() }, write, note }
}

/// The tickets answer the form: each required field you left empty, and
/// can see, gets a value, so Start needs no typing once tickets are
/// fetched. A choice takes its first option (before the other fields, as
/// it can show more), the title names the tickets, and any other field
/// points at them. What you typed stays as it is.
fn fill_required_from_tickets(role: &crate::roles::Role, values: &mut HashMap<String, String>, titles: &[String]) {
    use crate::roles::FieldType;
    use crate::template::field_visible;
    let Some(first) = titles.first() else { return };
    let empty = |values: &HashMap<String, String>, key: &str| values.get(key).is_none_or(|v| v.trim().is_empty());
    for field in role.fields.iter().filter(|f| f.required && f.field_type == FieldType::Select) {
        if field_visible(field, values) && empty(values, &field.key) {
            if let Some(option) = field.options.as_ref().and_then(|o| o.first()) {
                values.insert(field.key.clone(), option.clone());
            }
        }
    }
    let title = match titles.len() {
        1 => first.clone(),
        n => format!("{first} (+{} more ClickUp tickets)", n - 1),
    };
    for field in role.fields.iter().filter(|f| f.required) {
        if !field_visible(field, values) || !empty(values, &field.key) {
            continue;
        }
        let value = match field.field_type {
            FieldType::Select | FieldType::Folder => continue,
            _ if field.key == "title" => title.clone(),
            _ => "As the ClickUp tickets in this prompt say.".to_string(),
        };
        values.insert(field.key.clone(), value);
    }
}

pub(crate) fn read_snapshot(runs_root: &Path, run_id: &str) -> Result<Option<(PathBuf, TicketsSnapshot)>, String> {
    let run_dir = folder::run_dir(runs_root, run_id).ok_or_else(|| format!("not a run id: {run_id}"))?;
    let path = run_dir.join(TICKETS_FILE);
    if !path.is_file() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let snapshot: TicketsSnapshot =
        serde_json::from_str(&text).map_err(|_| "This run's tickets.json could not be read.".to_string())?;
    if snapshot.schema != intake::TICKETS_SCHEMA {
        return Err(format!("This run's tickets.json is schema {}, which this version cannot read.", snapshot.schema));
    }
    Ok(Some((run_dir, snapshot)))
}

/// Which snapshot tickets ClickUp edited since intake. `None`: the run has
/// no snapshot. A check within [`CHECK_EVERY`] of the last returns it.
pub(crate) fn check(
    deps: &Deps,
    state: &IntakeState,
    runs_root: &Path,
    run_id: &str,
) -> Result<Option<IntakeCheck>, String> {
    // Runs whose folder or snapshot is gone keep no check (L10).
    lock(&state.checks)?.retain(|id, _| {
        folder::run_dir(runs_root, id).is_some_and(|dir| dir.join(TICKETS_FILE).is_file())
    });
    let Some((_, snapshot)) = read_snapshot(runs_root, run_id)? else {
        return Ok(None);
    };
    if let Some(cached) = lock(&state.checks)?.get(run_id).filter(|c| c.at.elapsed() < CHECK_EVERY) {
        return Ok(Some(cached.check.clone()));
    }
    // The account the run started in, as recorded (E2a), not the window's.
    let (token, _) = access(deps, &snapshot.source.account_id)?;
    let changed = intake::check_changes(&client(deps, &token), &snapshot)?;
    let check = IntakeCheck { checked_at: now_text(), tickets: snapshot.tickets.len(), changed };
    lock(&state.checks)?.insert(run_id.to_string(), CheckCache { at: Instant::now(), check: check.clone() });
    Ok(Some(check))
}

/// Pull again: re-read `ticket_ids`, rewrite `tickets.json`, note it on the
/// run's Timeline and drop them from the last check.
pub(crate) fn pull(
    deps: &Deps,
    state: &IntakeState,
    store: &Mutex<StateStore>,
    events: &dyn ChainEvents,
    runs_root: &Path,
    run_id: &str,
    ticket_ids: &[String],
) -> Result<IntakeCheck, String> {
    let (run_dir, mut snapshot) =
        read_snapshot(runs_root, run_id)?.ok_or("This run did not start from ClickUp tickets.")?;
    let (token, _) = access(deps, &snapshot.source.account_id)?;
    let pulled = intake::pull_again(&client(deps, &token), &mut snapshot, ticket_ids, &now_text())?;
    write_snapshot(&run_dir, &snapshot)?;
    if !pulled.is_empty() {
        let summary = format!(
            "Pulled {} ticket{} again from ClickUp into tickets.json: {}",
            pulled.len(),
            if pulled.len() == 1 { "" } else { "s" },
            pulled.join(", ")
        );
        let mut store = lock(store)?;
        if store.pipeline_run_by_id(run_id).is_some() {
            crate::commands::pipeline::note(&mut store, run_id, None, &summary, None, false, None)?;
            events.chain_run_updated(run_id);
        }
    }
    let mut checks = lock(&state.checks)?;
    let check = match checks.get_mut(run_id) {
        Some(cached) => {
            cached.check.changed.retain(|c| !pulled.contains(&c.id));
            cached.check.clone()
        }
        None => IntakeCheck { checked_at: now_text(), tickets: snapshot.tickets.len(), changed: Vec::new() },
    };
    Ok(check)
}

fn runs_root(app: &AppHandle) -> PathBuf {
    crate::bridge::launch::runs_root(&crate::data_dir::app_data_dir(app).path)
}

fn account_of_window(app: &AppHandle, window_id: &str) -> Result<String, String> {
    window_account(app.state::<Mutex<StateStore>>().inner(), window_id)
}

/// Whether the window's Claude account has ClickUp set up.
#[tauri::command]
pub async fn clickup_intake_status(app: AppHandle, window_id: String) -> Result<IntakeStatus, String> {
    let account = account_of_window(&app, &window_id)?;
    with_deps(app, move |deps| status(deps, &account)).await
}

/// Fetch: what the pasted refs hold, with the window's account.
#[tauri::command]
pub async fn clickup_intake_preview(
    app: AppHandle,
    window_id: String,
    refs: Vec<IntakeRef>,
    filters: IntakeFilters,
) -> Result<IntakePreview, String> {
    let account = account_of_window(&app, &window_id)?;
    with_deps(app, move |deps| preview(deps, &account, &refs, &filters)).await
}

/// Start: the snapshot of the ticked tickets with their comments, kept for
/// the start that passes its `intakeId`.
#[tauri::command]
pub async fn clickup_intake_snapshot(
    app: AppHandle,
    window_id: String,
    refs: Vec<IntakeRef>,
    filters: IntakeFilters,
    ticket_ids: Option<Vec<String>>,
) -> Result<IntakeStaged, String> {
    let account = account_of_window(&app, &window_id)?;
    let handle = app.clone();
    with_deps(app, move |deps| {
        let state = handle.state::<IntakeState>();
        stage(deps, state.inner(), &account, &refs, &filters, ticket_ids.as_deref())
    })
    .await
}

/// The tickets ClickUp edited since the run's intake; `null` for a run that
/// did not start from ClickUp.
#[tauri::command]
pub async fn clickup_intake_check(app: AppHandle, run_id: String) -> Result<Option<IntakeCheck>, String> {
    let runs = runs_root(&app);
    let handle = app.clone();
    with_deps(app, move |deps| check(deps, handle.state::<IntakeState>().inner(), &runs, run_id.trim())).await
}

/// Pull again: re-read those tickets into the run's `tickets.json`.
#[tauri::command]
pub async fn clickup_intake_pull(
    app: AppHandle,
    run_id: String,
    ticket_ids: Vec<String>,
) -> Result<IntakeCheck, String> {
    let runs = runs_root(&app);
    let handle = app.clone();
    with_deps(app, move |deps| {
        pull(
            deps,
            handle.state::<IntakeState>().inner(),
            handle.state::<Mutex<StateStore>>().inner(),
            &handle,
            &runs,
            run_id.trim(),
            &ticket_ids,
        )
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clickup::client::tests::{fixture, ok, FakeClock, Recorded};
    use crate::clickup::secret::MemoryStore;
    use crate::clickup::{Gate, SecretStore};
    use crate::store::settings_store::{ClaudeAccount, ClickUpWorkspace, ProvidersSettings};
    use crate::store::{AppStateFile, SettingsStore, MAIN_WINDOW_ID};

    const WORK_TOKEN: &str = "pk_81234567_WORKINTAKELEAK0123456789AB";
    const HOME_TOKEN: &str = "pk_99999999_HOMEINTAKELEAK0123456789AB";
    const EPIC: &str = "/task/7xk2epic01?include_subtasks=true&include_markdown_description=true";
    const RUN: &str = "ee_1760000000200";

    struct Env {
        dir: crate::test_support::TempDir,
        settings: Mutex<SettingsStore>,
        secrets: MemoryStore,
        gate: Gate,
        clock: FakeClock,
    }

    /// Two Claude accounts, each config folder inside the test dir; `work`
    /// has a token and workspace, `home` a token and its own workspace.
    fn env(tag: &str) -> Env {
        let dir = crate::test_support::TempDir::new(&format!("clickup_intake_{tag}"));
        let mut store = SettingsStore::open(dir.path()).unwrap();
        let folder = |name: &str| Some(dir.join(name).to_string_lossy().into_owned());
        let mut providers = ProvidersSettings::default();
        providers.claude.config_dir = folder("claude-work");
        providers.claude.accounts = vec![
            ClaudeAccount { id: "default".into(), name: "Work".into(), config_dir: folder("claude-work") },
            ClaudeAccount { id: "home".into(), name: "Home".into(), config_dir: folder("claude-home") },
        ];
        store.set_providers(providers).unwrap();
        for account in &store.providers().claude.accounts {
            let folder = account.config_dir.as_deref().unwrap();
            assert!(Path::new(folder).starts_with(dir.path()), "{folder} is outside the test dir");
        }
        store
            .set_clickup_workspace("default", Some(ClickUpWorkspace { team_id: "9012345678".into(), team_name: "Koneksi QA".into() }))
            .unwrap();
        store
            .set_clickup_workspace("home", Some(ClickUpWorkspace { team_id: "9055555555".into(), team_name: "Home".into() }))
            .unwrap();
        let secrets = MemoryStore::default();
        secrets.set("default", &ClickUpToken::parse(WORK_TOKEN).unwrap()).unwrap();
        secrets.set("home", &ClickUpToken::parse(HOME_TOKEN).unwrap()).unwrap();
        Env { dir, settings: Mutex::new(store), secrets, gate: Gate::new(), clock: FakeClock::at(1_790_000_000) }
    }

    impl Env {
        fn deps<'a>(&'a self, api: &'a Recorded) -> Deps<'a> {
            Deps { settings: &self.settings, secrets: &self.secrets, env: None, env_rejected: false, transport: api, gate: &self.gate, clock: &self.clock }
        }

        fn runs(&self) -> PathBuf {
            self.dir.join("runs")
        }

        /// Every file under the test dir, as text.
        fn files(&self) -> Vec<(String, String)> {
            let mut out = Vec::new();
            let mut stack = vec![self.dir.path().to_path_buf()];
            while let Some(next) = stack.pop() {
                for entry in std::fs::read_dir(&next).unwrap().flatten() {
                    let path = entry.path();
                    if path.is_dir() {
                        stack.push(path);
                    } else {
                        let text = String::from_utf8_lossy(&std::fs::read(&path).unwrap()).into_owned();
                        out.push((path.display().to_string(), text));
                    }
                }
            }
            out
        }
    }

    fn epic_ref() -> Vec<IntakeRef> {
        vec![IntakeRef { kind: "task".into(), id: "7xk2epic01".into(), team_id: None, custom: false, line: 1 }]
    }

    fn epic_api() -> Recorded {
        Recorded::default()
            .on(EPIC, ok(fixture("task-with-subtasks.json")))
            .on("/task/86b1aa001?include_subtasks=true&include_markdown_description=true", ok(fixture("task-86b1aa001.json")))
            .on("/task/86b1aa002?include_subtasks=true&include_markdown_description=true", ok(fixture("task-86b1aa002.json")))
            .on("/task/86b1aa001/comment", ok(fixture("comments.json")))
            .on("/task/86b1aa002/comment", ok(r#"{"comments":[]}"#.into()))
    }

    fn state_store(dir: &Path) -> Mutex<StateStore> {
        let mut store = StateStore {
            path: dir.join("state.json"),
            data: AppStateFile::default(),
            new_tab_provider: crate::provider::ProviderId::DEFAULT,
            draft_window: MAIN_WINDOW_ID.to_string(),
        };
        store.data.windows.push(crate::store::WindowRecord { id: "w-home".into(), account_id: "home".into(), active_tab_id: None, layout: Default::default() });
        Mutex::new(store)
    }

    #[derive(Default)]
    struct Events(Mutex<Vec<String>>);
    impl ChainEvents for Events {
        fn chain_run_updated(&self, chain_id: &str) {
            self.0.lock().unwrap().push(chain_id.to_string());
        }
    }

    #[test]
    fn a_window_uses_only_its_own_account_s_token_and_workspace() {
        let env = env("isolation");
        let store = state_store(env.dir.path());
        assert_eq!(window_account(&store, MAIN_WINDOW_ID).unwrap(), "default");
        assert_eq!(window_account(&store, "w-home").unwrap(), "home");

        let api = Recorded::default().on(EPIC, ok(fixture("task-with-subtasks.json")));
        preview(&env.deps(&api), "default", &epic_ref(), &IntakeFilters::default()).unwrap();
        let custom = vec![IntakeRef { kind: "task".into(), id: "QA-1".into(), team_id: None, custom: true, line: 1 }];
        let home_path = "/task/QA-1?include_subtasks=true&include_markdown_description=true&custom_task_ids=true&team_id=9055555555";
        let api_home = Recorded::default().on(home_path, ok(r#"{"id":"h1","name":"Home task"}"#.into()));
        let home = preview(&env.deps(&api_home), "home", &custom, &IntakeFilters::default()).unwrap();
        assert_eq!(home.tickets[0].id, "h1");
        assert_eq!(api.calls.lock().unwrap()[0].1, WORK_TOKEN);
        // The home window's custom id is looked up in the home workspace, with the home token.
        assert_eq!(*api_home.calls.lock().unwrap(), vec![(home_path.to_string(), HOME_TOKEN.to_string())]);
    }

    #[test]
    fn an_account_with_no_token_or_workspace_is_pointed_to_settings() {
        let env = env("no_token");
        env.secrets.clear("home").unwrap();
        let api = Recorded::default();
        let err = preview(&env.deps(&api), "home", &epic_ref(), &IntakeFilters::default()).unwrap_err();
        assert_eq!(err, "ClickUp is not set up for the Claude account \"Home\". Add its token under Settings › Integrations.");
        assert!(api.paths().is_empty(), "the work token was not tried instead");
        let s = status(&env.deps(&api), "home").unwrap();
        assert_eq!((s.account_name.as_str(), s.configured), ("Home", false));
        assert!(status(&env.deps(&api), "default").unwrap().configured);

        env.settings.lock().unwrap().set_clickup_workspace("default", None).unwrap();
        let err = preview(&env.deps(&api), "default", &epic_ref(), &IntakeFilters::default()).unwrap_err();
        assert!(err.contains("press Test under Settings › Integrations"), "{err}");
        assert!(!status(&env.deps(&api), "default").unwrap().configured);
    }

    #[test]
    fn a_staged_snapshot_is_taken_once_by_a_start_in_the_same_account() {
        let env = env("pending");
        let state = IntakeState::default();
        let api = epic_api();
        let staged = stage(&env.deps(&api), &state, "default", &epic_ref(), &IntakeFilters::default(), None).unwrap();
        assert_eq!((staged.tickets, staged.excluded), (2, 1));
        assert_eq!(
            take_pending(&state, &staged.intake_id, "home").unwrap_err(),
            "These ClickUp tickets were fetched for another Claude account's window."
        );
        let snapshot = take_pending(&state, &staged.intake_id, "default").unwrap();
        assert_eq!(snapshot.source.account_id, "default");
        assert_eq!(snapshot.source.workspace_id, "9012345678");
        assert!(take_pending(&state, &staged.intake_id, "default").unwrap_err().contains("Fetch again"));
    }

    #[test]
    fn the_written_snapshot_holds_no_token_or_auth_data() {
        let env = env("leak");
        let state = IntakeState::default();
        let api = epic_api();
        let staged = stage(&env.deps(&api), &state, "default", &epic_ref(), &IntakeFilters::default(), None).unwrap();
        let snapshot = take_pending(&state, &staged.intake_id, "default").unwrap();
        let run_dir = folder::run_dir(&env.runs(), RUN).unwrap();
        let path = write_snapshot(&run_dir, &snapshot).unwrap();
        assert_eq!(path, run_dir.join("tickets.json"));
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"schema\": 1") || text.contains("\"schema\":1"), "{text}");
        for (file, text) in env.files() {
            for secret in [WORK_TOKEN, HOME_TOKEN, "Authorization", "pk_"] {
                assert!(!text.contains(secret), "{secret} in {file}");
            }
        }
        assert!(serde_json::to_string(&staged).unwrap().find("pk_").is_none());
        // The calls did carry the work token, as the header.
        assert!(api.calls.lock().unwrap().iter().all(|(_, auth)| auth == WORK_TOKEN));
    }

    fn run_with_snapshot(env: &Env) -> (IntakeState, Mutex<StateStore>) {
        let state = IntakeState::default();
        let api = epic_api();
        let staged = stage(&env.deps(&api), &state, "default", &epic_ref(), &IntakeFilters::default(), None).unwrap();
        let snapshot = take_pending(&state, &staged.intake_id, "default").unwrap();
        write_snapshot(&folder::run_dir(&env.runs(), RUN).unwrap(), &snapshot).unwrap();
        let store = state_store(env.dir.path());
        {
            let mut s = store.lock().unwrap();
            let role = crate::store::bundled_seed().unwrap().roles.into_iter().find(|r| r.id == "role_planner").unwrap();
            let tab = s.create_draft_tab(&role, "/tmp", true, None).unwrap();
            let chain = crate::store::ChainRef {
                chain_id: RUN.into(),
                kind: "eagle1".into(),
                step: 1,
                total: 4,
                round: 1,
                lane: None,
            };
            s.set_tab_chain(&tab, Some(chain), None).unwrap();
        }
        (state, store)
    }

    fn edited_api() -> Recorded {
        Recorded::default()
            .on("/task/86b1aa001?include_subtasks=true&include_markdown_description=true", ok(r#"{"id":"86b1aa001","name":"Sync (edited)","date_updated":"1790000000000"}"#.into()))
            .on("/task/86b1aa002?include_subtasks=true&include_markdown_description=true", ok(r#"{"id":"86b1aa002","date_updated":"1789960000000"}"#.into()))
    }

    #[test]
    fn the_change_check_uses_the_run_s_account_and_runs_at_most_every_five_minutes() {
        let env = env("check");
        let (state, _store) = run_with_snapshot(&env);
        let api = edited_api();
        let first = check(&env.deps(&api), &state, &env.runs(), RUN).unwrap().unwrap();
        assert_eq!(first.tickets, 2);
        let changed: Vec<&str> = first.changed.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(changed, ["86b1aa001"]);
        assert!(api.calls.lock().unwrap().iter().all(|(_, auth)| auth == WORK_TOKEN));
        // Within five minutes: the same answer, no call.
        let idle = Recorded::default();
        assert_eq!(check(&env.deps(&idle), &state, &env.runs(), RUN).unwrap(), Some(first));
        assert!(idle.paths().is_empty());
        // A run with no snapshot has nothing to check.
        assert_eq!(check(&env.deps(&idle), &state, &env.runs(), "ee_other").unwrap(), None);
    }

    #[test]
    fn pull_again_rewrites_tickets_json_notes_the_timeline_and_clears_the_change() {
        let env = env("pull");
        let (state, store) = run_with_snapshot(&env);
        check(&env.deps(&edited_api()), &state, &env.runs(), RUN).unwrap();
        let api = Recorded::default()
            .on("/task/86b1aa001?include_subtasks=true&include_markdown_description=true", ok(r#"{"id":"86b1aa001","name":"Sync (edited)","date_updated":"1790000000000"}"#.into()))
            .on("/task/86b1aa001/comment", ok(r#"{"comments":[]}"#.into()));
        let events = Events::default();
        let after = pull(&env.deps(&api), &state, &store, &events, &env.runs(), RUN, &["86b1aa001".into()]).unwrap();
        assert!(after.changed.is_empty());
        let text = std::fs::read_to_string(env.runs().join(RUN).join("tickets.json")).unwrap();
        let snapshot: TicketsSnapshot = serde_json::from_str(&text).unwrap();
        assert_eq!(snapshot.tickets[0].row.title, "Sync (edited)");
        assert_eq!(snapshot.pulls[0].ticket_ids, ["86b1aa001"]);
        let store = store.lock().unwrap();
        let run = store.pipeline_run_by_id(RUN).unwrap();
        assert!(run.events.iter().any(|e| e.summary == "Pulled 1 ticket again from ClickUp into tickets.json: 86b1aa001"));
        assert_eq!(*events.0.lock().unwrap(), [RUN]);
        for (file, text) in env.files() {
            assert!(!text.contains(WORK_TOKEN), "token in {file}");
        }
    }

    fn seed_role(id: &str) -> crate::roles::Role {
        crate::store::bundled_seed().unwrap().roles.into_iter().find(|r| r.id == id).unwrap()
    }

    fn staged_snapshot(env: &Env) -> TicketsSnapshot {
        let state = IntakeState::default();
        let staged = stage(&env.deps(&epic_api()), &state, "default", &epic_ref(), &IntakeFilters::default(), None).unwrap();
        take_pending(&state, &staged.intake_id, "default").unwrap()
    }

    #[test]
    fn an_engine_2_first_stage_gets_a_tickets_json_note_in_its_context_and_keeps_its_request() {
        let env = env("start_e2");
        let planner = seed_role("role_planner");
        let mut values = HashMap::from([
            ("request".to_string(), "Fix the QA 1.2.8 medium findings.".to_string()),
            ("additionalContext".to_string(), "Staging only.".to_string()),
        ]);
        let run_dir = env.runs().join(RUN);
        let launch = intake_for_start(&planner, &mut values, staged_snapshot(&env), Some(&run_dir));
        assert_eq!(values["request"], "Fix the QA 1.2.8 medium findings.", "the dictated text stays as it is");
        let context = &values["additionalContext"];
        assert!(context.contains(&run_dir.join("tickets.json").display().to_string()), "{context}");
        assert!(context.contains("- 86b1aa001 (QA-129) [high] Sync stalls on a folder of 7,839 files"), "{context}");
        assert!(context.ends_with("Staging only."), "your context stays after it: {context}");
        assert!(launch.tail.is_empty());
        assert_eq!(launch.write.as_ref().map(|s| s.tickets.len()), Some(2));
        // The merged prompt carries it.
        values.insert("cwd".into(), env.dir.path().display().to_string());
        values.insert("currentBehavior".into(), "They are open.".into());
        values.insert("title".into(), "QA 1.2.8".into());
        values.insert("taskType".into(), "Bug".into());
        values.insert("expectedBehavior".into(), "Each finding is fixed.".into());
        let merged = crate::template::merge_role_prompt_with(&planner, &values, "");
        assert!(merged.errors.is_empty(), "{:?}", merged.errors);
        let text = merged.merged.expect("merges").text;
        assert!(text.contains("tickets.json") && text.contains("[high] Sync stalls"), "{text}");
    }

    #[test]
    fn fetched_tickets_answer_the_required_fields_left_empty_and_keep_what_you_typed() {
        let env = env("start_empty");
        let planner = seed_role("role_planner");
        let run_dir = env.runs().join(RUN);
        let mut values = HashMap::from([("cwd".to_string(), env.dir.path().display().to_string())]);
        intake_for_start(&planner, &mut values, staged_snapshot(&env), Some(&run_dir));
        assert_eq!(values["taskType"], "Feature");
        assert_eq!(values["title"], "Sync stalls on a folder of 7,839 files (+1 more ClickUp tickets)");
        assert!(!values["request"].is_empty() && !values["expectedBehavior"].is_empty());
        let merged = crate::template::merge_role_prompt_with(&planner, &values, "");
        assert!(merged.errors.is_empty(), "Start needs no typing: {:?}", merged.errors);
        // A Bug shows Current Behavior: it is answered too; typed fields stay.
        let mut values = HashMap::from([
            ("cwd".to_string(), env.dir.path().display().to_string()),
            ("taskType".to_string(), "Bug".to_string()),
            ("title".to_string(), "QA 1.2.8".to_string()),
        ]);
        intake_for_start(&planner, &mut values, staged_snapshot(&env), Some(&run_dir));
        assert_eq!((values["taskType"].as_str(), values["title"].as_str()), ("Bug", "QA 1.2.8"));
        assert!(!values["currentBehavior"].is_empty());
        assert!(crate::template::merge_role_prompt_with(&planner, &values, "").errors.is_empty());
    }

    #[test]
    fn any_other_start_gets_the_summary_in_its_request_and_writes_no_file() {
        let env = env("start_e1");
        let planner = seed_role("role_planner");
        let mut values = HashMap::from([("request".to_string(), "Fix these.".to_string())]);
        let launch = intake_for_start(&planner, &mut values, staged_snapshot(&env), None);
        assert!(launch.write.is_none());
        let request = &values["request"];
        assert!(request.starts_with("Tickets from ClickUp (2):"), "{request}");
        assert!(request.contains("<https://app.clickup.com/t/86b1aa001>"), "{request}");
        assert!(request.ends_with("Fix these."), "{request}");
        assert!(!request.contains("tickets.json"));
        // A role with no request or context field gets it after its prompt.
        let mut bare = planner.clone();
        bare.fields.retain(|f| !["request", "description", "additionalContext"].contains(&f.key.as_str()));
        let mut values = HashMap::new();
        let launch = intake_for_start(&bare, &mut values, staged_snapshot(&env), None);
        assert!(launch.tail.starts_with("Tickets from ClickUp (2):"));
        assert!(values.values().all(|v| !v.contains("Tickets from ClickUp")), "{values:?}");
    }


    #[test]
    fn a_start_that_never_began_its_run_swaps_the_tickets_json_note_for_the_request_summary() {
        let env = env("no_run");
        let planner = seed_role("role_planner");
        let mut values = HashMap::from([("request".to_string(), "Fix these.".to_string())]);
        let run_dir = env.runs().join(RUN);
        let mut launch = intake_for_start(&planner, &mut values, staged_snapshot(&env), Some(&run_dir));
        let store = state_store(env.dir.path());
        let tab = {
            let mut s = store.lock().unwrap();
            let tab = s.create_draft_tab(&planner, "/tmp", true, None).unwrap();
            let record = s.data.tabs.iter_mut().find(|t| t.id == tab).unwrap();
            record.answers = values.clone();
            record.merged_prompt = format!("Plan this.\n\n{}", values["additionalContext"]);
            tab
        };
        let (from, to) = launch.without_run().expect("it had a file to write");
        assert_eq!(from, from.trim(), "kept trimmed, as the form holds it (L3)");
        assert!(launch.write.is_none(), "no tickets.json now");
        assert!(launch.without_run().is_none(), "once");
        assert!(from.contains("tickets.json") && !to.contains("tickets.json"));
        assert!(to.contains("<https://app.clickup.com/t/86b1aa001>"));
        swap_tab_note(&mut store.lock().unwrap(), &tab, &from, &to).unwrap();
        let s = store.lock().unwrap();
        let record = s.tab_by_id(&tab).unwrap();
        assert!(!record.merged_prompt.contains("tickets.json"), "{}", record.merged_prompt);
        assert!(record.merged_prompt.contains("Tickets from ClickUp (2):"));
        assert!(!record.answers["additionalContext"].contains("tickets.json"));
        assert_eq!(record.answers["request"], "Fix these.");
        assert_eq!(record.merged_prompt_hash, crate::template::template_hash(&record.merged_prompt));
    }

    #[test]
    fn checks_for_runs_that_are_gone_are_pruned() {
        let env = env("prune");
        let (state, _store) = run_with_snapshot(&env);
        check(&env.deps(&edited_api()), &state, &env.runs(), RUN).unwrap();
        assert!(state.checks.lock().unwrap().contains_key(RUN));
        std::fs::remove_dir_all(env.runs().join(RUN)).unwrap();
        let idle = Recorded::default();
        assert_eq!(check(&env.deps(&idle), &state, &env.runs(), "ee_other").unwrap(), None);
        assert!(state.checks.lock().unwrap().is_empty());
    }

}
