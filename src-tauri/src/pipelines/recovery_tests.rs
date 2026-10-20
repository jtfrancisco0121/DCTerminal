use super::*;
use crate::claude_session_log::OpenTool;
use crate::pipelines::find;
use crate::store::{RunAutopilot, RunLane};

const SID: &str = "11111111-2222-4333-8444-555555555555";
const PROMPT: &str = "2026-10-19T10:00:00.000Z";

fn run(stage: &str, tabs: &[(&str, &str)]) -> PipelineRun {
    let mut run: PipelineRun = serde_json::from_value(serde_json::json!({
        "id": "ee_1", "kind": "full", "cwd": "/repo", "stage": stage,
        "tabIds": {}, "createdAt": "2026-10-19T00:00:00Z", "chainId": "ee_1",
        "status": "running"
    }))
    .unwrap();
    run.tab_ids = tabs.iter().map(|(role, tab)| (role.to_string(), tab.to_string())).collect();
    run.autopilot = Some(RunAutopilot {
        enabled: true,
        ..RunAutopilot::default()
    });
    run
}

fn log(turn_done: bool) -> TerminalSessionLog {
    TerminalSessionLog {
        session_id: SID.into(),
        path: "/tmp/x.jsonl".into(),
        turn_done,
        last_reply: "done".into(),
        plan: None,
        plan_at: None,
        last_prompt_at: Some(PROMPT.into()),
        interrupted: false,
        tool_calls: Vec::new(),
        open_tool: None,
        rate_limit: None,
        pending_tools: Vec::new(),
        permission_mode: None,
    }
}

fn logs(entries: &[(&str, TerminalSessionLog)]) -> HashMap<String, TerminalSessionLog> {
    entries.iter().map(|(tab, log)| (tab.to_string(), log.clone())).collect()
}

fn eagle1() -> PipelineDef {
    find("eagle1").unwrap()
}

#[test]
fn finished_and_working_turns_read_like_the_frontend() {
    assert!(finished_turn("role_implementer", &log(true)));
    assert!(!working("role_implementer", &log(true)));
    let interrupted = TerminalSessionLog { interrupted: true, ..log(true) };
    assert!(!finished_turn("role_implementer", &interrupted), "an interrupted turn is left to you");
    assert!(!working("role_implementer", &interrupted));
    assert!(working("role_implementer", &log(false)));
    let fresh = TerminalSessionLog { last_prompt_at: None, ..log(false) };
    assert!(!working("role_implementer", &fresh), "no prompt yet");
    let plan = TerminalSessionLog {
        plan: Some("# Plan".into()),
        open_tool: Some(OpenTool {
            id: "toolu_1".into(),
            name: "ExitPlanMode".into(),
            title: "Plan".into(),
            hint: String::new(),
        }),
        ..log(false)
    };
    assert!(finished_turn("role_planner", &plan), "a plan awaiting approval");
    assert!(!working("role_planner", &plan));
    assert!(working("role_implementer", &plan), "only the Planner's plan counts");
    assert_eq!(turn_key("tab_1", &log(true)), format!("tab_1|{SID}|{PROMPT}"));
}

#[test]
fn a_finished_turn_nobody_decided_waits_with_app_restarted() {
    let def = eagle1();
    let mut run = run("implementer", &[("role_planner", "tab_p"), ("role_implementer", "tab_i")]);
    let found = reconcile_run(&def, &mut run, &logs(&[("tab_p", log(true)), ("tab_i", log(true))]));
    let Some(Reconciled::Waiting { tab_id, why }) = found else {
        panic!("not waiting: {found:?}");
    };
    assert_eq!(tab_id, "tab_i", "the current stage's tab, not an earlier one");
    assert_eq!((run.status, run.stop_reason), (RunStatus::Waiting, Some(StopReason::AppRestarted)));
    assert!(why.starts_with("Implementer finished while the app was closed"), "{why}");
    assert_eq!(run.autopilot.as_ref().unwrap().waiting.as_deref(), Some(why.as_str()));
    let last = run.events.last().unwrap();
    assert_eq!((last.kind.as_str(), last.stage_id.as_deref()), ("stop", Some("implementer")));
    // Never decided by itself: nothing was claimed or marked decided.
    assert!(run.claims.is_empty());
    assert!(run.autopilot.as_ref().unwrap().decided.is_empty());
}

#[test]
fn a_decided_turn_or_a_run_not_running_is_left_alone() {
    let def = eagle1();
    let mut decided = run("implementer", &[("role_implementer", "tab_i")]);
    decided.autopilot.as_mut().unwrap().decided.push(turn_key("tab_i", &log(true)));
    assert_eq!(reconcile_run(&def, &mut decided, &logs(&[("tab_i", log(true))])), None);
    assert_eq!(decided.status, RunStatus::Running);
    assert!(decided.events.is_empty());

    for status in [RunStatus::Waiting, RunStatus::Stopped, RunStatus::Complete] {
        let mut other = run("implementer", &[("role_implementer", "tab_i")]);
        other.status = status;
        assert_eq!(reconcile_run(&def, &mut other, &logs(&[("tab_i", log(true))])), None, "{status:?}");
        assert_eq!(other.status, status);
    }
    let mut manual = run("implementer", &[("role_implementer", "tab_i")]);
    manual.autopilot.as_mut().unwrap().enabled = false;
    assert_eq!(reconcile_run(&def, &mut manual, &logs(&[("tab_i", log(true))])), None);
}

#[test]
fn a_turn_cut_off_by_the_quit_is_noted_and_the_run_keeps_running() {
    let def = eagle1();
    let mut run = run("implementer", &[("role_implementer", "tab_i")]);
    assert_eq!(reconcile_run(&def, &mut run, &logs(&[("tab_i", log(false))])), Some(Reconciled::CutOff));
    assert_eq!((run.status, run.stop_reason), (RunStatus::Running, None));
    let last = run.events.last().unwrap();
    assert_eq!(last.kind, "note");
    assert!(last.summary.contains("cut off when the app closed"), "{}", last.summary);
    // No log, or a stage that never got a prompt: nothing to do.
    let mut quiet = super::tests::run("implementer", &[("role_implementer", "tab_i")]);
    assert_eq!(reconcile_run(&def, &mut quiet, &HashMap::new()), None);
    assert!(quiet.events.is_empty());
}

#[test]
fn lanes_reconcile_their_active_stage_and_parallel_reviewers_key_on_the_stage_role() {
    let mut def = eagle1();
    def.stages[3].also_reviewers = vec!["role_security".into()];
    let mut run = run("implementer", &[]);
    let lane = |id: &str, status: &str, tab: &str| RunLane {
        id: id.into(),
        title: format!("{} — API", id.to_uppercase()),
        depends_on: Vec::new(),
        status: status.into(),
        stage: "pr_reviewer".into(),
        round: 1,
        tab_ids: HashMap::from([
            ("role_pr_reviewer".to_string(), format!("{tab}_rev")),
            ("role_security".to_string(), format!("{tab}_sec")),
        ]),
        handoffs: HashMap::new(),
        verdicts: Vec::new(),
    };
    run.lanes = vec![lane("pr1", "approved", "a"), lane("pr2", "active", "b")];
    let tabs = current_stage_tabs(&def, &run);
    let ids: Vec<(&str, bool)> = tabs.iter().map(|t| (t.tab_id.as_str(), t.own)).collect();
    assert_eq!(ids, vec![("b_rev", true), ("b_sec", false)], "only the active lane");

    // Only the security reviewer finished: nothing autopilot would decide yet.
    let found = reconcile_run(&def, &mut run.clone(), &logs(&[("b_sec", log(true)), ("a_rev", log(true))]));
    assert_eq!(found, None);
    let found = reconcile_run(&def, &mut run, &logs(&[("b_rev", log(true))]));
    let Some(Reconciled::Waiting { tab_id, why }) = found else {
        panic!("not waiting: {found:?}");
    };
    assert_eq!(tab_id, "b_rev");
    assert!(why.starts_with("PR2 — API: PR Reviewer finished"), "{why}");
    assert_eq!(run.events.last().unwrap().lane_id.as_deref(), Some("pr2"));
}

fn seen(working: bool, log_len: u64, pty_quiet: Option<u64>) -> StallObservation {
    StallObservation {
        working,
        log_len: Some(log_len),
        pty_quiet: pty_quiet.map(Duration::from_secs),
    }
}

#[test]
fn quiet_counts_only_while_working_with_no_output_and_no_log_growth() {
    let limit = Duration::from_secs(30 * 60);
    let t0 = Instant::now();
    let at = |mins: u64| t0 + Duration::from_secs(mins * 60);
    let mut watch = StallWatch::new();
    // Quiet terminal, log growing: not stalled.
    assert_eq!(watch.observe("r|t", at(0), seen(true, 10, Some(0)), limit), None);
    assert_eq!(watch.observe("r|t", at(20), seen(true, 20, Some(20 * 60)), limit), None);
    assert_eq!(watch.observe("r|t", at(40), seen(true, 20, Some(40 * 60)), limit), None, "20 quiet minutes");
    assert_eq!(
        watch.observe("r|t", at(50), seen(true, 20, Some(50 * 60)), limit),
        Some(Duration::from_secs(30 * 60)),
        "the log stopped at minute 20"
    );
    // Output on screen keeps it alive even with no log growth (a long test run).
    let mut busy = StallWatch::new();
    assert_eq!(busy.observe("r|t", at(0), seen(true, 10, Some(0)), limit), None);
    assert_eq!(busy.observe("r|t", at(45), seen(true, 10, Some(5)), limit), None);
    // A finished turn forgets the tab; the next turn counts afresh.
    assert_eq!(watch.observe("r|t", at(51), seen(false, 20, Some(51 * 60)), limit), None);
    assert!(watch.is_empty());
    assert_eq!(watch.observe("r|t", at(52), seen(true, 20, Some(52 * 60)), limit), None, "quiet from before");
    assert_eq!(watch.observe("r|t", at(81), seen(true, 20, Some(81 * 60)), limit), None);
    assert!(watch.observe("r|t", at(82), seen(true, 20, Some(82 * 60)), limit).is_some());
}

#[test]
fn no_terminal_counts_as_quiet_and_retain_drops_runs_that_stopped() {
    let limit = Duration::from_secs(60);
    let t0 = Instant::now();
    let mut watch = StallWatch::new();
    let no_pty = StallObservation { working: true, log_len: None, pty_quiet: None };
    assert_eq!(watch.observe("r|a", t0, no_pty, limit), None);
    assert_eq!(watch.observe("r|b", t0, no_pty, limit), None);
    assert_eq!(watch.observe("r|a", t0 + limit, no_pty, limit), Some(limit));
    watch.retain(&HashSet::from(["r|b".to_string()]));
    assert_eq!(watch.len(), 1);
    // Back on later, `r|a` starts from zero again.
    assert_eq!(watch.observe("r|a", t0 + limit * 2, no_pty, limit), None);
}

#[test]
fn a_stall_stops_only_a_running_run_with_stalled() {
    let def = eagle1();
    let mut run = run("implementer", &[("role_implementer", "tab_i")]);
    let tab = current_stage_tabs(&def, &run).remove(0);
    let why = stop_stalled(&mut run, &tab, Duration::from_secs(30 * 60)).unwrap();
    assert!(why.starts_with("Implementer has been quiet for 30 minutes"), "{why}");
    assert_eq!((run.status, run.stop_reason), (RunStatus::Waiting, Some(StopReason::Stalled)));
    let last = run.events.last().unwrap();
    assert_eq!((last.kind.as_str(), last.role_id.as_deref()), ("stop", Some("role_implementer")));
    let before = run.events.len();
    assert_eq!(stop_stalled(&mut run, &tab, Duration::from_secs(3600)), None, "already waiting");
    assert_eq!(run.events.len(), before);
    assert_eq!(quiet_text(Duration::from_secs(61)), "1 minute");
    assert_eq!(quiet_text(Duration::from_millis(1500)), "1 second");
    assert_eq!(quiet_text(Duration::from_secs(45)), "45 seconds");
}
