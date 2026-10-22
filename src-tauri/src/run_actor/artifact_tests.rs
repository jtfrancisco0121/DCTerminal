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

/// F2: an Eagle-Eye L run on autopilot whose Analyst terminal (step 1) runs,
/// bridged. `fx.planner` holds the Analyst's tab until the Planner opens.
fn eagle_l(tag: &str) -> Fixture {
    let dir = TempDir::new(&format!("run_actor_{tag}"));
    let work = TempDir::new(&format!("run_actor_{tag}_work"));
    let roles = crate::store::bundled_seed().expect("seed").roles;
    let mut store = StateStore {
        path: dir.join("state.json"),
        data: AppStateFile::default(),
        new_tab_provider: crate::provider::ProviderId::DEFAULT,
        draft_window: MAIN_WINDOW_ID.to_string(),
    };
    let cwd = work.path().display().to_string();
    let analyst_role = roles.iter().find(|r| r.id == "role_analyst").expect("the Analyst role is in the seed");
    let analyst = store.create_draft_tab(analyst_role, &cwd, true, None).unwrap();
    store.data.tabs.iter_mut().find(|t| t.id == analyst).unwrap().answers = HashMap::from([
        ("cwd".into(), cwd.clone()),
        ("title".into(), "Offline sync".into()),
        ("request".into(), "Let field users keep working offline.".into()),
        ("expectedBehavior".into(), "Edits made offline sync when the connection is back.".into()),
    ]);
    let chain = ChainRef { kind: "eagle-eye-l".into(), total: 7, ..chain(1, None) };
    store.set_tab_chain(&analyst, Some(chain), None).unwrap();
    {
        let run = store.pipeline_run_by_id_mut(RUN).unwrap();
        run.set_autopilot_enabled(true);
        run.engine = crate::bridge::launch::engine_for(&crate::pipelines::find("eagle-eye-l").unwrap());
    }
    let runs = dir.join("runs");
    let plan = BridgePlan {
        run_id: RUN.into(),
        stage_id: "analyst".into(),
        role_id: "role_analyst".into(),
        lane: None,
        stage_key: "analyst".into(),
        kind: ResultKind::Artifact,
        autopilot: true,
    };
    prepare_stage(&runs, &plan, &analyst).unwrap();
    store.set_tab_bridge(&analyst, Some(BridgeTag { run_id: RUN.into(), stage: "analyst".into() })).unwrap();
    store.remember_claude_terminal_session(&analyst, PLANNER_SID).unwrap();
    let host = Arc::new(TestHost {
        store: Mutex::new(store),
        runs,
        roles,
        launches: Mutex::new(Vec::new()),
        resumes: Mutex::new(Vec::new()),
        resume_error: Mutex::new(None),
        pastes: Mutex::new(Vec::new()),
        live: Mutex::new(HashSet::from([analyst.clone()])),
        gates: Mutex::new(VecDeque::new()),
        panic_on_usage: AtomicBool::new(false),
        hold_usage: Mutex::new(None),
        pr_gate_urls: Mutex::new(Vec::new()),
        ran_gates: Mutex::new(Vec::new()),
        gate_open: AtomicBool::new(true),
        rate_limits: Mutex::new(HashMap::new()),
        stops: Mutex::new(Vec::new()),
        notices: Mutex::new(Vec::new()),
        _dir: dir,
    });
    let (me, gates_done) = channel();
    let actor = Actor::new(RUN.to_string(), host.clone(), me);
    Fixture { host, actor, gates_done, planner: analyst, work }
}

/// The document stage in `tab` wrote `file` and reported it complete (the
/// bridge's files), and its turn reaches the actor.
fn finish_document(fx: &mut Fixture, tab: &str, stage: &str, file: &str) {
    std::fs::write(fx.run_file(file), format!("# {file}\n")).unwrap();
    let role = fx.tab(tab).role_id;
    fx.stage_dir(tab)
        .write_artifacts(crate::bridge::folder::StageArtifacts {
            stage_key: stage.into(),
            stage_id: stage.into(),
            role_id: role,
            turn: format!("{stage}-1"),
            at: "now".into(),
            status: "complete".into(),
            artifacts: vec![file.into()],
        })
        .unwrap();
    let result = json!({ "schema": 1, "status": "complete", "artifacts": [file], "openQuestions": [], "summary": "Written." });
    let turn = fx.end_turn(tab, &format!("{stage}-1"), Some(result), "Done.");
    fx.actor.handle(ActorMsg::Turn(turn));
}

/// F2: a size-L run passes the brief, the PRD and the architecture on, so
/// the Planner bases its plan on them and the Plan Reviewer checks the plan
/// against them; a plan review that blames the PRD stops at a checkpoint
/// instead of sending the round back to the Planner.
#[test]
fn eagle_eye_l_passes_the_three_documents_to_the_planner_and_the_plan_reviewer() {
    let mut fx = eagle_l("eagle_l");
    assert_eq!(fx.run(|run| run.engine), 2, "Eagle-Eye L is engine 2");
    let analyst = fx.planner.clone();
    let path = |fx: &Fixture, file: &str| fx.run_file(file).display().to_string();

    finish_document(&mut fx, &analyst, "analyst", "brief.md");
    let pm = fx.launches().last().cloned().expect("the PM opened");
    assert_eq!(pm.role_id, "role_pm");
    assert!(pm.prompt.contains("Let field users keep working offline."), "the request:\n{}", pm.prompt);
    assert!(pm.prompt.contains(&format!("Analyst document: {}", path(&fx, "brief.md"))), "{}", pm.prompt);
    assert!(pm.prompt.contains("prd.md") && pm.prompt.contains(&fx.host.runs.join(RUN).display().to_string()));

    finish_document(&mut fx, &pm.tab_id, "pm", "prd.md");
    let architect = fx.launches().last().cloned().expect("the Architect opened");
    assert_eq!(architect.role_id, "role_architect");
    assert!(architect.prompt.contains(&format!("PM document: {}", path(&fx, "prd.md"))), "{}", architect.prompt);

    finish_document(&mut fx, &architect.tab_id, "architect", "architecture.md");
    let planner = fx.launches().last().cloned().expect("the Planner opened");
    assert_eq!(planner.role_id, "role_planner");
    for file in ["brief.md", "prd.md", "architecture.md"] {
        assert!(planner.prompt.contains(&path(&fx, file)), "the Planner sees {file}:\n{}", planner.prompt);
    }
    assert!(planner.prompt.contains("base the plan and its pull-request split on them"), "{}", planner.prompt);
    assert!(planner.prompt.contains("Edits made offline sync"), "the expected behaviour reaches the Planner");

    fx.planner = planner.tab_id.clone();
    let turn = fx.planner_turn("p-1", "# Plan\n1. Queue offline edits in src/sync.ts.");
    fx.actor.handle(ActorMsg::Turn(turn));
    let reviewer = fx.launches().last().cloned().expect("the Plan Reviewer opened");
    assert_eq!(reviewer.role_id, "role_plan_reviewer");
    for file in ["brief.md", "prd.md", "architecture.md"] {
        assert!(reviewer.prompt.contains(&path(&fx, file)), "the Plan Reviewer sees {file}:\n{}", reviewer.prompt);
    }
    assert!(reviewer.prompt.contains("Check the plan against them") && reviewer.prompt.contains("`area`"), "{}", reviewer.prompt);

    // A finding on the PRD stops for you; nothing goes back to the Planner.
    let findings = json!([{ "severity": "HIGH", "area": "prd", "summary": "FR3 contradicts the brief's scope." }]);
    let turn = fx.end_turn(&reviewer.tab_id, "r-1", review("CHANGES_REQUIRED", findings), "Changes required.");
    fx.actor.handle(ActorMsg::Turn(turn));
    assert!(fx.resumes().is_empty(), "the Planner is not resumed: {:?}", fx.resumes());
    fx.run(|run| {
        assert_eq!((run.status, run.stop_reason), (RunStatus::Waiting, Some(StopReason::Checkpoint)), "{:?}", run.events.last());
        let why = run.autopilot.as_ref().unwrap().waiting.clone().unwrap_or_default();
        assert!(why.contains("(prd) FR3 contradicts") && why.contains("cannot edit"), "{why}");
        assert!(run.verdicts.is_empty(), "no round was sent back");
    });
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
