use super::*;
use crate::pipelines::{find, GateResult};
use crate::store::{PipelineRun, RunAutopilot, StageGates};
use std::collections::HashMap;

fn run(round: u32) -> PipelineRun {
    PipelineRun {
        id: "ee_1".into(),
        kind: "full".into(),
        cwd: "/repo".into(),
        stage: "planner".into(),
        overview_tab_id: String::new(),
        tab_ids: HashMap::new(),
        candidate_plan: None,
        approved_plan: None,
        original_request: None,
        created_at: "2026-10-13T00:00:00Z".into(),
        chain_id: Some("ee_1".into()),
        handoffs: HashMap::new(),
        updated_at: None,
        round,
        verdicts: Vec::new(),
        events: Vec::new(),
        gates: HashMap::new(),
        autopilot: Some(RunAutopilot {
            enabled: true,
            ..RunAutopilot::default()
        }),
        lanes: Vec::new(),
        fan_out_stage: None,
    }
}

/// Recorded send-backs, one per reviewer role id given (in order), parsed
/// into whatever verdict list they are assigned to.
fn sent_back<T: serde::de::DeserializeOwned>(role_ids: &[&str]) -> T {
    let list: Vec<serde_json::Value> = role_ids
        .iter()
        .enumerate()
        .map(|(i, role)| {
            serde_json::json!({ "roleId": role, "round": i + 1, "verdict": "REQUEST CHANGES", "at": "then" })
        })
        .collect();
    serde_json::from_value(serde_json::Value::Array(list)).unwrap()
}

fn report(stage: &str, verdict: Option<&str>) -> TurnReport {
    TurnReport {
        stage_id: stage.into(),
        verdict: verdict.map(str::to_string),
        ..TurnReport::default()
    }
}

fn finding(severity: &str, summary: &str) -> FindingReport {
    FindingReport {
        severity: severity.into(),
        summary: summary.into(),
    }
}

fn eagle1() -> crate::pipelines::PipelineDef {
    find("eagle1").unwrap()
}

#[test]
fn off_means_no_decision_and_nothing_logged() {
    let mut r = run(1);
    r.autopilot = None;
    let d = decide(&eagle1(), &mut r, &report("planner", None));
    assert_eq!(d.action, "stop");
    assert!(r.events.is_empty());
}

#[test]
fn a_planner_turn_advances_to_the_plan_reviewer() {
    let mut r = run(1);
    let d = decide(&eagle1(), &mut r, &report("planner", None));
    assert_eq!((d.action.as_str(), d.stage_id.as_deref()), ("advance", Some("plan_reviewer")));
    assert_eq!(r.events.last().unwrap().kind, "autopilot");
}

#[test]
fn an_approved_plan_stops_at_the_implementer_checkpoint_until_passed() {
    let mut r = run(1);
    let d = decide(&eagle1(), &mut r, &report("plan_reviewer", Some("APPROVED")));
    assert_eq!((d.action.as_str(), d.stage_id.as_deref()), ("stop", Some("implementer")));
    assert!(d.reason.starts_with("Checkpoint before Implementer"));
    assert!(r.autopilot.as_ref().unwrap().waiting.is_some());
    r.autopilot.as_mut().unwrap().passed_checkpoints.push("implementer".into());
    let d = decide(&eagle1(), &mut r, &report("plan_reviewer", Some("APPROVED WITH CHANGES")));
    assert_eq!(d.action, "advance");
    assert!(r.autopilot.as_ref().unwrap().waiting.is_none());
}

#[test]
fn changes_with_a_medium_finding_loop_back_until_the_round_cap() {
    let mut r = run(1);
    let mut rep = report("pr_reviewer", Some("REQUEST CHANGES"));
    rep.findings = vec![finding("MEDIUM", "null token"), finding("LOW", "typo")];
    rep.findings_known = true;
    let d = decide(&eagle1(), &mut r, &rep);
    assert_eq!((d.action.as_str(), d.stage_id.as_deref()), ("loopBack", Some("implementer")));
    // Two earlier PR Reviewer send-backs: this is its third round on the edge.
    let mut capped = run(3);
    capped.verdicts = sent_back(&["role_pr_reviewer", "role_pr_reviewer"]);
    let d = decide(&eagle1(), &mut capped, &rep);
    assert_eq!(d.action, "stop");
    assert!(d.reason.starts_with("Round cap reached (3 of 3)"), "{}", d.reason);
}

#[test]
fn the_round_cap_counts_each_loop_back_edge_on_its_own() {
    // The plan was sent back twice, so the run is on round 3 ...
    let mut r = run(3);
    r.verdicts = sent_back(&["role_plan_reviewer", "role_plan_reviewer"]);
    let mut rep = report("pr_reviewer", Some("REQUEST CHANGES"));
    rep.findings = vec![finding("MEDIUM", "null token")];
    rep.findings_known = true;
    // ... but this is the PR Reviewer's first send-back: it loops back.
    let d = decide(&eagle1(), &mut r, &rep);
    assert_eq!((d.action.as_str(), d.stage_id.as_deref()), ("loopBack", Some("implementer")), "{}", d.reason);
    assert!(d.reason.contains("round 1"), "{}", d.reason);
    // Two PR Reviewer send-backs of its own: the third hits the cap.
    let mut capped = run(3);
    capped.verdicts = sent_back(&["role_plan_reviewer", "role_pr_reviewer", "role_pr_reviewer"]);
    let d = decide(&eagle1(), &mut capped, &rep);
    assert_eq!(d.action, "stop");
    assert!(d.reason.contains("3 of 3"), "{}", d.reason);
}

#[test]
fn an_approval_with_findings_at_the_threshold_stops_instead_of_advancing() {
    let mut r = run(1);
    let mut rep = report("pr_reviewer", Some("APPROVED WITH CHANGES"));
    rep.findings = vec![finding("HIGH", "token leaks to log"), finding("LOW", "typo")];
    rep.findings_known = true;
    let d = decide(&eagle1(), &mut r, &rep);
    assert_eq!((d.action.as_str(), d.stage_id.as_deref()), ("stop", Some("pr_reviewer")));
    assert!(d.reason.contains("1 finding(s)"), "{}", d.reason);
    assert!(r.autopilot.as_ref().unwrap().waiting.is_some());
    let logged = r.events.last().unwrap();
    assert_eq!(logged.kind, "stop");
    assert!(logged.detail.as_deref().unwrap_or("").contains("[HIGH] token leaks to log"));
    // Only LOW findings: a clean approval that completes, with follow-ups.
    let mut low = report("pr_reviewer", Some("APPROVED WITH CHANGES"));
    low.findings = vec![finding("LOW", "typo")];
    low.findings_known = true;
    let d = decide(&eagle1(), &mut run(1), &low);
    assert_eq!(d.action, "complete");
    assert_eq!(d.follow_ups, vec!["[LOW] typo"]);
}

#[test]
fn only_low_findings_finish_the_run_and_become_follow_ups() {
    let mut r = run(2);
    let mut rep = report("pr_reviewer", Some("REQUEST CHANGES"));
    rep.findings = vec![finding("LOW", "rename x"), finding("info", "comment wording")];
    rep.findings_known = true;
    let d = decide(&eagle1(), &mut r, &rep);
    assert_eq!(d.action, "complete");
    assert_eq!(d.follow_ups, vec!["[LOW] rename x", "[INFO] comment wording"]);
    assert_eq!(r.events.last().unwrap().kind, "complete");
}

#[test]
fn findings_without_a_structured_result_count_as_blocking() {
    let mut r = run(1);
    let rep = report("pr_reviewer", Some("REQUEST CHANGES"));
    assert_eq!(decide(&eagle1(), &mut r, &rep).action, "loopBack");
    let mut unlabelled = report("pr_reviewer", Some("REQUEST CHANGES"));
    unlabelled.findings = vec![finding("someday", "unclear")];
    unlabelled.findings_known = true;
    assert_eq!(decide(&eagle1(), &mut run(1), &unlabelled).action, "loopBack");
}

#[test]
fn an_approved_pr_review_completes_the_run() {
    let mut r = run(1);
    let d = decide(&eagle1(), &mut r, &report("pr_reviewer", Some("APPROVED")));
    assert_eq!(d.action, "complete");
}

#[test]
fn a_reviewer_reply_without_a_verdict_stops() {
    let d = decide(&eagle1(), &mut run(1), &report("pr_reviewer", None));
    assert_eq!(d.action, "stop");
    assert!(d.reason.contains("No verdict"));
}

#[test]
fn missing_sections_are_asked_for_once_then_stop() {
    let mut r = run(1);
    let mut rep = report("plan_reviewer", Some("APPROVED"));
    rep.missing_sections = vec!["Reviewed plan".into()];
    assert_eq!(decide(&eagle1(), &mut r, &rep).action, "reask");
    let d = decide(&eagle1(), &mut r, &rep);
    assert_eq!(d.action, "stop");
    assert!(d.reason.contains("Reviewed plan"));
}

#[test]
fn a_failed_gate_is_retried_twice_then_stops() {
    let mut r = run(1);
    r.gates.insert(
        "implementer".into(),
        StageGates {
            round: 1,
            at: "now".into(),
            results: vec![GateResult {
                kind: "command".into(),
                label: "npm run check".into(),
                status: "failed".into(),
                summary: "Failed (exit code 1).".into(),
                output: "1 test failed".into(),
                duration_ms: 10,
            }],
        },
    );
    let rep = report("implementer", None);
    let first = decide(&eagle1(), &mut r, &rep);
    assert_eq!((first.action.as_str(), first.stage_id.as_deref()), ("retry", Some("implementer")));
    assert!(first.message.unwrap().contains("1 test failed"));
    assert_eq!(decide(&eagle1(), &mut r, &rep).action, "retry");
    let third = decide(&eagle1(), &mut r, &rep);
    assert_eq!(third.action, "stop");
    assert!(third.reason.contains("failed 3 times"), "{}", third.reason);
}

#[test]
fn gate_results_from_an_earlier_round_are_ignored() {
    let mut r = run(2);
    r.gates.insert(
        "implementer".into(),
        StageGates {
            round: 1,
            at: "then".into(),
            results: vec![GateResult::skipped("command", "x", "y")],
        },
    );
    r.gates.get_mut("implementer").unwrap().results[0].status = "failed".into();
    let d = decide(&eagle1(), &mut r, &report("implementer", None));
    assert_eq!((d.action.as_str(), d.stage_id.as_deref()), ("advance", Some("pr_reviewer")));
}

#[test]
fn chat_stages_and_high_usage_stop() {
    let mut chat = report("planner", None);
    chat.chat = true;
    assert!(decide(&eagle1(), &mut run(1), &chat).reason.contains("chat tab"));
    let mut busy = report("planner", None);
    busy.usage_percent = Some(93);
    let d = decide(&eagle1(), &mut run(1), &busy);
    assert_eq!(d.action, "stop");
    assert!(d.reason.contains("93%"));
    busy.usage_percent = Some(89);
    assert_eq!(decide(&eagle1(), &mut run(1), &busy).action, "advance");
}

fn lane(id: &str, depends_on: &[&str], status: &str, round: u32) -> crate::store::RunLane {
    crate::store::RunLane {
        id: id.into(),
        title: id.to_uppercase(),
        depends_on: depends_on.iter().map(|d| d.to_string()).collect(),
        status: status.into(),
        stage: "implementer".into(),
        round,
        tab_ids: HashMap::new(),
        handoffs: HashMap::new(),
        verdicts: Vec::new(),
    }
}

fn in_lane(stage: &str, verdict: Option<&str>, lane_id: &str) -> TurnReport {
    TurnReport {
        lane: Some(lane_id.into()),
        ..report(stage, verdict)
    }
}

#[test]
fn an_approved_lane_unblocks_the_lanes_waiting_on_it() {
    let mut r = run(1);
    r.lanes = vec![
        lane("pr1", &[], "active", 1),
        lane("pr2", &["pr1"], "waiting", 1),
        lane("pr3", &[], "active", 1),
    ];
    let d = decide(&eagle1(), &mut r, &in_lane("pr_reviewer", Some("APPROVED"), "pr1"));
    assert_eq!(d.action, "laneDone");
    assert_eq!(d.unblocked, vec!["pr2"]);
    assert_eq!(d.lane.as_deref(), Some("pr1"));
    assert_eq!(r.lane("pr1").unwrap().status, "approved");
    // The last lane approved completes the run.
    r.lane_mut("pr2").unwrap().status = "approved".into();
    let d = decide(&eagle1(), &mut r, &in_lane("pr_reviewer", Some("APPROVED"), "pr3"));
    assert_eq!(d.action, "complete");
}

#[test]
fn a_lane_counts_its_own_rounds_and_gates() {
    let mut r = run(1);
    r.lanes = vec![lane("pr1", &[], "active", 3), lane("pr2", &[], "active", 1)];
    // pr1's reviewer has sent it back twice; pr2's never; the run's own
    // verdicts do not count toward a lane.
    r.lane_mut("pr1").unwrap().verdicts = sent_back(&["role_pr_reviewer", "role_pr_reviewer"]);
    r.verdicts = sent_back(&["role_pr_reviewer", "role_pr_reviewer"]);
    let rep = in_lane("pr_reviewer", Some("REQUEST CHANGES"), "pr1");
    let capped = decide(&eagle1(), &mut r, &rep);
    assert_eq!(capped.action, "stop");
    assert!(capped.reason.contains("3 of 3"), "{}", capped.reason);
    let other = decide(&eagle1(), &mut r, &in_lane("pr_reviewer", Some("REQUEST CHANGES"), "pr2"));
    assert_eq!((other.action.as_str(), other.lane.as_deref()), ("loopBack", Some("pr2")));
    // A failed check on one lane does not hold up the other.
    r.gates.insert(
        "implementer@pr2".into(),
        StageGates {
            round: 1,
            at: "now".into(),
            results: vec![GateResult {
                kind: "command".into(),
                label: "cargo test".into(),
                status: "failed".into(),
                summary: "Failed (exit code 101).".into(),
                output: String::new(),
                duration_ms: 1,
            }],
        },
    );
    assert_eq!(decide(&eagle1(), &mut r, &in_lane("implementer", None, "pr2")).action, "retry");
    let pr1 = decide(&eagle1(), &mut r, &in_lane("implementer", None, "pr1"));
    assert_eq!((pr1.action.as_str(), pr1.stage_id.as_deref()), ("advance", Some("pr_reviewer")));
    assert_eq!(pr1.lane.as_deref(), Some("pr1"));
    assert!(r.events.last().unwrap().summary.starts_with("PR1: "));
}
