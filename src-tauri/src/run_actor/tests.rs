//! The run actor against a recording host: no terminals start, the bridge's
//! run folder files are written by the test the way the hooks write them,
//! and each message is handed to the actor directly (`Actor::handle`), so
//! every step is checked in order. `tests/fake_claude.rs` runs a whole
//! Eagle-Eye 1 with real `fake_claude` terminals instead.

use super::actor::Actor;
use super::prompts::{stage_values, StageSources};
use super::{ActorMsg, Host, RunActors, StageLaunch, UserAction, UserOutcome};
use crate::bridge::folder::{RunPrs, RunTasks, StageDir, StoredResult, TurnEnd, TurnState};
use crate::bridge::launch::{prepare_stage, BridgePlan};
use crate::bridge::{BridgeTag, BridgeTurn, ResultKind, TurnOutcome};
use crate::pipelines::{GateDef, GateResult};
use crate::roles::Role;
use crate::store::{AppStateFile, ChainRef, RunStatus, StateStore, StopReason, MAIN_WINDOW_ID};
use crate::test_support::TempDir;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const RUN: &str = "ee_1760000000100";
/// The session the Planner terminal was started with.
const PLANNER_SID: &str = "5f0c2a31-1b2c-4d3e-8f40-00000000000a";

struct TestHost {
    store: Mutex<StateStore>,
    runs: PathBuf,
    roles: Vec<Role>,
    launches: Mutex<Vec<StageLaunch>>,
    /// Stages resumed in place (V4): their terminal stopped and `--resume`d.
    resumes: Mutex<Vec<StageLaunch>>,
    /// `resume_stage` fails with this.
    resume_error: Mutex<Option<String>>,
    pastes: Mutex<Vec<(String, String)>>,
    live: Mutex<HashSet<String>>,
    /// Gate results handed out in order; `passed` once they run out.
    gates: Mutex<VecDeque<GateResult>>,
    panic_on_usage: AtomicBool,
    /// While set, a panicking usage read first waits for this signal.
    hold_usage: Mutex<Option<Receiver<()>>>,
    /// The pull requests each pull-request gate was given.
    pr_gate_urls: Mutex<Vec<Vec<String>>>,
    /// The D24 gate's answer for the next bridged opens (false: engine 1).
    gate_open: AtomicBool,
    /// Session-log usage-limit errors by tab (H5).
    rate_limits: Mutex<HashMap<String, String>>,
    stops: Mutex<Vec<(StopReason, String)>>,
    notices: Mutex<Vec<String>>,
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
    fn bridge_gate(&self, run_id: &str, stage_key: &str, _cwd: &Path) -> Result<bool, String> {
        if self.gate_open.load(Ordering::SeqCst) {
            return Ok(true);
        }
        // The app's gate with an older Claude Code read (`actor_stage_gate`).
        crate::pty::actor_gate_on(&self.store, &self.runs, run_id, stage_key, Some("2.1.200 (Claude Code)"), None)
    }
    fn spawn_stage(&self, launch: &StageLaunch) -> Result<(), String> {
        self.live.lock().unwrap().insert(launch.tab_id.clone());
        self.launches.lock().unwrap().push(launch.clone());
        Ok(())
    }
    fn resume_stage(&self, launch: &StageLaunch) -> Result<(), String> {
        if let Some(err) = self.resume_error.lock().unwrap().clone() {
            return Err(err);
        }
        self.live.lock().unwrap().insert(launch.tab_id.clone());
        self.resumes.lock().unwrap().push(launch.clone());
        Ok(())
    }
    fn paste(&self, tab_id: &str, text: &str) -> Result<(), String> {
        self.pastes.lock().unwrap().push((tab_id.to_string(), text.to_string()));
        Ok(())
    }
    fn terminal_live(&self, tab_id: &str) -> bool {
        self.live.lock().unwrap().contains(tab_id)
    }
    fn run_gate(&self, gate: &GateDef, _folder: &Path, pr_urls: &[String]) -> GateResult {
        if matches!(gate, GateDef::PullRequest) {
            self.pr_gate_urls.lock().unwrap().push(pr_urls.to_vec());
        }
        let label = match gate {
            GateDef::Command { .. } => "npm run check",
            GateDef::PullRequest => "pull requests",
            GateDef::Verify { .. } => "verify",
        };
        self.gates.lock().unwrap().pop_front().unwrap_or(GateResult {
            kind: "command".into(),
            label: label.into(),
            status: "passed".into(),
            summary: "Passed.".into(),
            output: String::new(),
            duration_ms: 1,
        optional: false,
        })
    }
    fn usage_percent(&self, _run_id: &str) -> Option<u8> {
        if self.panic_on_usage.load(Ordering::SeqCst) {
            let hold = self.hold_usage.lock().unwrap().take();
            if let Some(hold) = hold {
                let _ = hold.recv_timeout(Duration::from_secs(10));
            }
            panic!("usage exploded");
        }
        None
    }
    fn rate_limit(&self, tab_id: &str) -> Option<String> {
        self.rate_limits.lock().unwrap().get(tab_id).cloned()
    }
    fn run_changed(&self, _run_id: &str) {}
    fn tab_opened(&self, _run_id: &str, _tab_id: &str) {}
    fn stopped(&self, _run_id: &str, _tab_id: Option<&str>, reason: StopReason, summary: &str) {
        self.stops.lock().unwrap().push((reason, summary.to_string()));
    }
    fn notice(&self, _run_id: &str, title: &str, _body: &str) {
        self.notices.lock().unwrap().push(title.to_string());
    }
}

/// An Eagle-Eye 1 run on autopilot whose Planner terminal runs, bridged.
struct Fixture {
    host: Arc<TestHost>,
    actor: Actor<TestHost>,
    gates_done: Receiver<ActorMsg>,
    planner: String,
    work: TempDir,
}

fn planner_answers(cwd: &str) -> HashMap<String, String> {
    HashMap::from([
        ("cwd".into(), cwd.into()),
        ("taskType".into(), "Bug".into()),
        ("title".into(), "Expired tokens".into()),
        ("request".into(), "Refresh expired tokens instead of failing.".into()),
        ("expectedBehavior".into(), "A request with an expired token is retried once.".into()),
        ("currentBehavior".into(), "It returns 500.".into()),
    ])
}

impl Fixture {
    fn new(tag: &str) -> Self {
        Self::with_engine(tag, 2)
    }

    fn with_engine(tag: &str, engine: u32) -> Self {
        Self::build(tag, engine, "eagle1", Vec::new())
    }

    /// An engine-2 run of your own pipeline `kind` (registered by the
    /// test), with `extra` roles (copies of built-in ones) next to the seed's.
    fn with_pipeline(tag: &str, kind: &str, extra: Vec<Role>) -> Self {
        Self::build(tag, 2, kind, extra)
    }

    fn build(tag: &str, engine: u32, kind: &str, extra: Vec<Role>) -> Self {
        let dir = TempDir::new(&format!("run_actor_{tag}"));
        let work = TempDir::new(&format!("run_actor_{tag}_work"));
        let mut roles = crate::store::bundled_seed().expect("seed").roles;
        roles.extend(extra);
        let mut store = StateStore {
            path: dir.join("state.json"),
            data: AppStateFile::default(),
            new_tab_provider: crate::provider::ProviderId::DEFAULT,
            draft_window: MAIN_WINDOW_ID.to_string(),
        };
        let cwd = work.path().display().to_string();
        let planner_role = roles.iter().find(|r| r.id == "role_planner").unwrap();
        let planner = store.create_draft_tab(planner_role, &cwd, true, None).unwrap();
        store.data.tabs.iter_mut().find(|t| t.id == planner).unwrap().answers = planner_answers(&cwd);
        let chain = ChainRef { kind: kind.into(), ..chain(1, None) };
        store.set_tab_chain(&planner, Some(chain.clone()), None).unwrap();
        {
            let run = store.pipeline_run_by_id_mut(RUN).unwrap();
            run.set_autopilot_enabled(true);
            run.engine = engine;
        }
        let runs = dir.join("runs");
        let plan = BridgePlan {
            run_id: RUN.into(),
            stage_id: "planner".into(),
            role_id: "role_planner".into(),
            lane: None,
            stage_key: "planner".into(),
            kind: ResultKind::Planner,
            autopilot: true,
        };
        prepare_stage(&runs, &plan, &planner).unwrap();
        store
            .set_tab_bridge(&planner, Some(BridgeTag { run_id: RUN.into(), stage: "planner".into() }))
            .unwrap();
        store.remember_claude_terminal_session(&planner, PLANNER_SID).unwrap();
        let host = Arc::new(TestHost {
            store: Mutex::new(store),
            runs,
            roles,
            launches: Mutex::new(Vec::new()),
            resumes: Mutex::new(Vec::new()),
            resume_error: Mutex::new(None),
            pastes: Mutex::new(Vec::new()),
            live: Mutex::new(HashSet::from([planner.clone()])),
            gates: Mutex::new(VecDeque::new()),
            panic_on_usage: AtomicBool::new(false),
            hold_usage: Mutex::new(None),
            pr_gate_urls: Mutex::new(Vec::new()),
            gate_open: AtomicBool::new(true),
            rate_limits: Mutex::new(HashMap::new()),
            stops: Mutex::new(Vec::new()),
            notices: Mutex::new(Vec::new()),
            _dir: dir,
        });
        let (me, gates_done) = channel();
        let actor = Actor::new(RUN.to_string(), host.clone(), me);
        Self { host, actor, gates_done, planner, work }
    }

    fn run<T>(&self, read: impl FnOnce(&crate::store::PipelineRun) -> T) -> T {
        let store = self.host.store.lock().unwrap();
        read(store.pipeline_run_by_id(RUN).unwrap())
    }

    fn tab(&self, tab_id: &str) -> crate::store::TabRecord {
        self.host.store.lock().unwrap().tab_by_id(tab_id).unwrap().clone()
    }

    fn stage_dir(&self, tab_id: &str) -> StageDir {
        let tag = self.tab(tab_id).bridge.expect("bridged tab");
        StageDir::open(&self.host.runs.join(RUN), RUN, &tag.stage, tab_id).expect("stage dir")
    }

    /// The tab's stage started a turn and has not ended it (Working).
    fn start_turn(&self, tab_id: &str, turn: &str) {
        self.stage_dir(tab_id).write_turn(&TurnState::new(turn)).unwrap();
    }

    /// The tab's stage ended `turn` with `result` (the hook's files), as the
    /// inbox event delivers it.
    fn end_turn(&self, tab_id: &str, turn: &str, result: Option<Value>, message: &str) -> BridgeTurn {
        let dir = self.stage_dir(tab_id);
        let mut state = TurnState::new(turn);
        let end = TurnEnd {
            at: chrono::Utc::now().to_rfc3339(),
            outcome: if result.is_some() { TurnOutcome::Result } else { TurnOutcome::NoResult },
            last_assistant_message: message.to_string(),
        };
        state.ended = Some(end.clone());
        dir.write_turn(&state).unwrap();
        if let Some(result) = &result {
            dir.write_result(&StoredResult { schema: 1, turn: turn.into(), at: end.at.clone(), result: result.clone() })
                .unwrap();
        }
        BridgeTurn::new(&dir.info, &state, &end, result)
    }

    fn planner_turn(&self, turn: &str, plan: &str) -> BridgeTurn {
        let tasks = vec![crate::bridge::PlannedTask {
            id: "pr1".into(),
            title: "Refresh".into(),
            depends_on: vec![],
            manual: false,
            summary: "Refresh expired tokens.".into(),
            repo: None,
            stories: vec![],
        }];
        let dir = self.stage_dir(&self.planner);
        dir.write_plan(
            plan,
            &RunTasks { schema: 1, run_id: RUN.into(), stage_key: "planner".into(), turn: turn.into(), at: "now".into(), tasks },
        )
        .unwrap();
        self.end_turn(&self.planner, turn, Some(json!({ "schema": 1, "tasks": [{ "id": "pr1" }] })), "Plan received.")
    }

    fn launches(&self) -> Vec<StageLaunch> {
        self.host.launches.lock().unwrap().clone()
    }

    fn resumes(&self) -> Vec<StageLaunch> {
        self.host.resumes.lock().unwrap().clone()
    }

    fn run_file(&self, name: &str) -> PathBuf {
        self.host.runs.join(RUN).join(name)
    }

    fn pastes(&self) -> Vec<(String, String)> {
        self.host.pastes.lock().unwrap().clone()
    }

    fn stops(&self) -> Vec<(StopReason, String)> {
        self.host.stops.lock().unwrap().clone()
    }

    fn user(&mut self, action: UserAction) -> Result<UserOutcome, String> {
        let (reply, answer) = channel();
        self.actor.handle(ActorMsg::User { action, reply: Some(reply) });
        answer.recv().unwrap()
    }

    /// Hand the actor the gate results its gate thread sends back.
    fn finish_gates(&mut self) {
        let msg = self.gates_done.recv_timeout(Duration::from_secs(10)).expect("gates finished");
        assert!(matches!(msg, ActorMsg::GatesDone { .. }));
        self.actor.handle(msg);
    }

    /// Planner → Plan Reviewer (opened by the actor) → its tab.
    fn open_plan_reviewer(&mut self) -> String {
        let turn = self.planner_turn("p-1", "# Plan\n1. Refresh tokens in src/auth.ts.");
        self.actor.handle(ActorMsg::Turn(turn));
        self.launches().last().expect("plan reviewer opened").tab_id.clone()
    }
}

fn chain(step: u32, lane: Option<&str>) -> ChainRef {
    ChainRef {
        chain_id: RUN.into(),
        kind: "eagle1".into(),
        step,
        total: 4,
        round: 1,
        lane: lane.map(str::to_string),
    }
}

fn review(verdict: &str, findings: Value) -> Option<Value> {
    Some(json!({ "schema": 1, "verdict": verdict, "findings": findings }))
}

#[test]
fn a_planner_turn_opens_the_plan_reviewer_with_the_plan_from_the_run_folder() {
    let mut fx = Fixture::new("advance");
    let reviewer = fx.open_plan_reviewer();
    let launches = fx.launches();
    assert_eq!(launches.len(), 1);
    let launch = &launches[0];
    assert_eq!(launch.role_id, "role_plan_reviewer");
    assert!(launch.prompt.contains("1. Refresh tokens in src/auth.ts."), "the plan, from plan.md:\n{}", launch.prompt);
    assert!(launch.prompt.contains("Title: Expired tokens"), "the step-1 request as one block");
    assert!(launch.prompt.contains("mcp__dcterminal__submit_result"), "the result instructions");
    // It points at the run's hand-off files (D20).
    assert!(launch.prompt.contains(&fx.run_file("plan.md").display().to_string()), "plan.md: {}", launch.prompt);
    assert!(launch.prompt.contains(&fx.run_file("tasks.json").display().to_string()), "tasks.json");
    assert!(!launch.prompt.contains("prs.json"), "no pull requests yet");
    let bridge = launch.bridge.as_ref().expect("bridged");
    assert!(bridge.args.iter().any(|a| a == "--mcp-config"), "{:?}", bridge.args);
    assert!(launch.cwd.ends_with(fx.work.path().file_name().unwrap()), "{}", launch.cwd.display());
    let tab = fx.tab(&reviewer);
    assert_eq!(tab.chain.as_ref().map(|c| c.step), Some(2));
    assert_eq!(tab.bridge.as_ref().map(|b| b.stage.as_str()), Some("plan_reviewer"));
    assert_eq!(tab.sessions.claude_terminal_session_id.as_deref(), Some(launch.session_id.as_str()));
    fx.run(|run| {
        assert_eq!(run.tab_ids.get("role_plan_reviewer"), Some(&reviewer));
        assert_eq!(run.stage, "plan_reviewer");
        assert!(run.handoffs["role_plan_reviewer"].text.contains("Refresh tokens"));
        let kinds: Vec<(&str, Option<&str>)> =
            run.events.iter().map(|e| (e.kind.as_str(), e.outcome.as_deref())).collect();
        assert!(kinds.contains(&("turn", None)), "{kinds:?}");
        assert!(kinds.contains(&("autopilot", Some("advance"))), "{kinds:?}");
        assert!(kinds.contains(&("handoff", None)), "{kinds:?}");
    });
}

#[test]
fn a_turn_is_acted_on_once_even_by_a_new_actor() {
    let mut fx = Fixture::new("once");
    let turn = fx.planner_turn("p-1", "# Plan");
    fx.actor.handle(ActorMsg::Turn(turn.clone()));
    fx.actor.handle(ActorMsg::Turn(turn.clone()));
    // A new thread for the run (the old one went idle) reads it again.
    let (me, _rx) = channel();
    let mut again = Actor::new(RUN.to_string(), fx.host.clone(), me);
    again.handle(ActorMsg::Turn(turn));
    assert_eq!(fx.launches().len(), 1, "one hand-off for one turn");
}

#[test]
fn changes_required_resumes_the_planner_session_pointing_at_the_findings_file() {
    let mut fx = Fixture::new("loop_back");
    let reviewer = fx.open_plan_reviewer();
    let turn = fx.end_turn(
        &reviewer,
        "r-1",
        review("CHANGES_REQUIRED", json!([{ "severity": "HIGH", "file": "src/auth.ts:42", "summary": "Retries forever." }])),
        "Changes required.",
    );
    fx.actor.handle(ActorMsg::Turn(turn));
    assert!(fx.pastes().is_empty(), "no keystrokes (D17): {:?}", fx.pastes());
    let resumes = fx.resumes();
    assert_eq!(resumes.len(), 1, "{resumes:?}");
    let resumed = &resumes[0];
    assert_eq!((resumed.tab_id.as_str(), resumed.role_id.as_str()), (fx.planner.as_str(), "role_planner"));
    assert_eq!(resumed.session_id, PLANNER_SID, "the same session");
    // The same flags it was launched with.
    let expected = crate::bridge::launch::relaunch_flags(
        &fx.host.runs,
        &BridgeTag { run_id: RUN.into(), stage: "planner".into() },
        &fx.planner,
        Path::new("/opt/dcterminal"),
    )
    .unwrap();
    assert_eq!(resumed.bridge.as_ref(), Some(&expected));
    // A short prompt pointing at the findings file, which holds the round.
    let file = fx.run_file("findings-plan_reviewer-r1.json");
    assert!(resumed.prompt.starts_with("Review findings from the Plan Reviewer (round 1)"), "{}", resumed.prompt);
    assert!(resumed.prompt.contains(&file.display().to_string()), "{}", resumed.prompt);
    assert!(resumed.prompt.contains("1. [HIGH] src/auth.ts:42: Retries forever."), "{}", resumed.prompt);
    let saved: Value = serde_json::from_slice(&std::fs::read(&file).expect("findings file")).unwrap();
    assert_eq!(saved["round"], json!(1));
    assert_eq!(saved["stageKey"], json!("plan_reviewer"));
    assert_eq!(saved["verdict"], json!("CHANGES_REQUIRED"));
    assert_eq!(saved["findings"][0]["summary"], json!("Retries forever."));
    fx.run(|run| {
        assert_eq!(run.round, 2);
        assert_eq!(run.verdicts.last().and_then(|v| v.verdict.as_deref()), Some("REQUIRES REVISION"));
        assert_eq!(run.stage, "planner");
        assert_eq!(run.tab_ids.get("role_planner"), Some(&fx.planner), "the view stays on the Planner's tab");
    });
    assert_eq!(fx.launches().len(), 1, "no new Planner tab");
    // Until the resumed session's first prompt, the Planner reads as working:
    // its old turn was handed on, and an exit now would be news.
    assert!(!fx.host.runs.join(RUN).join("stages/planner/turn.json").exists());
    fx.actor.handle(ActorMsg::Exited { tab_id: fx.planner.clone(), code: Some(1) });
    fx.run(|run| assert_eq!(run.stop_reason, Some(StopReason::CarryOutFailed)));
}

#[test]
fn a_resume_that_fails_stops_the_run() {
    let mut fx = Fixture::new("resume_fails");
    let reviewer = fx.open_plan_reviewer();
    *fx.host.resume_error.lock().unwrap() = Some("claude would not start".into());
    let turn = fx.end_turn(&reviewer, "r-1", review("CHANGES_REQUIRED", json!([{ "severity": "HIGH", "summary": "x" }])), "");
    fx.actor.handle(ActorMsg::Turn(turn));
    fx.run(|run| {
        assert_eq!((run.status, run.stop_reason), (RunStatus::Waiting, Some(StopReason::CarryOutFailed)));
        assert!(run.claims.iter().all(|c| !c.key.starts_with("back:")), "its hand-off record is given back: {:?}", run.claims);
    });
    assert!(fx.stops().last().unwrap().1.contains("claude would not start"), "{:?}", fx.stops());
    // The Planner's last turn is not lost: it still reads as idle, so a Send
    // back by hand is not refused as "still working".
    let tag = fx.tab(&fx.planner).bridge.expect("still bridged");
    assert!(
        crate::bridge::launch::read_stage_turn(&fx.host.runs, &tag, &fx.planner).is_some(),
        "a failed resume puts the stage's turn back"
    );
}

#[test]
fn a_stage_with_no_saved_session_gets_the_round_pasted_after_clearing_its_input() {
    let mut fx = Fixture::new("no_session");
    let reviewer = fx.open_plan_reviewer();
    fx.host.store.lock().unwrap().data.tabs.iter_mut().find(|t| t.id == fx.planner).unwrap().sessions.claude_terminal_session_id = None;
    let turn = fx.end_turn(&reviewer, "r-1", review("CHANGES_REQUIRED", json!([{ "severity": "HIGH", "summary": "Retries forever." }])), "");
    fx.actor.handle(ActorMsg::Turn(turn));
    assert!(fx.resumes().is_empty());
    let pastes = fx.pastes();
    assert_eq!(pastes.len(), 1, "{pastes:?}");
    assert!(pastes[0].1.contains("findings-plan_reviewer-r1.json"), "{}", pastes[0].1);
}

#[test]
fn a_round_sent_back_while_the_stage_still_works_stops_the_run() {
    let mut fx = Fixture::new("busy");
    let reviewer = fx.open_plan_reviewer();
    fx.start_turn(&fx.planner.clone(), "p-2");
    let turn = fx.end_turn(&reviewer, "r-1", review("CHANGES_REQUIRED", json!([{ "severity": "HIGH", "summary": "x" }])), "");
    fx.actor.handle(ActorMsg::Turn(turn));
    assert!(fx.pastes().is_empty());
    fx.run(|run| {
        assert_eq!((run.status, run.stop_reason), (RunStatus::Waiting, Some(StopReason::CarryOutFailed)));
        assert_eq!(run.round, 1, "the round is not recorded");
        assert!(run.claims.iter().all(|c| !c.key.starts_with("back:")), "its hand-off record is given back: {:?}", run.claims);
    });
    let stops = fx.stops();
    assert!(stops.last().unwrap().1.contains("still working"), "{stops:?}");
}

#[test]
fn an_exited_planner_is_resumed_in_its_own_tab() {
    let mut fx = Fixture::new("exited_planner");
    let reviewer = fx.open_plan_reviewer();
    fx.host.live.lock().unwrap().remove(&fx.planner.clone());
    let turn = fx.end_turn(&reviewer, "r-1", review("CHANGES_REQUIRED", json!([{ "severity": "HIGH", "summary": "Retries forever." }])), "");
    fx.actor.handle(ActorMsg::Turn(turn));
    let resumes = fx.resumes();
    assert_eq!(resumes.len(), 1, "{resumes:?}");
    assert_eq!((resumes[0].tab_id.as_str(), resumes[0].session_id.as_str()), (fx.planner.as_str(), PLANNER_SID));
    assert_eq!(fx.launches().len(), 1, "no new tab");
}

#[test]
fn an_exited_planner_with_no_session_gets_a_new_terminal_with_its_form_and_the_findings() {
    let mut fx = Fixture::new("new_planner");
    let reviewer = fx.open_plan_reviewer();
    fx.host.live.lock().unwrap().remove(&fx.planner.clone());
    fx.host.store.lock().unwrap().data.tabs.iter_mut().find(|t| t.id == fx.planner).unwrap().sessions.claude_terminal_session_id = None;
    let turn = fx.end_turn(&reviewer, "r-1", review("CHANGES_REQUIRED", json!([{ "severity": "HIGH", "summary": "Retries forever." }])), "");
    fx.actor.handle(ActorMsg::Turn(turn));
    assert!(fx.resumes().is_empty());
    let launches = fx.launches();
    assert_eq!(launches.len(), 2, "{:?}", fx.stops());
    let planner = &launches[1];
    assert_eq!(planner.role_id, "role_planner");
    assert!(planner.prompt.contains("Refresh expired tokens instead of failing."), "its own form");
    assert!(planner.prompt.contains("Retries forever."), "and the findings");
    assert!(planner.prompt.contains("findings-plan_reviewer-r1.json"), "and where they are");
    let tab = fx.tab(&planner.tab_id);
    assert_eq!(tab.chain.as_ref().map(|c| (c.step, c.round)), Some((1, 2)));
    fx.run(|run| assert_eq!(run.tab_ids.get("role_planner"), Some(&planner.tab_id)));
}

/// A run that started from ClickUp tickets (C2): the app wrote its
/// `tickets.json` before the first stage launched.
fn write_tickets(fx: &Fixture) -> String {
    let path = fx.run_file("tickets.json");
    std::fs::write(
        &path,
        r#"{"schema":1,"source":{"kind":"clickup","accountId":"default","workspaceId":"9012345678","refs":[],"filters":{"priorities":[]}},"fetchedAt":"2026-10-22T09:00:00.000Z","limits":{"descriptionChars":20000,"commentChars":4000,"commentsPerTicket":25,"note":""},"tickets":[],"excluded":[]}"#,
    )
    .unwrap();
    path.display().to_string()
}

#[test]
fn a_run_from_clickup_tickets_points_each_stage_at_tickets_json() {
    let mut fx = Fixture::new("tickets");
    let tickets = write_tickets(&fx);
    fx.open_plan_reviewer();
    let reviewer = &fx.launches()[0];
    assert!(reviewer.prompt.contains(&format!("- Tickets: {tickets}")), "{}", reviewer.prompt);
    // A run with no snapshot lists no tickets file.
    let mut plain = Fixture::new("no_tickets");
    plain.open_plan_reviewer();
    assert!(!plain.launches()[0].prompt.contains("tickets.json"));
}

#[test]
fn a_first_stage_the_actor_opens_again_is_pointed_at_tickets_json() {
    let mut fx = Fixture::new("tickets_planner");
    let tickets = write_tickets(&fx);
    let reviewer = fx.open_plan_reviewer();
    fx.host.live.lock().unwrap().remove(&fx.planner.clone());
    fx.host.store.lock().unwrap().data.tabs.iter_mut().find(|t| t.id == fx.planner).unwrap().sessions.claude_terminal_session_id = None;
    let turn = fx.end_turn(&reviewer, "r-1", review("CHANGES_REQUIRED", json!([{ "severity": "HIGH", "summary": "Misses QA-129." }])), "");
    fx.actor.handle(ActorMsg::Turn(turn));
    let launches = fx.launches();
    let planner = launches.last().unwrap();
    assert_eq!(planner.role_id, "role_planner");
    assert!(
        planner.prompt.contains(&format!("Tickets from ClickUp (this run's intake snapshot): {tickets}")),
        "{}",
        planner.prompt
    );
    assert!(planner.prompt.contains("Refresh expired tokens instead of failing."), "its own request stays");
    assert!(planner.prompt.contains("Misses QA-129."), "and the findings");
}

/// To the Implementer: the plan is approved and the checkpoint passed by
/// your Send, which goes through the actor too.
fn to_implementer(fx: &mut Fixture) -> String {
    let reviewer = fx.open_plan_reviewer();
    let turn = fx.end_turn(&reviewer, "r-1", review("APPROVED", json!([])), "Approved.");
    fx.actor.handle(ActorMsg::Turn(turn));
    fx.run(|run| assert_eq!(run.stop_reason, Some(StopReason::Checkpoint), "{:?}", run.events.last()));
    let sent = fx
        .user(UserAction::Send {
            source_tab_id: reviewer,
            target_role_id: "role_implementer".into(),
            values: None,
            handoff_plan: None,
            handoff_text: None,
            force: false,
        })
        .unwrap();
    sent.tab_id.expect("the Implementer opened")
}

#[test]
fn your_send_at_a_checkpoint_opens_the_next_stage_and_passes_it() {
    let mut fx = Fixture::new("checkpoint");
    let implementer = to_implementer(&mut fx);
    let launch = fx.launches().last().cloned().unwrap();
    assert_eq!((launch.tab_id.as_str(), launch.role_id.as_str()), (implementer.as_str(), "role_implementer"));
    assert!(launch.prompt.contains("Bug Fix"), "the Planner's Bug is the Implementer's Bug Fix");
    assert!(launch.prompt.contains("1. Refresh tokens in src/auth.ts."), "the approved plan");
    fx.run(|run| {
        assert_eq!(run.status, RunStatus::Running, "autopilot carries on");
        assert!(run.autopilot.as_ref().unwrap().passed_checkpoints.contains(&"implementer".to_string()));
        assert_eq!(run.claims.last().map(|c| c.by.as_str()), Some("you"));
    });
}

#[test]
fn a_failed_gate_goes_back_to_the_implementer_and_a_pass_moves_on() {
    let mut fx = Fixture::new("gates");
    let implementer = to_implementer(&mut fx);
    fx.host.gates.lock().unwrap().push_back(GateResult {
        kind: "command".into(),
        label: "npm run check".into(),
        status: "failed".into(),
        summary: "Exited with code 1.".into(),
        output: "FAIL src/auth.test.ts".into(),
        duration_ms: 5,
        optional: false,
    });
    let prs = json!({ "schema": 1, "prs": [{ "url": "https://github.com/acme/app/pull/12", "branch": "fix/refresh", "title": "Refresh" }],
                      "summary": "Expired tokens are refreshed once.", "checks": [{ "command": "npm test", "passed": true }] });
    let dir = fx.stage_dir(&implementer);
    dir.write_prs(&RunPrs { schema: 1, run_id: RUN.into(), stage_key: "implementer".into(), lane: None, turn: "i-1".into(), at: "now".into(), result: prs.clone() })
        .unwrap();
    let turn = fx.end_turn(&implementer, "i-1", Some(prs.clone()), "Opened https://github.com/acme/app/pull/12 (see https://github.com/acme/app/pull/1)");
    fx.actor.handle(ActorMsg::Turn(turn));
    assert!(fx.actor.busy(), "the gates run on their own thread");
    fx.finish_gates();
    assert_eq!(
        fx.host.pr_gate_urls.lock().unwrap().clone(),
        vec![vec!["https://github.com/acme/app/pull/12".to_string()]],
        "the pull-request gate checks what submit_result reported"
    );
    assert!(fx.pastes().is_empty(), "no keystrokes: {:?}", fx.pastes());
    let resumes = fx.resumes();
    assert_eq!(resumes.len(), 1, "{resumes:?}");
    assert_eq!(resumes[0].tab_id, implementer);
    let first = fx.launches().into_iter().find(|l| l.tab_id == implementer).unwrap();
    assert_eq!(resumes[0].session_id, first.session_id, "the Implementer's own session");
    assert!(resumes[0].prompt.contains("FAIL src/auth.test.ts"), "the gate output: {}", resumes[0].prompt);
    fx.run(|run| {
        assert_eq!(run.autopilot.as_ref().unwrap().gate_retries.get("implementer"), Some(&1));
        assert!(run.events.iter().any(|e| e.kind == "gate" && e.outcome.as_deref() == Some("failed")));
    });
    // The fix: the next turn's gates pass, and the PR Reviewer opens with the pull request.
    let turn = fx.end_turn(&implementer, "i-2", Some(prs), "Fixed.");
    fx.actor.handle(ActorMsg::Turn(turn));
    fx.finish_gates();
    let launch = fx.launches().last().cloned().unwrap();
    assert_eq!(launch.role_id, "role_pr_reviewer");
    assert!(launch.prompt.contains("Pull request: https://github.com/acme/app/pull/12 (branch `fix/refresh`): Refresh"), "{}", launch.prompt);
    assert!(launch.prompt.contains("npm test: passed"));
    assert!(launch.prompt.contains(&fx.run_file("prs.json").display().to_string()), "points at prs.json: {}", launch.prompt);
    fx.run(|run| assert!(run.autopilot.as_ref().unwrap().gate_retries.is_empty(), "a pass resets the retries"));
}

#[test]
fn gate_results_for_a_turn_overtaken_by_a_newer_prompt_are_not_acted_on() {
    let mut fx = Fixture::new("stale_gates");
    let implementer = to_implementer(&mut fx);
    let turn = fx.end_turn(&implementer, "i-1", Some(json!({ "schema": 1, "prs": [], "summary": "x" })), "");
    fx.actor.handle(ActorMsg::Turn(turn));
    // You typed into the Implementer while its checks ran.
    fx.start_turn(&implementer, "i-2");
    fx.finish_gates();
    assert_eq!(fx.launches().len(), 2, "no PR Reviewer");
    fx.run(|run| {
        let last = run.events.last().unwrap();
        assert!(last.summary.contains("got a newer prompt while its checks ran"), "{}", last.summary);
        assert_eq!(run.status, RunStatus::Running);
    });
}

#[test]
fn your_send_after_autopilot_handed_on_warns_once_then_goes_ahead_with_force() {
    let mut fx = Fixture::new("send_twice");
    fx.open_plan_reviewer();
    let send = |force| UserAction::Send {
        source_tab_id: String::new(),
        target_role_id: "role_plan_reviewer".into(),
        values: None,
        handoff_plan: None,
        handoff_text: None,
        force,
    };
    let with_source = |action: UserAction, tab: &str| match action {
        UserAction::Send { target_role_id, values, handoff_plan, handoff_text, force, .. } => UserAction::Send {
            source_tab_id: tab.to_string(),
            target_role_id,
            values,
            handoff_plan,
            handoff_text,
            force,
        },
        other => other,
    };
    let planner = fx.planner.clone();
    let warned = fx.user(with_source(send(false), &planner)).unwrap();
    assert!(warned.tab_id.is_none());
    assert!(warned.warning.as_deref().unwrap().starts_with("Autopilot already handed this turn on"), "{warned:?}");
    assert_eq!(fx.launches().len(), 1, "nothing opened");
    let forced = fx.user(with_source(send(true), &planner)).unwrap();
    assert!(forced.tab_id.is_some());
    assert_eq!(fx.launches().len(), 2);
    assert!(fx.user(with_source(send(false), &planner)).unwrap().tab_id.is_some(), "your own earlier hand-off never warns");
}

/// A hand-off you make outside the actor (to a Chat tab) is recorded like
/// your Send: it warns when autopilot made it first, and autopilot skips a
/// turn you already handed on. Released when the hand-off failed.
#[test]
fn a_chat_hand_off_is_recorded_so_autopilot_and_you_never_both_make_it() {
    let mut fx = Fixture::new("record_chat");
    fx.open_plan_reviewer();
    let planner = fx.planner.clone();
    let record = |force| UserAction::RecordHandoff { source_tab_id: planner.clone(), back: false, force };
    let warned = fx.user(record(false)).unwrap();
    assert!(warned.warning.as_deref().unwrap().starts_with("Autopilot already handed this turn on"), "{warned:?}");
    assert!(fx.user(record(true)).unwrap().warning.is_none());
    fx.run(|run| assert_eq!(run.claims.last().map(|c| c.by.as_str()), Some("you")));
    assert_eq!(fx.launches().len(), 1, "recording opens nothing");

    // Recorded before autopilot decides: autopilot leaves the turn to you.
    let mut fx = Fixture::new("record_chat_first");
    let planner = fx.planner.clone();
    let recorded = fx.user(UserAction::RecordHandoff { source_tab_id: planner.clone(), back: false, force: false }).unwrap();
    assert!(recorded.warning.is_none());
    let turn = fx.planner_turn("p-1", "# Plan\n1. Refresh tokens in src/auth.ts.");
    fx.actor.handle(ActorMsg::Turn(turn));
    assert!(fx.launches().is_empty(), "already handed on by you: {:?}", fx.launches());

    // Released after a failed hand-off: autopilot hands the turn on.
    let mut fx = Fixture::new("record_chat_released");
    let planner = fx.planner.clone();
    fx.user(UserAction::RecordHandoff { source_tab_id: planner.clone(), back: false, force: false }).unwrap();
    fx.user(UserAction::ReleaseHandoff { source_tab_id: planner.clone(), back: false }).unwrap();
    fx.run(|run| assert!(run.claims.is_empty(), "{:?}", run.claims));
    let turn = fx.planner_turn("p-1", "# Plan\n1. Refresh tokens in src/auth.ts.");
    fx.actor.handle(ActorMsg::Turn(turn));
    assert_eq!(fx.launches().len(), 1, "autopilot opened the Plan Reviewer");
}

#[test]
fn your_send_back_goes_into_the_running_stage() {
    let mut fx = Fixture::new("send_back");
    let reviewer = fx.open_plan_reviewer();
    fx.end_turn(&reviewer, "r-1", review("APPROVED_WITH_CHANGES", json!([])), "");
    let outcome = fx
        .user(UserAction::SendBack {
            source_tab_id: reviewer,
            target_role_id: "role_planner".into(),
            text: "Review findings from the Plan Reviewer (round 1):\n\nAdd a test.".into(),
            verdict: None,
            values: None,
            handoff_plan: None,
            force: false,
        })
        .unwrap();
    assert_eq!(outcome.tab_id.as_deref(), Some(fx.planner.as_str()));
    assert!(fx.pastes().is_empty());
    let resumes = fx.resumes();
    assert_eq!(resumes.len(), 1);
    assert_eq!(resumes[0].session_id, PLANNER_SID);
    assert!(resumes[0].prompt.starts_with("Review findings from the Plan Reviewer (round 1):\n\nAdd a test."), "your text: {}", resumes[0].prompt);
    fx.run(|run| {
        assert_eq!(run.round, 2);
        assert_eq!(run.claims.last().map(|c| (c.key.as_str(), c.by.as_str())), Some(("back:plan_reviewer#1", "you")));
    });
}

#[test]
fn a_stage_that_exits_mid_turn_stops_the_run() {
    let mut fx = Fixture::new("exited");
    let reviewer = fx.open_plan_reviewer();
    fx.start_turn(&reviewer, "r-1");
    fx.actor.handle(ActorMsg::Exited { tab_id: reviewer.clone(), code: Some(1) });
    fx.run(|run| assert_eq!((run.status, run.stop_reason), (RunStatus::Waiting, Some(StopReason::CarryOutFailed))));
    assert!(fx.stops().last().unwrap().1.contains("exited (exit code 1) before it finished its turn"));
    // An exit after the turn ended is nobody's news.
    let mut fx = Fixture::new("exited_after");
    let reviewer = fx.open_plan_reviewer();
    fx.end_turn(&reviewer, "r-1", None, "");
    fx.actor.handle(ActorMsg::Exited { tab_id: reviewer, code: Some(0) });
    fx.run(|run| assert_eq!(run.status, RunStatus::Running));
}

#[test]
fn a_turn_on_an_engine_1_run_is_left_alone_because_it_is_manual_only() {
    let mut fx = Fixture::with_engine("engine1", 1);
    let turn = fx.planner_turn("p-1", "# Plan");
    fx.actor.handle(ActorMsg::Turn(turn));
    assert!(fx.launches().is_empty());
    fx.run(|run| assert!(run.events.iter().all(|e| e.kind != "turn")));
    let err = fx.user(UserAction::Continue).unwrap_err();
    assert!(err.contains("older pipeline engine") && err.contains("manual only"), "{err}");
}

#[test]
fn autopilot_off_records_the_turn_and_does_nothing_else() {
    let mut fx = Fixture::new("manual");
    fx.host.store.lock().unwrap().pipeline_run_by_id_mut(RUN).unwrap().set_autopilot_enabled(false);
    let turn = fx.planner_turn("p-1", "# Plan");
    fx.actor.handle(ActorMsg::Turn(turn));
    assert!(fx.launches().is_empty());
    fx.run(|run| assert_eq!(run.events.last().map(|e| e.kind.as_str()), Some("turn")));
}

#[test]
fn a_panic_stops_the_run_with_carry_out_failed_and_leaves_the_store_usable() {
    let fx = Fixture::new("panic");
    fx.host.panic_on_usage.store(true, Ordering::SeqCst);
    let turn = fx.planner_turn("p-1", "# Plan");
    let actors = RunActors::with_idle(fx.host.clone(), Duration::from_secs(30));
    actors.send(RUN, ActorMsg::Turn(turn));
    let deadline = Instant::now() + Duration::from_secs(10);
    while actors.running(RUN) {
        assert!(Instant::now() < deadline, "the actor thread never ended");
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(!fx.host.store.is_poisoned(), "the store keeps working for the rest of the app");
    fx.run(|run| {
        assert_eq!((run.status, run.stop_reason), (RunStatus::Stopped, Some(StopReason::CarryOutFailed)));
        assert!(!run.autopilot.as_ref().unwrap().enabled);
        assert!(run.events.last().unwrap().summary.contains("usage exploded"), "{:?}", run.events.last());
    });
    assert_eq!(fx.stops().last().map(|s| s.0), Some(StopReason::CarryOutFailed));
    let mode = std::fs::read_to_string(fx.host.runs.join(RUN).join("stages/planner/mode")).unwrap();
    assert_eq!(mode, "manual", "the stages stop enforcing a result");
    // The next message starts a new thread, which answers.
    fx.host.panic_on_usage.store(false, Ordering::SeqCst);
    let err = actors.ask(RUN, UserAction::Continue, Duration::from_secs(10)).unwrap_err();
    assert!(err.contains("not waiting after a restart"), "{err}");
}

#[test]
fn an_idle_actor_ends_and_the_next_message_starts_another() {
    let fx = Fixture::new("idle");
    let actors = RunActors::with_idle(fx.host.clone(), Duration::from_millis(50));
    let _ = actors.ask(RUN, UserAction::Approve { lane: Some("pr9".into()) }, Duration::from_secs(10));
    let deadline = Instant::now() + Duration::from_secs(10);
    while actors.running(RUN) {
        assert!(Instant::now() < deadline, "the idle actor never ended");
        std::thread::sleep(Duration::from_millis(10));
    }
    let err = actors.ask(RUN, UserAction::Approve { lane: Some("pr9".into()) }, Duration::from_secs(10)).unwrap_err();
    assert!(err.contains("pr9"), "a new thread answered: {err}");
}

#[test]
fn every_built_in_stage_merges_from_the_run_folder_alone() {
    let roles = crate::store::bundled_seed().unwrap().roles;
    let sources = StageSources {
        first_answers: planner_answers("/tmp"),
        first_role: "role_planner".into(),
        plan: Some("# Plan".into()),
        prs: Some(json!({ "prs": [{ "url": "https://github.com/a/b/pull/1" }], "summary": "Done." })),
        cwd: "/tmp".into(),
        ..StageSources::default()
    };
    for (role_id, reviews) in [("role_plan_reviewer", true), ("role_implementer", false), ("role_pr_reviewer", true)] {
        let role = roles.iter().find(|r| r.id == role_id).unwrap();
        let built = stage_values(role, reviews, &sources);
        let merged = crate::template::merge_role_prompt_with(role, &built.values, "");
        assert!(merged.errors.is_empty(), "{role_id}: {:?}", merged.errors);
        assert_eq!(built.handoff_text, "# Plan", "{role_id}");
    }
    // A lane's Implementer is told which task is its own.
    let role = roles.iter().find(|r| r.id == "role_implementer").unwrap();
    let lane = StageSources { lane_note: Some("Implement only PR2 (UI)".into()), ..sources.clone() };
    assert!(stage_values(role, false, &lane).values["additionalContext"].starts_with("Implement only PR2"));
    // Eagle-Eye 2: the Implementer is step 1, and its reviewer reads its form.
    let ee2 = StageSources {
        first_answers: HashMap::from([("title".into(), "T".into()), ("description".into(), "Do it.".into())]),
        first_role: "role_implementer".into(),
        ..sources
    };
    let reviewer = roles.iter().find(|r| r.id == "role_pr_reviewer").unwrap();
    let values = stage_values(reviewer, true, &ee2).values;
    assert_eq!(values["originalTask"], "Title: T\n\nRequest:\nDo it.");
}

#[test]
fn a_prefill_for_your_send_comes_from_the_run_files() {
    let mut fx = Fixture::new("prefill");
    let reviewer = fx.open_plan_reviewer();
    fx.end_turn(&reviewer, "r-1", review("APPROVED", json!([])), "Approved.");
    let outcome = fx
        .user(UserAction::Prefill { source_tab_id: reviewer.clone(), target_role_id: "role_implementer".into() })
        .unwrap();
    let prefill = outcome.prefill.expect("values");
    assert_eq!(prefill.values["approvedPlan"], "# Plan\n1. Refresh tokens in src/auth.ts.", "from plan.md");
    assert_eq!(prefill.values["taskType"], "Bug Fix");
    assert!(prefill.values["additionalContext"].contains(&fx.run_file("plan.md").display().to_string()));
    assert_eq!(prefill.handoff_text, "# Plan\n1. Refresh tokens in src/auth.ts.");
    assert!(fx.launches().len() == 1 && fx.run(|run| run.claims.iter().all(|c| c.by != "you")), "nothing happens");
    // Not the next stage: no prefill.
    let err = fx
        .user(UserAction::Prefill { source_tab_id: reviewer, target_role_id: "role_pr_reviewer".into() })
        .unwrap_err();
    assert!(err.contains("not the stage after"), "{err}");
}

/// V2b's BLOCKED Implementer, ported to the actor: no checks run, and the
/// run waits for you (`checkpoint`) with its reason.
#[test]
fn a_blocked_implementer_runs_no_checks_and_waits_with_its_reason() {
    let mut fx = Fixture::new("blocked");
    let implementer = to_implementer(&mut fx);
    let blocked = json!({ "schema": 1, "prs": [], "summary": "Nothing built.", "blocked": "The plan's API does not exist." });
    let turn = fx.end_turn(&implementer, "i-1", Some(blocked), "Blocked.");
    fx.actor.handle(ActorMsg::Turn(turn));
    assert!(!fx.actor.busy(), "no checks run for a blocked turn");
    assert!(fx.gates_done.try_recv().is_err());
    fx.run(|run| {
        assert_eq!((run.status, run.stop_reason), (RunStatus::Waiting, Some(StopReason::Checkpoint)));
        assert!(run.events.iter().all(|e| e.kind != "gate"));
        let last = run.events.last().unwrap();
        assert!(last.summary.contains("The plan's API does not exist"), "{}", last.summary);
    });
    assert_eq!(fx.stops().last().map(|s| s.0), Some(StopReason::Checkpoint));
}

/// The Implementer's turn whose check failed: the retry resumed it once (V4).
fn implementer_with_a_failed_gate(fx: &mut Fixture) -> (String, BridgeTurn) {
    let implementer = to_implementer(fx);
    fx.host.gates.lock().unwrap().push_back(GateResult {
        kind: "command".into(),
        label: "npm run check".into(),
        status: "failed".into(),
        summary: "Exited with code 1.".into(),
        output: "FAIL src/auth.test.ts".into(),
        duration_ms: 5,
        optional: false,
    });
    let prs = json!({ "schema": 1, "prs": [{ "url": "https://github.com/acme/app/pull/12", "branch": "b", "title": "t" }], "summary": "s" });
    let turn = fx.end_turn(&implementer, "i-1", Some(prs), "Opened https://github.com/acme/app/pull/12");
    fx.actor.handle(ActorMsg::Turn(turn.clone()));
    fx.finish_gates();
    assert_eq!(fx.resumes().len(), 1, "the failed check went back once");
    assert!(fx.pastes().is_empty());
    (implementer, turn)
}

fn retries(fx: &Fixture) -> Option<u32> {
    fx.run(|run| run.autopilot.as_ref().unwrap().gate_retries.get("implementer").copied())
}

#[test]
fn a_turn_handed_to_a_new_actor_again_runs_no_checks_and_pastes_nothing() {
    let mut fx = Fixture::new("dedupe_retry");
    let (_, turn) = implementer_with_a_failed_gate(&mut fx);
    let gate_lines = fx.run(|run| run.events.iter().filter(|e| e.kind == "gate").count());
    // The thread went idle; the watcher (or a re-read) hands the same turn to a new one.
    let (me, gates) = channel();
    let mut again = Actor::new(RUN.to_string(), fx.host.clone(), me);
    again.handle(ActorMsg::Turn(turn));
    if let Ok(msg) = gates.recv_timeout(Duration::from_millis(500)) {
        again.handle(msg);
    }
    assert!(!again.busy(), "no checks for a turn decided already");
    assert_eq!(fx.resumes().len(), 1, "the check's output is not sent twice");
    assert!(fx.pastes().is_empty());
    assert_eq!(retries(&fx), Some(1), "no extra retry is counted");
    assert_eq!(fx.run(|run| run.events.iter().filter(|e| e.kind == "gate").count()), gate_lines, "no duplicate gate lines");
}

/// A session log whose last turn finished (what H3's reconcile reads).
fn finished_log() -> crate::claude_session_log::TerminalSessionLog {
    crate::claude_session_log::TerminalSessionLog {
        session_id: "s".into(),
        path: "/tmp/x.jsonl".into(),
        turn_done: true,
        last_reply: "Done".into(),
        plan: None,
        plan_at: None,
        last_prompt_at: Some("2026-10-20T10:00:00Z".into()),
        interrupted: false,
        tool_calls: Vec::new(),
        open_tool: None,
        pending_tools: Vec::new(),
        permission_mode: None,
        rate_limit: None,
    }
}

/// H3's startup reconcile of the run, fed the way the app feeds it: each
/// current stage tab's turn id from its stage's `turn.json`, read now.
fn reconcile_after_restart(fx: &Fixture, tab_id: &str) -> Option<crate::pipelines::recovery::Reconciled> {
    let mut store = fx.host.store.lock().unwrap();
    let tag = store.tab_by_id(tab_id).and_then(|tab| tab.bridge.clone());
    let mut bridged = HashMap::new();
    let mut no_turn = HashSet::new();
    match crate::commands::run_recovery::bridge_turn_of(&fx.host.runs, tab_id, tag.as_ref()) {
        Some(Some(turn)) => {
            bridged.insert(tab_id.to_string(), turn);
        }
        Some(None) => {
            no_turn.insert(tab_id.to_string());
        }
        None => {}
    }
    let logs = HashMap::from([(tab_id.to_string(), finished_log())]);
    let run = store.pipeline_run_by_id_mut(RUN).unwrap();
    let def = crate::pipelines::find(&run.kind).unwrap();
    crate::pipelines::recovery::reconcile_run_bridged(&def, run, &logs, &bridged, &no_turn)
}

/// A turn the actor decided that keeps its `turn.json`: the Planner's plan,
/// handed on, then a round pasted back into it (a Planner with no saved
/// session is pasted into, not resumed, so its `turn.json` stays). After a
/// restart before the pasted round started, H3's reconcile sees that turn
/// as decided, and Continue on it decides nothing again.
#[test]
fn continue_on_a_turn_the_actor_decided_runs_no_checks() {
    let mut fx = Fixture::new("dedupe_continue");
    let planner = fx.planner.clone();
    let reviewer = fx.open_plan_reviewer();
    fx.host.store.lock().unwrap().data.tabs.iter_mut().find(|t| t.id == planner).unwrap().sessions.claude_terminal_session_id = None;
    let turn = fx.end_turn(&reviewer, "r-1", review("CHANGES_REQUIRED", json!([{ "severity": "HIGH", "summary": "x" }])), "");
    fx.actor.handle(ActorMsg::Turn(turn));
    assert_eq!(fx.pastes().len(), 1, "the round was pasted into the Planner");
    assert_eq!(fx.stage_dir(&planner).turn().map(|t| t.turn), Some("p-1".to_string()), "its decided turn keeps turn.json");
    let launches = fx.launches().len();
    let turn_lines = fx.run(|run| run.events.iter().filter(|e| e.kind == "turn").count());
    // The app restarted with the run on the Planner: its decided turn does
    // not wait for Continue...
    assert_eq!(reconcile_after_restart(&fx, &planner), None, "a turn the actor decided is not stopped as app_restarted");
    fx.run(|run| assert_eq!(run.status, RunStatus::Running));
    // ...and when the run waits after a restart anyway (another tab), Continue
    // reads that turn.json again and decides nothing twice.
    fx.host.store.lock().unwrap().pipeline_run_by_id_mut(RUN).unwrap().stop_for(
        StopReason::AppRestarted,
        Some("planner"),
        None,
        "Waiting after a restart.".to_string(),
        None,
    );
    let (me, gates) = channel();
    let mut fresh = Actor::new(RUN.to_string(), fx.host.clone(), me);
    let (reply, answer) = channel();
    fresh.handle(ActorMsg::User { action: UserAction::Continue, reply: Some(reply) });
    answer.recv().unwrap().unwrap();
    assert!(!fresh.busy(), "Continue starts no checks for a decided turn");
    assert!(gates.try_recv().is_err());
    assert_eq!(fx.launches().len(), launches, "Continue does not hand the decided plan on again: {:?}", fx.launches());
    let again = fx.run(|run| run.events.iter().filter(|e| e.kind == "turn").count());
    assert_eq!(again, turn_lines, "no second ledger line for the decided turn");
    assert_eq!(fx.pastes().len(), 1);
    assert!(fx.resumes().is_empty());
    fx.run(|run| assert_eq!(run.status, RunStatus::Running, "the run carries on"));
}

/// A restart right after a resume: the stage's `turn.json` was cleared and
/// its log still ends on the turn the actor decided. That is no finished
/// turn to Continue on: the run is not stopped as `app_restarted`, and a
/// Timeline note says the round may not have reached the stage.
#[test]
fn a_restart_right_after_a_resume_is_not_stopped_as_app_restarted() {
    let mut fx = Fixture::new("restart_after_resume");
    let (implementer, _) = implementer_with_a_failed_gate(&mut fx);
    assert!(fx.stage_dir(&implementer).turn().is_none(), "the resume cleared turn.json");
    let found = reconcile_after_restart(&fx, &implementer);
    assert!(!matches!(found, Some(crate::pipelines::recovery::Reconciled::Waiting { .. })), "a false Continue: {found:?}");
    fx.run(|run| {
        assert_eq!((run.status, run.stop_reason), (RunStatus::Running, None));
        let last = run.events.last().unwrap();
        assert_eq!(last.kind, "note");
        assert!(last.summary.contains("may not have reached it"), "{}", last.summary);
    });
}

/// A copy of a built-in role under another id (Settings › Roles › Duplicate).
fn copied_role(of: &str, id: &str, name: &str) -> Role {
    let mut role = crate::store::bundled_seed().unwrap().roles.into_iter().find(|r| r.id == of).unwrap();
    role.id = id.into();
    role.name = name.into();
    role
}

/// Eagle-Eye 1's shape with copied reviewers: the stage kind (a loop-back
/// to the Planner) makes "Plan check" a plan reviewer, whatever its role id.
fn copied_reviewers_pipeline(id: &str) -> crate::pipelines::PipelineDef {
    serde_json::from_value(json!({
        "id": id, "name": "Copied reviewers",
        "stages": [
            { "id": "planner", "roleId": "role_planner", "title": "Planner" },
            { "id": "plan_check", "roleId": "role_custom_plan_check", "title": "Plan check",
              "loopBack": { "to": "planner", "minSeverity": "MEDIUM" } },
            { "id": "implementer", "roleId": "role_implementer", "title": "Implementer" },
            { "id": "pr_check", "roleId": "role_custom_pr_check", "title": "PR check",
              "loopBack": { "to": "implementer", "minSeverity": "MEDIUM" } }
        ]
    }))
    .unwrap()
}

#[test]
fn a_copied_plan_reviewer_sends_its_round_back_with_the_planner_ask() {
    let id = "copied_reviewers_v3";
    crate::pipelines::register_for_test(copied_reviewers_pipeline(id));
    let mut fx = Fixture::with_pipeline(
        "copied_plan_reviewer",
        id,
        vec![
            copied_role("role_plan_reviewer", "role_custom_plan_check", "Plan check"),
            copied_role("role_pr_reviewer", "role_custom_pr_check", "PR check"),
        ],
    );
    assert_eq!(fx.run(|run| run.engine), 2, "a copied reviewer is bridged like the built-in one");
    let reviewer = fx.open_plan_reviewer();
    assert_eq!(fx.tab(&reviewer).role_id, "role_custom_plan_check");
    let turn = fx.end_turn(
        &reviewer,
        "r-1",
        review("CHANGES_REQUIRED", json!([{ "severity": "HIGH", "summary": "Retries forever." }])),
        "Changes required.",
    );
    fx.actor.handle(ActorMsg::Turn(turn));
    crate::pipelines::unregister_for_test(id);
    // V4: the round resumes the Planner's session; its prompt carries the ask.
    let resumes = fx.resumes();
    assert_eq!(resumes.len(), 1, "{resumes:?}");
    assert_eq!(resumes[0].tab_id, fx.planner);
    let prompt = &resumes[0].prompt;
    assert!(prompt.contains("Revise the plan"), "the Planner is asked to revise its plan:\n{prompt}");
    assert!(!prompt.contains("push to the same branch"), "not the Implementer's ask:\n{prompt}");
    fx.run(|run| {
        assert_eq!(run.verdicts.last().and_then(|v| v.verdict.as_deref()), Some("REQUIRES REVISION"), "a plan reviewer revises");
    });
}

/// H4: your Send's prefill fills a reviewer's form by the stage's kind, so
/// a copied reviewer with no loop-back of its own still gets the pull
/// requests in its context.
#[test]
fn a_prefill_for_a_copied_reviewer_with_no_loop_back_carries_the_pull_requests() {
    let id = "copied_final_check_v4";
    // Eagle-Eye 1 with its PR Reviewer swapped for a copied reviewer that
    // sends nothing back.
    let mut def = crate::pipelines::find("eagle1").unwrap();
    def.id = id.into();
    def.run_kind = None;
    def.built_in = false;
    let last = def.stages.last_mut().unwrap();
    last.role_id = "role_custom_final_check".into();
    last.kind = Some(crate::pipelines::StageKind::Reviewer);
    last.loop_back = None;
    crate::pipelines::register_for_test(def);
    let mut fx = Fixture::with_pipeline(
        "prefill_copied_reviewer",
        id,
        vec![copied_role("role_pr_reviewer", "role_custom_final_check", "Final check")],
    );
    let implementer = to_implementer(&mut fx);
    let prs = json!({ "schema": 1, "prs": [{ "url": "https://github.com/acme/app/pull/12", "branch": "fix/refresh", "title": "Refresh" }],
                      "summary": "Expired tokens are refreshed once." });
    fx.stage_dir(&implementer)
        .write_prs(&RunPrs { schema: 1, run_id: RUN.into(), stage_key: "implementer".into(), lane: None, turn: "i-1".into(), at: "now".into(), result: prs.clone() })
        .unwrap();
    fx.end_turn(&implementer, "i-1", Some(prs), "Opened https://github.com/acme/app/pull/12");
    let outcome = fx.user(UserAction::Prefill { source_tab_id: implementer, target_role_id: "role_custom_final_check".into() });
    crate::pipelines::unregister_for_test(id);
    let prefill = outcome.unwrap().prefill.expect("values");
    let context = prefill.values.values().cloned().collect::<Vec<_>>().join("\n");
    assert!(context.contains("https://github.com/acme/app/pull/12"), "a reviewer's form names the pull requests:\n{context}");
}

#[test]
fn plan_reviewers_and_fan_out_stages_are_known_by_their_kind() {
    use super::actor::{implementer_stage, reviews_plan, revise_word};
    let mut def = copied_reviewers_pipeline("copied_kinds");
    assert!(reviews_plan(&def, &def.stages[1]));
    assert!(!reviews_plan(&def, &def.stages[3]));
    assert_eq!(revise_word(&def, &def.stages[1]), "REQUIRES REVISION");
    assert_eq!(revise_word(&def, &def.stages[3]), "REQUEST CHANGES");
    // A copied Implementer is where lanes start.
    def.stages[2].role_id = "role_custom_builder".into();
    def.stages[2].kind = Some(crate::pipelines::StageKind::Implementer);
    assert_eq!(implementer_stage(&def).map(|s| s.role_id.as_str()), Some("role_custom_builder"));
    let built_in = crate::pipelines::find("eagle1").unwrap();
    assert!(reviews_plan(&built_in, built_in.stage("plan_reviewer").unwrap()));
    assert_eq!(implementer_stage(&built_in).map(|s| s.role_id.as_str()), Some("role_implementer"));
}

/// H5 on engine 2: a turn Claude refused for the usage limit ends without
/// the tool; the run stops with `usage_limit`, not `no_result`, and runs no checks.
#[test]
fn a_turn_cut_off_by_the_usage_limit_stops_as_usage_limit_without_checks() {
    let mut fx = Fixture::new("rate_limit");
    let implementer = to_implementer(&mut fx);
    fx.host
        .rate_limits
        .lock()
        .unwrap()
        .insert(implementer.clone(), "You've hit your limit · resets 3pm".into());
    let turn = fx.end_turn(&implementer, "i-1", None, "");
    fx.actor.handle(ActorMsg::Turn(turn));
    assert!(!fx.actor.busy(), "no checks for a refused turn");
    fx.run(|run| {
        assert_eq!((run.status, run.stop_reason), (RunStatus::Waiting, Some(StopReason::UsageLimit)));
        assert!(run.events.iter().all(|e| e.kind != "gate"));
        assert!(run.events.last().unwrap().summary.contains("resets 3pm"), "{:?}", run.events.last());
    });
    assert_eq!(fx.stops().last().map(|s| s.0), Some(StopReason::UsageLimit));
}

/// H5 with V4: a review turn the usage limit cut off sends no round back,
/// so no stage is killed and resumed into the same limit.
#[test]
fn a_review_cut_off_by_the_usage_limit_resumes_nothing() {
    let mut fx = Fixture::new("rate_limit_resume");
    let reviewer = fx.open_plan_reviewer();
    fx.host.rate_limits.lock().unwrap().insert(reviewer.clone(), "You've hit your limit · resets 3pm".into());
    let turn = fx.end_turn(&reviewer, "r-1", review("CHANGES_REQUIRED", json!([{ "severity": "HIGH", "summary": "x" }])), "");
    fx.actor.handle(ActorMsg::Turn(turn));
    assert!(fx.resumes().is_empty() && fx.pastes().is_empty(), "nothing sent back: {:?}", fx.resumes());
    fx.run(|run| assert_eq!((run.status, run.stop_reason), (RunStatus::Waiting, Some(StopReason::UsageLimit))));
}

/// D24 on the actor's launch path (always mid-run): a stage the gate sends
/// to engine 1 opens without the bridge (no flags, no result instructions,
/// no stage folder), and the run is manual from then on (V2a's rule for a
/// mid-run switch): autopilot off for good, the stages stop enforcing a
/// result, one Timeline note.
#[test]
fn a_stage_the_version_gate_refuses_opens_unbridged_and_the_run_goes_to_engine_1() {
    let mut fx = Fixture::new("gate_refused");
    fx.host.gate_open.store(false, Ordering::SeqCst);
    let reviewer = fx.open_plan_reviewer();
    let launch = fx.launches().last().cloned().unwrap();
    assert_eq!(launch.bridge, None, "launched without the bridge");
    assert!(!launch.prompt.contains("mcp__dcterminal__submit_result"), "no result instructions");
    assert_eq!(fx.tab(&reviewer).bridge, None);
    assert!(!fx.host.runs.join(RUN).join("stages/plan_reviewer").exists(), "no stage folder");
    fx.run(|run| {
        assert_eq!(run.engine, 1);
        assert!(run.engine_note.as_deref().unwrap().contains("manual from now on"), "{:?}", run.engine_note);
        assert!(!run.autopilot.as_ref().unwrap().enabled, "autopilot is off");
        assert!(run.manual_only, "for good");
        assert_eq!(run.status, RunStatus::Stopped);
        let notes = run.events.iter().filter(|e| e.kind == "note" && e.summary.contains("Claude Code 2.1.200")).count();
        assert_eq!(notes, 1, "one Timeline note: {:?}", run.events);
    });
    let mode = std::fs::read_to_string(fx.host.runs.join(RUN).join("stages/planner/mode")).unwrap();
    assert_eq!(mode, "manual", "the bridged Planner stops enforcing a result");
}

/// V4 with V2a: a resume relaunches through the same D24 gate as a first
/// launch. When the gate now refuses (Claude Code downgraded, hooks off),
/// the run is manual from then on (V2a's rule for a mid-run switch) and
/// nothing is resumed: a loop-back is autopilot's own action. The round's
/// findings file stays, and the one Timeline note says where it is.
#[test]
fn a_resume_the_version_gate_refuses_makes_the_run_manual_and_resumes_nothing() {
    let mut fx = Fixture::new("gate_refused_resume");
    let reviewer = fx.open_plan_reviewer();
    let launches = fx.launches().len();
    fx.host.gate_open.store(false, Ordering::SeqCst);
    let turn = fx.end_turn(&reviewer, "r-1", review("CHANGES_REQUIRED", json!([{ "severity": "HIGH", "summary": "x" }])), "");
    fx.actor.handle(ActorMsg::Turn(turn));
    assert!(fx.resumes().is_empty(), "nothing resumed: {:?}", fx.resumes());
    assert!(fx.pastes().is_empty(), "nothing pasted");
    assert_eq!(fx.launches().len(), launches, "no new terminal");
    let file = fx.run_file("findings-plan_reviewer-r1.json");
    assert!(file.exists(), "the round's findings stay in the run folder");
    fx.run(|run| {
        assert_eq!(run.engine, 1);
        assert!(run.manual_only, "manual for good");
        assert!(!run.autopilot.as_ref().unwrap().enabled, "autopilot is off");
        assert_eq!(run.status, RunStatus::Stopped);
        assert_ne!(run.stop_reason, Some(StopReason::CarryOutFailed), "not a failure to carry out");
        let notes: Vec<&str> = run.events.iter().filter(|e| e.kind == "note").map(|e| e.summary.as_str()).collect();
        let manual: Vec<&&str> = notes.iter().filter(|n| n.contains("manual from now on")).collect();
        assert_eq!(manual.len(), 1, "one Timeline note: {notes:?}");
        assert!(manual[0].contains(&file.display().to_string()), "it says where the findings are: {}", manual[0]);
        assert!(notes.iter().all(|n| !n.contains("could not")), "no carry-out failure note: {notes:?}");
        // Nothing was sent, so no round is recorded as sent back and
        // autopilot's hand-off is not kept: your own Send back is a first one.
        let sent: Vec<&str> = run.events.iter().filter(|e| e.kind == "loopBack").map(|e| e.summary.as_str()).collect();
        assert!(sent.is_empty(), "the Timeline says the round was sent back: {sent:?}");
        assert_eq!(run.round, 1, "the round counter stays");
        assert!(run.claims.iter().all(|c| c.key != "back:plan_reviewer#1"), "autopilot's claim is released: {:?}", run.claims);
    });
    let mode = std::fs::read_to_string(fx.host.runs.join(RUN).join("stages/planner/mode")).unwrap();
    assert_eq!(mode, "manual", "the stages stop enforcing a result");
}

/// Your own Send back, refused by the D24 / hooks-off gate at the resume:
/// you get the reason, nothing is recorded as sent back, your hand-off is
/// released, and the one Timeline note talks about your Send back, not
/// about something autopilot was sending.
#[test]
fn your_send_back_the_version_gate_refuses_is_not_recorded_as_sent() {
    let mut fx = Fixture::new("gate_refused_send_back");
    let reviewer = fx.open_plan_reviewer();
    fx.end_turn(&reviewer, "r-1", review("APPROVED_WITH_CHANGES", json!([])), "");
    fx.host.gate_open.store(false, Ordering::SeqCst);
    let err = fx
        .user(UserAction::SendBack {
            source_tab_id: reviewer,
            target_role_id: "role_planner".into(),
            text: "Add a test.".into(),
            verdict: None,
            values: None,
            handoff_plan: None,
            force: false,
        })
        .unwrap_err();
    assert!(err.contains("manual now"), "{err}");
    assert!(fx.resumes().is_empty() && fx.pastes().is_empty(), "nothing sent");
    fx.run(|run| {
        assert!(run.manual_only);
        assert!(run.events.iter().all(|e| e.kind != "loopBack"), "not recorded as sent back");
        assert_eq!(run.round, 1);
        assert!(run.claims.iter().all(|c| c.key != "back:plan_reviewer#1"), "your claim is released: {:?}", run.claims);
        let manual: Vec<&str> = run
            .events
            .iter()
            .filter(|e| e.kind == "note" && e.summary.contains("manual from now on"))
            .map(|e| e.summary.as_str())
            .collect();
        assert_eq!(manual.len(), 1, "{manual:?}");
        assert!(!manual[0].contains("autopilot was sending"), "wrong wording for your own Send back: {}", manual[0]);
        assert!(manual[0].contains("Your Send back was not sent"), "it says your Send back was not sent: {}", manual[0]);
    });
}

/// H4 on engine 2: an `auto` check with nothing to run stops the run with
/// `no_check_found` unless its gate is `optional`; the actor carries the
/// gate's `optional` into the result whatever the host reported.
#[test]
fn an_optional_gate_with_no_check_lets_the_run_go_on_and_a_required_one_stops_it() {
    let no_check = || GateResult::skipped("command", "auto", "No check command found.");
    let prs = json!({ "schema": 1, "prs": [{ "url": "https://github.com/acme/app/pull/12", "branch": "b", "title": "t" }], "summary": "s" });

    // Required (Eagle-Eye 1's own gate): the run stops.
    let mut fx = Fixture::new("gate_required");
    let implementer = to_implementer(&mut fx);
    fx.host.gates.lock().unwrap().push_back(no_check());
    let turn = fx.end_turn(&implementer, "i-1", Some(prs.clone()), "Done.");
    fx.actor.handle(ActorMsg::Turn(turn));
    fx.finish_gates();
    fx.run(|run| assert_eq!((run.status, run.stop_reason), (RunStatus::Waiting, Some(StopReason::NoCheckFound))));

    // Optional, on a pipeline of your own: the run moves on to the PR Reviewer.
    let id = "eagle1_optional_gate_v3";
    let mut def = crate::pipelines::find("eagle1").unwrap();
    def.id = id.into();
    def.name = "Optional gate".into();
    def.run_kind = None;
    def.built_in = false;
    let implementer_stage = def.stages.iter_mut().find(|s| s.id == "implementer").unwrap();
    implementer_stage.gates = vec![crate::pipelines::GateDef::Command { run: "auto".into(), timeout_secs: None, optional: true }];
    crate::pipelines::register_for_test(def);
    let mut fx = Fixture::with_pipeline("gate_optional", id, Vec::new());
    let implementer = to_implementer(&mut fx);
    fx.host.gates.lock().unwrap().push_back(no_check());
    let turn = fx.end_turn(&implementer, "i-1", Some(prs), "Done.");
    fx.actor.handle(ActorMsg::Turn(turn));
    fx.finish_gates();
    crate::pipelines::unregister_for_test(id);
    fx.run(|run| {
        assert_eq!(run.status, RunStatus::Running, "{:?}", run.events.last());
        assert!(run.gates["implementer"].results[0].optional, "the result says the gate is optional");
    });
    assert_eq!(fx.launches().last().map(|l| l.role_id.as_str()), Some("role_pr_reviewer"));
}

fn turn_with(result: Option<Value>, message: &str) -> BridgeTurn {
    BridgeTurn {
        schema: 1,
        run_id: RUN.into(),
        stage_key: "implementer".into(),
        stage_id: "implementer".into(),
        role_id: "role_implementer".into(),
        lane: None,
        tab_id: "tab_i".into(),
        turn: "i-1".into(),
        outcome: if result.is_some() { TurnOutcome::Result } else { TurnOutcome::NoResult },
        ended_at: "2026-10-20T10:00:00Z".into(),
        last_assistant_message: message.into(),
        blocked: false,
        result,
    }
}

#[test]
fn the_pull_request_gate_checks_the_reported_pull_requests_else_the_links_in_the_reply() {
    use super::actor::{github_pr_urls, pr_urls};
    // submit_result's prs[] wins over the reply's links.
    let reported = turn_with(
        Some(json!({ "schema": 1, "prs": [{ "url": "https://github.com/acme/app/pull/12" }, { "url": "https://github.com/acme/app/pull/13" }], "summary": "s" })),
        "See https://github.com/other/repo/pull/99",
    );
    assert_eq!(pr_urls(&reported), vec!["https://github.com/acme/app/pull/12", "https://github.com/acme/app/pull/13"]);
    // No prs[] (no result, or an empty list): every pull-request link in the reply.
    let none = turn_with(None, "Opened https://github.com/acme/app/pull/12.");
    assert_eq!(pr_urls(&none), vec!["https://github.com/acme/app/pull/12"]);
    let empty = turn_with(Some(json!({ "schema": 1, "prs": [], "summary": "s" })), "https://github.com/acme/app/pull/7");
    assert_eq!(pr_urls(&empty), vec!["https://github.com/acme/app/pull/7"]);
    // Trailing paths, anchors and punctuation are cut; repeats count once.
    let text = "PRs: (https://github.com/acme/app/pull/12), https://github.com/acme/app/pull/12/files, \
                https://github.com/acme/app/pull/12#issuecomment-1, [x](https://github.com/acme/my.app-2/pull/3).\n\
                Not these: https://github.com/acme/app/pulls, https://github.com/acme/app/issues/4, \
                https://github.com/acme/app/pull/, https://github.com/acme/pull/5";
    assert_eq!(github_pr_urls(text), vec!["https://github.com/acme/app/pull/12", "https://github.com/acme/my.app-2/pull/3"]);
    assert!(github_pr_urls("").is_empty());
}

/// D18's safety net: a message that arrives while the actor panics is
/// handed to a fresh thread, which answers it; nothing is lost.
#[test]
fn a_message_queued_behind_a_panic_is_answered_by_the_next_thread() {
    let fx = Fixture::new("panic_queue");
    fx.host.panic_on_usage.store(true, Ordering::SeqCst);
    let (release, hold) = channel();
    *fx.host.hold_usage.lock().unwrap() = Some(hold);
    let turn = fx.planner_turn("p-1", "# Plan");
    let actors = RunActors::with_idle(fx.host.clone(), Duration::from_secs(30));
    // The turn's handling blocks in the usage read, then panics.
    actors.send(RUN, ActorMsg::Turn(turn));
    let asking = actors.clone();
    let button = std::thread::spawn(move || {
        asking.ask(RUN, UserAction::Approve { lane: Some("pr9".into()) }, Duration::from_secs(20))
    });
    // The button press is queued behind the turn before the panic.
    std::thread::sleep(Duration::from_millis(300));
    release.send(()).unwrap();
    let answer = button.join().unwrap();
    let err = answer.unwrap_err();
    assert!(err.contains("pr9"), "a new thread handled the queued press: {err}");
    fx.run(|run| assert_eq!(run.stop_reason, Some(StopReason::CarryOutFailed)));
}

// ---- Take over and Hand back (V5, D28) ----

fn stage_mode(fx: &Fixture, tab_id: &str) -> crate::bridge::StageMode {
    fx.stage_dir(tab_id).mode()
}

#[test]
fn a_taken_over_stage_is_never_decided_and_hand_back_decides_its_result_at_once() {
    let mut fx = Fixture::new("take_over");
    let reviewer = fx.open_plan_reviewer();
    fx.user(UserAction::TakeOver { tab_id: reviewer.clone() }).expect("take over");
    assert_eq!(stage_mode(&fx, &reviewer), crate::bridge::StageMode::Takeover, "the bridge stops enforcing");
    fx.run(|run| {
        assert_eq!(run.taken_over, vec![reviewer.clone()]);
        assert_eq!((run.status, run.stop_reason), (RunStatus::Waiting, Some(StopReason::TakenOver)));
    });
    // You and the reviewer reach a verdict while you drive it: nothing acts on it.
    let turn = fx.end_turn(
        &reviewer,
        "r-1",
        review("CHANGES_REQUIRED", json!([{ "severity": "HIGH", "summary": "Retries forever." }])),
        "Changes required.",
    );
    fx.actor.handle(ActorMsg::Turn(turn));
    assert!(fx.resumes().is_empty() && fx.pastes().is_empty(), "no decision while taken over");
    fx.run(|run| {
        assert!(run.events.iter().any(|e| e.kind == "turn"), "the turn is still recorded");
        let decided = &run.autopilot.as_ref().unwrap().decided;
        assert!(!decided.iter().any(|t| t.ends_with("|bridge|r-1")), "and left undecided: {decided:?}");
    });
    // Hand back: enforcement and decisions are on again, and the turn that
    // already has a result is decided at once.
    fx.user(UserAction::HandBack { tab_id: reviewer.clone() }).expect("hand back");
    assert_eq!(stage_mode(&fx, &reviewer), crate::bridge::StageMode::Autopilot);
    assert_eq!(fx.resumes().len(), 1, "the round went back to the Planner");
    assert_eq!(fx.resumes()[0].tab_id, fx.planner);
    fx.run(|run| {
        assert!(run.taken_over.is_empty());
        assert_eq!(run.round, 2);
        assert!(run.events.iter().any(|e| e.summary.contains("handed") && e.summary.contains("back")), "{:?}", run.events);
    });
    // A second Hand back changes nothing.
    fx.user(UserAction::HandBack { tab_id: reviewer.clone() }).expect("hand back again");
    assert_eq!(fx.resumes().len(), 1);
    // Nor does taking over and handing back again: that turn was decided.
    fx.user(UserAction::TakeOver { tab_id: reviewer.clone() }).unwrap();
    fx.user(UserAction::HandBack { tab_id: reviewer.clone() }).unwrap();
    assert_eq!(fx.resumes().len(), 1);
    fx.run(|run| assert_eq!(run.round, 2));
}

#[test]
fn handing_back_a_turn_with_no_result_waits_for_the_next_turn() {
    let mut fx = Fixture::new("hand_back_no_result");
    let reviewer = fx.open_plan_reviewer();
    fx.user(UserAction::TakeOver { tab_id: reviewer.clone() }).unwrap();
    let turn = fx.end_turn(&reviewer, "r-1", None, "What should I look at first?");
    fx.actor.handle(ActorMsg::Turn(turn));
    fx.user(UserAction::HandBack { tab_id: reviewer.clone() }).unwrap();
    assert!(fx.resumes().is_empty() && fx.pastes().is_empty());
    assert!(fx.stops().is_empty(), "no stop for a turn you drove: {:?}", fx.stops());
    fx.run(|run| assert_eq!((run.status, run.stop_reason), (RunStatus::Running, None)));
    // The next turn, on autopilot again, is decided as usual.
    let turn = fx.end_turn(&reviewer, "r-2", review("CHANGES_REQUIRED", json!([{ "severity": "HIGH", "summary": "x" }])), "");
    fx.actor.handle(ActorMsg::Turn(turn));
    assert_eq!(fx.resumes().len(), 1);
}

#[test]
fn a_taken_over_stage_may_exit_without_stopping_the_run() {
    let mut fx = Fixture::new("take_over_exit");
    let reviewer = fx.open_plan_reviewer();
    fx.start_turn(&reviewer, "r-1");
    fx.user(UserAction::TakeOver { tab_id: reviewer.clone() }).unwrap();
    fx.actor.handle(ActorMsg::Exited { tab_id: reviewer.clone(), code: Some(0) });
    assert!(fx.stops().is_empty(), "{:?}", fx.stops());
}

#[test]
fn take_over_with_autopilot_off_keeps_the_run_stopped_and_hand_back_leaves_it_manual() {
    let mut fx = Fixture::new("take_over_manual");
    let reviewer = fx.open_plan_reviewer();
    fx.host.store.lock().unwrap().pipeline_run_by_id_mut(RUN).unwrap().set_autopilot_enabled(false);
    fx.user(UserAction::TakeOver { tab_id: reviewer.clone() }).unwrap();
    fx.run(|run| assert_eq!((run.status, run.stop_reason), (RunStatus::Stopped, Some(StopReason::PausedByYou))));
    fx.user(UserAction::HandBack { tab_id: reviewer.clone() }).unwrap();
    assert_eq!(stage_mode(&fx, &reviewer), crate::bridge::StageMode::Manual);
    // Only a tab of this run can be taken over.
    assert!(fx.user(UserAction::TakeOver { tab_id: "tab_elsewhere".into() }).is_err());
}

/// D28: a decision whose carry-out lands on a stage you took over (here a
/// reviewer's round sent back to the Planner) leaves that stage alone. The
/// run waits for you with `taken_over`, and Hand back carries it out.
#[test]
fn a_round_sent_back_to_a_stage_you_took_over_waits_and_hand_back_carries_it_out() {
    let mut fx = Fixture::new("take_over_target");
    let reviewer = fx.open_plan_reviewer();
    let planner = fx.planner.clone();
    fx.user(UserAction::TakeOver { tab_id: planner.clone() }).expect("take over");
    fx.run(|run| assert_eq!(run.status, RunStatus::Running, "the reviewer still works"));
    let turn = fx.end_turn(&reviewer, "r-1", review("CHANGES_REQUIRED", json!([{ "severity": "HIGH", "summary": "x" }])), "");
    fx.actor.handle(ActorMsg::Turn(turn));
    assert!(fx.resumes().is_empty() && fx.pastes().is_empty(), "autopilot resumed a stage you took over: {:?}", fx.resumes());
    assert_eq!(stage_mode(&fx, &planner), crate::bridge::StageMode::Takeover);
    fx.run(|run| {
        assert_eq!((run.status, run.stop_reason), (RunStatus::Waiting, Some(StopReason::TakenOver)));
        let why = run.autopilot.as_ref().and_then(|a| a.waiting.clone()).unwrap_or_default();
        assert!(why.contains("Planner"), "names the stage: {why}");
        assert_eq!(run.round, 1, "no round sent back yet");
    });
    // Hand back: the round goes back to the Planner now.
    fx.user(UserAction::HandBack { tab_id: planner.clone() }).expect("hand back");
    let resumes = fx.resumes();
    assert_eq!(resumes.len(), 1, "{resumes:?}");
    assert_eq!(resumes[0].tab_id, planner);
    fx.run(|run| {
        assert_eq!((run.status, run.stop_reason), (RunStatus::Running, None));
        assert_eq!(run.round, 2);
    });
}

#[test]
fn a_turn_on_a_run_whose_pipeline_became_disabled_stops_the_run_and_opens_nothing() {
    // H4: autopilot stops with the reason instead of driving a disabled
    // pipeline on (was `pipeline_decide`'s, removed in V6).
    let id = "eagle1_disabled_v6";
    let mut def = crate::pipelines::find("eagle1").unwrap();
    def.id = id.into();
    def.name = "Disabled copy".into();
    def.run_kind = None;
    def.built_in = false;
    def.disabled = Some("role \"role_gone\" does not exist".into());
    crate::pipelines::register_for_test(def);
    let mut fx = Fixture::with_pipeline("disabled_pipeline", id, Vec::new());
    let turn = fx.planner_turn("p-1", "# Plan\n1. Refresh tokens in src/auth.ts.");
    fx.actor.handle(ActorMsg::Turn(turn));
    crate::pipelines::unregister_for_test(id);
    assert!(fx.launches().is_empty(), "nothing opened: {:?}", fx.launches());
    fx.run(|run| {
        assert_eq!((run.status, run.stop_reason), (RunStatus::Waiting, Some(StopReason::CarryOutFailed)));
        let last = run.events.last().unwrap();
        assert!(last.summary.contains("is disabled"), "{}", last.summary);
    });
}

#[test]
fn an_implementer_turn_on_a_run_whose_pipeline_became_disabled_runs_no_checks() {
    // The disabled pipeline stops the run before the stage's checks run, not
    // after them.
    let id = "eagle1_disabled_gates";
    let mut def = crate::pipelines::find("eagle1").unwrap();
    def.id = id.into();
    def.name = "Disabled later".into();
    def.run_kind = None;
    def.built_in = false;
    crate::pipelines::register_for_test(def.clone());
    let mut fx = Fixture::with_pipeline("disabled_pipeline_gates", id, Vec::new());
    let implementer = to_implementer(&mut fx);
    def.disabled = Some("role \"role_gone\" does not exist".into());
    crate::pipelines::register_for_test(def);
    let prs = json!({ "schema": 1, "prs": [{ "url": "https://github.com/acme/app/pull/12", "title": "Refresh" }], "summary": "Opened." });
    let turn = fx.end_turn(&implementer, "i-1", Some(prs), "Opened https://github.com/acme/app/pull/12");
    fx.actor.handle(ActorMsg::Turn(turn));
    crate::pipelines::unregister_for_test(id);
    assert!(!fx.actor.busy(), "no checks run on a disabled pipeline");
    assert!(fx.gates_done.try_recv().is_err());
    fx.run(|run| {
        assert_eq!((run.status, run.stop_reason), (RunStatus::Waiting, Some(StopReason::CarryOutFailed)));
        assert!(run.events.iter().all(|e| e.kind != "gate"), "{:?}", run.events);
        let last = run.events.last().unwrap();
        assert!(last.summary.contains("is disabled"), "{}", last.summary);
    });
}

/// D28: you revised the plan yourself in the Planner you took over while a
/// round for it was held, then handed it back. Your newer turn is decided
/// (the plan goes to review again); the stale findings are not sent back.
#[test]
fn handing_back_a_stage_you_revised_yourself_decides_your_turn_not_the_held_round() {
    let mut fx = Fixture::new("take_over_revised");
    let reviewer = fx.open_plan_reviewer();
    let planner = fx.planner.clone();
    fx.user(UserAction::TakeOver { tab_id: planner.clone() }).expect("take over");
    let turn = fx.end_turn(&reviewer, "r-1", review("CHANGES_REQUIRED", json!([{ "severity": "HIGH", "summary": "x" }])), "");
    fx.actor.handle(ActorMsg::Turn(turn));
    fx.run(|run| assert_eq!(run.stop_reason, Some(StopReason::TakenOver), "the round is held"));
    // You revise the plan yourself: the Planner ends a newer turn.
    let revised = fx.planner_turn("p-2", "# Plan\n1. Refresh tokens once, then fail.");
    fx.actor.handle(ActorMsg::Turn(revised));
    let reviews_before = fx.launches().iter().filter(|l| l.role_id == "role_plan_reviewer").count();
    fx.user(UserAction::HandBack { tab_id: planner.clone() }).expect("hand back");
    assert!(fx.resumes().is_empty() && fx.pastes().is_empty(), "the stale round is not sent back: {:?}", fx.resumes());
    let reviews = fx.launches().iter().filter(|l| l.role_id == "role_plan_reviewer").count();
    assert_eq!(reviews, reviews_before + 1, "your revised plan goes to review");
    fx.run(|run| {
        assert_eq!((run.status, run.stop_reason), (RunStatus::Running, None));
        assert!(
            !run.events.iter().any(|e| e.summary.contains("already handed on")),
            "your turn is not skipped: {:?}",
            run.events.iter().map(|e| e.summary.clone()).collect::<Vec<_>>()
        );
        let decided = &run.autopilot.as_ref().unwrap().decided;
        assert!(decided.iter().any(|t| t.ends_with("|bridge|p-2")), "your turn is decided: {decided:?}");
        // The Timeline never says the round went back: nothing was sent.
        let lines: Vec<&str> = run.events.iter().map(|e| e.summary.as_str()).collect();
        assert!(
            !lines.iter().any(|l| l.contains("goes back to") || l.contains("sent back") || l.contains("Handed to Planner")),
            "{lines:?}"
        );
        assert!(lines.iter().any(|l| l.contains("revised Planner yourself")), "{lines:?}");
        // Nor is the review stored as the Planner's hand-off.
        let handoff = run.handoffs.get("role_planner").map(|h| h.text.clone()).unwrap_or_default();
        assert!(!handoff.starts_with("Review findings from the"), "{handoff}");
    });
    assert!(!fx.run_file("findings-plan_reviewer-r1.json").exists(), "no findings file nothing points to");
    // Nothing is decided twice: handing back again changes nothing.
    let launches = fx.launches().len();
    fx.user(UserAction::TakeOver { tab_id: planner.clone() }).unwrap();
    fx.user(UserAction::HandBack { tab_id: planner.clone() }).unwrap();
    assert_eq!(fx.launches().len(), launches);
    assert!(fx.resumes().is_empty());
}

/// D28: Take over and Hand back keep the stage's `mode` file and the saved
/// run in step. When the run cannot be saved, the mode is put back and the
/// press fails, so the bridge and the keystroke gate never disagree with it.
#[test]
fn take_over_and_hand_back_put_the_mode_back_when_the_run_cannot_be_saved() {
    let mut fx = Fixture::new("take_over_save_fails");
    let reviewer = fx.open_plan_reviewer();
    let tmp = fx.host.store.lock().unwrap().path.with_extension("json.tmp");
    // A directory where the save writes its temp file: every save fails.
    std::fs::create_dir_all(&tmp).unwrap();
    assert!(fx.user(UserAction::TakeOver { tab_id: reviewer.clone() }).is_err());
    assert_eq!(stage_mode(&fx, &reviewer), crate::bridge::StageMode::Autopilot, "the mode is put back");
    fx.run(|run| {
        assert!(run.taken_over.is_empty(), "nor is the run left taken over");
        assert_eq!(run.status, RunStatus::Running);
    });

    std::fs::remove_dir(&tmp).unwrap();
    fx.user(UserAction::TakeOver { tab_id: reviewer.clone() }).expect("take over");
    std::fs::create_dir_all(&tmp).unwrap();
    assert!(fx.user(UserAction::HandBack { tab_id: reviewer.clone() }).is_err());
    assert_eq!(stage_mode(&fx, &reviewer), crate::bridge::StageMode::Takeover, "still yours");
    fx.run(|run| {
        assert_eq!(run.taken_over, vec![reviewer.clone()]);
        assert_eq!(run.stop_reason, Some(StopReason::TakenOver));
    });
    std::fs::remove_dir(&tmp).unwrap();
}

/// D28: the run waits with `taken_over` only when it has current stage tabs
/// and you took over every one; a run with none (here its tab list was
/// emptied) keeps running.
#[test]
fn take_over_never_waits_on_a_run_with_no_current_stage_tabs() {
    let mut fx = Fixture::new("take_over_no_current");
    let planner = fx.planner.clone();
    fx.host.store.lock().unwrap().pipeline_run_by_id_mut(RUN).unwrap().tab_ids.clear();
    fx.user(UserAction::TakeOver { tab_id: planner.clone() }).expect("take over");
    fx.run(|run| {
        assert_eq!(run.taken_over, vec![planner.clone()]);
        assert_eq!((run.status, run.stop_reason), (RunStatus::Running, None));
    });
}

/// D28 with V2a: a run the version gate sends to engine 1 mid-run is manual
/// for good, so nothing is taken over any more. A stage you had taken over
/// is released (`manual`, which takes keystrokes) and leaves `takenOver`,
/// so neither its view nor the overview offers a Hand back that would fail.
#[test]
fn a_switch_to_engine_1_releases_the_stages_you_took_over() {
    let mut fx = Fixture::new("take_over_engine_1");
    let reviewer = fx.open_plan_reviewer();
    let planner = fx.planner.clone();
    fx.user(UserAction::TakeOver { tab_id: planner.clone() }).expect("take over");
    let turn = fx.end_turn(&reviewer, "r-1", review("APPROVED", json!([])), "Approved.");
    fx.actor.handle(ActorMsg::Turn(turn));
    fx.host.gate_open.store(false, Ordering::SeqCst);
    fx.user(UserAction::Send {
        source_tab_id: reviewer,
        target_role_id: "role_implementer".into(),
        values: None,
        handoff_plan: None,
        handoff_text: None,
        force: false,
    })
    .expect("send");
    fx.run(|run| {
        assert_eq!(run.engine, 1);
        assert!(run.taken_over.is_empty(), "nothing is taken over on a manual run: {:?}", run.taken_over);
    });
    assert_eq!(stage_mode(&fx, &planner), crate::bridge::StageMode::Manual, "the Planner is released");
}

impl Fixture {
    /// A bridged, live tab of `role_id` at `step` of the run (in `lane`).
    fn bridged_tab(&self, role_id: &str, stage_id: &str, step: u32, lane: Option<&str>, kind: ResultKind) -> String {
        let mut store = self.host.store.lock().unwrap();
        let role = self.host.roles.iter().find(|r| r.id == role_id).unwrap();
        let cwd = self.work.path().display().to_string();
        let tab = store.create_draft_tab(role, &cwd, true, None).unwrap();
        store.set_tab_chain(&tab, Some(chain(step, lane)), None).unwrap();
        let stage_key = crate::pipelines::autopilot::stage_key(stage_id, lane);
        let plan = BridgePlan {
            run_id: RUN.into(),
            stage_id: stage_id.into(),
            role_id: role_id.into(),
            lane: lane.map(str::to_string),
            stage_key: stage_key.clone(),
            kind,
            autopilot: true,
        };
        prepare_stage(&self.host.runs, &plan, &tab).unwrap();
        store.set_tab_bridge(&tab, Some(BridgeTag { run_id: RUN.into(), stage: stage_key })).unwrap();
        store.remember_claude_terminal_session(&tab, &format!("5f0c2a31-1b2c-4d3e-8f40-{:012}", step * 10 + lane.map_or(0, |l| l.len() as u32))).unwrap();
        if let Some(lane) = lane {
            let run = store.pipeline_run_by_id_mut(RUN).unwrap();
            run.lanes.iter_mut().find(|l| l.id == lane).unwrap().tab_ids.insert(role_id.into(), tab.clone());
        }
        store.save().unwrap();
        self.host.live.lock().unwrap().insert(tab.clone());
        tab
    }
}

/// D28 in a fanned-out run: a decision held for a stage you took over in
/// one lane makes the run wait. A turn another lane finishes meanwhile is
/// not lost: Hand back acts on it with the held round.
#[test]
fn a_turn_another_lane_finished_while_a_round_was_held_is_acted_on_at_hand_back() {
    let mut fx = Fixture::new("take_over_lanes");
    {
        let mut store = fx.host.store.lock().unwrap();
        let lanes = ["pr1", "pr2"]
            .iter()
            .map(|id| crate::commands::pipeline::LaneInput { id: id.to_string(), title: id.to_uppercase(), depends_on: vec![], repo: None })
            .collect();
        crate::commands::pipeline::fan_out(&mut store, RUN, "implementer", lanes).unwrap();
        let run = store.pipeline_run_by_id_mut(RUN).unwrap();
        run.stage = "pr_reviewer".into();
        for lane in &mut run.lanes {
            lane.stage = "pr_reviewer".into();
        }
        store.save().unwrap();
    }
    let impl1 = fx.bridged_tab("role_implementer", "implementer", 3, Some("pr1"), ResultKind::Implementer);
    let rev1 = fx.bridged_tab("role_pr_reviewer", "pr_reviewer", 4, Some("pr1"), ResultKind::Reviewer);
    let _impl2 = fx.bridged_tab("role_implementer", "implementer", 3, Some("pr2"), ResultKind::Implementer);
    let rev2 = fx.bridged_tab("role_pr_reviewer", "pr_reviewer", 4, Some("pr2"), ResultKind::Reviewer);
    let prs = json!({ "schema": 1, "prs": [{ "url": "https://github.com/acme/app/pull/12", "branch": "b", "title": "t" }], "summary": "s" });
    fx.end_turn(&impl1, "i-1", Some(prs), "Done.");
    fx.run(|run| {
        let current: Vec<String> = crate::pipelines::recovery::current_stage_tabs(&crate::pipelines::find("eagle1").unwrap(), run)
            .into_iter()
            .map(|t| t.tab_id)
            .collect();
        assert!(current.contains(&rev1) && current.contains(&rev2), "{current:?}");
    });

    fx.user(UserAction::TakeOver { tab_id: impl1.clone() }).expect("take over");
    let turn = fx.end_turn(&rev1, "r-1", review("CHANGES_REQUIRED", json!([{ "severity": "HIGH", "summary": "x" }])), "");
    fx.actor.handle(ActorMsg::Turn(turn));
    fx.run(|run| assert_eq!(run.stop_reason, Some(StopReason::TakenOver), "the round is held"));
    // PR2's reviewer approves while the run waits.
    let turn = fx.end_turn(&rev2, "r2-1", review("APPROVED", json!([])), "Approved.");
    fx.actor.handle(ActorMsg::Turn(turn));
    fx.run(|run| {
        let decided = &run.autopilot.as_ref().unwrap().decided;
        assert!(!decided.iter().any(|t| t.ends_with("|bridge|r2-1")), "not decided while the run waits: {decided:?}");
    });

    fx.user(UserAction::HandBack { tab_id: impl1.clone() }).expect("hand back");
    assert_eq!(fx.resumes().iter().filter(|l| l.tab_id == impl1).count(), 1, "the held round went back");
    fx.run(|run| {
        let pr2 = run.lane("pr2").unwrap();
        assert_eq!(pr2.status, "approved", "PR2's approval is acted on: {:?}", run.events.iter().map(|e| e.summary.clone()).collect::<Vec<_>>());
    });
}

/// D28 with a reviewer stage that has checks: Hand back finds you revised
/// the stage after the held round's turn. The stale round is recorded as
/// dealt with by you at once (no checks on it), never resumed into the
/// stage after its checks come back.
#[test]
fn a_held_round_with_checks_you_revised_yourself_is_not_sent_after_the_checks() {
    let id = "eagle1_reviewer_gates_v5";
    let mut def = crate::pipelines::find("eagle1").unwrap();
    def.id = id.into();
    def.name = "Reviewer with checks".into();
    def.run_kind = None;
    def.built_in = false;
    def.stages.iter_mut().find(|s| s.id == "plan_reviewer").unwrap().gates =
        vec![crate::pipelines::GateDef::Command { run: "npm run check".into(), timeout_secs: None, optional: false }];
    crate::pipelines::register_for_test(def);
    let mut fx = Fixture::with_pipeline("take_over_revised_gates", id, Vec::new());
    let reviewer = fx.open_plan_reviewer();
    let planner = fx.planner.clone();
    fx.user(UserAction::TakeOver { tab_id: planner.clone() }).expect("take over");
    let turn = fx.end_turn(&reviewer, "r-1", review("CHANGES_REQUIRED", json!([{ "severity": "HIGH", "summary": "x" }])), "");
    fx.actor.handle(ActorMsg::Turn(turn));
    fx.finish_gates();
    fx.run(|run| assert_eq!(run.stop_reason, Some(StopReason::TakenOver), "the round is held"));
    let revised = fx.planner_turn("p-2", "# Plan\n1. Refresh tokens once, then fail.");
    fx.actor.handle(ActorMsg::Turn(revised));
    fx.user(UserAction::HandBack { tab_id: planner.clone() }).expect("hand back");
    // Any checks Hand back started come back now.
    while let Ok(msg) = fx.gates_done.recv_timeout(Duration::from_millis(500)) {
        fx.actor.handle(msg);
    }
    crate::pipelines::unregister_for_test(id);
    assert!(fx.resumes().is_empty() && fx.pastes().is_empty(), "the stale round is not sent back: {:?}", fx.resumes());
    fx.run(|run| {
        let decided = &run.autopilot.as_ref().unwrap().decided;
        assert!(decided.iter().any(|t| t.ends_with("|bridge|p-2")), "your turn is decided: {decided:?}");
    });
}

/// D28: Hand back sends a held round back to the stage (your own turn there
/// is older than the round). When the round is pasted (no session to
/// resume), your older turn is not decided as well: the stage's next turn,
/// its reply to the round, is the one autopilot acts on.
#[test]
fn a_held_round_pasted_back_at_hand_back_leaves_your_older_turn_undecided() {
    let mut fx = Fixture::new("take_over_pasted");
    let reviewer = fx.open_plan_reviewer();
    let planner = fx.planner.clone();
    fx.user(UserAction::TakeOver { tab_id: planner.clone() }).expect("take over");
    // You revise the plan first; the reviewer's round ends after it.
    let yours = fx.planner_turn("p-2", "# Plan\n1. Refresh tokens once, then fail.");
    fx.actor.handle(ActorMsg::Turn(yours));
    std::thread::sleep(Duration::from_millis(5));
    let turn = fx.end_turn(&reviewer, "r-1", review("CHANGES_REQUIRED", json!([{ "severity": "HIGH", "summary": "x" }])), "");
    fx.actor.handle(ActorMsg::Turn(turn));
    fx.run(|run| assert_eq!(run.stop_reason, Some(StopReason::TakenOver), "the round is held"));
    // No session to resume: the round is pasted into the Planner.
    fx.host.store.lock().unwrap().data.tabs.iter_mut().find(|t| t.id == planner).unwrap().sessions.claude_terminal_session_id = None;
    let launches = fx.launches().len();
    fx.user(UserAction::HandBack { tab_id: planner.clone() }).expect("hand back");
    assert_eq!(fx.pastes().iter().filter(|(tab, _)| *tab == planner).count(), 1, "the round went back");
    assert_eq!(fx.launches().len(), launches, "your older plan is not sent to review: {:?}", fx.launches());
    fx.run(|run| {
        let decided = &run.autopilot.as_ref().unwrap().decided;
        assert!(!decided.iter().any(|t| t.ends_with("|bridge|p-2")), "your older turn stays undecided: {decided:?}");
    });
}

/// When the D24 gate refuses one lane mid-run (the run goes manual on
/// engine 1), the other lanes it unblocked are left waiting for you; the
/// actor does not try them, fail on "does not report through the pipeline
/// bridge" and add a `carry_out_failed` stop.
#[test]
fn lanes_after_a_gate_refusal_are_left_waiting_without_a_carry_out_failed_stop() {
    let mut fx = Fixture::new("lanes_gate_refused");
    let implementer = to_implementer(&mut fx);
    let answers = fx.tab(&implementer).answers.clone();
    let cwd = fx.work.path().display().to_string();
    {
        let mut store = fx.host.store.lock().unwrap();
        let lane = |id: &str, deps: &[&str]| crate::commands::pipeline::LaneInput {
            id: id.into(),
            title: format!("PR {id}"),
            depends_on: deps.iter().map(|d| d.to_string()).collect(),
            repo: None,
        };
        crate::commands::pipeline::fan_out(&mut store, RUN, "implementer", vec![lane("pr1", &[]), lane("pr2", &["pr1"]), lane("pr3", &["pr1"])])
            .unwrap();
        let role = fx.host.roles.iter().find(|r| r.id == "role_implementer").unwrap().clone();
        for id in ["pr2", "pr3"] {
            let tab = store.create_draft_tab(&role, &cwd, false, None).unwrap();
            store.data.tabs.iter_mut().find(|t| t.id == tab).unwrap().answers = answers.clone();
            store.set_tab_chain(&tab, Some(chain(3, Some(id))), None).unwrap();
            let run = store.pipeline_run_by_id_mut(RUN).unwrap();
            run.lane_mut(id).unwrap().tab_ids.insert("role_implementer".into(), tab);
        }
    }
    fx.host.gate_open.store(false, Ordering::SeqCst);
    let before = fx.launches().len();
    let outcome = fx.user(UserAction::Approve { lane: Some("pr1".into()) }).expect("approve");
    assert_eq!(outcome.started.len(), 1, "the first lane opened (unbridged): {:?}", outcome.started);
    assert_eq!(fx.launches().len(), before + 1);
    assert!(fx.stops().iter().all(|s| s.0 != StopReason::CarryOutFailed), "{:?}", fx.stops());
    fx.run(|run| {
        assert!(run.manual_only);
        assert_ne!(run.stop_reason, Some(StopReason::CarryOutFailed));
        let waiting = run.lanes.iter().filter(|l| l.status == "waiting").count();
        assert_eq!(waiting, 1, "the other lane waits for you: {:?}", run.lanes);
    });
}

/// L1: a lane made in a repo that was removed from Settings › Repos after
/// the plan was accepted is not started in some other folder. When the lane
/// it waits on is approved, the run stops with `carry_out_failed` and says
/// which repo is gone.
#[test]
fn a_lane_whose_repo_left_settings_stops_the_run_naming_the_repo() {
    let mut fx = Fixture::new("lane_repo_removed");
    {
        let mut store = fx.host.store.lock().unwrap();
        let lane = |id: &str, deps: &[&str], repo: &str| crate::commands::pipeline::LaneInput {
            id: id.into(),
            title: format!("{} — {repo}", id.to_uppercase()),
            depends_on: deps.iter().map(|d| d.to_string()).collect(),
            repo: Some(repo.into()),
        };
        crate::commands::pipeline::fan_out(&mut store, RUN, "implementer", vec![lane("pr1", &[], "backend"), lane("pr2", &["pr1"], "engine")])
            .unwrap();
        let run = store.pipeline_run_by_id_mut(RUN).unwrap();
        assert_eq!(run.lane("pr2").unwrap().repo.as_deref(), Some("engine"), "the lane keeps its repo");
        run.stage = "pr_reviewer".into();
        run.lane_mut("pr1").unwrap().stage = "pr_reviewer".into();
        store.save().unwrap();
    }
    let reviewer = fx.bridged_tab("role_pr_reviewer", "pr_reviewer", 4, Some("pr1"), ResultKind::Reviewer);
    // The test host has no repos: `engine` is gone from Settings.
    assert!(fx.host.repos().is_empty());
    let launches = fx.launches().len();
    let turn = fx.end_turn(&reviewer, "r-1", review("APPROVED", json!([])), "Approved.");
    fx.actor.handle(ActorMsg::Turn(turn));
    assert_eq!(fx.launches().len(), launches, "PR2 is not opened anywhere");
    let stops = fx.stops();
    let (reason, summary) = stops.last().expect("the run stopped");
    assert_eq!(*reason, StopReason::CarryOutFailed);
    assert!(summary.contains("the repo \"engine\", which is no longer in Settings › Repos"), "{summary}");
    fx.run(|run| {
        assert_eq!(run.stop_reason, Some(StopReason::CarryOutFailed));
        assert_eq!(run.lane("pr1").unwrap().status, "approved");
        assert_eq!(run.lane("pr2").unwrap().status, "waiting", "left for you to start once the repo is back");
    });
}

/// Eagle-Eye 1 with a verify gate after the Implementer's check (L2).
fn verify_pipeline(id: &str) -> crate::pipelines::PipelineDef {
    serde_json::from_value(json!({
        "id": id, "name": "Verified",
        "stages": [
            { "id": "planner", "roleId": "role_planner", "kind": "planner", "title": "Planner" },
            { "id": "plan_reviewer", "roleId": "role_plan_reviewer", "kind": "reviewer", "title": "Plan Reviewer",
              "loopBack": { "to": "planner", "minSeverity": "MEDIUM" } },
            { "id": "implementer", "roleId": "role_implementer", "kind": "implementer", "title": "Implementer", "checkpoint": true,
              "gates": [{ "kind": "command", "run": "auto" }, { "kind": "verify", "steps": "Run qa128-ml on Windows." }] },
            { "id": "pr_reviewer", "roleId": "role_pr_reviewer", "kind": "reviewer", "title": "PR Reviewer",
              "loopBack": { "to": "implementer", "minSeverity": "MEDIUM" } }
        ]
    }))
    .unwrap()
}

/// The Implementer's turn on [`verify_pipeline`], checked: the run waits on the verify gate.
fn implementer_waiting_on_verify(fx: &mut Fixture) -> String {
    let implementer = to_implementer(fx);
    let prs = json!({ "schema": 1, "prs": [{ "url": "https://github.com/acme/app/pull/12", "branch": "fix/refresh", "title": "Refresh" }],
                      "summary": "Expired tokens are refreshed once." });
    let turn = fx.end_turn(&implementer, "i-1", Some(prs), "Opened https://github.com/acme/app/pull/12");
    fx.actor.handle(ActorMsg::Turn(turn));
    fx.finish_gates();
    fx.run(|run| {
        let wait = run.autopilot.as_ref().and_then(|a| a.verify.clone()).expect("waiting on the verify gate");
        assert_eq!(wait.prs, ["https://github.com/acme/app/pull/12"]);
    });
    implementer
}

/// Review fix (L2): your answer and the decision it leads to are saved
/// together, under the turn's `#verify` key; a refused answer changes nothing.
#[test]
fn a_verify_answer_is_saved_with_its_decision_and_a_refused_one_changes_nothing() {
    let id = "verify_actor_l2";
    crate::pipelines::register_for_test(verify_pipeline(id));
    let mut fx = Fixture::with_pipeline("verify_answer", id, Vec::new());
    let implementer = implementer_waiting_on_verify(&mut fx);
    let before = fx.run(|run| run.clone());
    let verify = |verified: bool, note: Option<&str>| UserAction::Verify {
        stage_id: "implementer".into(),
        lane: None,
        verified,
        note: note.map(str::to_string),
    };
    let err = fx.user(verify(false, Some("  "))).unwrap_err();
    assert!(err.contains("Say what failed"), "{err}");
    fx.run(|run| assert_eq!(run, &before, "nothing changed"));
    let launches = fx.launches().len();

    let outcome = fx.user(verify(true, None)).unwrap();
    assert_eq!(outcome.tab_id.as_deref(), Some(implementer.as_str()));
    assert_eq!(fx.launches().len(), launches + 1);
    assert_eq!(fx.launches().last().unwrap().role_id, "role_pr_reviewer");
    // Saved: the record and the decision under its key, read back from disk.
    let saved = StateStore::open_path(fx.host.store.lock().unwrap().path.clone()).expect("reload");
    let run = saved.pipeline_run_by_id(RUN).unwrap();
    let key = format!("{implementer}|bridge|i-1#verify1");
    assert_eq!(run.verifications.len(), 1);
    assert!(run.autopilot.as_ref().unwrap().decided.contains(&key), "{:?}", run.autopilot);
    assert_eq!(run.decision_key(&format!("{implementer}|bridge|i-1")), key);
    crate::pipelines::unregister_for_test(id);
}

/// Review fix (L2): a turn whose verification you answered, left undecided
/// while you held its stage (its decision waited on a stage you took over),
/// is decided by Hand back under its `#verify` key, with no checks run again.
#[test]
fn hand_back_decides_an_answered_turn_under_its_verify_key() {
    let id = "verify_hand_back_l2";
    crate::pipelines::register_for_test(verify_pipeline(id));
    let mut fx = Fixture::with_pipeline("verify_hand_back", id, Vec::new());
    let implementer = implementer_waiting_on_verify(&mut fx);
    fx.user(UserAction::TakeOver { tab_id: implementer.clone() }).unwrap();
    {
        // As a held decision leaves it: your answer saved, nothing decided.
        let mut store = fx.host.store.lock().unwrap();
        let run = store.pipeline_run_by_id_mut(RUN).unwrap();
        crate::pipelines::verify::answer(run, "implementer", None, true, None, "now").unwrap();
        run.stop_for(StopReason::TakenOver, Some("implementer"), None, "Held for you.", None);
        store.save().unwrap();
    }
    let launches = fx.launches().len();
    fx.user(UserAction::HandBack { tab_id: implementer.clone() }).unwrap();
    assert!(fx.gates_done.try_recv().is_err(), "no checks run again");
    assert_eq!(fx.launches().len(), launches + 1);
    assert_eq!(fx.launches().last().unwrap().role_id, "role_pr_reviewer");
    let key = format!("{implementer}|bridge|i-1#verify1");
    fx.run(|run| assert!(run.autopilot.as_ref().unwrap().decided.contains(&key), "{:?}", run.events.last()));
    crate::pipelines::unregister_for_test(id);
}

/// A run of `id` fanned out into lanes pr1 and pr2 at the Implementer, each
/// with a live bridged Implementer tab. Returns `(impl1, impl2)`.
fn two_lanes_at_the_implementer(fx: &mut Fixture) -> (String, String) {
    {
        let mut store = fx.host.store.lock().unwrap();
        let lanes = ["pr1", "pr2"]
            .iter()
            .map(|id| crate::commands::pipeline::LaneInput { id: id.to_string(), title: id.to_uppercase(), depends_on: vec![], repo: None })
            .collect();
        crate::commands::pipeline::fan_out(&mut store, RUN, "implementer", lanes).unwrap();
        let run = store.pipeline_run_by_id_mut(RUN).unwrap();
        run.stage = "implementer".into();
        run.set_running();
        store.save().unwrap();
    }
    let impl1 = fx.bridged_tab("role_implementer", "implementer", 3, Some("pr1"), ResultKind::Implementer);
    let impl2 = fx.bridged_tab("role_implementer", "implementer", 3, Some("pr2"), ResultKind::Implementer);
    (impl1, impl2)
}

fn implemented(fx: &Fixture, tab: &str, turn: &str) -> BridgeTurn {
    let prs = json!({ "schema": 1, "prs": [{ "url": "https://github.com/acme/app/pull/12", "branch": "b", "title": "t" }], "summary": "s" });
    fx.end_turn(tab, turn, Some(prs), "Done.")
}

fn verify_in(lane: &str) -> UserAction {
    UserAction::Verify { stage_id: "implementer".into(), lane: Some(lane.into()), verified: true, note: None }
}

/// Review fix (L2, M-a): a stage with two verify gates. Lane pr2's turn is
/// held while pr1 waits on the first; answering it opens pr1's second
/// wait, which keeps pr2 held (no "hand it on yourself" line). Answering
/// the second moves pr1 on and decides pr2, checks first.
#[test]
fn a_second_verify_wait_keeps_the_held_turns_for_its_answer() {
    let id = "verify_twice_l2";
    let mut def = verify_pipeline(id);
    def.stages[2].gates.push(crate::pipelines::GateDef::Verify { steps: "Read the Windows log.".into() });
    crate::pipelines::register_for_test(def);
    let mut fx = Fixture::with_pipeline("verify_twice", id, Vec::new());
    let (impl1, impl2) = two_lanes_at_the_implementer(&mut fx);
    fx.actor.handle(ActorMsg::Turn(implemented(&fx, &impl1, "a-1")));
    fx.finish_gates();
    fx.run(|run| assert_eq!(run.autopilot.as_ref().unwrap().verify.as_ref().unwrap().steps, "Run qa128-ml on Windows."));
    fx.actor.handle(ActorMsg::Turn(implemented(&fx, &impl2, "b-1")));
    let held_b = format!("{impl2}|bridge|b-1");
    let told = |run: &crate::store::PipelineRun| run.events.iter().any(|e| e.summary.ends_with("Hand it on yourself."));
    fx.run(|run| assert_eq!(run.autopilot.as_ref().unwrap().held.iter().map(|h| h.turn.clone()).collect::<Vec<_>>(), std::slice::from_ref(&held_b)));

    fx.user(verify_in("pr1")).unwrap();
    fx.run(|run| {
        let autopilot = run.autopilot.as_ref().unwrap();
        assert_eq!(autopilot.verify.as_ref().map(|w| w.steps.as_str()), Some("Read the Windows log."), "pr1's second wait");
        assert_eq!(autopilot.held.iter().map(|h| h.turn.clone()).collect::<Vec<_>>(), std::slice::from_ref(&held_b), "pr2 is still held");
        assert!(!told(run), "{:?}", run.events.last());
    });
    assert!(fx.gates_done.try_recv().is_err(), "pr2 is not taken up yet");

    fx.user(verify_in("pr1")).unwrap();
    assert_eq!(fx.launches().last().unwrap().role_id, "role_pr_reviewer", "pr1 moved on");
    fx.finish_gates();
    fx.run(|run| {
        let autopilot = run.autopilot.as_ref().unwrap();
        assert!(autopilot.held.is_empty());
        assert_eq!(autopilot.verify.as_ref().and_then(|w| w.lane.as_deref()), Some("pr2"), "pr2 was decided: its own wait");
        assert!(!told(run));
    });
    crate::pipelines::unregister_for_test(id);
}

/// Review fix (L2 scoping): only a current stage tab other than the one
/// waiting is held. A turn of the waiting tab itself, or of a tab that is
/// not a current stage, is skipped with the old text.
#[test]
fn only_other_current_stages_are_held_during_a_verify_wait() {
    let id = "verify_scope_l2";
    crate::pipelines::register_for_test(verify_pipeline(id));
    let mut fx = Fixture::with_pipeline("verify_scope", id, Vec::new());
    let (impl1, _impl2) = two_lanes_at_the_implementer(&mut fx);
    fx.actor.handle(ActorMsg::Turn(implemented(&fx, &impl1, "a-1")));
    fx.finish_gates();
    fx.run(|run| assert!(run.autopilot.as_ref().unwrap().verify.is_some()));
    // The waiting tab's own newer turn.
    fx.actor.handle(ActorMsg::Turn(implemented(&fx, &impl1, "a-2")));
    // The Planner: not a current stage of the fanned-out run.
    let planner = fx.planner.clone();
    fx.actor.handle(ActorMsg::Turn(fx.end_turn(&planner, "p-9", None, "Late.")));
    fx.run(|run| {
        assert!(run.autopilot.as_ref().unwrap().held.is_empty(), "{:?}", run.autopilot);
        let skips: Vec<&str> = run
            .events
            .iter()
            .filter(|e| e.outcome.as_deref() == Some("skip"))
            .map(|e| e.summary.as_str())
            .collect();
        assert_eq!(skips.len(), 2, "{skips:?}");
        assert!(skips.iter().all(|s| s.contains("finished while the run is waiting for you")), "{skips:?}");
    });
    crate::pipelines::unregister_for_test(id);
}

// ---- L3: the story loop -----------------------------------------------------

fn planned_story(id: &str, title: &str, checkpoint: Option<&str>) -> crate::bridge::folder::PlannedStory {
    crate::bridge::folder::PlannedStory {
        id: id.into(),
        title: title.into(),
        checkpoint: checkpoint.map(str::to_string),
        ..Default::default()
    }
}

/// One task built in three stories; the first is a checkpoint story.
fn story_task(id: &str) -> crate::bridge::PlannedTask {
    crate::bridge::PlannedTask {
        id: id.into(),
        title: "Engine fixes".into(),
        depends_on: vec![],
        manual: false,
        summary: "R5 and the log fixes.".into(),
        repo: None,
        stories: vec![
            planned_story("s1", "R5 instrumentation", Some("Rerun the 7,839-file case on Windows")),
            planned_story("s2", "Log dedupe", None),
            planned_story("s3", "Folder name", None),
        ],
    }
}

/// A story's `submit_result`; the last one reports the pull request.
fn story_result(id: &str, last: bool) -> Value {
    let prs = if last {
        json!([{ "url": "https://github.com/acme/engine/pull/5", "branch": "fix/engine", "title": "Engine fixes" }])
    } else {
        json!([])
    };
    json!({ "schema": 1, "story": id, "prs": prs, "summary": format!("{id} is built.") })
}

/// To the Implementer of a one-task plan whose task has stories.
fn to_implementer_with_stories(fx: &mut Fixture) -> String {
    let dir = fx.stage_dir(&fx.planner);
    let tasks = RunTasks { schema: 1, run_id: RUN.into(), stage_key: "planner".into(), turn: "p-1".into(), at: "now".into(), tasks: vec![story_task("pr1")] };
    dir.write_plan("# Plan\n1. R5, then the log fixes.", &tasks).unwrap();
    let planner = fx.planner.clone();
    let turn = fx.end_turn(&planner, "p-1", Some(json!({ "schema": 1, "tasks": [{ "id": "pr1" }] })), "Plan received.");
    fx.actor.handle(ActorMsg::Turn(turn));
    let reviewer = fx.launches().last().expect("plan reviewer opened").tab_id.clone();
    let turn = fx.end_turn(&reviewer, "r-1", review("APPROVED", json!([])), "Approved.");
    fx.actor.handle(ActorMsg::Turn(turn));
    fx.user(UserAction::Send {
        source_tab_id: reviewer,
        target_role_id: "role_implementer".into(),
        values: None,
        handoff_plan: None,
        handoff_text: None,
        force: false,
    })
    .unwrap()
    .tab_id
    .expect("the Implementer opened")
}

fn story_mark_of(fx: &Fixture, stage_key: &str) -> Option<crate::bridge::folder::StoryMark> {
    crate::bridge::folder::read_story(&fx.run_file("stages").join(stage_key))
}

fn story_states(fx: &Fixture, lane: Option<&str>) -> Vec<(String, crate::store::StoryStatus)> {
    fx.run(|run| crate::pipelines::stories::of_lane(run, lane).iter().map(|s| (s.id.clone(), s.status)).collect())
}

/// L3 on the actor: the first prompt lists the stories; a checkpoint story
/// waits once its command check passes and your Continue resumes the same
/// session with the next story and your note; a failed check goes back
/// for the same story; only the last story runs the pull-request gate, and
/// then the PR Reviewer opens. `story.json` follows the current story.
#[test]
fn a_pull_request_in_stories_runs_each_story_in_the_same_session_then_goes_to_review() {
    use crate::store::StoryStatus::{Active, Done, Pending, Waiting};
    let mut fx = Fixture::new("stories");
    let implementer = to_implementer_with_stories(&mut fx);
    let first = fx.launches().last().cloned().unwrap();
    assert!(first.prompt.contains("## Stories") && first.prompt.contains("Do story s1 now (1 of 3)"), "{}", first.prompt);
    assert_eq!(story_states(&fx, None), [("s1".to_string(), Active), ("s2".into(), Pending), ("s3".into(), Pending)]);
    assert_eq!(story_mark_of(&fx, "implementer").and_then(|m| m.current), Some("s1".into()));

    // s1: its command check passes, and the run waits on its checkpoint.
    fx.actor.handle(ActorMsg::Turn(fx.end_turn(&implementer, "i-1", Some(story_result("s1", false)), "s1 done.")));
    fx.finish_gates();
    assert!(fx.host.pr_gate_urls.lock().unwrap().is_empty(), "no pull-request gate before the last story");
    fx.run(|run| {
        assert_eq!((run.status, run.stop_reason), (RunStatus::Waiting, Some(StopReason::Checkpoint)));
        assert_eq!(run.autopilot.as_ref().unwrap().story_wait.as_ref().map(|w| w.story.as_str()), Some("s1"));
    });
    assert_eq!(story_states(&fx, None)[0], ("s1".to_string(), Waiting));
    assert!(fx.resumes().is_empty(), "nothing is sent while the checkpoint waits");
    let refused = fx.user(UserAction::ContinueStory { lane: None, story: "s2".into(), note: None, add: None }).unwrap_err();
    assert!(refused.contains("not waiting on that story's checkpoint"), "{refused}");

    // Continue with your finding: the same session gets s2 and the note.
    let note = "JT's finding from the Windows rerun: the walk stalls 40 s on the lock file.";
    let outcome = fx
        .user(UserAction::ContinueStory { lane: None, story: "s1".into(), note: Some(note.into()), add: None })
        .expect("continued");
    assert_eq!(outcome.tab_id.as_deref(), Some(implementer.as_str()));
    let resumes = fx.resumes();
    assert_eq!(resumes.len(), 1);
    assert_eq!((resumes[0].tab_id.as_str(), resumes[0].session_id.as_str()), (implementer.as_str(), first.session_id.as_str()));
    assert!(resumes[0].prompt.starts_with("Story 2 of 3: Log dedupe"), "{}", resumes[0].prompt);
    assert!(resumes[0].prompt.contains(note), "{}", resumes[0].prompt);
    fx.run(|run| {
        assert_eq!(run.status, RunStatus::Running);
        assert!(run.autopilot.as_ref().unwrap().story_wait.is_none());
        assert_eq!(run.stories[0].note.as_deref(), Some(note));
        assert!(run.events.iter().any(|e| e.outcome.as_deref() == Some("storyContinue")));
    });
    assert_eq!(story_mark_of(&fx, "implementer").and_then(|m| m.current), Some("s2".into()));

    // s2: its check fails once; the output goes back for s2, then it passes.
    fx.host.gates.lock().unwrap().push_back(GateResult {
        kind: "command".into(),
        label: "npm run check".into(),
        status: "failed".into(),
        summary: "Exited with code 1.".into(),
        output: "FAIL TestLogDedupe".into(),
        duration_ms: 5,
        optional: false,
    });
    fx.actor.handle(ActorMsg::Turn(fx.end_turn(&implementer, "i-2", Some(story_result("s2", false)), "s2 done.")));
    fx.finish_gates();
    let retry = fx.resumes().last().cloned().unwrap();
    assert!(retry.prompt.contains("FAIL TestLogDedupe") && retry.prompt.contains("This is still story s2 (2 of 3)"), "{}", retry.prompt);
    fx.run(|run| assert_eq!((run.stories[1].status, run.stories[1].attempt), (crate::store::StoryStatus::Failed, 1)));
    fx.actor.handle(ActorMsg::Turn(fx.end_turn(&implementer, "i-3", Some(story_result("s2", false)), "s2 fixed.")));
    fx.finish_gates();
    let next = fx.resumes().last().cloned().unwrap();
    assert!(next.prompt.starts_with("Story 3 of 3: Folder name") && next.prompt.contains("This is the last story"), "{}", next.prompt);
    assert!(fx.host.pr_gate_urls.lock().unwrap().is_empty());

    // s3, the last: every gate runs, then the PR Reviewer opens.
    fx.actor.handle(ActorMsg::Turn(fx.end_turn(&implementer, "i-4", Some(story_result("s3", true)), "Opened the pull request.")));
    fx.finish_gates();
    assert_eq!(fx.host.pr_gate_urls.lock().unwrap().clone(), vec![vec!["https://github.com/acme/engine/pull/5".to_string()]]);
    assert_eq!(fx.launches().last().unwrap().role_id, "role_pr_reviewer");
    assert_eq!(story_states(&fx, None), [("s1".to_string(), Done), ("s2".into(), Done), ("s3".into(), Done)]);
    assert_eq!(story_mark_of(&fx, "implementer").map(|m| m.current), Some(None), "every story is done");
    // One session throughout, and one record per story with its summary.
    assert!(fx.resumes().iter().all(|r| r.session_id == first.session_id && r.tab_id == implementer));
    fx.run(|run| {
        let summaries: Vec<Option<&str>> = run.stories.iter().map(|s| s.summary.as_deref()).collect();
        assert_eq!(summaries, [Some("s1 is built."), Some("s2 is built."), Some("s3 is built.")]);
        assert!(run.stories.iter().all(|s| s.turn.as_deref().is_some_and(|t| t.starts_with(&implementer))));
    });
    // A review round goes back to the same session as before; the stories
    // are not started again, and its turn reports no story.
    let reviewer = fx.launches().last().unwrap().tab_id.clone();
    let findings = json!([{ "severity": "HIGH", "file": "walk.go:12", "summary": "The filter misses .lock~ files." }]);
    fx.actor.handle(ActorMsg::Turn(fx.end_turn(&reviewer, "pr-1", review("CHANGES_REQUIRED", findings), "Changes.")));
    let round = fx.resumes().last().cloned().unwrap();
    assert_eq!((round.tab_id.as_str(), round.session_id.as_str()), (implementer.as_str(), first.session_id.as_str()));
    assert!(round.prompt.starts_with("Review findings from the PR Reviewer (round 1)"), "{}", round.prompt);
    let mut fixed = story_result("s3", true);
    fixed.as_object_mut().unwrap().remove("story");
    fx.actor.handle(ActorMsg::Turn(fx.end_turn(&implementer, "i-5", Some(fixed), "Fixed.")));
    fx.finish_gates();
    assert_eq!(fx.launches().last().unwrap().role_id, "role_pr_reviewer", "the next review round");
    assert_eq!(story_states(&fx, None).len(), 3);
}

/// L3 with L2: a lane's story turn that ends while another lane waits on a
/// verification is held like any turn; your answer decides it, its command
/// check runs (no verify gate before its last story), and the next story
/// goes to that lane's session. A checkpoint story's wait holds the other
/// lane's turn the same way, and Continue decides it.
#[test]
fn story_turns_are_held_during_another_lanes_wait_and_a_story_wait_holds_theirs() {
    let id = "verify_stories_l3";
    crate::pipelines::register_for_test(verify_pipeline(id));
    let mut fx = Fixture::with_pipeline("verify_stories", id, Vec::new());
    let tasks = RunTasks {
        schema: 1,
        run_id: RUN.into(),
        stage_key: "planner".into(),
        turn: "p-1".into(),
        at: "now".into(),
        tasks: vec![
            crate::bridge::PlannedTask { stories: vec![], ..story_task("pr1") },
            crate::bridge::PlannedTask {
                stories: vec![planned_story("s1", "Log dedupe", None), planned_story("s2", "R5", Some("Rerun on Windows")), planned_story("s3", "Fix", None)],
                ..story_task("pr2")
            },
        ],
    };
    fx.stage_dir(&fx.planner).write_plan("# Plan", &tasks).unwrap();
    let (impl1, impl2) = two_lanes_at_the_implementer(&mut fx);
    // pr1 waits on its verification.
    fx.actor.handle(ActorMsg::Turn(implemented(&fx, &impl1, "a-1")));
    fx.finish_gates();
    fx.run(|run| assert_eq!(run.autopilot.as_ref().unwrap().verify.as_ref().and_then(|w| w.lane.as_deref()), Some("pr1")));
    // pr2's s1 ends meanwhile: recorded (its stories too) and held, not checked.
    fx.actor.handle(ActorMsg::Turn(fx.end_turn(&impl2, "b-1", Some(story_result("s1", false)), "s1 done.")));
    assert!(fx.gates_done.try_recv().is_err(), "held: no checks yet");
    fx.run(|run| {
        assert_eq!(run.autopilot.as_ref().unwrap().held.len(), 1);
        assert_eq!(crate::pipelines::stories::of_lane(run, Some("pr2")).len(), 3);
    });
    assert_eq!(story_mark_of(&fx, "implementer@pr2").and_then(|m| m.current), Some("s1".into()));

    // Mark verified: pr1 goes on, then pr2's s1 is checked (command only) and s2 sent.
    fx.user(verify_in("pr1")).unwrap();
    fx.finish_gates();
    let sent = fx.resumes().into_iter().filter(|r| r.tab_id == impl2).collect::<Vec<_>>();
    assert_eq!(sent.len(), 1, "{sent:?}");
    assert!(sent[0].prompt.starts_with("Story 2 of 3: R5"), "{}", sent[0].prompt);
    fx.run(|run| {
        let gates = &run.gates["implementer@pr2"].results;
        assert!(gates.iter().all(|g| g.kind == "command"), "no verify gate before the last story: {gates:?}");
        assert_eq!(run.status, RunStatus::Running, "{:?}", run.autopilot);
    });

    // pr2's s2 is a checkpoint: the run waits on it, and holds pr1's reviewer turn.
    fx.actor.handle(ActorMsg::Turn(fx.end_turn(&impl2, "b-2", Some(story_result("s2", false)), "s2 done.")));
    fx.finish_gates();
    fx.run(|run| assert_eq!(run.autopilot.as_ref().unwrap().story_wait.as_ref().map(|w| w.story.as_str()), Some("s2")));
    let reviewer1 = fx.launches().last().unwrap().tab_id.clone();
    fx.actor.handle(ActorMsg::Turn(fx.end_turn(&reviewer1, "rv-1", review("APPROVED", json!([])), "Approved.")));
    fx.run(|run| {
        assert_eq!(run.autopilot.as_ref().unwrap().held.len(), 1, "pr1's review is held for your Continue");
        assert!(run.autopilot.as_ref().unwrap().held[0].for_story, "held for the story checkpoint");
        assert!(run.events.iter().any(|e| e.summary.contains("finished while the run waits on a story checkpoint")), "the held line says why");
        assert_eq!(run.lane("pr1").unwrap().status, "active");
    });
    fx.user(UserAction::ContinueStory { lane: Some("pr2".into()), story: "s2".into(), note: Some("Clean on Windows.".into()), add: Some("Tidy the log text".into()) })
        .expect("continued");
    let last = fx.resumes().last().cloned().unwrap();
    assert!(last.prompt.starts_with("Story 3 of 4: Tidy the log text") && last.prompt.contains("Clean on Windows."), "{}", last.prompt);
    fx.run(|run| {
        assert_eq!(run.lane("pr1").unwrap().status, "approved", "pr1's held review was decided");
        let ids: Vec<&str> = crate::pipelines::stories::of_lane(run, Some("pr2")).iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["s1", "s2", "s4", "s3"], "the story you added goes right after s2");
        assert!(run.autopilot.as_ref().unwrap().held.is_empty());
    });
    assert_eq!(story_mark_of(&fx, "implementer@pr2").and_then(|m| m.current), Some("s4".into()));
    crate::pipelines::unregister_for_test(id);
}

/// L3 review fix: to the Implementer of [`story_task`], with s1's checks
/// passed and the run waiting on its checkpoint.
fn to_story_wait(fx: &mut Fixture) -> String {
    let implementer = to_implementer_with_stories(fx);
    fx.actor.handle(ActorMsg::Turn(fx.end_turn(&implementer, "i-1", Some(story_result("s1", false)), "s1 done.")));
    fx.finish_gates();
    fx.run(|run| assert!(run.autopilot.as_ref().unwrap().story_wait.is_some()));
    implementer
}

fn failed_check() -> GateResult {
    GateResult {
        kind: "command".into(),
        label: "npm run check".into(),
        status: "failed".into(),
        summary: "Exited with code 1.".into(),
        output: "FAIL TestLogDedupe".into(),
        duration_ms: 5,
        optional: false,
    }
}

fn set_autopilot(fx: &Fixture, enabled: bool) {
    let mut store = fx.host.store.lock().unwrap();
    crate::commands::pipeline::set_autopilot(&mut store, RUN, enabled).unwrap();
}

/// L3 review fix (root cause): turning autopilot off and on during a story
/// checkpoint keeps the wait: the run waits again, Continue is refused
/// while autopilot is off and sends s2 once it is on.
#[test]
fn continue_still_works_after_autopilot_is_turned_off_and_on_during_a_story_wait() {
    let mut fx = Fixture::new("story_toggle");
    let implementer = to_story_wait(&mut fx);
    set_autopilot(&fx, false);
    let off = fx.user(UserAction::ContinueStory { lane: None, story: "s1".into(), note: None, add: None }).unwrap_err();
    assert!(off.contains("Autopilot is off"), "{off}");
    set_autopilot(&fx, true);
    fx.run(|run| {
        assert_eq!((run.status, run.stop_reason), (RunStatus::Waiting, Some(StopReason::Checkpoint)));
        assert!(run.autopilot.as_ref().unwrap().story_wait.is_some());
        assert_eq!(run.stories[0].status, crate::store::StoryStatus::Waiting);
    });
    let outcome = fx
        .user(UserAction::ContinueStory { lane: None, story: "s1".into(), note: Some("Clean rerun.".into()), add: None })
        .expect("Continue still works");
    assert_eq!(outcome.tab_id.as_deref(), Some(implementer.as_str()));
    let sent = fx.resumes().last().cloned().unwrap();
    assert!(sent.prompt.starts_with("Story 2 of 3: Log dedupe") && sent.prompt.contains("Clean rerun."), "{}", sent.prompt);
    assert_eq!(story_mark_of(&fx, "implementer").and_then(|m| m.current), Some("s2".into()));
}

/// L3 review fix (MEDIUM): a story whose checks keep failing stops the run
/// with `gate_failed`, naming Resend story; Resend story sends the same
/// story to the same session again, with its retries started over.
#[test]
fn resend_story_sends_the_current_story_again_after_a_stop() {
    let mut fx = Fixture::new("story_resend");
    let implementer = to_story_wait(&mut fx);
    fx.user(UserAction::ContinueStory { lane: None, story: "s1".into(), note: None, add: None }).unwrap();
    let refused = fx.user(UserAction::ResendStory { lane: None }).unwrap_err();
    assert!(refused.contains("under way"), "{refused}");
    for n in 0..=crate::pipelines::autopilot::MAX_GATE_RETRIES {
        fx.host.gates.lock().unwrap().push_back(failed_check());
        fx.actor.handle(ActorMsg::Turn(fx.end_turn(&implementer, &format!("i-2-{n}"), Some(story_result("s2", false)), "s2.")));
        fx.finish_gates();
    }
    fx.run(|run| {
        assert_eq!((run.status, run.stop_reason), (RunStatus::Waiting, Some(StopReason::GateFailed)));
        assert!(run.autopilot.as_ref().unwrap().waiting.as_deref().unwrap().contains("press Resend story"), "{:?}", run.autopilot);
        assert_eq!(run.stories[1].status, crate::store::StoryStatus::Failed);
    });
    let before = fx.resumes().len();
    let outcome = fx.user(UserAction::ResendStory { lane: None }).expect("resent");
    assert_eq!(outcome.tab_id.as_deref(), Some(implementer.as_str()));
    let resumes = fx.resumes();
    assert_eq!(resumes.len(), before + 1);
    let sent = resumes.last().unwrap();
    assert!(sent.prompt.starts_with("Story 2 of 3: Log dedupe"), "{}", sent.prompt);
    assert_eq!(sent.session_id, resumes[0].session_id, "the same session");
    fx.run(|run| {
        assert_eq!(run.status, RunStatus::Running);
        assert!(run.autopilot.as_ref().unwrap().gate_retries.is_empty(), "its retries start over");
        assert_eq!(run.stories[1].status, crate::store::StoryStatus::Active);
        assert!(run.events.iter().any(|e| e.outcome.as_deref() == Some("storyResend")));
    });
    // The resent story passes: on to s3.
    fx.actor.handle(ActorMsg::Turn(fx.end_turn(&implementer, "i-3", Some(story_result("s2", false)), "s2 fixed.")));
    fx.finish_gates();
    assert!(fx.resumes().last().unwrap().prompt.starts_with("Story 3 of 3"));
}

/// L3 review fix (MEDIUM): handing an unfinished pull request on to its
/// PR Reviewer marks the stories left skipped, with a Timeline line. The
/// reviewer's round then goes back as a review round, never a story.
#[test]
fn handing_on_with_unfinished_stories_skips_them_and_a_review_round_is_not_a_story() {
    let mut fx = Fixture::new("story_hand_on");
    let implementer = to_story_wait(&mut fx);
    fx.user(UserAction::ContinueStory { lane: None, story: "s1".into(), note: None, add: None }).unwrap();
    // s2's turn ends (not decided yet), and you hand the stage on yourself.
    let mut opened = story_result("s2", false);
    opened["prs"] = json!([{ "url": "https://github.com/acme/engine/pull/5", "branch": "fix/engine", "title": "Engine fixes" }]);
    fx.end_turn(&implementer, "i-2", Some(opened), "s2, and a draft pull request.");
    fx.user(UserAction::Send {
        source_tab_id: implementer.clone(),
        target_role_id: "role_pr_reviewer".into(),
        values: None,
        handoff_plan: None,
        handoff_text: None,
        force: false,
    })
    .expect("your hand-on");
    use crate::store::StoryStatus::{Done, Skipped};
    assert_eq!(story_states(&fx, None), [("s1".to_string(), Done), ("s2".into(), Skipped), ("s3".into(), Skipped)]);
    fx.run(|run| {
        let line = run.events.iter().find(|e| e.outcome.as_deref() == Some("storySkipped")).expect("a Timeline line");
        assert!(line.summary.contains("Stories s2, s3 were not done before the pull request went on to PR Reviewer"), "{}", line.summary);
    });
    assert_eq!(story_mark_of(&fx, "implementer").map(|m| m.current), Some(None));

    let reviewer = fx.launches().last().unwrap().tab_id.clone();
    let findings = json!([{ "severity": "HIGH", "summary": "Story s3 is missing." }]);
    fx.actor.handle(ActorMsg::Turn(fx.end_turn(&reviewer, "pr-1", review("CHANGES_REQUIRED", findings), "Changes.")));
    let round = fx.resumes().last().cloned().unwrap();
    assert!(round.prompt.starts_with("Review findings from the PR Reviewer (round 1)"), "{}", round.prompt);
    let mut fixed = story_result("s3", true);
    fixed.as_object_mut().unwrap().remove("story");
    fx.actor.handle(ActorMsg::Turn(fx.end_turn(&implementer, "i-3", Some(fixed), "Fixed.")));
    fx.finish_gates();
    assert_eq!(fx.launches().last().unwrap().role_id, "role_pr_reviewer", "the next review round");
    fx.run(|run| assert!(!run.events.iter().any(|e| e.outcome.as_deref() == Some("nextStory")), "no story was sent"));
}

/// To s2 with its checks failed past the retry limit: the run waits with `gate_failed`.
fn story_gate_failed(fx: &mut Fixture) -> String {
    let implementer = to_story_wait(fx);
    fx.user(UserAction::ContinueStory { lane: None, story: "s1".into(), note: None, add: None }).unwrap();
    for n in 0..=crate::pipelines::autopilot::MAX_GATE_RETRIES {
        fx.host.gates.lock().unwrap().push_back(failed_check());
        fx.actor.handle(ActorMsg::Turn(fx.end_turn(&implementer, &format!("g-{n}"), Some(story_result("s2", false)), "s2.")));
        fx.finish_gates();
    }
    fx.run(|run| assert_eq!(run.stop_reason, Some(StopReason::GateFailed)));
    implementer
}

/// L3 review fix (MEDIUM 3): turning autopilot on runs a stopped run, as
/// for any stop. With the failed story's turn decided and nothing running,
/// Resend story still sends it again.
#[test]
fn resend_story_works_after_autopilot_is_turned_off_and_on_after_a_stop() {
    let mut fx = Fixture::new("story_resend_toggle");
    let implementer = story_gate_failed(&mut fx);
    set_autopilot(&fx, false);
    let off = fx.user(UserAction::ResendStory { lane: None }).unwrap_err();
    assert!(off.contains("Autopilot is off"), "{off}");
    set_autopilot(&fx, true);
    fx.run(|run| {
        assert_eq!(run.status, RunStatus::Running);
        assert_eq!(run.stories[1].status, crate::store::StoryStatus::Failed);
    });
    let before = fx.resumes().len();
    fx.user(UserAction::ResendStory { lane: None }).expect("resent on a running run");
    let sent = fx.resumes();
    assert_eq!(sent.len(), before + 1);
    assert_eq!(sent.last().unwrap().tab_id, implementer);
    assert!(sent.last().unwrap().prompt.starts_with("Story 2 of 3"));
    // Now the story is under way: a second Resend is refused.
    let busy = fx.user(UserAction::ResendStory { lane: None }).unwrap_err();
    assert!(busy.contains("under way"), "{busy}");
}

/// L3 review fix: Resend story is refused for a stage you took over and
/// while the run waits on a verification.
#[test]
fn resend_story_is_refused_when_taken_over_or_waiting_on_a_verification() {
    let mut fx = Fixture::new("story_resend_refused");
    let implementer = story_gate_failed(&mut fx);
    {
        let mut store = fx.host.store.lock().unwrap();
        let run = store.pipeline_run_by_id_mut(RUN).unwrap();
        run.autopilot.as_mut().unwrap().verify = Some(crate::store::VerifyWait {
            stage_id: "implementer".into(),
            label: "verify".into(),
            steps: "Run it on Windows.".into(),
            at: "now".into(),
            ..Default::default()
        });
    }
    let waits = fx.user(UserAction::ResendStory { lane: None }).unwrap_err();
    assert!(waits.contains("waits on your answer"), "{waits}");
    fx.host.store.lock().unwrap().pipeline_run_by_id_mut(RUN).unwrap().autopilot.as_mut().unwrap().verify = None;
    fx.user(UserAction::TakeOver { tab_id: implementer.clone() }).unwrap();
    let mine = fx.user(UserAction::ResendStory { lane: None }).unwrap_err();
    assert!(mine.contains("You took"), "{mine}");
    fx.run(|run| assert_eq!(run.stories[1].status, crate::store::StoryStatus::Failed, "nothing changed"));
}

/// L3 review fix: approving the pull request with stories left marks them
/// skipped, with a Timeline line, and `story.json` says every story is finished.
#[test]
fn approving_with_unfinished_stories_skips_them_and_clears_the_story_mark() {
    let mut fx = Fixture::new("story_approve");
    let (impl1, _impl2) = two_lanes_at_the_implementer(&mut fx);
    {
        let mut store = fx.host.store.lock().unwrap();
        let run = store.pipeline_run_by_id_mut(RUN).unwrap();
        crate::pipelines::stories::seed(run, Some("pr1"), &story_task("pr1"));
        store.save().unwrap();
    }
    let tag = fx.tab(&impl1).bridge.unwrap();
    {
        let store = fx.host.store.lock().unwrap();
        crate::bridge::launch::write_story_mark(&fx.host.runs, store.pipeline_run_by_id(RUN).unwrap(), &tag.stage, Some("pr1")).unwrap();
    }
    assert_eq!(story_mark_of(&fx, "implementer@pr1").and_then(|m| m.current), Some("s1".into()));
    fx.user(UserAction::Approve { lane: Some("pr1".into()) }).expect("approved");
    use crate::store::StoryStatus::Skipped;
    assert_eq!(story_states(&fx, Some("pr1")), [("s1".to_string(), Skipped), ("s2".into(), Skipped), ("s3".into(), Skipped)]);
    fx.run(|run| {
        let line = run.events.iter().find(|e| e.outcome.as_deref() == Some("storySkipped")).expect("a Timeline line");
        assert!(line.summary.contains("Stories s1, s2, s3 were not done when you approved it"), "{}", line.summary);
    });
    assert_eq!(story_mark_of(&fx, "implementer@pr1").map(|m| m.current), Some(None));
}

/// L3 review fix: a hand-on you record yourself (to a Chat tab) skips the stories left too.
#[test]
fn a_hand_on_you_record_yourself_skips_the_stories_left() {
    use crate::store::StoryStatus::{Active, Done, Pending, Skipped};
    let mut fx = Fixture::new("story_record");
    let implementer = to_story_wait(&mut fx);
    fx.user(UserAction::ContinueStory { lane: None, story: "s1".into(), note: None, add: None }).unwrap();
    // MEDIUM 3: a recorded hand-on that then fails and is released skips nothing.
    fx.user(UserAction::RecordHandoff { source_tab_id: implementer.clone(), back: false, force: false }).unwrap();
    fx.user(UserAction::ReleaseHandoff { source_tab_id: implementer.clone(), back: false }).unwrap();
    assert_eq!(story_states(&fx, None), [("s1".to_string(), Done), ("s2".into(), Active), ("s3".into(), Pending)]);
    // The hand-on itself, recorded on the run (a Chat tab joining the
    // chain at the PR Reviewer with the hand-off), skips the stories left.
    fx.user(UserAction::RecordHandoff { source_tab_id: implementer, back: false, force: false }).unwrap();
    {
        let mut store = fx.host.store.lock().unwrap();
        let role = fx.host.roles.iter().find(|r| r.id == "role_pr_reviewer").unwrap();
        let chat = store.create_draft_tab(role, &fx.work.path().display().to_string(), true, None).unwrap();
        store.set_tab_chain(&chat, Some(chain(4, None)), Some("Review the pull request.")).unwrap();
    }
    assert_eq!(story_states(&fx, None), [("s1".to_string(), Done), ("s2".into(), Skipped), ("s3".into(), Skipped)]);
    fx.run(|run| {
        let line = run.events.iter().find(|e| e.outcome.as_deref() == Some("storySkipped")).expect("a Timeline line");
        assert!(line.summary.contains("Stories s2, s3 were not done before the pull request went on to PR Reviewer"), "{}", line.summary);
    });
    // The bridge hears it at the run's next turn.
    let planner = fx.planner.clone();
    fx.actor.handle(ActorMsg::Turn(fx.end_turn(&planner, "late-1", None, "Late.")));
    assert_eq!(story_mark_of(&fx, "implementer").map(|m| m.current), Some(None));
}

/// L3 review fix (MEDIUM 1): lane A waits on a checkpoint story; you
/// approve lane B, which ends A's wait. A's story is active again and
/// Resend story sends it.
#[test]
fn approving_another_lane_ends_a_story_wait_and_resend_picks_the_story_up() {
    let mut fx = Fixture::new("story_other_lane");
    let tasks = RunTasks {
        schema: 1,
        run_id: RUN.into(),
        stage_key: "planner".into(),
        turn: "p-1".into(),
        at: "now".into(),
        tasks: vec![story_task("pr1"), crate::bridge::PlannedTask { stories: vec![], ..story_task("pr2") }],
    };
    fx.stage_dir(&fx.planner).write_plan("# Plan", &tasks).unwrap();
    let (impl1, _impl2) = two_lanes_at_the_implementer(&mut fx);
    fx.actor.handle(ActorMsg::Turn(fx.end_turn(&impl1, "a-1", Some(story_result("s1", false)), "s1 done.")));
    fx.finish_gates();
    fx.run(|run| {
        assert_eq!(run.autopilot.as_ref().unwrap().story_wait.as_ref().and_then(|w| w.lane.as_deref()), Some("pr1"));
        // The stop line carries its lane, so the overview offers Resend for it later.
        let stop = run.events.iter().rev().find(|e| e.kind == "stop").unwrap();
        assert_eq!(stop.lane_id.as_deref(), Some("pr1"), "{}", stop.summary);
    });
    fx.user(UserAction::Approve { lane: Some("pr2".into()) }).expect("approve PR2");
    fx.run(|run| {
        assert!(run.autopilot.as_ref().unwrap().story_wait.is_none(), "the wait ended");
        assert_eq!(run.stories[0].status, crate::store::StoryStatus::Active, "its story is active again");
    });
    let refused = fx.user(UserAction::ContinueStory { lane: Some("pr1".into()), story: "s1".into(), note: None, add: None }).unwrap_err();
    assert!(refused.contains("not waiting"), "{refused}");
    fx.user(UserAction::ResendStory { lane: Some("pr1".into()) }).expect("Resend picks it up");
    let sent = fx.resumes().last().cloned().unwrap();
    assert_eq!(sent.tab_id, impl1);
    assert!(sent.prompt.starts_with("Story 1 of 3: R5 instrumentation"), "{}", sent.prompt);
}

/// L3 review fix: a lane's `gate_failed` stop is logged in that lane.
#[test]
fn a_lanes_story_gate_failed_stop_is_logged_in_its_lane() {
    let mut fx = Fixture::new("story_lane_stop");
    let tasks = RunTasks {
        schema: 1,
        run_id: RUN.into(),
        stage_key: "planner".into(),
        turn: "p-1".into(),
        at: "now".into(),
        tasks: vec![story_task("pr1"), crate::bridge::PlannedTask { stories: vec![], ..story_task("pr2") }],
    };
    fx.stage_dir(&fx.planner).write_plan("# Plan", &tasks).unwrap();
    let (impl1, _impl2) = two_lanes_at_the_implementer(&mut fx);
    for n in 0..=crate::pipelines::autopilot::MAX_GATE_RETRIES {
        fx.host.gates.lock().unwrap().push_back(failed_check());
        fx.actor.handle(ActorMsg::Turn(fx.end_turn(&impl1, &format!("f-{n}"), Some(story_result("s1", false)), "s1.")));
        fx.finish_gates();
    }
    fx.run(|run| {
        assert_eq!(run.stop_reason, Some(StopReason::GateFailed));
        let stop = run.events.iter().rev().find(|e| e.kind == "stop").unwrap();
        assert_eq!((stop.lane_id.as_deref(), stop.outcome.as_deref()), (Some("pr1"), Some("gate_failed")));
    });
}

/// L3 review fix: a review round sent back to the Implementer skips no story.
#[test]
fn a_loop_back_to_the_implementer_skips_no_story() {
    use crate::store::StoryStatus::{Active, Done, Pending};
    let mut fx = Fixture::new("story_loop_back");
    let implementer = to_story_wait(&mut fx);
    fx.user(UserAction::ContinueStory { lane: None, story: "s1".into(), note: None, add: None }).unwrap();
    {
        let mut store = fx.host.store.lock().unwrap();
        store
            .chain_loop_back_in(RUN, None, "role_pr_reviewer", &implementer, Some("REQUEST CHANGES"), Some("Review findings."))
            .unwrap();
    }
    assert_eq!(story_states(&fx, None), [("s1".to_string(), Done), ("s2".into(), Active), ("s3".into(), Pending)]);
    fx.run(|run| assert!(!run.events.iter().any(|e| e.outcome.as_deref() == Some("storySkipped"))));
}

// F1: artifact stages on the actor, with this file's fixture.
#[path = "artifact_tests.rs"]
mod artifact_tests;
