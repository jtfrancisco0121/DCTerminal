//! Write-back commands (C3) against recorded ClickUp replies. No network,
//! no keychain, and every Claude account folder inside the test dir.

use super::*;
use crate::bridge::folder::TICKETS_FILE;
use crate::clickup::client::tests::{ok, status, FakeClock, Recorded};
use crate::clickup::secret::MemoryStore;
use crate::clickup::writeback::tests::{snapshot, ticket};
use crate::clickup::{ClickUpToken, Gate, Reply, SecretStore};
use crate::store::settings_store::{ClaudeAccount, ClickUpWorkspace, ProvidersSettings};
use crate::store::{AppStateFile, VerifyRecord, MAIN_WINDOW_ID};

const WORK_TOKEN: &str = "pk_81234567_WORKWRITEBACKLEAK0123456789";
const HOME_TOKEN: &str = "pk_99999999_HOMEWRITEBACKLEAK0123456789";
const RUN: &str = "ee_1760000000400";
const LIST: &str = "901800112233";
const LIST_REPLY: &str = r#"{"id":"901800112233","name":"QA 1.2.8","statuses":[{"status":"to do","type":"open"},{"status":"QA PASSED","type":"custom"},{"status":"complete","type":"closed"}]}"#;

struct Env {
    dir: crate::test_support::TempDir,
    settings: Mutex<SettingsStore>,
    secrets: MemoryStore,
    gate: Gate,
    clock: FakeClock,
    store: Mutex<StateStore>,
    state: WritebackState,
}

#[derive(Default)]
struct Events(Mutex<Vec<String>>);
impl ChainEvents for Events {
    fn chain_run_updated(&self, chain_id: &str) {
        self.0.lock().unwrap().push(chain_id.to_string());
    }
}

/// Two Claude accounts with their own tokens and workspaces, each config
/// folder inside the test dir, and a run in a window of the first.
fn env(tag: &str) -> Env {
    let dir = crate::test_support::TempDir::new(&format!("clickup_writeback_{tag}"));
    let mut settings = SettingsStore::open(dir.path()).unwrap();
    let folder = |name: &str| Some(dir.join(name).to_string_lossy().into_owned());
    let mut providers = ProvidersSettings::default();
    providers.claude.config_dir = folder("claude-work");
    providers.claude.accounts = vec![
        ClaudeAccount { id: "default".into(), name: "Work".into(), config_dir: folder("claude-work") },
        ClaudeAccount { id: "home".into(), name: "Home".into(), config_dir: folder("claude-home") },
    ];
    settings.set_providers(providers).unwrap();
    for account in &settings.providers().claude.accounts {
        let folder = account.config_dir.as_deref().unwrap();
        assert!(Path::new(folder).starts_with(dir.path()), "{folder} is outside the test dir");
    }
    settings
        .set_clickup_workspace("default", Some(ClickUpWorkspace { team_id: "9012345678".into(), team_name: "Koneksi QA".into() }))
        .unwrap();
    settings
        .set_clickup_workspace("home", Some(ClickUpWorkspace { team_id: "9055555555".into(), team_name: "Home".into() }))
        .unwrap();
    let secrets = MemoryStore::default();
    secrets.set("default", &ClickUpToken::parse(WORK_TOKEN).unwrap()).unwrap();
    secrets.set("home", &ClickUpToken::parse(HOME_TOKEN).unwrap()).unwrap();

    let mut store = StateStore {
        path: dir.join("state.json"),
        data: AppStateFile::default(),
        new_tab_provider: crate::provider::ProviderId::DEFAULT,
        draft_window: MAIN_WINDOW_ID.to_string(),
    };
    store.data.windows.push(crate::store::WindowRecord {
        id: "w-home".into(),
        account_id: "home".into(),
        active_tab_id: None,
        layout: Default::default(),
    });
    let role = crate::store::bundled_seed().unwrap().roles.into_iter().find(|r| r.id == "role_planner").unwrap();
    let tab = store.create_draft_tab(&role, "/tmp", true, None).unwrap();
    let chain = crate::store::ChainRef { chain_id: RUN.into(), kind: "eagle1".into(), step: 1, total: 4, round: 1, lane: None };
    store.set_tab_chain(&tab, Some(chain), None).unwrap();
    assert!(store.pipeline_run_by_id(RUN).is_some());
    Env {
        dir,
        settings: Mutex::new(settings),
        secrets,
        gate: Gate::new(),
        clock: FakeClock::at(1_790_000_000),
        store: Mutex::new(store),
        state: WritebackState::default(),
    }
}

impl Env {
    fn deps<'a>(&'a self, api: &'a Recorded) -> Deps<'a> {
        Deps {
            settings: &self.settings,
            secrets: &self.secrets,
            env: None,
            env_rejected: false,
            transport: api,
            gate: &self.gate,
            clock: &self.clock,
        }
    }

    fn runs(&self) -> PathBuf {
        self.dir.join("runs")
    }

    fn run_dir(&self) -> PathBuf {
        self.runs().join(RUN)
    }

    /// `tickets.json` with two tickets in [`LIST`], taken by the work account.
    fn with_tickets(&self) {
        std::fs::create_dir_all(self.run_dir()).unwrap();
        let snap = snapshot(vec![ticket("86b1aa001", Some("QA-129"), Some(LIST)), ticket("86b1aa002", None, Some(LIST))]);
        folder::write_json(&self.run_dir().join(TICKETS_FILE), &snap).unwrap();
    }

    /// The Implementer's `prs.json` for the run's own stages.
    fn with_prs(&self) {
        let prs = RunPrs {
            schema: 1,
            run_id: RUN.into(),
            stage_key: "implementer".into(),
            lane: None,
            turn: "t1".into(),
            at: "2026-10-22T10:00:00Z".into(),
            result: serde_json::json!({
                "prs": [{ "url": "https://github.com/koneksi/desktop/pull/412", "branch": "ee-pr1", "title": "Sync large folders" }],
                "summary": "Sync now pages through folders of any size."
            }),
        };
        folder::write_json(&self.run_dir().join("prs.json"), &prs).unwrap();
    }

    fn verify(&self, verified: bool) {
        let mut store = self.store.lock().unwrap();
        let run = store.pipeline_run_by_id_mut(RUN).unwrap();
        run.verifications.push(VerifyRecord {
            stage_id: "implementer".into(),
            lane: None,
            repo: None,
            round: 1,
            attempt: 1,
            label: "verify".into(),
            steps: "Run the qa128-ml Playwright project on the Windows staging build.".into(),
            result: if verified { "verified" } else { "failed" }.into(),
            note: Some("7,839 files synced.".into()),
            by: "you".into(),
            at: "2026-10-22T11:00:00Z".into(),
            prs: Vec::new(),
            turn: None,
        });
    }

    fn map_list(&self) {
        self.settings
            .lock()
            .unwrap()
            .set_clickup_status_map("default", LIST, Some(ClickUpStatusMap { verified: "QA PASSED".into(), list_name: "QA 1.2.8".into() }))
            .unwrap();
    }

    fn load(&self) -> Option<WritebackView> {
        load(&self.settings, &self.store, &self.state, &self.runs(), RUN).unwrap()
    }

    fn tick(&self, ticket: &str) -> WritebackView {
        edit(&self.settings, &self.state, &self.runs(), RUN, ticket, &RowEdit { ticked: Some(true), ..Default::default() }).unwrap()
    }

    /// Send ticked, as the overview asks it: the rows it shows ticked, as shown.
    fn send(&self, api: &Recorded, window_account: &str) -> Result<WritebackSent, String> {
        let shown = self.load().map(|v| v.proposals).unwrap_or_default();
        self.send_rows(api, window_account, &shown_ticked(&shown))
    }

    fn send_rows(&self, api: &Recorded, window_account: &str, rows: &[SendRequest]) -> Result<WritebackSent, String> {
        send(&self.deps(api), &self.state, &self.store, &Events::default(), &self.runs(), RUN, window_account, rows)
    }

    fn saved(&self) -> Writeback {
        serde_json::from_str(&std::fs::read_to_string(self.run_dir().join(WRITEBACK_FILE)).unwrap()).unwrap()
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
                    out.push((path.display().to_string(), String::from_utf8_lossy(&std::fs::read(&path).unwrap()).into_owned()));
                }
            }
        }
        out
    }
}

/// What the overview sends for the rows it shows ticked.
fn shown_ticked(rows: &[Proposal]) -> Vec<SendRequest> {
    rows.iter()
        .filter(|p| p.ticked && !p.skipped)
        .map(|p| SendRequest { ticket_id: p.ticket.id.clone(), comment: p.comment.clone(), status: p.status.clone() })
        .collect()
}

#[test]
fn a_run_without_tickets_or_before_anything_is_verified_shows_nothing_and_writes_no_file() {
    let env = env("nothing");
    env.verify(true);
    assert_eq!(env.load(), None, "no tickets.json: nothing new");
    assert!(!env.run_dir().join(WRITEBACK_FILE).exists());
    let env = env_with_tickets("not_due");
    assert_eq!(env.load(), None, "nothing verified and the run is not complete");
    env.verify(false);
    assert_eq!(env.load(), None, "a failed verification is no trigger");
    assert!(!env.run_dir().join(WRITEBACK_FILE).exists());
}

fn env_with_tickets(tag: &str) -> Env {
    let env = env(tag);
    env.with_tickets();
    env.with_prs();
    env
}

#[test]
fn a_verified_run_proposes_a_comment_from_its_files_and_the_mapped_status() {
    let env = env_with_tickets("verified");
    env.map_list();
    env.verify(true);
    let view = env.load().expect("proposals are due");
    assert_eq!((view.account_id.as_str(), view.account_name.as_str()), ("default", "Work"));
    assert_eq!(view.lists, [ListMapping { id: LIST.into(), name: "QA 1.2.8".into(), verified: Some("QA PASSED".into()) }]);
    assert_eq!(view.proposals.len(), 2);
    let first = &view.proposals[0];
    assert!(!first.ticked, "nothing is ticked for you");
    assert_eq!(first.status.as_deref(), Some("QA PASSED"));
    for part in [
        "Sync large folders: https://github.com/koneksi/desktop/pull/412",
        "What changed:\nSync now pages through folders of any size.",
        "How it was verified:\nRun the qa128-ml Playwright project on the Windows staging build.",
        "Note: 7,839 files synced.",
    ] {
        assert!(first.comment.contains(part), "{part} not in {}", first.comment);
    }
    // It is in the run folder, and a second load changes nothing.
    assert_eq!(env.saved().proposals, view.proposals);
    assert_eq!(env.load(), Some(view));
}

#[test]
fn a_completed_run_with_several_lanes_and_no_ticket_mapping_proposes_no_status() {
    let env = env_with_tickets("lanes");
    env.map_list();
    {
        let mut store = env.store.lock().unwrap();
        let run = store.pipeline_run_by_id_mut(RUN).unwrap();
        run.status = RunStatus::Complete;
        for id in ["pr1", "pr2"] {
            run.lanes.push(RunLane {
                id: id.into(),
                title: format!("{} — Work", id.to_uppercase()),
                depends_on: Vec::new(),
                status: "approved".into(),
                stage: "implementer".into(),
                round: 1,
                tab_ids: Default::default(),
                handoffs: Default::default(),
                verdicts: Vec::new(),
                repo: None,
            });
        }
    }
    let view = env.load().unwrap();
    assert!(view.proposals.iter().all(|p| p.status.is_none()));
    assert!(view.proposals[0].status_note.as_deref().unwrap().contains("several lanes"));
    // The plan names each ticket's task, by id or custom id (here in a story): now they match.
    std::fs::write(
        env.run_dir().join(TASKS_FILE),
        r#"{"schema":1,"runId":"x","stageKey":"planner","turn":"t","at":"t","tasks":[
            {"id":"pr1","title":"A","summary":"a","tickets":["86b1aa002"]},
            {"id":"PR2","title":"B","summary":"b","stories":[{"id":"s1","title":"S","tickets":["QA-129"]}]}]}"#,
    )
    .unwrap();
    let view = env.load().unwrap();
    assert_eq!(view.proposals[0].lanes, ["pr2"]);
    assert_eq!(view.proposals[1].lanes, ["pr1"]);
    assert!(view.proposals[0].status_note.as_deref().unwrap().starts_with("Not marked verified"));
}

#[test]
fn send_with_nothing_ticked_makes_no_call() {
    let env = env_with_tickets("unticked");
    env.map_list();
    env.verify(true);
    env.load().unwrap();
    let api = Recorded::default();
    let err = env.send(&api, "default").unwrap_err();
    assert_eq!(err, "Tick at least one update to send. Nothing is sent without a tick.");
    // A skipped row is not sent either, even if its tick was forced into the file.
    edit(&env.settings, &env.state, &env.runs(), RUN, "86b1aa001", &RowEdit { skipped: Some(true), ..Default::default() }).unwrap();
    let mut wb = env.saved();
    wb.proposals[0].ticked = true;
    write_writeback(&env.run_dir(), &wb).unwrap();
    assert!(env.send(&api, "default").is_err());
    assert!(api.calls.lock().unwrap().is_empty() && api.writes.lock().unwrap().is_empty());
    assert!(env.saved().proposals.iter().all(|p| p.sent.is_none()));
}

#[test]
fn another_account_s_window_or_a_changed_workspace_sends_nothing() {
    let env = env_with_tickets("isolation");
    env.map_list();
    env.verify(true);
    env.load().unwrap();
    env.tick("86b1aa001");
    let api = Recorded::default();
    assert_eq!(window_account(&env.store, "w-home").unwrap(), "home");
    let err = env.send(&api, "home").unwrap_err();
    assert!(err.contains("taken with the Claude account \"Work\""), "{err}");
    // The work account's workspace changed since intake.
    env.settings
        .lock()
        .unwrap()
        .set_clickup_workspace("default", Some(ClickUpWorkspace { team_id: "9087654321".into(), team_name: "Sandbox".into() }))
        .unwrap();
    let err = env.send(&api, "default").unwrap_err();
    assert!(err.contains("workspace of \"Work\" changed"), "{err}");
    assert!(api.calls.lock().unwrap().is_empty(), "no call with either token");
    assert!(env.saved().proposals[0].ticked && env.saved().proposals[0].sent.is_none());
}

#[test]
fn send_posts_only_ticked_rows_with_the_run_s_account_and_records_them() {
    let env = env_with_tickets("send");
    env.map_list();
    env.verify(true);
    env.load().unwrap();
    env.tick("86b1aa002");
    let api = Recorded::default()
        .on("PUT /task/86b1aa002", ok("{}".into()))
        .on("POST /task/86b1aa002/comment", ok(r#"{"id":"90"}"#.into()));
    let events = Events::default();
    let rows = shown_ticked(&env.load().unwrap().proposals);
    let sent = send(&env.deps(&api), &env.state, &env.store, &events, &env.runs(), RUN, "default", &rows).unwrap();
    assert_eq!((sent.sent, sent.failed), (1, 0));
    let writes = api.writes.lock().unwrap().clone();
    assert_eq!(writes.iter().map(|w| (w.method, w.path.as_str())).collect::<Vec<_>>(), [("PUT", "/task/86b1aa002"), ("POST", "/task/86b1aa002/comment")]);
    assert!(writes.iter().all(|w| w.auth == WORK_TOKEN));
    let saved = env.saved();
    assert!(saved.proposals[0].sent.is_none(), "86b1aa001 was not ticked");
    let row = &saved.proposals[1];
    assert_eq!(row.sent.as_ref().map(|s| s.status.as_deref()), Some(Some("QA PASSED")));
    assert!(!row.ticked && !sent.view.sending);
    let store = env.store.lock().unwrap();
    let run = store.pipeline_run_by_id(RUN).unwrap();
    assert!(run.events.iter().any(|e| e.summary == "Sent 1 ClickUp update: 86b1aa002 (comment, status QA PASSED)"), "{:?}", run.events);
    assert_eq!(*events.0.lock().unwrap(), [RUN]);
}

#[test]
fn a_failed_row_shows_clickup_s_error_on_the_timeline_and_a_retry_sends_it_once() {
    let env = env_with_tickets("retry");
    env.verify(true);
    env.load().unwrap();
    env.tick("86b1aa001");
    // No mapping: comment only.
    let api = Recorded::default()
        .on("POST /task/86b1aa001/comment", Err(crate::clickup::NoReply::Offline))
        .on("POST /task/86b1aa001/comment", ok("{}".into()));
    let first = env.send(&api, "default").unwrap();
    assert_eq!((first.sent, first.failed), (0, 1));
    let row = &env.saved().proposals[0];
    assert_eq!(row.error.as_deref(), Some("Could not reach ClickUp. Check your connection."));
    assert!(row.ticked, "still ticked, to retry");
    {
        let store = env.store.lock().unwrap();
        let run = store.pipeline_run_by_id(RUN).unwrap();
        assert!(run.events.iter().any(|e| e.summary == "ClickUp update for 86b1aa001 failed: Could not reach ClickUp. Check your connection."));
    }
    let again = env.send(&api, "default").unwrap();
    assert_eq!((again.sent, again.failed), (1, 0));
    assert!(env.saved().proposals[0].error.is_none());
    // Sent: a third send has nothing to send and makes no call.
    assert!(env.send(&api, "default").is_err());
    assert_eq!(api.writes.lock().unwrap().len(), 2);
}

#[test]
fn edits_wait_while_a_send_is_under_way() {
    let env = env_with_tickets("sending");
    env.verify(true);
    env.load().unwrap();
    let claim = claim_send(&env.state, RUN).unwrap();
    assert!(claim_send(&env.state, RUN).is_err(), "one send at a time");
    let err = edit(&env.settings, &env.state, &env.runs(), RUN, "86b1aa001", &RowEdit { ticked: Some(true), ..Default::default() }).unwrap_err();
    assert!(err.contains("being sent"), "{err}");
    assert!(env.load().unwrap().sending);
    drop(claim);
    assert!(!env.load().unwrap().sending);
    env.tick("86b1aa001");
}

#[test]
fn a_list_s_verified_status_is_mapped_from_its_real_statuses() {
    let env = env_with_tickets("map");
    env.verify(true);
    let before = env.load().unwrap();
    assert!(before.proposals[0].status_note.as_deref().unwrap().starts_with("Map a verified status"));
    let api = Recorded::default()
        .on(&format!("/list/{LIST}"), ok(LIST_REPLY.into()))
        .on(&format!("/list/{LIST}"), ok(LIST_REPLY.into()))
        .on(&format!("/list/{LIST}"), ok(LIST_REPLY.into()));
    let statuses = list_statuses(&env.deps(&api), "default", LIST).unwrap();
    assert_eq!(statuses.statuses.iter().map(|s| s.status.as_str()).collect::<Vec<_>>(), ["to do", "QA PASSED", "complete"]);
    let err = set_status_map(&env.deps(&api), "default", LIST, Some("verified")).unwrap_err();
    assert_eq!(err, "The list \"QA 1.2.8\" has no status \"verified\".");
    // Any case; ClickUp's spelling is kept.
    let maps = set_status_map(&env.deps(&api), "default", LIST, Some("qa passed")).unwrap();
    assert_eq!(maps, [ListMapping { id: LIST.into(), name: "QA 1.2.8".into(), verified: Some("QA PASSED".into()) }]);
    assert!(api.calls.lock().unwrap().iter().all(|(_, auth)| auth == WORK_TOKEN));
    assert!(api.writes.lock().unwrap().is_empty(), "mapping writes nothing to ClickUp");
    let after = env.load().unwrap();
    assert_eq!(after.proposals[0].status.as_deref(), Some("QA PASSED"));
    let all = all_mappings(&env.settings).unwrap();
    assert_eq!((all[0].account_name.as_str(), all[0].lists.len()), ("Work", 1));
    assert!(all[1].lists.is_empty(), "the home account maps its own lists");
    assert!(set_status_map(&env.deps(&api), "default", "a/b", Some("x")).is_err());
    assert!(set_status_map(&env.deps(&api), "default", LIST, None).unwrap().is_empty());
}

#[test]
fn no_token_reaches_writeback_json_a_reply_or_an_error() {
    let env = env_with_tickets("leak");
    env.map_list();
    env.verify(true);
    env.load().unwrap();
    env.tick("86b1aa001");
    env.tick("86b1aa002");
    // A careless server echoes the token in a refusal.
    let echo = Ok(Reply { status: 400, body: format!("{{\"err\":\"bad {WORK_TOKEN}\"}}"), ..Default::default() });
    let api = Recorded::default()
        .on("PUT /task/86b1aa001", echo)
        .on("PUT /task/86b1aa002", status(401))
        .on(&format!("/list/{LIST}"), ok(LIST_REPLY.into()));
    let mut seen = Vec::new();
    let sent = env.send(&api, "default").unwrap();
    assert_eq!(sent.failed, 2);
    seen.push(serde_json::to_string(&sent).unwrap());
    seen.push(env.send(&api, "home").unwrap_err());
    seen.push(serde_json::to_string(&list_statuses(&env.deps(&api), "default", LIST).unwrap()).unwrap());
    seen.push(serde_json::to_string(&env.load()).unwrap());
    for text in &seen {
        assert!(!text.contains(WORK_TOKEN) && !text.contains(HOME_TOKEN) && !text.contains("pk_"), "token in {text}");
    }
    for (file, text) in env.files() {
        for secret in [WORK_TOKEN, HOME_TOKEN, "Authorization"] {
            assert!(!text.contains(secret), "{secret} in {file}");
        }
    }
    assert!(api.calls.lock().unwrap().iter().all(|(path, auth)| auth == WORK_TOKEN && !path.contains("pk_")));
}

#[test]
fn a_ticked_row_injected_into_writeback_json_for_a_foreign_id_is_never_sent_or_shown() {
    let env = env_with_tickets("inject");
    env.map_list();
    env.verify(true);
    env.load().unwrap();
    // A stage writes a ticked row for a ticket that is not in tickets.json.
    let mut wb = env.saved();
    let mut foreign = wb.proposals[0].clone();
    foreign.ticket.id = "86b1evil9".into();
    foreign.ticked = true;
    wb.proposals.push(foreign.clone());
    write_writeback(&env.run_dir(), &wb).unwrap();
    assert!(env.load().unwrap().proposals.iter().all(|p| p.ticket.id != "86b1evil9"), "not offered");
    let api = Recorded::default();
    let asked = SendRequest { ticket_id: foreign.ticket.id.clone(), comment: foreign.comment.clone(), status: foreign.status.clone() };
    let sent = env.send_rows(&api, "default", &[asked]).unwrap();
    assert_eq!((sent.sent, sent.failed), (0, 0));
    assert!(sent.not_sent[0].reason.contains("not in the run's tickets.json"), "{:?}", sent.not_sent);
    // A tick written straight into the file for a real ticket sends nothing either.
    let mut wb = env.saved();
    wb.proposals[0].ticked = true;
    write_writeback(&env.run_dir(), &wb).unwrap();
    assert!(env.send_rows(&api, "default", &[]).is_err());
    // An edit for the foreign id is refused too.
    let err = edit(&env.settings, &env.state, &env.runs(), RUN, "86b1evil9", &RowEdit { ticked: Some(true), ..Default::default() }).unwrap_err();
    assert!(err.contains("not in this run's tickets.json"), "{err}");
    assert!(api.calls.lock().unwrap().is_empty() && api.writes.lock().unwrap().is_empty());
}

#[test]
fn a_send_that_dies_after_row_1_of_3_leaves_row_1_recorded_and_a_later_send_does_not_repeat_it() {
    let env = env("crash");
    std::fs::create_dir_all(env.run_dir()).unwrap();
    let snap = snapshot(vec![ticket("t1", None, Some(LIST)), ticket("t2", None, Some(LIST)), ticket("t3", None, Some(LIST))]);
    folder::write_json(&env.run_dir().join(TICKETS_FILE), &snap).unwrap();
    env.with_prs();
    env.verify(true);
    env.load().unwrap();
    for id in ["t1", "t2", "t3"] {
        env.tick(id);
    }
    // Row 2 has no recorded reply: the transport panics, as a quit mid-send would stop it.
    let api = Recorded::default().on("POST /task/t1/comment", ok("{}".into()));
    let rows = shown_ticked(&env.load().unwrap().proposals);
    let died = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| env.send_rows(&api, "default", &rows)));
    assert!(died.is_err());
    let saved = env.saved();
    assert!(saved.proposals[0].sent.is_some() && !saved.proposals[0].ticked, "row 1 was saved as soon as it went");
    assert!(saved.proposals[1].sent.is_none() && saved.proposals[2].sent.is_none());
    assert!(!env.load().unwrap().sending, "the send is not left claimed");
    // The next send posts rows 2 and 3 only.
    let api = Recorded::default()
        .on("POST /task/t2/comment", ok("{}".into()))
        .on("POST /task/t3/comment", ok("{}".into()));
    let again = env.send(&api, "default").unwrap();
    assert_eq!(again.sent, 2);
    let paths: Vec<String> = api.writes.lock().unwrap().iter().map(|w| w.path.clone()).collect();
    assert_eq!(paths, ["/task/t2/comment", "/task/t3/comment"]);
}

#[test]
fn a_row_changed_since_you_ticked_it_is_reported_and_not_sent() {
    let env = env_with_tickets("changed");
    env.verify(true);
    env.load().unwrap();
    env.tick("86b1aa001");
    let seen = shown_ticked(&env.load().unwrap().proposals);
    // A mapping arrives: the rebuild adds a status and unticks the row.
    env.map_list();
    let after = env.load().unwrap();
    assert_eq!(after.proposals[0].status.as_deref(), Some("QA PASSED"));
    assert!(!after.proposals[0].ticked);
    let api = Recorded::default();
    let sent = env.send_rows(&api, "default", &seen).unwrap();
    assert_eq!(sent.not_sent, [NotSent { ticket_id: "86b1aa001".into(), reason: writeback::CHANGED_SINCE_TICK.into() }]);
    assert!(api.writes.lock().unwrap().is_empty());
}
