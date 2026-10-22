//! F1: an artifact stage on the run actor: it opens bridged with the run
//! folder, a `partial` result waits for your Answer, which resumes the same
//! session, and the documents reach the next stage's prompt.

use super::*;

const DOCS_PIPELINE: &str = "docs_between_v1";

/// Planner → Brief (an artifact stage, a copy of the General role) → Implementer.
fn docs_pipeline() -> crate::pipelines::PipelineDef {
    serde_json::from_value(json!({
        "id": DOCS_PIPELINE, "name": "Docs between",
        "stages": [
            { "id": "planner", "roleId": "role_planner", "title": "Planner" },
            { "id": "brief", "roleId": "role_custom_brief", "title": "Brief", "kind": "artifact" },
            { "id": "implementer", "roleId": "role_implementer", "title": "Implementer" }
        ]
    }))
    .unwrap()
}

fn artifact_result(status: &str) -> Option<Value> {
    Some(match status {
        "partial" => json!({ "schema": 1, "status": "partial", "artifacts": ["brief.md"], "openQuestions": ["Is offline in scope?"], "summary": "Draft." }),
        _ => json!({ "schema": 1, "status": "complete", "artifacts": ["brief.md"], "openQuestions": [], "summary": "Done." }),
    })
}

/// What the bridge writes for an accepted artifact result.
fn report_documents(fx: &Fixture, tab: &str, status: &str) {
    std::fs::write(fx.run_file("brief.md"), "# Brief\n").unwrap();
    fx.stage_dir(tab)
        .write_artifacts(crate::bridge::folder::StageArtifacts {
            stage_key: "brief".into(),
            stage_id: "brief".into(),
            role_id: "role_custom_brief".into(),
            turn: "b".into(),
            at: "now".into(),
            status: status.into(),
            artifacts: vec!["brief.md".into()],
        })
        .unwrap();
}

#[test]
fn a_partial_document_waits_for_your_answer_which_resumes_its_session_then_the_next_stage_sees_it() {
    crate::pipelines::register_for_test(docs_pipeline());
    let mut fx = Fixture::with_pipeline("artifact_stage", DOCS_PIPELINE, vec![copied_role("role_general", "role_custom_brief", "Brief")]);
    assert_eq!(fx.run(|run| run.engine), 2, "an artifact stage is bridged");
    let turn = fx.planner_turn("p-1", "# Plan\n1. Refresh tokens in src/auth.ts.");
    fx.actor.handle(ActorMsg::Turn(turn));
    let launch = fx.launches().last().cloned().expect("the Brief stage opened");
    let brief = launch.tab_id.clone();
    assert_eq!(launch.role_id, "role_custom_brief");
    let run_dir = fx.host.runs.join(RUN).display().to_string();
    assert!(launch.prompt.contains(&run_dir), "the prompt names the run folder:\n{}", launch.prompt);
    let flags = launch.bridge.as_ref().expect("bridged");
    assert_eq!(flags.args[..2], ["--add-dir".to_string(), run_dir.clone()]);
    assert_eq!(fx.tab(&brief).bridge.unwrap().stage, "brief");

    // Partial: the run waits with checkpoint and the questions.
    report_documents(&fx, &brief, "partial");
    let turn = fx.end_turn(&brief, "b-1", artifact_result("partial"), "Questions.");
    fx.actor.handle(ActorMsg::Turn(turn));
    fx.run(|run| {
        assert_eq!((run.status, run.stop_reason), (RunStatus::Waiting, Some(StopReason::Checkpoint)), "{:?}", run.events.last());
        let wait = run.autopilot.as_ref().unwrap().artifact_wait.clone().expect("the wait");
        assert_eq!((wait.stage_id.as_str(), wait.questions.clone()), ("brief", vec!["Is offline in scope?".to_string()]));
    });
    assert!(fx.resumes().is_empty());

    // Refused, with nothing changed: no answer, another stage, autopilot off.
    let empty = fx.user(UserAction::ArtifactAnswer { stage_id: "brief".into(), answer: Some("  ".into()) }).unwrap_err();
    assert!(empty.contains("Write your answers"), "{empty}");
    let other = fx.user(UserAction::ArtifactAnswer { stage_id: "planner".into(), answer: Some("x".into()) }).unwrap_err();
    assert!(other.contains("not waiting"), "{other}");
    {
        let mut store = fx.host.store.lock().unwrap();
        store.pipeline_run_by_id_mut(RUN).unwrap().set_autopilot_enabled(false);
    }
    let off = fx.user(UserAction::ArtifactAnswer { stage_id: "brief".into(), answer: Some("Out.".into()) }).unwrap_err();
    assert!(off.contains("Autopilot is off"), "{off}");
    {
        let mut store = fx.host.store.lock().unwrap();
        store.pipeline_run_by_id_mut(RUN).unwrap().set_autopilot_enabled(true);
    }
    fx.run(|run| assert!(run.autopilot.as_ref().unwrap().artifact_wait.is_some(), "the wait survives the toggle"));
    assert!(fx.resumes().is_empty());

    // Your answer resumes the same session with the questions and answers.
    let sent = fx.user(UserAction::ArtifactAnswer { stage_id: "brief".into(), answer: Some("Offline is out of scope.".into()) }).unwrap();
    assert_eq!(sent.tab_id.as_deref(), Some(brief.as_str()));
    let resumes = fx.resumes();
    assert_eq!(resumes.len(), 1);
    assert_eq!(resumes[0].tab_id, brief);
    assert!(resumes[0].prompt.contains("Is offline in scope?") && resumes[0].prompt.contains("Offline is out of scope."), "{}", resumes[0].prompt);
    fx.run(|run| {
        assert_eq!(run.status, RunStatus::Running);
        assert!(run.autopilot.as_ref().unwrap().artifact_wait.is_none());
        assert!(run.events.iter().any(|e| e.outcome.as_deref() == Some("artifactAnswer")));
    });

    // Complete: the Implementer opens with the document in its hand-off files.
    report_documents(&fx, &brief, "complete");
    let turn = fx.end_turn(&brief, "b-2", artifact_result("complete"), "Done.");
    fx.actor.handle(ActorMsg::Turn(turn));
    crate::pipelines::unregister_for_test(DOCS_PIPELINE);
    let launch = fx.launches().last().cloned().unwrap();
    assert_eq!(launch.role_id, "role_implementer");
    let brief_path = fx.run_file("brief.md").display().to_string();
    assert!(launch.prompt.contains(&format!("Brief document: {brief_path}")), "the document is named:\n{}", launch.prompt);
}

#[test]
fn a_blocked_document_continues_with_your_note_or_with_none() {
    crate::pipelines::register_for_test(serde_json::from_value(json!({
        "id": "docs_blocked_v1", "name": "Docs blocked",
        "stages": [
            { "id": "planner", "roleId": "role_planner", "title": "Planner" },
            { "id": "brief", "roleId": "role_custom_brief", "title": "Brief", "kind": "artifact" },
            { "id": "implementer", "roleId": "role_implementer", "title": "Implementer" }
        ]
    }))
    .unwrap());
    let mut fx = Fixture::with_pipeline("artifact_blocked", "docs_blocked_v1", vec![copied_role("role_general", "role_custom_brief", "Brief")]);
    let turn = fx.planner_turn("p-1", "# Plan\n1. Refresh.");
    fx.actor.handle(ActorMsg::Turn(turn));
    let brief = fx.launches().last().unwrap().tab_id.clone();
    let blocked = json!({ "schema": 1, "status": "blocked", "artifacts": [], "openQuestions": [], "reason": "The wiki is down.", "summary": "s" });
    let turn = fx.end_turn(&brief, "b-1", Some(blocked), "Blocked.");
    fx.actor.handle(ActorMsg::Turn(turn));
    fx.run(|run| {
        assert_eq!(run.stop_reason, Some(StopReason::Checkpoint));
        assert!(run.autopilot.as_ref().unwrap().waiting.as_deref().unwrap_or_default().contains("The wiki is down"), "{:?} {:?}", run.status, run.events);
    });
    fx.user(UserAction::ArtifactAnswer { stage_id: "brief".into(), answer: None }).expect("Continue with no note");
    let prompt = fx.resumes().last().unwrap().prompt.clone();
    assert!(prompt.contains("The wiki is down.") && prompt.contains("carry on"), "{prompt}");
    crate::pipelines::unregister_for_test("docs_blocked_v1");
}
