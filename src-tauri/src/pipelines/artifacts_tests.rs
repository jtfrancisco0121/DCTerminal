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

// ---- F2: Eagle-Eye L, the document roles, and findings on a document ----

fn eagle_l() -> PipelineDef {
    crate::pipelines::find("eagle-eye-l").expect("Eagle-Eye L is built in")
}

/// Eagle-Eye L validates as a pipeline (a copy of it does, with every seed
/// role checked) and is engine 2: every stage reports through the bridge.
#[test]
fn eagle_eye_l_validates_with_the_seed_roles_and_is_engine_2() {
    let def = eagle_l();
    assert!(def.built_in && def.disabled.is_none());
    let kinds: Vec<StageKind> = def.stages.iter().map(StageDef::kind).collect();
    use StageKind::*;
    assert_eq!(kinds, [Artifact, Artifact, Artifact, Planner, Reviewer, Implementer, Reviewer]);
    assert_eq!(crate::bridge::launch::engine_for(&def), crate::bridge::launch::ENGINE_V2);
    let mut copy = def.clone();
    copy.id = "eagle_l_copy".into();
    copy.built_in = false;
    let roles: std::collections::HashSet<String> =
        crate::store::bundled_seed().unwrap().roles.into_iter().map(|role| role.id).collect();
    assert_eq!(crate::pipelines::validate_user_pipelines_with(&[copy], Some(&roles)), Ok(()));
    // Its roles are artifact stages by their built-in ids too.
    for id in ["role_analyst", "role_pm", "role_architect"] {
        assert_eq!(StageKind::of_builtin_role(id), Some(Artifact), "{id}");
    }
}

/// The three roles are in the seed as our own templates: each writes its
/// file into the run folder, reports through `{{result_instructions}}`,
/// merges with the values the actor fills, and no name says BMad.
#[test]
fn the_document_roles_are_in_the_seed_and_merge_from_their_fields() {
    let seed = crate::store::bundled_seed().unwrap();
    let work = crate::test_support::TempDir::new("document_roles_merge");
    for (id, name, file) in [("role_analyst", "Analyst", "brief.md"), ("role_pm", "PM", "prd.md"), ("role_architect", "Architect", "architecture.md")] {
        let role = seed.roles.iter().find(|r| r.id == id).unwrap_or_else(|| panic!("{id} in the seed"));
        assert_eq!(role.name, name);
        assert!(role.is_built_in);
        assert!(role.template_text.contains("{{result_instructions}}"), "{id}");
        assert!(role.template_text.contains(&format!("`{file}`")), "{id} writes {file}");
        assert!(role.template_text.contains("`partial`") && role.template_text.contains("`blocked`"), "{id}");
        let values: std::collections::HashMap<String, String> = role
            .fields
            .iter()
            .map(|field| (field.key.clone(), format!("value of {}", field.key)))
            .chain([("cwd".to_string(), work.path().display().to_string())])
            .collect();
        let merged = crate::template::merge_role_prompt_with(role, &values, "RESULT HERE");
        assert!(merged.errors.is_empty(), "{id}: {:?}", merged.errors);
        let text = merged.merged.unwrap().text;
        assert!(text.contains("RESULT HERE") && !text.contains("{{"), "{id}:\n{text}");
    }
    for role in &seed.roles {
        for text in [&role.id, &role.name, &role.template_text] {
            assert!(!text.to_ascii_lowercase().contains("bmad"), "{}", role.id);
        }
    }
    let analyst = seed.roles.iter().find(|r| r.id == "role_analyst").unwrap();
    let keys: Vec<&str> = analyst.fields.iter().map(|f| f.key.as_str()).collect();
    assert_eq!(keys, ["title", "request", "expectedBehavior", "additionalContext"], "what the Planner's form is filled from");
}

fn plan_review(findings: Vec<(&str, Option<&str>)>) -> TurnReport {
    TurnReport {
        stage_id: "plan_reviewer".into(),
        verdict: Some("REQUIRES REVISION".into()),
        findings: findings
            .into_iter()
            .map(|(severity, area)| crate::pipelines::autopilot::FindingReport {
                severity: severity.into(),
                summary: "FR3 contradicts the brief.".into(),
                area: area.map(str::to_string),
            })
            .collect(),
        findings_known: true,
        turn: Some("r-1".into()),
        ..TurnReport::default()
    }
}

fn at_plan_review() -> PipelineRun {
    let mut r = run();
    r.kind = "eagle-eye-l".into();
    r.stage = "plan_reviewer".into();
    r
}

/// A blocking plan-review finding on the PRD or the architecture stops at a
/// checkpoint; on the plan it goes back to the Planner as before; below the
/// threshold it is a follow-up. A PR review's document finding still goes
/// back to the Implementer.
#[test]
fn a_plan_review_finding_on_a_document_stops_instead_of_looping_back() {
    let def = eagle_l();
    for area in ["prd", "architecture", "brief"] {
        let mut r = at_plan_review();
        let d = decide(&def, &mut r, &plan_review(vec![("HIGH", Some(area))]));
        assert_eq!((d.action.as_str(), d.stop_reason), ("stop", Some(StopReason::Checkpoint)), "{area}");
        assert!(d.reason.contains(&format!("({area})")) && d.reason.contains("cannot edit"), "{}", d.reason);
        assert!(r.claims.is_empty(), "no round claimed");
    }
    let mut r = at_plan_review();
    let d = decide(&def, &mut r, &plan_review(vec![("HIGH", Some("plan")), ("MEDIUM", None)]));
    assert_eq!((d.action.as_str(), d.stage_id.as_deref()), ("loopBack", Some("planner")));
    let mut r = at_plan_review();
    let d = decide(&def, &mut r, &plan_review(vec![("LOW", Some("prd"))]));
    assert_eq!((d.action.as_str(), d.stage_id.as_deref()), ("stop", Some("implementer")), "below the threshold: on to the checkpoint");
    assert!(d.follow_ups.is_empty() || d.follow_ups[0].contains("FR3"));
    let mut r = at_plan_review();
    r.stage = "pr_reviewer".into();
    r.autopilot.as_mut().unwrap().passed_checkpoints.push("implementer".into());
    let mut pr = plan_review(vec![("HIGH", Some("prd"))]);
    pr.stage_id = "pr_reviewer".into();
    pr.verdict = Some("REQUEST CHANGES".into());
    let d = decide(&def, &mut r, &pr);
    assert_eq!((d.action.as_str(), d.stage_id.as_deref()), ("loopBack", Some("implementer")));
}

#[test]
fn a_finding_may_name_its_area_and_an_unknown_one_is_refused() {
    use crate::bridge::schema;
    let ok = schema::validate(
        crate::bridge::ResultKind::Reviewer,
        &json!({ "verdict": "CHANGES_REQUIRED", "findings": [{ "severity": "HIGH", "summary": "s", "area": "PRD" }] }),
    )
    .unwrap();
    assert_eq!(ok["findings"][0]["area"], "prd");
    let bad = schema::validate(
        crate::bridge::ResultKind::Reviewer,
        &json!({ "verdict": "APPROVED", "findings": [{ "severity": "LOW", "summary": "s", "area": "ux" }] }),
    )
    .unwrap_err()
    .join("\n");
    assert!(bad.contains("area") && bad.contains("architecture"), "{bad}");
    assert!(schema::result_instructions(crate::bridge::ResultKind::Reviewer).contains("`area`"));
}

/// The Planner and a plan review are told what to do with the documents;
/// no other stage, and no run without documents, gets the line.
#[test]
fn only_the_planner_and_a_plan_review_get_the_document_note() {
    use crate::run_actor::prompts::document_note;
    let docs = vec![("Analyst document".to_string(), "/runs/ee/brief.md".to_string()), ("PM document".to_string(), "/runs/ee/prd.md".to_string())];
    let planner = document_note(&docs, true, false).unwrap();
    assert!(planner.contains("brief.md, prd.md") && planner.contains("pull-request split"), "{planner}");
    let review = document_note(&docs, false, true).unwrap();
    assert!(review.contains("Check the plan against them") && review.contains("`area`"), "{review}");
    assert!(document_note(&docs, false, false).is_none());
    assert!(document_note(&[], true, false).is_none());
}
