//! R2: the round runner against a recording host. No terminal starts; each
//! plan run's start is recorded, and the test moves the runs on (stops,
//! completes) the way their actors would, then tells the runner, as the
//! app's `chain-run-updated` does.

use super::files::{rounds_root, ROUND_PLAN_FILE, RUNS_FILE};
use super::runner::{view, RoundAction, RoundMsg, Rounds};
use super::schedule::{next_to_start, plan_checkpoint, run_state, waiting_reason};
use super::types::{PlanRunState, QaRound};
use crate::bridge::round::{PlanStatus, Round, RoundPlan, RoundWave, RunRound};
use crate::pipelines::{GateDef, GateResult};
use crate::roles::Role;
use crate::run_actor::{Host, StageLaunch};
use crate::store::{AppStateFile, ChainRef, RepoEntry, RunStatus, StateStore, StopReason, MAIN_WINDOW_ID};
use crate::test_support::TempDir;
use serde_json::json;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

const TRIAGE: &str = "ee_1760000000300";

struct TestHost {
    store: Mutex<StateStore>,
    runs: PathBuf,
    roles: Vec<Role>,
    repos: Vec<RepoEntry>,
    launches: Mutex<Vec<StageLaunch>>,
    /// The next this many spawns fail.
    fail_spawns: AtomicUsize,
    changed: Mutex<Vec<String>>,
    _dir: TempDir,
}

impl Host for TestHost {
    fn store(&self) -> &Mutex<StateStore> {
        &self.store
    }
    fn runs_root(&self) -> PathBuf {
        self.runs.clone()
    }
    fn bridge_program(&self) -> Option<PathBuf> {
        Some(PathBuf::from("/opt/dcterminal"))
    }
    fn role(&self, role_id: &str) -> Option<Role> {
        self.roles.iter().find(|r| r.id == role_id).cloned()
    }
    fn bridge_gate(&self, _run_id: &str, _stage_key: &str, _cwd: &Path) -> Result<bool, String> {
        Ok(true)
    }
    fn spawn_stage(&self, launch: &StageLaunch) -> Result<(), String> {
        if self.fail_spawns.load(Ordering::SeqCst) > 0 {
            self.fail_spawns.fetch_sub(1, Ordering::SeqCst);
            return Err("claude is not installed".into());
        }
        self.launches.lock().unwrap().push(launch.clone());
        Ok(())
    }
    fn resume_stage(&self, _launch: &StageLaunch) -> Result<(), String> {
        Ok(())
    }
    fn paste(&self, _tab_id: &str, _text: &str) -> Result<(), String> {
        Ok(())
    }
    fn terminal_live(&self, _tab_id: &str) -> bool {
        false
    }
    fn run_gate(&self, _gate: &GateDef, _folder: &Path, _pr_urls: &[String]) -> GateResult {
        unreachable!("the round runner runs no gates")
    }
    fn usage_percent(&self, _run_id: &str) -> Option<u8> {
        None
    }
    fn rate_limit(&self, _tab_id: &str) -> Option<String> {
        None
    }
    fn run_changed(&self, run_id: &str) {
        self.changed.lock().unwrap().push(run_id.to_string());
    }
    fn tab_opened(&self, _run_id: &str, _tab_id: &str) {}
    fn stopped(&self, _run_id: &str, _tab_id: Option<&str>, _reason: StopReason, _summary: &str) {}
    fn notice(&self, _run_id: &str, _title: &str, _body: &str) {}
    fn repos(&self) -> Vec<RepoEntry> {
        self.repos.clone()
    }
}

fn plan(id: &str, wave: Option<u32>, status: PlanStatus, tickets: &[&str], repos: &[&str]) -> RoundPlan {
    RoundPlan {
        id: id.into(),
        title: format!("Title of {id}"),
        tickets: tickets.iter().map(|t| t.to_string()).collect(),
        repos: repos.iter().map(|r| r.to_string()).collect(),
        status,
        reason: (status != PlanStatus::Active).then(|| format!("{id} waits.")),
        wave,
        summary: format!("Fix the tickets of {id}."),
    }
}

/// Three active plans in two waves (plans 1 and 2, then plan 3), a parked
/// plan in wave 2 and a deferred plan.
fn the_round() -> Round {
    Round {
        plans: vec![
            plan("plan1", Some(1), PlanStatus::Active, &["QA-401"], &["backend"]),
            plan("plan2", Some(1), PlanStatus::Active, &["QA-402"], &["web"]),
            plan("plan3", Some(2), PlanStatus::Active, &["QA-403", "QA-404"], &["backend", "web"]),
            plan("plan4", Some(2), PlanStatus::Parked, &["QA-405"], &["web"]),
            plan("plan5", None, PlanStatus::Deferred, &["QA-406"], &["cdn"]),
        ],
        waves: vec![RoundWave { n: 1, why: "Isolated fixes".into() }, RoundWave { n: 2, why: "Builds on wave 1".into() }],
        merge_order: BTreeMap::from([
            ("backend".to_string(), vec!["plan1".to_string(), "plan3".to_string()]),
            ("web".to_string(), vec!["plan2".to_string(), "plan3".to_string(), "plan4".to_string()]),
        ]),
        excluded: Vec::new(),
    }
}

struct Fixture {
    host: Arc<TestHost>,
    rounds: Rounds<TestHost>,
    work: TempDir,
}

fn tickets_json() -> serde_json::Value {
    let ticket = |id: &str| {
        json!({ "id": id, "title": format!("Ticket {id}"), "priority": "normal", "status": "open", "statusType": "open",
                "url": format!("https://app.clickup.com/t/{id}"), "description": "", "comments": [], "tags": [] })
    };
    let tickets: Vec<serde_json::Value> = ["QA-401", "QA-402", "QA-403", "QA-404", "QA-405", "QA-406"].map(ticket).to_vec();
    json!({
        "schema": 1,
        "source": { "kind": "clickup", "accountId": "acct-test", "workspaceId": "ws-test", "refs": [],
                    "filters": { "priorities": [], "statuses": [], "tags": [] } },
        "fetchedAt": "2026-10-22T00:00:00.000Z",
        "limits": { "descriptionChars": 8000, "commentChars": 2000, "commentsPerTicket": 20, "note": "Capped." },
        "tickets": tickets,
        "excluded": [{ "id": "QA-499", "title": "Closed one", "priority": "low", "status": "closed", "statusType": "closed",
                       "url": "https://app.clickup.com/t/QA-499", "reason": "closed" }]
    })
}

impl Fixture {
    fn new(tag: &str) -> Self {
        let dir = TempDir::new(&format!("rounds_{tag}"));
        let work = TempDir::new(&format!("rounds_{tag}_work"));
        let store = StateStore {
            path: dir.join("state.json"),
            data: AppStateFile::default(),
            new_tab_provider: crate::provider::ProviderId::DEFAULT,
            draft_window: MAIN_WINDOW_ID.to_string(),
        };
        let runs = dir.join("runs");
        let roles = crate::store::bundled_seed().expect("seed").roles;
        let repos = ["backend", "web"]
            .map(|name| RepoEntry { name: name.into(), folder: work.join(name).display().to_string(), ..RepoEntry::default() })
            .to_vec();
        let host = Arc::new(TestHost {
            store: Mutex::new(store),
            runs,
            roles,
            repos,
            launches: Mutex::new(Vec::new()),
            fail_spawns: AtomicUsize::new(0),
            changed: Mutex::new(Vec::new()),
            _dir: dir,
        });
        let fixture = Self { rounds: Rounds::new(host.clone()), host, work };
        fixture.approved_triage_run();
        fixture
    }

    /// A QA round's Triage run, approved, with its round.json and tickets.json.
    fn approved_triage_run(&self) {
        let cwd = self.work.path().display().to_string();
        {
            let mut store = self.host.store.lock().unwrap();
            let role = self.host.roles.iter().find(|r| r.id == "role_triage").unwrap().clone();
            let tab = store.create_draft_tab(&role, &cwd, true, None).unwrap();
            store.data.tabs.iter_mut().find(|t| t.id == tab).unwrap().answers =
                std::collections::HashMap::from([("cwd".into(), cwd.clone()), ("title".into(), "QA 9.9".into())]);
            let chain = ChainRef { chain_id: TRIAGE.into(), kind: "round".into(), step: 1, total: 2, round: 1, lane: None };
            store.set_tab_chain(&tab, Some(chain), None).unwrap();
            store.pipeline_run_by_id_mut(TRIAGE).unwrap().set_complete();
            store.save().unwrap();
        }
        let dir = self.host.runs.join(TRIAGE);
        std::fs::create_dir_all(&dir).unwrap();
        let round = RunRound {
            schema: 1,
            run_id: TRIAGE.into(),
            stage_key: "triage".into(),
            turn: "t1".into(),
            at: "now".into(),
            round: the_round(),
        };
        std::fs::write(dir.join("round.json"), serde_json::to_vec_pretty(&round).unwrap()).unwrap();
        std::fs::write(dir.join("round.md"), "# QA 9.9 round\n").unwrap();
        std::fs::write(dir.join("tickets.json"), serde_json::to_vec_pretty(&tickets_json()).unwrap()).unwrap();
    }

    fn act(&self, action: RoundAction) -> Result<String, String> {
        let (reply, answer) = std::sync::mpsc::channel();
        self.rounds.handle(RoundMsg::Action { action, reply: Some(reply) });
        answer.recv().unwrap()
    }

    fn start(&self, runs_at_once: u32, commit_up_to_wave: u32) -> String {
        self.act(RoundAction::Start {
            triage_run_id: TRIAGE.into(),
            pipeline: None,
            runs_at_once: Some(runs_at_once),
            commit_up_to_wave: Some(commit_up_to_wave),
        })
        .expect("Start round")
    }

    fn round(&self) -> QaRound {
        self.host.store.lock().unwrap().data.rounds[0].clone()
    }

    fn state(&self, plan_id: &str) -> PlanRunState {
        self.round().plan(plan_id).unwrap().state
    }

    fn run_of(&self, plan_id: &str) -> String {
        self.round().plan(plan_id).unwrap().run_id.clone().expect("started")
    }

    /// The plans whose runs started, in order.
    fn started(&self) -> Vec<String> {
        let round = self.round();
        self.host
            .launches
            .lock()
            .unwrap()
            .iter()
            .map(|l| round.plan_of_run(&l.run_id).map(|p| p.plan_id.clone()).unwrap_or_default())
            .collect()
    }

    /// Move `plan_id`'s run on as its actor would, then tell the runner.
    fn run_does(&self, plan_id: &str, change: impl FnOnce(&mut crate::store::PipelineRun)) {
        let run_id = self.run_of(plan_id);
        {
            let mut store = self.host.store.lock().unwrap();
            change(store.pipeline_run_by_id_mut(&run_id).unwrap());
            store.save().unwrap();
        }
        self.rounds.handle(RoundMsg::RunChanged(run_id));
    }

    fn waiting(&self, plan_id: &str) -> String {
        let round = self.round();
        waiting_reason(&round, round.plan(plan_id).unwrap()).unwrap_or_default()
    }
}

fn gate_failed(run: &mut crate::store::PipelineRun) {
    run.stop_for(StopReason::GateFailed, Some("implementer"), Some("role_implementer"), "The npm run check check failed 3 times in a row.", None);
}

#[test]
fn a_round_of_three_plans_in_two_waves_with_a_cap_of_two_isolates_a_stopped_run() {
    let f = Fixture::new("waves");
    let id = f.start(2, 2);
    // Wave 1's two plans start; wave 2 waits for them.
    assert_eq!(f.started(), ["plan1", "plan2"]);
    assert_eq!((f.state("plan1"), f.state("plan2"), f.state("plan3")), (PlanRunState::Running, PlanRunState::Running, PlanRunState::Ready));
    assert!(f.waiting("plan3").contains("Waits for the earlier waves: plan1 (running), plan2 (running)"), "{}", f.waiting("plan3"));
    // Parked and deferred plans never start by themselves.
    assert_eq!((f.state("plan4"), f.state("plan5")), (PlanRunState::Parked, PlanRunState::Deferred));

    // Each plan run started from its section of the round, with its own tickets.
    let launches = f.host.launches.lock().unwrap().clone();
    let first = &launches[0];
    assert_eq!(first.role_id, "role_planner");
    assert!(first.bridge.is_some(), "bridged, so its actor follows it");
    assert!(first.prompt.contains("plan1 of the QA round \"QA 9.9\": Title of plan1"), "{}", first.prompt);
    assert!(first.prompt.contains("Wave 1 of 2: Isolated fixes."), "{}", first.prompt);
    assert!(first.prompt.contains("Merge order: backend: plan1 → plan3."), "{}", first.prompt);
    let run1 = f.run_of("plan1");
    let run_dir = f.host.runs.join(&run1);
    assert!(first.prompt.contains(&run_dir.join("tickets.json").display().to_string()), "{}", first.prompt);
    let tickets: serde_json::Value = serde_json::from_slice(&std::fs::read(run_dir.join("tickets.json")).unwrap()).unwrap();
    let ids: Vec<&str> = tickets["tickets"].as_array().unwrap().iter().map(|t| t["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["QA-401"]);
    assert_eq!(tickets["excluded"], json!([]));
    let link: serde_json::Value = serde_json::from_slice(&std::fs::read(run_dir.join(ROUND_PLAN_FILE)).unwrap()).unwrap();
    assert_eq!((link["roundId"].as_str(), link["plan"]["id"].as_str()), (Some(id.as_str()), Some("plan1")));
    {
        let store = f.host.store.lock().unwrap();
        let run = store.pipeline_run_by_id(&run1).unwrap();
        assert_eq!((run.kind.as_str(), run.engine, run.status), ("full", 2, RunStatus::Running));
        assert!(run.autopilot.as_ref().is_some_and(|a| a.enabled));
    }
    // The round folder holds its copies and its runs.
    let dir = rounds_root(&f.host.runs).join(&id);
    for name in ["round.json", "round.md", "tickets.json", RUNS_FILE] {
        assert!(dir.join(name).is_file(), "{name}");
    }
    let runs: serde_json::Value = serde_json::from_slice(&std::fs::read(dir.join(RUNS_FILE)).unwrap()).unwrap();
    assert_eq!(runs["runs"]["plan1"], json!(run1));

    // Plan 1's run stops; plan 2 keeps going, and wave 2 does not start.
    f.run_does("plan1", gate_failed);
    assert_eq!(f.state("plan1"), PlanRunState::Stopped);
    assert!(f.round().plan("plan1").unwrap().note.as_deref().unwrap_or_default().contains("failed 3 times"));
    assert_eq!(f.state("plan2"), PlanRunState::Running);
    f.run_does("plan2", |run| run.set_complete());
    assert_eq!(f.state("plan2"), PlanRunState::Done);
    assert_eq!(f.started(), ["plan1", "plan2"], "wave 2 waits for the stopped plan");
    assert!(f.waiting("plan3").contains("plan1 (stopped)"), "{}", f.waiting("plan3"));
    {
        let store = f.host.store.lock().unwrap();
        let rounds_root = rounds_root(&f.host.runs);
        let shown = view(&store, &rounds_root, TRIAGE).expect("the round's view");
        assert_eq!(shown.plans.iter().find(|p| p.plan.plan_id == "plan3").unwrap().repos, ["backend", "web"]);
    }

    // You resolve plan 1 (its run carries on and completes): wave 2 starts.
    f.run_does("plan1", |run| run.set_running());
    assert_eq!(f.state("plan1"), PlanRunState::Running);
    assert_eq!(f.started(), ["plan1", "plan2"]);
    f.run_does("plan1", |run| run.set_complete());
    assert_eq!(f.started(), ["plan1", "plan2", "plan3"]);
    assert_eq!(f.state("plan3"), PlanRunState::Running);
    // A second Start round on the same Triage run is the same round.
    assert_eq!(f.start(2, 1), id);
    assert_eq!(f.host.store.lock().unwrap().data.rounds.len(), 1);
}

#[test]
fn commit_up_to_wave_holds_later_waves_until_you_raise_it_and_the_cap_holds_the_rest() {
    let f = Fixture::new("commit");
    let id = f.start(1, 1);
    // A cap of one: plan 1 first.
    assert_eq!(f.started(), ["plan1"]);
    assert!(f.waiting("plan2").contains("Waits for a free slot: 1 of 1"), "{}", f.waiting("plan2"));
    f.run_does("plan1", |run| run.set_complete());
    assert_eq!(f.started(), ["plan1", "plan2"]);
    f.run_does("plan2", |run| run.set_complete());
    // Wave 1 is done, but the round is committed up to wave 1.
    assert_eq!(f.started(), ["plan1", "plan2"]);
    assert!(f.waiting("plan3").starts_with("Held: the round is committed up to wave 1"), "{}", f.waiting("plan3"));
    let refused = f.act(RoundAction::Settings { round_id: id.clone(), runs_at_once: Some(9), commit_up_to_wave: None });
    assert!(refused.unwrap_err().contains("1 to 8"));
    let refused = f.act(RoundAction::Settings { round_id: id.clone(), runs_at_once: None, commit_up_to_wave: Some(3) });
    assert!(refused.unwrap_err().contains("1 to 2"));
    f.act(RoundAction::Settings { round_id: id.clone(), runs_at_once: Some(2), commit_up_to_wave: Some(2) }).unwrap();
    assert_eq!(f.started(), ["plan1", "plan2", "plan3"]);
    assert_eq!((f.round().runs_at_once, f.round().commit_up_to_wave), (2, 2));
}

#[test]
fn unpark_puts_a_parked_plan_in_its_wave_and_deferred_plans_never_start() {
    let f = Fixture::new("unpark");
    let id = f.start(3, 2);
    assert_eq!(f.started(), ["plan1", "plan2"]);
    let refused = f.act(RoundAction::Unpark { round_id: id.clone(), plan_id: "plan5".into(), wave: None });
    assert!(refused.unwrap_err().contains("not parked"));
    f.act(RoundAction::Unpark { round_id: id.clone(), plan_id: "plan4".into(), wave: None }).unwrap();
    assert_eq!(f.state("plan4"), PlanRunState::Ready);
    assert_eq!(f.round().plan("plan4").unwrap().wave, Some(2));
    f.run_does("plan1", |run| run.set_complete());
    f.run_does("plan2", |run| run.set_complete());
    assert_eq!(f.started(), ["plan1", "plan2", "plan3", "plan4"]);
    assert_eq!(f.state("plan5"), PlanRunState::Deferred);
    let refused = f.act(RoundAction::Unpark { round_id: id, plan_id: "plan4".into(), wave: None });
    assert!(refused.is_err());
}

#[test]
fn a_plan_that_fails_to_start_stops_alone_and_can_be_retried() {
    let f = Fixture::new("fail");
    f.host.fail_spawns.store(1, Ordering::SeqCst);
    let id = f.start(2, 2);
    // Plan 1's terminal did not start: its run waits with why; plan 2 started.
    assert_eq!(f.state("plan1"), PlanRunState::Stopped);
    let note = f.round().plan("plan1").unwrap().note.clone().unwrap_or_default();
    assert!(note.contains("claude is not installed"), "{note}");
    assert_eq!(f.started(), ["plan2"]);
    let refused = f.act(RoundAction::Retry { round_id: id.clone(), plan_id: "plan1".into() });
    assert!(refused.unwrap_err().contains("carry it on in its own overview"));
    // A start that failed before its run was made can be retried.
    {
        let mut store = f.host.store.lock().unwrap();
        let plan = store.data.rounds[0].plan_mut("plan1").unwrap();
        plan.run_id = None;
        plan.note = Some("Could not start: the form is incomplete".into());
        store.save().unwrap();
    }
    f.act(RoundAction::Retry { round_id: id, plan_id: "plan1".into() }).unwrap();
    assert_eq!(f.state("plan1"), PlanRunState::Running);
    assert_eq!(f.started(), ["plan2", "plan1"]);
}

#[test]
fn after_a_restart_the_round_catches_up_with_its_runs() {
    let f = Fixture::new("restart");
    f.start(2, 2);
    let path = f.host.store.lock().unwrap().path.clone();
    let run1 = f.run_of("plan1");
    let run2 = f.run_of("plan2");
    // While the app was closed: plan 1's run completed, plan 2's run is gone.
    {
        let mut store = f.host.store.lock().unwrap();
        store.pipeline_run_by_id_mut(&run1).unwrap().set_complete();
        store.data.pipeline_runs.retain(|run| run.id != run2);
        store.save().unwrap();
    }
    let reopened = StateStore::open_path(path).expect("state.json");
    assert_eq!(reopened.data.rounds.len(), 1, "rounds are kept in state.json");
    *f.host.store.lock().unwrap() = reopened;
    let after = Rounds::new(f.host.clone());
    after.handle(RoundMsg::Recover);
    let round = f.round();
    assert_eq!(round.plan("plan1").unwrap().state, PlanRunState::Done);
    assert_eq!(round.plan("plan2").unwrap().state, PlanRunState::Stopped);
    assert!(round.plan("plan2").unwrap().note.as_deref().unwrap_or_default().contains("gone"));
    // Plan 2 holds wave 2, so nothing new started.
    assert_eq!(f.started(), ["plan1", "plan2"]);
    // A restart while a run waits after it is still running.
    let mut run = crate::store::PipelineRun {
        status: RunStatus::Waiting,
        stop_reason: Some(StopReason::AppRestarted),
        ..f.host.store.lock().unwrap().pipeline_run_by_id(&run1).unwrap().clone()
    };
    assert_eq!(run_state(Some(&run)).0, PlanRunState::Running);
    run.stop_reason = Some(StopReason::Stalled);
    assert_eq!(run_state(Some(&run)).0, PlanRunState::Stopped);
}

#[test]
fn approve_all_checkpoints_lists_each_plan_run_waiting_at_its_plan_checkpoint() {
    let f = Fixture::new("checkpoints");
    f.start(2, 2);
    let run1 = f.run_of("plan1");
    let def = crate::pipelines::find("eagle1").unwrap();
    {
        let mut store = f.host.store.lock().unwrap();
        let run = store.pipeline_run_by_id_mut(&run1).unwrap();
        run.tab_ids.insert("role_plan_reviewer".into(), "tab_review_1".into());
        run.stop_for(StopReason::Checkpoint, Some("implementer"), Some("role_implementer"), "Checkpoint before Implementer.", None);
        store.save().unwrap();
    }
    f.rounds.handle(RoundMsg::RunChanged(run1.clone()));
    assert_eq!(f.state("plan1"), PlanRunState::Running, "a checkpoint is not a stop");
    let store = f.host.store.lock().unwrap();
    let shown = view(&store, &rounds_root(&f.host.runs), TRIAGE).unwrap();
    assert_eq!(shown.checkpoints.len(), 1);
    let wait = &shown.checkpoints[0];
    assert_eq!(
        (wait.plan_id.as_str(), wait.run_id.as_str(), wait.source_tab_id.as_str(), wait.target_role_id.as_str()),
        ("plan1", run1.as_str(), "tab_review_1", "role_implementer")
    );
    // A verify wait is not a plan checkpoint.
    let mut run = store.pipeline_run_by_id(&run1).unwrap().clone();
    run.events.last_mut().unwrap().stage_id = Some("pr_reviewer".into());
    assert!(plan_checkpoint(&def, &run, "plan1").is_none());
}

#[test]
fn start_round_takes_only_an_approved_triage_run_and_a_pipeline_that_builds_a_plan() {
    let f = Fixture::new("refuse");
    f.host.store.lock().unwrap().pipeline_run_by_id_mut(TRIAGE).unwrap().status = RunStatus::Running;
    let start = |pipeline: Option<&str>| {
        f.act(RoundAction::Start {
            triage_run_id: TRIAGE.into(),
            pipeline: pipeline.map(str::to_string),
            runs_at_once: None,
            commit_up_to_wave: None,
        })
    };
    assert!(start(None).unwrap_err().contains("Approve the round first"));
    f.host.store.lock().unwrap().pipeline_run_by_id_mut(TRIAGE).unwrap().set_complete();
    assert!(start(Some("round")).unwrap_err().contains("round's pipeline"));
    assert!(start(Some("nope")).unwrap_err().contains("unknown pipeline"));
    let refused = f.act(RoundAction::Start { triage_run_id: "ee_missing".into(), pipeline: None, runs_at_once: None, commit_up_to_wave: None });
    assert!(refused.unwrap_err().contains("unknown pipeline run"));
    // The defaults: Eagle-Eye 1, 2 at once, committed up to wave 1.
    start(None).unwrap();
    let round = f.round();
    assert_eq!((round.pipeline.as_str(), round.runs_at_once, round.commit_up_to_wave, round.waves), ("eagle1", 2, 1, 2));
}

#[test]
fn next_to_start_follows_waves_cap_and_commit() {
    let f = Fixture::new("pure");
    f.start(2, 2);
    let mut round = f.round();
    // Pure: with both wave-1 plans done and a cap of 1, only plan 3 is next.
    for id in ["plan1", "plan2"] {
        round.plan_mut(id).unwrap().state = PlanRunState::Done;
    }
    round.runs_at_once = 1;
    assert_eq!(next_to_start(&round), ["plan3"]);
    round.commit_up_to_wave = 1;
    assert!(next_to_start(&round).is_empty());
    round.commit_up_to_wave = 2;
    round.plan_mut("plan4").unwrap().state = PlanRunState::Ready;
    round.runs_at_once = 2;
    assert_eq!(next_to_start(&round), ["plan3", "plan4"]);
    round.plan_mut("plan3").unwrap().state = PlanRunState::Running;
    round.runs_at_once = 1;
    assert!(next_to_start(&round).is_empty(), "the cap counts running plans");
}

#[test]
fn the_runner_thread_answers_each_button_in_turn() {
    let f = Fixture::new("thread");
    let runner = super::RoundRunner::new(f.host.clone());
    let id = runner
        .ask(
            RoundAction::Start { triage_run_id: TRIAGE.into(), pipeline: None, runs_at_once: Some(1), commit_up_to_wave: Some(2) },
            std::time::Duration::from_secs(10),
        )
        .expect("Start round");
    assert_eq!(f.started(), ["plan1"]);
    let run1 = f.run_of("plan1");
    f.host.store.lock().unwrap().pipeline_run_by_id_mut(&run1).unwrap().set_complete();
    runner.run_changed(&run1);
    // Messages are handled in order: this answer comes after the run change.
    runner
        .ask(RoundAction::Settings { round_id: id, runs_at_once: Some(1), commit_up_to_wave: None }, std::time::Duration::from_secs(10))
        .unwrap();
    assert_eq!(f.started(), ["plan1", "plan2"]);
}
