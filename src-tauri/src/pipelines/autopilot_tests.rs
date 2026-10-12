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
    }
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
    let mut capped = run(3);
    let d = decide(&eagle1(), &mut capped, &rep);
    assert_eq!(d.action, "stop");
    assert!(d.reason.starts_with("Round cap reached (3 of 3)"), "{}", d.reason);
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
