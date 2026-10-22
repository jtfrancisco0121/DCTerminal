//! L2: `decide` for a verify gate waiting, passed and failed, and
//! [`answer`]'s checks and records.

use super::*;
use crate::pipelines::autopilot::{decide, TurnReport, MAX_GATE_RETRIES};
use crate::pipelines::lane_gates::waiting_verify;
use crate::pipelines::{find, GateResult, PipelineDef};
use crate::store::{RunStatus, StageGates, StopReason};
use serde_json::json;

const STEPS: &str = "Run the qa128-ml Playwright project on the Windows staging build.";

fn eagle1() -> PipelineDef {
    find("eagle1").expect("Eagle-Eye 1")
}

/// An Eagle-Eye 1 run at its Implementer with autopilot on; with `lanes`,
/// fanned out into `pr1` (in the `backend` repo) and `pr2`.
fn run(lanes: bool) -> PipelineRun {
    let mut value = json!({
        "id": "ee_v", "kind": "full", "cwd": "/repo", "stage": "implementer", "tabIds": {},
        "createdAt": "2026-10-22T00:00:00Z", "chainId": "ee_v", "status": "running", "engine": 2,
        "autopilot": { "enabled": true, "passedCheckpoints": ["implementer"] }
    });
    if lanes {
        value["fanOutStage"] = json!("implementer");
        value["lanes"] = json!([
            { "id": "pr1", "title": "PR1 — API", "status": "active", "stage": "implementer", "round": 1, "tabIds": {}, "repo": "backend" },
            { "id": "pr2", "title": "PR2 — Client", "status": "waiting", "stage": "implementer", "round": 1, "tabIds": {}, "dependsOn": ["pr1"] }
        ]);
    }
    serde_json::from_value(value).expect("a run")
}

fn passed(label: &str) -> GateResult {
    GateResult {
        kind: "command".into(),
        label: label.into(),
        status: "passed".into(),
        summary: "Passed.".into(),
        output: String::new(),
        duration_ms: 5,
        optional: false,
    }
}

/// The Implementer's gates as the actor records them: its check passed and
/// a verify gate waits.
fn gates_waiting(run: &mut PipelineRun, lane: Option<&str>, label: &str) {
    run.gates.insert(
        stage_key("implementer", lane),
        StageGates {
            round: 1,
            at: "now".into(),
            results: vec![passed("backend check: go test ./..."), waiting_verify(label.into(), STEPS)],
        },
    );
}

fn report(lane: Option<&str>, turn: &str) -> TurnReport {
    TurnReport {
        stage_id: "implementer".into(),
        lane: lane.map(str::to_string),
        round: Some(1),
        turn: Some(turn.into()),
        findings_known: true,
        ..TurnReport::default()
    }
}

#[test]
fn a_waiting_verify_gate_stops_with_checkpoint_and_records_the_wait() {
    let mut r = run(true);
    gates_waiting(&mut r, Some("pr1"), "backend verify");
    r.autopilot.as_mut().unwrap().gate_retries.insert("implementer@pr1".into(), 1);
    let d = decide(&eagle1(), &mut r, &report(Some("pr1"), "tab|bridge|t1"));
    assert_eq!((d.action.as_str(), d.stop_reason), ("stop", Some(StopReason::Checkpoint)));
    assert_eq!(d.lane.as_deref(), Some("pr1"));
    assert!(d.reason.starts_with("PR1 — API: Implementer passed its checks, and backend verify waits for you"), "{}", d.reason);
    assert_eq!((r.status, r.stop_reason), (RunStatus::Waiting, Some(StopReason::Checkpoint)));
    let wait = r.autopilot.as_ref().unwrap().verify.clone().expect("the wait");
    assert_eq!(
        (wait.stage_id.as_str(), wait.lane.as_deref(), wait.label.as_str(), wait.steps.as_str(), wait.turn.as_deref()),
        ("implementer", Some("pr1"), "backend verify", STEPS, Some("tab|bridge|t1"))
    );
    assert_eq!(r.autopilot.as_ref().unwrap().gate_retries.get("implementer@pr1"), Some(&1), "retries are kept while it waits");
    assert_eq!(r.events.last().unwrap().outcome.as_deref(), Some("checkpoint"));
}

#[test]
fn mark_verified_passes_the_gate_and_the_lane_moves_on() {
    let mut r = run(true);
    gates_waiting(&mut r, Some("pr1"), "backend verify");
    decide(&eagle1(), &mut r, &report(Some("pr1"), "tab|bridge|t1"));
    let wait = answer(&mut r, "implementer", Some("pr1"), true, None, "2026-10-22T10:00:00Z").expect("answered");
    assert_eq!(wait.turn.as_deref(), Some("tab|bridge|t1"));
    assert_eq!(r.status, RunStatus::Running);
    assert!(r.autopilot.as_ref().unwrap().verify.is_none(), "the wait is cleared");
    let result = &r.gates["implementer@pr1"].results[1];
    assert_eq!((result.status.as_str(), result.output.as_str()), ("passed", ""));
    let record = r.latest_verification(Some("pr1")).expect("a record");
    assert!(record.verified());
    assert_eq!(
        (record.repo.as_deref(), record.round, record.attempt, record.by.as_str(), record.at.as_str(), record.steps.as_str()),
        (Some("backend"), 1, 1, "you", "2026-10-22T10:00:00Z", STEPS)
    );
    let event = r.events.last().unwrap();
    assert_eq!((event.kind.as_str(), event.outcome.as_deref()), ("verify", Some("verified")));
    assert_eq!(event.summary, "PR1 — API: backend verify marked verified by you.");

    // The actor decides the same turn again, under its own key.
    let d = decide(&eagle1(), &mut r, &report(Some("pr1"), "tab|bridge|t1#verify1"));
    assert_eq!((d.action.as_str(), d.stage_id.as_deref()), ("advance", Some("pr_reviewer")), "{}", d.reason);
    assert!(!r.autopilot.as_ref().unwrap().gate_retries.contains_key("implementer@pr1"), "a full pass resets the retries");
    // Saved and read back, the record stays (C3 reads it).
    let back: PipelineRun = serde_json::from_value(serde_json::to_value(&r).unwrap()).unwrap();
    assert_eq!(back.verifications, r.verifications);
    assert_eq!(serde_json::to_value(&r).unwrap()["verifications"][0]["result"], "verified");
}

#[test]
fn failed_with_a_note_goes_back_to_the_stage_and_counts_toward_its_retries() {
    let mut r = run(false);
    let mut turn = 0;
    let mut next = |r: &mut PipelineRun| {
        turn += 1;
        decide(&eagle1(), r, &report(None, &format!("tab|bridge|t{turn}")))
    };
    for attempt in 1..=MAX_GATE_RETRIES {
        gates_waiting(&mut r, None, "verify");
        assert_eq!(next(&mut r).stop_reason, Some(StopReason::Checkpoint));
        answer(&mut r, "implementer", None, false, Some(" The login page shows a blank screen. "), "now").unwrap();
        let d = next(&mut r);
        assert_eq!((d.action.as_str(), d.stage_id.as_deref()), ("retry", Some("implementer")), "{}", d.reason);
        assert_eq!(d.reason, "verify failed: your note went back to Implementer.");
        let message = d.message.unwrap();
        assert!(message.starts_with("Verification failed after your last turn."), "{message}");
        assert!(message.contains(STEPS) && message.contains("What failed:\n\nThe login page shows a blank screen."), "{message}");
        assert_eq!(r.autopilot.as_ref().unwrap().gate_retries["implementer"], attempt);
        let record = r.latest_verification(None).unwrap();
        assert_eq!((record.result.as_str(), record.note.as_deref(), record.attempt), ("failed", Some("The login page shows a blank screen."), attempt));
    }
    // One failure too many: the run stops with gate_failed, as a check that keeps failing does.
    gates_waiting(&mut r, None, "verify");
    next(&mut r);
    answer(&mut r, "implementer", None, false, Some("Still blank."), "now").unwrap();
    let d = next(&mut r);
    assert_eq!((d.action.as_str(), d.stop_reason), ("stop", Some(StopReason::GateFailed)));
    assert!(d.reason.contains("verify gate failed 3 times in a row") && d.reason.ends_with("Your last note: Still blank."), "{}", d.reason);
    assert_eq!(r.verifications.len(), 3);
    assert!(r.verifications.iter().all(|v| v.lane.is_none() && v.round == 1));
}

#[test]
fn an_answer_is_refused_unless_the_run_waits_on_that_gate_and_a_failure_has_a_note() {
    let mut r = run(true);
    gates_waiting(&mut r, Some("pr1"), "backend verify");
    // Not waiting yet.
    assert!(answer(&mut r, "implementer", Some("pr1"), true, None, "now").unwrap_err().contains("not waiting"));
    decide(&eagle1(), &mut r, &report(Some("pr1"), "tab|bridge|t1"));
    let before = r.clone();
    assert!(answer(&mut r, "implementer", Some("pr2"), true, None, "now").unwrap_err().contains("not waiting"));
    assert!(answer(&mut r, "pr_reviewer", Some("pr1"), true, None, "now").unwrap_err().contains("not waiting"));
    assert!(answer(&mut r, "implementer", Some("pr1"), false, Some("  "), "now").unwrap_err().contains("Say what failed"));
    let long = "x".repeat(MAX_VERIFY_NOTE_CHARS + 1);
    assert!(answer(&mut r, "implementer", Some("pr1"), false, Some(&long), "now").unwrap_err().contains("longer than"));
    assert_eq!(r, before, "a refused answer changes nothing");
    // A note on a pass is kept.
    answer(&mut r, "implementer", Some("pr1"), true, Some("Passed on build 1.2.8-rc3."), "now").unwrap();
    assert_eq!(r.latest_verification(Some("pr1")).unwrap().note.as_deref(), Some("Passed on build 1.2.8-rc3."));
    assert!(r.latest_verification(None).is_none(), "per lane");
    // Answered once: a second answer is refused.
    assert!(answer(&mut r, "implementer", Some("pr1"), true, None, "now").is_err());
}

#[test]
fn any_other_stop_or_turning_autopilot_off_clears_the_wait() {
    let mut r = run(false);
    gates_waiting(&mut r, None, "verify");
    decide(&eagle1(), &mut r, &report(None, "tab|bridge|t1"));
    assert!(r.autopilot.as_ref().unwrap().verify.is_some());
    r.set_waiting(StopReason::Stalled, "It stalled.");
    assert!(r.autopilot.as_ref().unwrap().verify.is_none());
    decide(&eagle1(), &mut r, &report(None, "tab|bridge|t2"));
    r.set_running();
    gates_waiting(&mut r, None, "verify");
    decide(&eagle1(), &mut r, &report(None, "tab|bridge|t3"));
    r.set_autopilot_enabled(false);
    assert!(r.autopilot.as_ref().unwrap().verify.is_none());
    assert!(answer(&mut r, "implementer", None, true, None, "now").is_err());
}

/// Review fix: Run checks by hand during a verify wait keeps the wait
/// answerable when every check passed, and ends it the normal way when one
/// failed.
#[test]
fn run_checks_by_hand_keeps_a_waiting_verify_or_ends_the_wait_on_a_failure() {
    let mut r = run(true);
    gates_waiting(&mut r, Some("pr1"), "backend verify");
    decide(&eagle1(), &mut r, &report(Some("pr1"), "tab|bridge|t1"));
    let kept = manual_results(&mut r, "implementer", Some("pr1"), 1, vec![passed("backend check: go test ./...")]);
    assert_eq!(kept.len(), 2);
    assert!(kept[1].waiting_verify() && kept[1].label == "backend verify");
    assert!(r.autopilot.as_ref().unwrap().verify.is_some(), "still waiting on you");
    r.gates.get_mut("implementer@pr1").unwrap().results = kept;
    answer(&mut r, "implementer", Some("pr1"), true, None, "now").expect("answerable after Run checks");

    // A failed check by hand: the wait ends, the run waits for you with the failure.
    let mut r = run(true);
    gates_waiting(&mut r, Some("pr1"), "backend verify");
    decide(&eagle1(), &mut r, &report(Some("pr1"), "tab|bridge|t1"));
    let mut failed = passed("backend check: go test ./...");
    failed.status = "failed".into();
    let kept = manual_results(&mut r, "implementer", Some("pr1"), 1, vec![failed]);
    assert_eq!(kept.len(), 1, "no waiting verify is kept beside a failure");
    assert!(r.autopilot.as_ref().unwrap().verify.is_none());
    assert_eq!((r.status, r.stop_reason), (RunStatus::Waiting, Some(StopReason::Checkpoint)));
    let why = r.autopilot.as_ref().unwrap().waiting.clone().unwrap();
    assert!(why.contains("the backend check: go test ./... check failed when you ran the checks"), "{why}");
    assert!(answer(&mut r, "implementer", Some("pr1"), true, None, "now").is_err());
    // Another stage's checks, or a run waiting on nothing, are left alone.
    let mut idle = run(true);
    let kept = manual_results(&mut idle, "implementer", Some("pr2"), 1, vec![passed("npm run check")]);
    assert_eq!(kept.len(), 1);
    assert_eq!(idle.status, RunStatus::Running);
}

/// Review fix: a wait whose waiting result is gone (an older build's Run
/// checks overwrote it) is rebuilt from the wait when you answer.
#[test]
fn an_answer_rebuilds_a_waiting_result_that_is_gone() {
    let mut r = run(true);
    gates_waiting(&mut r, Some("pr1"), "backend verify");
    decide(&eagle1(), &mut r, &report(Some("pr1"), "tab|bridge|t1"));
    r.gates.get_mut("implementer@pr1").unwrap().results = vec![passed("backend check: go test ./...")];
    answer(&mut r, "implementer", Some("pr1"), false, Some("Blank page."), "now").unwrap();
    let results = &r.gates["implementer@pr1"].results;
    assert_eq!(results.len(), 2);
    assert_eq!((results[1].kind.as_str(), results[1].label.as_str(), results[1].status.as_str()), ("verify", "backend verify", "failed"));
    assert_eq!((results[1].summary.as_str(), results[1].output.as_str()), (STEPS, "Blank page."));
    // And with no gate results at all.
    let mut r = run(false);
    gates_waiting(&mut r, None, "verify");
    decide(&eagle1(), &mut r, &report(None, "tab|bridge|t1"));
    r.gates.clear();
    answer(&mut r, "implementer", None, true, None, "now").unwrap();
    assert_eq!(r.gates["implementer"].results[0].status, "passed");
    assert_eq!(decide(&eagle1(), &mut r, &report(None, "tab|bridge|t1#verify1")).action, "advance");
}

/// Review fix: an answered turn is decided again under `<turn>#verify<n>`,
/// and a wait records the turn's own key even when it was decided under one.
#[test]
fn an_answered_turn_has_its_own_decision_key() {
    let mut r = run(false);
    assert_eq!(r.decision_key("tab|bridge|t1"), "tab|bridge|t1");
    gates_waiting(&mut r, None, "verify");
    decide(&eagle1(), &mut r, &report(None, "tab|bridge|t1"));
    answer(&mut r, "implementer", None, false, Some("No."), "now").unwrap();
    assert_eq!(r.decision_key("tab|bridge|t1"), "tab|bridge|t1#verify1");
    assert_eq!(r.verifications[0].turn.as_deref(), Some("tab|bridge|t1"));
    assert_eq!(r.decision_key("tab|bridge|t2"), "tab|bridge|t2");
    // A second waiting gate on the same turn, decided under its verify key, keeps the plain key.
    r.gates.insert(
        "implementer".into(),
        StageGates { round: 1, at: "now".into(), results: vec![waiting_verify("backend verify".into(), STEPS)] },
    );
    decide(&eagle1(), &mut r, &report(None, "tab|bridge|t1#verify1"));
    assert_eq!(r.autopilot.as_ref().unwrap().verify.as_ref().unwrap().turn.as_deref(), Some("tab|bridge|t1"));
}

/// Review fix: an `auto` gate with nothing to run names go.mod and Settings › Repos.
#[test]
fn nothing_to_run_advice_names_go_mod_and_a_repo_check() {
    let mut r = run(false);
    r.gates.insert(
        "implementer".into(),
        StageGates { round: 1, at: "now".into(), results: vec![GateResult::skipped("command", "auto", "No check command found.")] },
    );
    let d = decide(&eagle1(), &mut r, &report(None, "tab|bridge|t1"));
    assert_eq!(d.stop_reason, Some(StopReason::NoCheckFound));
    assert!(d.reason.contains("a Cargo.toml or a go.mod") && d.reason.contains("a check for its repo"), "{}", d.reason);
    assert!(d.reason.contains("in Settings › Repos"), "{}", d.reason);
}
