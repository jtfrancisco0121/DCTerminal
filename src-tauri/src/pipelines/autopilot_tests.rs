use super::*;
use crate::pipelines::{find, GateResult};
use crate::store::{claim_key, PipelineRun, RunAutopilot, RunStatus, StageGates, StopReason};
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
        claims: Vec::new(),
        status: RunStatus::Running,
        stop_reason: None,
        engine: 1,
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

/// Eagle-Eye 1 with a round cap on every loop-back, as set in Settings › Pipelines.
fn eagle1_capped(cap: u32) -> crate::pipelines::PipelineDef {
    let mut def = eagle1();
    for back in def.stages.iter_mut().filter_map(|stage| stage.loop_back.as_mut()) {
        back.max_rounds = Some(cap);
    }
    def
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
    let logged = r.events.last().unwrap();
    assert_eq!(logged.kind, "autopilot");
    assert_eq!(logged.outcome.as_deref(), Some("advance"), "the lanes read the action");
}

#[test]
fn an_approved_plan_stops_at_the_implementer_checkpoint_until_passed() {
    let mut r = run(1);
    let d = decide(&eagle1(), &mut r, &report("plan_reviewer", Some("APPROVED")));
    assert_eq!((d.action.as_str(), d.stage_id.as_deref()), ("stop", Some("implementer")));
    assert!(d.reason.starts_with("Checkpoint before Implementer"));
    assert!(r.autopilot.as_ref().unwrap().waiting.is_some());
    // You pass it (send into the Implementer yourself): the run carries on.
    r.autopilot.as_mut().unwrap().passed_checkpoints.push("implementer".into());
    r.resume_after_you();
    let d = decide(&eagle1(), &mut r, &report("plan_reviewer", Some("APPROVED WITH CHANGES")));
    assert_eq!(d.action, "advance");
    assert!(r.autopilot.as_ref().unwrap().waiting.is_none());
}

#[test]
fn changes_with_a_medium_finding_loop_back_until_a_set_round_cap() {
    let mut r = run(1);
    let mut rep = report("pr_reviewer", Some("REQUEST CHANGES"));
    rep.findings = vec![finding("MEDIUM", "null token"), finding("LOW", "typo")];
    rep.findings_known = true;
    let d = decide(&eagle1(), &mut r, &rep);
    assert_eq!((d.action.as_str(), d.stage_id.as_deref()), ("loopBack", Some("implementer")));
    // Two earlier PR Reviewer send-backs: this is its third round on the edge.
    let mut capped = run(3);
    capped.verdicts = sent_back(&["role_pr_reviewer", "role_pr_reviewer"]);
    let d = decide(&eagle1_capped(3), &mut capped, &rep);
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
    let d = decide(&eagle1_capped(3), &mut capped, &rep);
    assert_eq!(d.action, "stop");
    assert!(d.reason.contains("3 of 3"), "{}", d.reason);
}

#[test]
fn a_plain_approval_with_findings_at_the_threshold_stops_instead_of_advancing() {
    let mut r = run(1);
    let mut rep = report("pr_reviewer", Some("APPROVED"));
    rep.findings = vec![finding("HIGH", "token leaks to log"), finding("LOW", "typo")];
    rep.findings_known = true;
    let d = decide(&eagle1(), &mut r, &rep);
    assert_eq!((d.action.as_str(), d.stage_id.as_deref()), ("stop", Some("pr_reviewer")));
    assert!(d.reason.contains("1 finding(s)"), "{}", d.reason);
    // The last stage has nothing to send it on to: say how to get past it.
    assert!(d.reason.ends_with("Send it back, or press Mark complete in the chain overview."), "{}", d.reason);
    assert!(r.autopilot.as_ref().unwrap().waiting.is_some());
    let logged = r.events.last().unwrap();
    assert_eq!(logged.kind, "stop");
    assert!(logged.detail.as_deref().unwrap_or("").contains("[HIGH] token leaks to log"));
    // Only LOW findings: a clean approval that completes, with follow-ups.
    let mut low = report("pr_reviewer", Some("APPROVED"));
    low.findings = vec![finding("LOW", "typo")];
    low.findings_known = true;
    let d = decide(&eagle1(), &mut run(1), &low);
    assert_eq!(d.action, "complete");
    assert_eq!(d.follow_ups, vec!["[LOW] typo"]);
}

#[test]
fn approved_with_changes_advances_and_logs_the_applied_findings() {
    let mut r = run(1);
    r.autopilot.as_mut().unwrap().passed_checkpoints.push("implementer".into());
    let mut rep = report("plan_reviewer", Some("APPROVED WITH CHANGES"));
    rep.findings = vec![finding("MEDIUM", "missing rollback step"), finding("LOW", "typo")];
    rep.findings_known = true;
    let d = decide(&eagle1(), &mut r, &rep);
    assert_eq!((d.action.as_str(), d.stage_id.as_deref()), ("advance", Some("implementer")), "{}", d.reason);
    // Applied findings are in the event detail, not the follow-ups.
    assert_eq!(d.follow_ups, vec!["[LOW] typo"]);
    let detail = r.events.last().unwrap().detail.clone().unwrap_or_default();
    assert!(detail.contains("[MEDIUM] missing rollback step"), "{detail}");
    assert!(detail.contains("[LOW] typo"), "{detail}");
}

#[test]
fn a_specialist_send_back_counts_toward_its_stage_round() {
    let mut def = eagle1_capped(3);
    let pr = def.stage_index("pr_reviewer").unwrap();
    def.stages[pr].also_reviewers = vec!["role_security".into()];
    // One send-back by the PR Reviewer, one (manual) by the specialist.
    let mut r = run(3);
    r.verdicts = sent_back(&["role_pr_reviewer", "role_security"]);
    let mut rep = report("pr_reviewer", Some("REQUEST CHANGES"));
    rep.findings = vec![finding("MEDIUM", "null token")];
    rep.findings_known = true;
    let d = decide(&def, &mut r, &rep);
    assert_eq!(d.action, "stop");
    assert!(d.reason.contains("3 of 3"), "{}", d.reason);
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
fn a_bridge_turn_with_no_result_stops_at_once_with_no_result() {
    // Engine 2: the bridge already blocked the stop once (D10), so there is
    // no second ask here.
    let mut r = run(1);
    let mut rep = report("pr_reviewer", None);
    rep.no_result = true;
    rep.turn = Some("tab|s|p-1".into());
    let d = decide(&eagle1(), &mut r, &rep);
    assert_eq!(d.action, "stop");
    assert_eq!(d.stage_id.as_deref(), Some("pr_reviewer"));
    assert!(d.reason.contains("submit_result"), "{}", d.reason);
    assert_eq!(r.status, RunStatus::Waiting);
    assert_eq!(r.stop_reason, Some(StopReason::NoResult));
}

#[test]
fn bridge_verdict_words_decide_like_the_v1_words() {
    let mut r = run(1);
    let mut rep = report("pr_reviewer", Some("CHANGES_REQUIRED"));
    rep.findings = vec![finding("HIGH", "token not refreshed")];
    rep.findings_known = true;
    let d = decide(&eagle1(), &mut r, &rep);
    assert_eq!((d.action.as_str(), d.stage_id.as_deref()), ("loopBack", Some("implementer")));
    let mut r = run(1);
    let mut rep = report("plan_reviewer", Some("APPROVED_WITH_CHANGES"));
    rep.findings = vec![finding("HIGH", "applied already")];
    rep.findings_known = true;
    let d = decide(&eagle1(), &mut r, &rep);
    assert_eq!(d.action, "stop", "the Implementer checkpoint: {}", d.reason);
    assert!(d.reason.starts_with("Checkpoint before Implementer"), "{}", d.reason);
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
    let capped = decide(&eagle1_capped(3), &mut r, &rep);
    assert_eq!(capped.action, "stop");
    assert!(capped.reason.contains("3 of 3"), "{}", capped.reason);
    // The run waits for you until you act on pr1 (here: you did).
    r.resume_after_you();
    let other = decide(&eagle1_capped(3), &mut r, &in_lane("pr_reviewer", Some("REQUEST CHANGES"), "pr2"));
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
    assert_eq!(r.events.last().unwrap().lane_id.as_deref(), Some("pr1"));
}

#[test]
fn approved_with_changes_at_the_last_stage_stops_on_blocking_findings() {
    let mut r = run(1);
    let mut rep = report("pr_reviewer", Some("APPROVED WITH CHANGES"));
    rep.findings = vec![finding("HIGH", "token leaks to log")];
    rep.findings_known = true;
    let d = decide(&eagle1(), &mut r, &rep);
    assert_eq!((d.action.as_str(), d.stage_id.as_deref()), ("stop", Some("pr_reviewer")), "{}", d.reason);
    assert!(d.reason.ends_with("Send it back, or press Mark complete in the chain overview."), "{}", d.reason);
    assert!(r.autopilot.as_ref().unwrap().waiting.is_some());
    // In a lane, the way past it is that lane's Mark approved.
    let mut r = run(1);
    r.lanes = vec![lane("pr1", &[], "active", 1)];
    let mut rep = in_lane("pr_reviewer", Some("APPROVED WITH CHANGES"), "pr1");
    rep.findings = vec![finding("MEDIUM", "null token")];
    rep.findings_known = true;
    let d = decide(&eagle1(), &mut r, &rep);
    assert_eq!((d.action.as_str(), d.lane.as_deref()), ("stop", Some("pr1")));
    assert!(
        d.reason.ends_with("Send it back, or mark it approved in the chain overview's Pull requests list."),
        "{}",
        d.reason
    );
    assert_eq!(r.lane("pr1").unwrap().status, "active", "not approved by the stop");
}

#[test]
fn a_turn_in_an_approved_lane_changes_nothing() {
    let mut r = run(1);
    r.lanes = vec![lane("pr1", &[], "approved", 1), lane("pr2", &[], "active", 1)];
    let mut rep = in_lane("pr_reviewer", Some("REQUEST CHANGES"), "pr1");
    rep.findings = vec![finding("HIGH", "late finding")];
    rep.findings_known = true;
    let d = decide(&eagle1(), &mut r, &rep);
    assert_eq!((d.action.as_str(), d.lane.as_deref()), ("ignore", Some("pr1")));
    assert_eq!(d.reason, "That pull request is already approved.");
    assert!(r.events.is_empty(), "nothing logged");
    assert!(r.autopilot.as_ref().unwrap().waiting.is_none(), "not waiting");
    assert_eq!(r.lane("pr1").unwrap().status, "approved");
}

/// A PR Reviewer turn asking for changes with one MEDIUM finding.
fn changes_asked() -> TurnReport {
    let mut rep = report("pr_reviewer", Some("REQUEST CHANGES"));
    rep.findings = vec![finding("MEDIUM", "null token")];
    rep.findings_known = true;
    rep
}

#[test]
fn with_no_round_cap_rounds_go_back_until_the_reviewer_approves() {
    // Five PR Reviewer send-backs already: built-ins have no cap, so the
    // sixth round goes back too.
    let mut r = run(6);
    r.verdicts = sent_back(&["role_pr_reviewer"; 5]);
    let d = decide(&eagle1(), &mut r, &changes_asked());
    assert_eq!((d.action.as_str(), d.stage_id.as_deref()), ("loopBack", Some("implementer")), "{}", d.reason);
    assert!(d.reason.contains("round 6"), "{}", d.reason);
    // Approved, or only LOW findings left: the run completes.
    let mut r = run(7);
    r.verdicts = sent_back(&["role_pr_reviewer"; 6]);
    let d = decide(&eagle1(), &mut r, &report("pr_reviewer", Some("APPROVED")));
    assert_eq!(d.action, "complete");
    let mut r = run(7);
    r.verdicts = sent_back(&["role_pr_reviewer"; 6]);
    let mut low = changes_asked();
    low.findings = vec![finding("LOW", "typo")];
    let d = decide(&eagle1(), &mut r, &low);
    assert_eq!(d.action, "complete");
    assert_eq!(d.follow_ups, vec!["[LOW] typo"]);
}

#[test]
fn a_set_round_cap_still_stops_and_never_starts_the_next_round() {
    let def = eagle1_capped(3);
    let mut r = run(3);
    r.verdicts = sent_back(&["role_pr_reviewer"; 2]);
    let d = decide(&def, &mut r, &changes_asked());
    assert_eq!(d.action, "stop");
    assert!(d.reason.starts_with("Round cap reached (3 of 3)"), "{}", d.reason);
    assert!(r.claims.is_empty(), "no send-back was claimed");
    // You sent round 3 back yourself anyway: round 4's verdict stops again.
    let mut r = run(4);
    r.verdicts = sent_back(&["role_pr_reviewer"; 3]);
    let d = decide(&def, &mut r, &changes_asked());
    assert_eq!(d.action, "stop");
    assert!(d.reason.contains("4 of 3"), "{}", d.reason);
}

#[test]
fn a_hand_off_you_made_is_not_made_again_by_autopilot() {
    // 08:42:41 you sent the Implementer's round-5 turn to the PR Reviewer;
    // 08:42:44 autopilot's checks for that turn finished.
    let mut r = run(5);
    r.autopilot.as_mut().unwrap().passed_checkpoints.push("implementer".into());
    r.add_claim(claim_key("advance", "implementer", 5, None), Some("impl|s|t5".into()), "you");
    let mut rep = report("implementer", None);
    rep.turn = Some("impl|s|t5".into());
    rep.round = Some(5);
    let d = decide(&eagle1(), &mut r, &rep);
    assert_eq!(d.action, "skip", "{}", d.reason);
    assert_eq!(d.reason, "Implementer finished: already handed on by you.");
    let logged = r.events.last().unwrap();
    assert_eq!((logged.kind.as_str(), logged.outcome.as_deref()), ("autopilot", Some("skip")));
    assert_eq!(r.claims.len(), 1, "no second claim");
    // Matched by stage and round alone too (a chat source has no turn).
    let mut r2 = run(5);
    r2.add_claim(claim_key("advance", "implementer", 5, None), None, "you");
    assert_eq!(decide(&eagle1(), &mut r2, &report("implementer", None)).action, "skip");
}

#[test]
fn autopilot_hands_a_stage_on_once_per_round() {
    // The Planner's turn went to the Plan Reviewer; a later turn of the same
    // round (a background task reporting in) does not open a second one.
    let mut r = run(1);
    let mut first = report("planner", None);
    first.turn = Some("planner|s|t1".into());
    let d = decide(&eagle1(), &mut r, &first);
    assert_eq!(d.action, "advance");
    assert_eq!(d.claim.as_deref(), Some("advance:planner#1"));
    assert_eq!(r.claims[0].by, "autopilot");
    let mut second = report("planner", None);
    second.turn = Some("planner|s|t2".into());
    let d = decide(&eagle1(), &mut r, &second);
    assert_eq!(d.action, "skip");
    assert_eq!(d.reason, "Planner finished: already handed on by autopilot.");
    // A round sent back starts a fresh claim.
    let mut r = run(2);
    r.add_claim("advance:planner#1".into(), None, "autopilot");
    assert_eq!(decide(&eagle1(), &mut r, &report("planner", None)).action, "advance");
}

#[test]
fn a_send_back_is_claimed_once() {
    let mut r = run(1);
    let mut rep = changes_asked();
    rep.turn = Some("rev|s|t1".into());
    let d = decide(&eagle1(), &mut r, &rep);
    assert_eq!(d.action, "loopBack");
    assert_eq!(d.claim.as_deref(), Some("back:pr_reviewer#1"));
    // You already sent this round back: autopilot does not send it again.
    let mut r = run(1);
    r.add_claim("back:pr_reviewer#1".into(), None, "you");
    let d = decide(&eagle1(), &mut r, &changes_asked());
    assert_eq!((d.action.as_str(), d.reason.as_str()), ("skip", "PR Reviewer finished: already sent back by you."));
}

#[test]
fn a_turn_is_decided_once() {
    let mut r = run(1);
    let mut rep = report("planner", None);
    rep.turn = Some("planner|s|t1".into());
    assert_eq!(decide(&eagle1(), &mut r, &rep).action, "advance");
    let events = r.events.len();
    let d = decide(&eagle1(), &mut r, &rep);
    assert_eq!(d.action, "ignore");
    assert_eq!(r.events.len(), events, "nothing logged");
}

#[test]
fn a_turn_from_a_round_that_ended_is_skipped() {
    // 08:40:16 the Implementer's round-4 turn was read; its checks ran until
    // 08:40:44, after round 5 was sent in at 08:40:22. Its missing sections
    // must not be asked for in the middle of round 5's turn.
    let mut r = run(5);
    let mut rep = report("implementer", None);
    rep.round = Some(4);
    rep.missing_sections = vec!["Pull requests".into()];
    let d = decide(&eagle1(), &mut r, &rep);
    assert_eq!(d.action, "skip");
    assert_eq!(d.reason, "Skipped Implementer's turn from round 4: the run is on round 5 now.");
    assert!(r.autopilot.as_ref().unwrap().reasked.is_empty(), "no re-ask");
    assert!(r.claims.is_empty());
    // A turn of the current round is decided as usual.
    rep.round = Some(5);
    assert_eq!(decide(&eagle1(), &mut r, &rep).action, "reask");
}

fn failed_gate(round: u32) -> StageGates {
    StageGates {
        round,
        at: "now".into(),
        results: vec![GateResult {
            kind: "command".into(),
            label: "npm run check".into(),
            status: "failed".into(),
            summary: "Failed (exit code 1).".into(),
            output: "1 test failed".into(),
            duration_ms: 10,
        }],
    }
}

#[test]
fn a_stop_puts_the_run_in_waiting_with_its_reason_code() {
    let mut r = run(1);
    decide(&eagle1(), &mut r, &report("plan_reviewer", Some("APPROVED")));
    assert_eq!((r.status, r.stop_reason), (RunStatus::Waiting, Some(StopReason::Checkpoint)));
    assert!(r.autopilot.as_ref().unwrap().waiting.is_some(), "the sentence is kept for the overview");
}

#[test]
fn every_stop_in_decide_carries_its_reason_code() {
    let stopped = |def: &crate::pipelines::PipelineDef, mut r: PipelineRun, rep: TurnReport| {
        let d = decide(def, &mut r, &rep);
        assert_eq!(d.action, "stop", "{}", d.reason);
        assert_eq!(r.status, RunStatus::Waiting, "{}", d.reason);
        r.stop_reason
    };
    let mut capped = run(3);
    capped.verdicts = sent_back(&["role_pr_reviewer"; 2]);
    assert_eq!(stopped(&eagle1_capped(3), capped, changes_asked()), Some(StopReason::RoundCap));
    let mut busy = report("planner", None);
    busy.usage_percent = Some(95);
    assert_eq!(stopped(&eagle1(), run(1), busy), Some(StopReason::UsageLimit));
    assert_eq!(stopped(&eagle1(), run(1), report("pr_reviewer", None)), Some(StopReason::NoVerdict));
    let mut missing = report("plan_reviewer", Some("APPROVED"));
    missing.missing_sections = vec!["Reviewed plan".into()];
    let mut reasked = run(1);
    reasked.autopilot.as_mut().unwrap().reasked.push("plan_reviewer#1".into());
    assert_eq!(stopped(&eagle1(), reasked, missing), Some(StopReason::NoResult));
    let mut failing = run(1);
    failing.gates.insert("implementer".into(), failed_gate(1));
    failing.autopilot.as_mut().unwrap().gate_retries.insert("implementer".into(), MAX_GATE_RETRIES);
    assert_eq!(stopped(&eagle1(), failing, report("implementer", None)), Some(StopReason::GateFailed));
    let mut approved = report("pr_reviewer", Some("APPROVED"));
    approved.findings = vec![finding("HIGH", "token leaks to log")];
    approved.findings_known = true;
    assert_eq!(stopped(&eagle1(), run(1), approved), Some(StopReason::BlockingFindings));
    let mut chat = report("planner", None);
    chat.chat = true;
    assert_eq!(stopped(&eagle1(), run(1), chat), Some(StopReason::CarryOutFailed));
    assert_eq!(stopped(&eagle1(), run(1), report("nowhere", None)), Some(StopReason::CarryOutFailed));
}

#[test]
fn decide_acts_only_while_running() {
    let mut r = run(1);
    r.set_waiting(StopReason::Checkpoint, "Checkpoint before Implementer");
    let mut rep = report("planner", None);
    rep.turn = Some("planner|s|t1".into());
    let d = decide(&eagle1(), &mut r, &rep);
    assert_eq!(d.action, "skip", "{}", d.reason);
    assert!(d.reason.contains("waiting for you"), "{}", d.reason);
    assert!(r.claims.is_empty(), "nothing handed on");
    assert_eq!((r.status, r.stop_reason), (RunStatus::Waiting, Some(StopReason::Checkpoint)));
    // You acted (a hand-off, say): the next turn is decided again.
    r.resume_after_you();
    assert_eq!(r.status, RunStatus::Running);
    let mut next = report("planner", None);
    next.turn = Some("planner|s|t2".into());
    assert_eq!(decide(&eagle1(), &mut r, &next).action, "advance");
}

#[test]
fn complete_is_final_and_late_turns_after_it_are_ignored() {
    let mut r = run(1);
    let d = decide(&eagle1(), &mut r, &report("pr_reviewer", Some("APPROVED")));
    assert_eq!(d.action, "complete");
    assert_eq!((r.status, r.stop_reason), (RunStatus::Complete, None));
    let events = r.events.len();
    // A late turn (a background task reporting in) changes nothing.
    let mut late = changes_asked();
    late.turn = Some("rev|s|late".into());
    let d = decide(&eagle1(), &mut r, &late);
    assert_eq!(d.action, "ignore", "{}", d.reason);
    assert_eq!(r.events.len(), events, "nothing logged");
    assert!(r.claims.is_empty(), "no send-back claimed");
    assert_eq!(r.status, RunStatus::Complete);
    // Nothing reopens it: not a stop, not you turning autopilot off and on.
    r.set_waiting(StopReason::CarryOutFailed, "x");
    r.set_autopilot_enabled(false);
    r.set_autopilot_enabled(true);
    r.resume_after_you();
    assert_eq!(r.status, RunStatus::Complete);
    // The last lane approved completes a fanned-out run the same way.
    let mut r = run(1);
    r.lanes = vec![lane("pr1", &[], "active", 1)];
    decide(&eagle1(), &mut r, &in_lane("pr_reviewer", Some("APPROVED"), "pr1"));
    assert_eq!(r.status, RunStatus::Complete);
}

#[test]
fn a_passing_gate_resets_the_stage_retries() {
    let mut r = run(1);
    r.gates.insert("implementer".into(), failed_gate(1));
    let rep = report("implementer", None);
    assert_eq!(decide(&eagle1(), &mut r, &rep).action, "retry");
    assert_eq!(decide(&eagle1(), &mut r, &rep).action, "retry");
    // The fix worked: the check passes and the stage hands on.
    r.gates.get_mut("implementer").unwrap().results[0].status = "passed".into();
    r.autopilot.as_mut().unwrap().passed_checkpoints.push("implementer".into());
    assert_eq!(decide(&eagle1(), &mut r, &rep).action, "advance");
    assert!(!r.autopilot.as_ref().unwrap().gate_retries.contains_key("implementer"));
    // A later failure in the same round starts counting again.
    r.gates.insert("implementer".into(), failed_gate(1));
    let d = decide(&eagle1(), &mut r, &rep);
    assert_eq!(d.action, "retry", "{}", d.reason);
}
