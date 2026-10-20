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

struct TestHost {
    store: Mutex<StateStore>,
    runs: PathBuf,
    roles: Vec<Role>,
    launches: Mutex<Vec<StageLaunch>>,
    pastes: Mutex<Vec<(String, String)>>,
    live: Mutex<HashSet<String>>,
    /// Gate results handed out in order; `passed` once they run out.
    gates: Mutex<VecDeque<GateResult>>,
    panic_on_usage: AtomicBool,
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
    fn spawn_stage(&self, launch: &StageLaunch) -> Result<(), String> {
        self.live.lock().unwrap().insert(launch.tab_id.clone());
        self.launches.lock().unwrap().push(launch.clone());
        Ok(())
    }
    fn paste(&self, tab_id: &str, text: &str) -> Result<(), String> {
        self.pastes.lock().unwrap().push((tab_id.to_string(), text.to_string()));
        Ok(())
    }
    fn terminal_live(&self, tab_id: &str) -> bool {
        self.live.lock().unwrap().contains(tab_id)
    }
    fn run_gate(&self, gate: &GateDef, _folder: &Path, _pr_urls: &[String]) -> GateResult {
        let label = match gate {
            GateDef::Command { .. } => "npm run check",
            GateDef::PullRequest => "pull requests",
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
        let host = Arc::new(TestHost {
            store: Mutex::new(store),
            runs,
            roles,
            launches: Mutex::new(Vec::new()),
            pastes: Mutex::new(Vec::new()),
            live: Mutex::new(HashSet::from([planner.clone()])),
            gates: Mutex::new(VecDeque::new()),
            panic_on_usage: AtomicBool::new(false),
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
    assert!(launch.bridge.args.iter().any(|a| a == "--mcp-config"), "{:?}", launch.bridge.args);
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
fn changes_required_goes_into_the_idle_planner_and_records_the_round() {
    let mut fx = Fixture::new("loop_back");
    let reviewer = fx.open_plan_reviewer();
    let turn = fx.end_turn(
        &reviewer,
        "r-1",
        review("CHANGES_REQUIRED", json!([{ "severity": "HIGH", "file": "src/auth.ts:42", "summary": "Retries forever." }])),
        "Changes required.",
    );
    fx.actor.handle(ActorMsg::Turn(turn));
    let pastes = fx.pastes();
    assert_eq!(pastes.len(), 1, "{pastes:?}");
    assert_eq!(pastes[0].0, fx.planner);
    assert!(pastes[0].1.starts_with("Review findings from the Plan Reviewer (round 1):"), "{}", pastes[0].1);
    assert!(pastes[0].1.contains("1. [HIGH] src/auth.ts:42: Retries forever."), "{}", pastes[0].1);
    fx.run(|run| {
        assert_eq!(run.round, 2);
        assert_eq!(run.verdicts.last().and_then(|v| v.verdict.as_deref()), Some("REQUIRES REVISION"));
        assert_eq!(run.stage, "planner");
    });
    assert_eq!(fx.launches().len(), 1, "no new Planner: the round went into the running one");
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
fn a_closed_planner_gets_a_new_terminal_with_its_form_and_the_findings() {
    let mut fx = Fixture::new("new_planner");
    let reviewer = fx.open_plan_reviewer();
    fx.host.live.lock().unwrap().remove(&fx.planner.clone());
    let turn = fx.end_turn(&reviewer, "r-1", review("CHANGES_REQUIRED", json!([{ "severity": "HIGH", "summary": "Retries forever." }])), "");
    fx.actor.handle(ActorMsg::Turn(turn));
    let launches = fx.launches();
    assert_eq!(launches.len(), 2);
    let planner = &launches[1];
    assert_eq!(planner.role_id, "role_planner");
    assert!(planner.prompt.contains("Refresh expired tokens instead of failing."), "its own form");
    assert!(planner.prompt.contains("Retries forever."), "and the findings");
    let tab = fx.tab(&planner.tab_id);
    assert_eq!(tab.chain.as_ref().map(|c| (c.step, c.round)), Some((1, 2)));
    fx.run(|run| assert_eq!(run.tab_ids.get("role_planner"), Some(&planner.tab_id)));
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
    let turn = fx.end_turn(&implementer, "i-1", Some(prs.clone()), "Opened https://github.com/acme/app/pull/12");
    fx.actor.handle(ActorMsg::Turn(turn));
    assert!(fx.actor.busy(), "the gates run on their own thread");
    fx.finish_gates();
    let pastes = fx.pastes();
    assert_eq!(pastes.len(), 1, "{pastes:?}");
    assert_eq!(pastes[0].0, implementer);
    assert!(pastes[0].1.contains("FAIL src/auth.test.ts"), "{}", pastes[0].1);
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
    assert_eq!(fx.pastes().len(), 1);
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
fn a_turn_on_an_engine_1_run_is_left_to_the_frontend() {
    let mut fx = Fixture::with_engine("engine1", 1);
    let turn = fx.planner_turn("p-1", "# Plan");
    fx.actor.handle(ActorMsg::Turn(turn));
    assert!(fx.launches().is_empty());
    fx.run(|run| assert!(run.events.iter().all(|e| e.kind != "turn")));
    let err = fx.user(UserAction::Continue).unwrap_err();
    assert!(err.contains("older pipeline engine"), "{err}");
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

/// The Implementer's turn whose check failed: the retry pasted once.
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
    assert_eq!(fx.pastes().len(), 1, "the failed check went back once");
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
    assert_eq!(fx.pastes().len(), 1, "the check's output is not pasted twice");
    assert_eq!(retries(&fx), Some(1), "no extra retry is counted");
    assert_eq!(fx.run(|run| run.events.iter().filter(|e| e.kind == "gate").count()), gate_lines, "no duplicate gate lines");
}

#[test]
fn continue_on_a_turn_the_actor_decided_runs_no_checks() {
    let mut fx = Fixture::new("dedupe_continue");
    let (implementer, _) = implementer_with_a_failed_gate(&mut fx);
    // The app restarted with the run on that turn: H3's reconcile matches
    // the actor's key, so the decided turn does not wait for Continue...
    let tag = fx.tab(&implementer).bridge.unwrap();
    let turn_id = crate::bridge::launch::stage_turn_id(&fx.host.runs, &tag, &implementer).expect("turn.json");
    let bridged = HashMap::from([(implementer.clone(), turn_id)]);
    let finished = crate::claude_session_log::TerminalSessionLog {
        session_id: "s".into(),
        path: "/tmp/x.jsonl".into(),
        turn_done: true,
        last_reply: "Opened".into(),
        plan: None,
        plan_at: None,
        last_prompt_at: Some("2026-10-20T10:00:00Z".into()),
        interrupted: false,
        tool_calls: Vec::new(),
        open_tool: None,
        pending_tools: Vec::new(),
        permission_mode: None,
        rate_limit: None,
    };
    let logs = HashMap::from([(implementer.clone(), finished)]);
    {
        let mut store = fx.host.store.lock().unwrap();
        let run = store.pipeline_run_by_id_mut(RUN).unwrap();
        let def = crate::pipelines::find(&run.kind).unwrap();
        let found = crate::pipelines::recovery::reconcile_run_with(&def, run, &logs, &bridged);
        assert_eq!(found, None, "a turn the actor decided is not stopped as app_restarted");
        assert_eq!(run.status, RunStatus::Running);
        // ...and when the run waits after a restart anyway (another tab), Continue
        // on the decided turn decides nothing again.
        run.stop_for(StopReason::AppRestarted, Some("implementer"), None, "Waiting after a restart.".to_string(), None);
        assert_eq!(run.stop_reason, Some(StopReason::AppRestarted));
    }
    let (me, gates) = channel();
    let mut fresh = Actor::new(RUN.to_string(), fx.host.clone(), me);
    let (reply, answer) = channel();
    fresh.handle(ActorMsg::User { action: UserAction::Continue, reply: Some(reply) });
    answer.recv().unwrap().unwrap();
    assert!(!fresh.busy(), "Continue starts no checks for a decided turn");
    assert!(gates.try_recv().is_err());
    assert_eq!(fx.pastes().len(), 1);
    assert_eq!(retries(&fx), Some(1));
    fx.run(|run| assert_eq!(run.status, RunStatus::Running, "the run carries on"));
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
    let pastes = fx.pastes();
    assert_eq!(pastes.len(), 1, "{pastes:?}");
    assert_eq!(pastes[0].0, fx.planner);
    assert!(pastes[0].1.contains("Revise the plan"), "the Planner is asked to revise its plan:\n{}", pastes[0].1);
    assert!(!pastes[0].1.contains("push to the same branch"), "not the Implementer's ask:\n{}", pastes[0].1);
    fx.run(|run| {
        assert_eq!(run.verdicts.last().and_then(|v| v.verdict.as_deref()), Some("REQUIRES REVISION"), "a plan reviewer revises");
    });
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
