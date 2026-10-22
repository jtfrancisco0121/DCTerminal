//! F1: artifact stages in a pipeline, and `decide` for their results:
//! complete goes on, partial waits for your answer, blocked waits with its
//! reason; the wait ends like the other waits for your answer.

use super::*;
use crate::pipelines::autopilot::{decide, TurnReport};
use crate::pipelines::{check_pipeline_for_test, PipelineDef};
use crate::store::{HeldTurn, RunStatus, StopReason};
use serde_json::json;

/// A pipeline with an artifact stage first: Analyst → Planner → Implementer.
fn docs_first() -> PipelineDef {
    serde_json::from_value(json!({
        "id": "docs_first", "name": "Docs first",
        "stages": [
            { "id": "analyst", "roleId": "role_general", "title": "Analyst", "kind": "artifact" },
            { "id": "planner", "roleId": "role_planner", "title": "Planner" },
            { "id": "implementer", "roleId": "role_implementer", "title": "Implementer" }
        ]
    }))
    .unwrap()
}

fn run() -> PipelineRun {
    serde_json::from_value(json!({
        "id": "ee_f", "kind": "docs_first", "cwd": "/repo", "stage": "analyst", "tabIds": {},
        "createdAt": "2026-10-22T00:00:00Z", "chainId": "ee_f", "status": "running", "engine": 2,
        "autopilot": { "enabled": true }
    }))
    .unwrap()
}

fn artifact_turn(status: &str, turn: &str) -> TurnReport {
    let result = match status {
        "partial" => json!({ "status": "partial", "artifacts": ["brief.md"], "openQuestions": ["Is offline in scope?", "Who signs off?"], "summary": "s" }),
        "blocked" => json!({ "status": "blocked", "artifacts": [], "reason": "The repo is not readable.", "summary": "s" }),
        _ => json!({ "status": "complete", "artifacts": ["brief.md"], "openQuestions": [], "summary": "s" }),
    };
    TurnReport {
        stage_id: "analyst".into(),
        turn: Some(turn.into()),
        artifact: report_of(&result),
        findings_known: true,
        ..TurnReport::default()
    }
}

#[test]
fn an_artifact_stage_goes_before_the_implementer_with_no_gates_and_no_loop_back() {
    assert_eq!(check_pipeline_for_test(&docs_first()), Ok(()));
    let mut late = docs_first();
    late.stages.swap(0, 2);
    assert!(check_pipeline_for_test(&late).unwrap_err().contains("after the implementer"));
    let mut gated = docs_first();
    gated.stages[0].gates = vec![crate::pipelines::GateDef::PullRequest];
    assert!(check_pipeline_for_test(&gated).unwrap_err().contains("runs no gates"));
    let mut looping = docs_first();
    looping.stages[0].loop_back = Some(serde_json::from_value(json!({ "to": "planner" })).unwrap());
    assert!(check_pipeline_for_test(&looping).unwrap_err().contains("kind is reviewer"));
    let mut back_to_docs: PipelineDef = docs_first();
    back_to_docs.stages.insert(
        1,
        serde_json::from_value(json!({ "id": "brief_check", "roleId": "role_plan_reviewer", "title": "Brief check", "loopBack": { "to": "analyst" } }))
            .unwrap(),
    );
    assert!(check_pipeline_for_test(&back_to_docs).unwrap_err().contains("an artifact stage"));
}

#[test]
fn complete_goes_on_to_the_next_stage() {
    let mut r = run();
    let d = decide(&docs_first(), &mut r, &artifact_turn("complete", "t-1"));
    assert_eq!((d.action.as_str(), d.stage_id.as_deref()), ("advance", Some("planner")));
    assert_eq!(r.status, RunStatus::Running);
    assert!(r.autopilot.as_ref().unwrap().artifact_wait.is_none());
}

#[test]
fn partial_waits_with_the_questions_and_after_your_answer_complete_goes_on() {
    let def = docs_first();
    let mut r = run();
    let d = decide(&def, &mut r, &artifact_turn("partial", "t-1"));
    assert_eq!((d.action.as_str(), d.stop_reason), ("stop", Some(StopReason::Checkpoint)));
    assert!(d.reason.contains("Is offline in scope?"), "{}", d.reason);
    assert_eq!((r.status, r.stop_reason), (RunStatus::Waiting, Some(StopReason::Checkpoint)));
    let wait = r.autopilot.as_ref().unwrap().artifact_wait.clone().expect("the wait");
    assert_eq!((wait.stage_id.as_str(), wait.status.as_str(), wait.turn.as_deref()), ("analyst", "partial", Some("t-1")));
    assert_eq!(wait.questions.len(), 2);
    assert_eq!(wait.artifacts, ["brief.md"]);
    // Your answer: checked, then the message the session is resumed with.
    assert!(checked_answer(&wait, Some("  ")).unwrap_err().contains("Write your answers"));
    assert!(checked_answer(&wait, Some(&"x".repeat(MAX_ANSWER_CHARS + 1))).is_err());
    let answer = checked_answer(&wait, Some(" Offline is out. JT signs off. ")).unwrap();
    let message = answer_message(&wait, &answer);
    assert!(message.contains("1. Is offline in scope?") && message.contains("Offline is out. JT signs off."), "{message}");
    assert!(message.contains("brief.md") && message.contains("submit_result"), "{message}");
    // The actor's answer runs the run again, which ends the wait.
    r.set_running();
    assert!(r.autopilot.as_ref().unwrap().artifact_wait.is_none());
    let d = decide(&def, &mut r, &artifact_turn("complete", "t-2"));
    assert_eq!((d.action.as_str(), d.stage_id.as_deref()), ("advance", Some("planner")));
}

#[test]
fn blocked_waits_with_its_reason_and_continue_needs_no_note() {
    let mut r = run();
    let d = decide(&docs_first(), &mut r, &artifact_turn("blocked", "t-1"));
    assert_eq!(d.stop_reason, Some(StopReason::Checkpoint));
    assert!(d.reason.contains("The repo is not readable") && d.reason.contains("Continue"), "{}", d.reason);
    let wait = r.autopilot.as_ref().unwrap().artifact_wait.clone().unwrap();
    assert_eq!((wait.status.as_str(), wait.reason.as_deref()), ("blocked", Some("The repo is not readable.")));
    assert_eq!(checked_answer(&wait, None).unwrap(), "");
    let message = answer_message(&wait, "");
    assert!(message.contains("You reported that you were blocked") && message.contains("carry on"), "{message}");
    assert!(answer_message(&wait, "Try the mirror.").contains("Try the mirror."));
}

#[test]
fn an_artifact_result_on_another_kind_of_stage_is_not_a_wait() {
    let mut r = run();
    let mut report = artifact_turn("partial", "t-1");
    report.stage_id = "implementer".into();
    let d = decide(&docs_first(), &mut r, &report);
    assert!(r.autopilot.as_ref().unwrap().artifact_wait.is_none(), "{d:?}");
}

/// The wait survives an autopilot toggle, as a checkpoint story's does, and
/// any other end (your hand-on, another stop, completion) clears it.
#[test]
fn the_wait_survives_a_toggle_and_ends_like_the_other_waits() {
    let def = docs_first();
    let waiting = || {
        let mut r = run();
        decide(&def, &mut r, &artifact_turn("partial", "t-1"));
        r
    };
    let mut r = waiting();
    r.set_autopilot_enabled(false);
    assert_eq!((r.status, r.stop_reason), (RunStatus::Stopped, Some(StopReason::PausedByYou)));
    assert!(r.autopilot.as_ref().unwrap().artifact_wait.is_some(), "kept while off");
    r.set_autopilot_enabled(true);
    assert_eq!((r.status, r.stop_reason), (RunStatus::Waiting, Some(StopReason::Checkpoint)), "waits again");
    let mut r = waiting();
    r.resume_after_you();
    assert!(r.autopilot.as_ref().unwrap().artifact_wait.is_none(), "your hand-on ends it");
    let mut r = waiting();
    r.set_waiting(StopReason::Stalled, "It stalled.");
    assert!(r.autopilot.as_ref().unwrap().artifact_wait.is_none(), "another stop ends it");
    let mut r = waiting();
    r.set_stopped(StopReason::CarryOutFailed);
    assert!(r.autopilot.as_ref().unwrap().artifact_wait.is_none());
    let mut r = waiting();
    r.set_complete();
    assert!(r.autopilot.as_ref().unwrap().artifact_wait.is_none());
}

/// Held turns behave as for a verify or story wait: an end with no answer
/// hands them to you with a line naming the document's questions.
#[test]
fn turns_held_during_the_wait_are_yours_when_it_ends_without_an_answer() {
    let mut r = run();
    decide(&docs_first(), &mut r, &artifact_turn("partial", "t-1"));
    r.hold_turn(HeldTurn {
        turn: "tab_b|bridge|b1".into(),
        tab_id: "tab_b".into(),
        stage_id: "planner".into(),
        stage_title: "Planner".into(),
        lane: None,
        for_story: false,
        for_document: true,
    });
    // Toggling autopilot keeps them with the wait.
    r.set_autopilot_enabled(false);
    r.set_autopilot_enabled(true);
    assert_eq!(r.autopilot.as_ref().unwrap().held.len(), 1);
    r.resume_after_you();
    assert!(r.autopilot.as_ref().unwrap().held.is_empty());
    let line = r.events.last().unwrap();
    assert!(line.summary.contains("your answer to a document's questions") && line.summary.contains("ended without your answer"), "{}", line.summary);
    // A new partial while turns are held keeps them for the new wait.
    let mut r = run();
    r.hold_turn(HeldTurn { turn: "x".into(), tab_id: "t".into(), stage_id: "planner".into(), stage_title: "Planner".into(), ..HeldTurn::default() });
    decide(&docs_first(), &mut r, &artifact_turn("partial", "t-2"));
    assert_eq!(r.autopilot.as_ref().unwrap().held.len(), 1, "kept for this wait");
}

#[test]
fn the_documents_reported_are_the_runs_hand_off_files_in_stage_order() {
    let dir = crate::test_support::TempDir::new("artifacts_run_documents");
    std::fs::write(dir.join("brief.md"), "b").unwrap();
    std::fs::write(dir.join("notes.md"), "n").unwrap();
    assert!(run_documents(dir.path(), &docs_first()).is_empty(), "no artifacts.json yet");
    let file = json!({
        "schema": 1, "runId": "ee_f",
        "stages": [
            { "stageKey": "planner", "stageId": "planner", "roleId": "r", "turn": "t", "at": "a", "status": "partial", "artifacts": ["notes.md"] },
            { "stageKey": "analyst", "stageId": "analyst", "roleId": "r", "turn": "t", "at": "a", "status": "complete", "artifacts": ["brief.md", "gone.md"] }
        ]
    });
    std::fs::write(dir.join("artifacts.json"), file.to_string()).unwrap();
    let docs = run_documents(dir.path(), &docs_first());
    assert_eq!(docs.len(), 2, "a document deleted since is left out: {docs:?}");
    assert_eq!(docs[0].0, "Analyst document");
    assert!(docs[0].1.ends_with("brief.md"));
    assert_eq!(docs[1].0, "Planner document (partial, not complete)");
}
