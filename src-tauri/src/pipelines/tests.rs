use super::*;

fn user_def(id: &str) -> PipelineDef {
    serde_json::from_value(serde_json::json!({
        "id": id,
        "name": "Bug fix",
        "stages": [
            { "id": "fix", "roleId": "role_implementer", "title": "Implementer" },
            { "id": "review", "roleId": "role_pr_reviewer", "title": "PR Reviewer",
              "loopBack": { "to": "fix" } }
        ]
    }))
    .unwrap()
}

#[test]
fn built_ins_match_the_stages_runs_have_always_used() {
    assert_eq!(
        stages("full").unwrap(),
        [
            ("planner", "role_planner"),
            ("plan_reviewer", "role_plan_reviewer"),
            ("implementer", "role_implementer"),
            ("pr_reviewer", "role_pr_reviewer"),
        ]
        .map(|(a, b)| (a.to_string(), b.to_string()))
    );
    assert_eq!(stages("execute"), stages("eagle2"));
    assert_eq!(stages("eagle2").unwrap().len(), 2);
    assert_eq!(run_kind_for_chain("eagle1").as_deref(), Some("full"));
    assert_eq!(run_kind_for_chain("eagle2").as_deref(), Some("execute"));
    assert_eq!(chain_kind_for_run("execute").as_deref(), Some("eagle2"));
    assert!(run_kind_for_chain("nope").is_none());
    // An unknown run kind is an error, never a silent Eagle-Eye 1 (Track H4).
    assert_eq!(stages("mystery"), None);
    assert_eq!(chain_kind_for_run("mystery"), None);
    assert_eq!(find_enabled("mystery").unwrap_err(), "unknown pipeline: mystery");
    assert!(builtins().iter().all(|def| def.built_in));
}

#[test]
fn built_in_loop_backs_have_no_round_cap_and_keep_their_gates() {
    let eagle1 = find("eagle1").unwrap();
    let review = eagle1.stage("pr_reviewer").unwrap();
    let back = review.loop_back.as_ref().unwrap();
    assert_eq!((back.to.as_str(), back.max_rounds, back.min_severity), ("implementer", None, Severity::Medium));
    // Every built-in loop-back goes on until its reviewer approves.
    let caps: Vec<Option<u32>> = builtins()
        .iter()
        .flat_map(|def| def.stages.iter().filter_map(|stage| stage.loop_back.as_ref()))
        .map(|back| back.max_rounds)
        .collect();
    assert_eq!(caps, vec![None, None, None]);
    let implementer = eagle1.stage("implementer").unwrap();
    assert!(implementer.checkpoint);
    assert_eq!(
        implementer.gates,
        vec![
            GateDef::Command { run: "auto".into(), timeout_secs: None, optional: false },
            GateDef::PullRequest
        ]
    );
    assert_eq!(eagle1.autopilot.pause_at_usage_percent, 90);
}

#[test]
fn user_pipelines_join_the_registry() {
    let id = "bugfix_registry_test";
    assert!(find(id).is_none());
    register_for_test(user_def(id));
    let def = find(id).unwrap();
    assert!(!def.built_in);
    assert_eq!(run_kind_for_chain(id).as_deref(), Some(id));
    assert_eq!(stages(id).unwrap()[1].1, "role_pr_reviewer");
    let back = def.stage("review").unwrap().loop_back.clone().unwrap();
    assert_eq!(back.max_rounds, None, "no maxRounds means no limit");
    unregister_for_test(id);
    assert!(find(id).is_none());
}

#[test]
fn validation_names_the_problem() {
    assert_eq!(validate_user_pipelines(&[user_def("bugfix")]), Ok(()));
    let err = |def: PipelineDef| validate_user_pipelines(&[def]).unwrap_err();
    assert!(err(user_def("eagle1")).contains("built-in"));
    assert!(err(user_def("full")).contains("built-in"));
    assert!(err(user_def("bad id")).contains("letters"));
    let mut forward = user_def("fwd");
    forward.stages[0].loop_back = Some(LoopBackDef {
        to: "review".into(),
        max_rounds: Some(3),
        min_severity: Severity::Medium,
    });
    assert!(err(forward).contains("not an earlier stage"));
    // A cap you set stays as set; 0 or more than 20 is refused.
    let mut capped = user_def("capped");
    capped.stages[1].loop_back.as_mut().unwrap().max_rounds = Some(3);
    assert_eq!(validate_user_pipelines(&[capped.clone()]), Ok(()));
    let json = serde_json::to_value(&capped).unwrap();
    assert_eq!(json["stages"][1]["loopBack"]["maxRounds"], 3);
    capped.stages[1].loop_back.as_mut().unwrap().max_rounds = Some(0);
    assert!(err(capped).contains("left out for no limit"));
    let mut empty = user_def("empty");
    empty.stages.clear();
    assert!(err(empty).contains("1 to"));
    let mut gate = user_def("gate");
    gate.stages[0].gates = vec![GateDef::Command { run: " ".into(), timeout_secs: None, optional: false }];
    assert!(err(gate).contains("command gate"));
    let twice = validate_user_pipelines(&[user_def("dup"), user_def("dup")]).unwrap_err();
    assert!(twice.contains("two pipelines"));
}

#[test]
fn severities_order_and_parse() {
    assert!(Severity::High.at_least(Severity::Medium));
    assert!(Severity::Medium.at_least(Severity::Medium));
    assert!(!Severity::Low.at_least(Severity::Medium));
    assert_eq!(Severity::parse(" nit "), Some(Severity::Info));
    assert_eq!(Severity::parse("Blocker"), Some(Severity::Critical));
    assert_eq!(Severity::parse("whatever"), None);
}

#[test]
fn parallel_reviewers_need_a_loop_back_and_distinct_roles() {
    let mut def = user_def("pair");
    def.stages[1].also_reviewers = vec!["role_security".into()];
    assert_eq!(validate_user_pipelines(&[def.clone()]), Ok(()));
    assert_eq!(def.stages[1].roles(), vec!["role_pr_reviewer", "role_security"]);
    let mut twice = def.clone();
    twice.stages[1].also_reviewers = vec!["role_pr_reviewer".into()];
    assert!(validate_user_pipelines(&[twice]).unwrap_err().contains("twice"));
    let mut no_loop = def.clone();
    no_loop.stages[0].also_reviewers = vec!["role_docs".into()];
    assert!(validate_user_pipelines(&[no_loop]).unwrap_err().contains("loopBack"));
}

#[test]
fn a_role_used_in_two_stages_is_rejected() {
    let mut def = user_def("dup");
    def.stages[1].role_id = "role_implementer".into();
    assert!(validate_user_pipelines(&[def]).unwrap_err().contains("two stages"));
    // Also when the second use is a parallel reviewer.
    let mut also = user_def("dup_also");
    also.stages[1].also_reviewers = vec!["role_implementer".into()];
    assert!(validate_user_pipelines(&[also]).unwrap_err().contains("two stages"));
}

#[test]
fn stall_minutes_default_to_30_and_are_set_per_pipeline() {
    assert_eq!(find("eagle1").unwrap().autopilot.stall_minutes, 30);
    assert_eq!(user_def("quiet").autopilot.stall_minutes, 30, "left out of the file");
    let mut slow: PipelineDef = serde_json::from_value(serde_json::json!({
        "id": "slow_suite",
        "name": "Slow suite",
        "stages": [{ "id": "fix", "roleId": "role_implementer", "title": "Implementer" }],
        "autopilot": { "stallMinutes": 90 }
    }))
    .unwrap();
    assert_eq!(slow.autopilot.stall_minutes, 90);
    assert_eq!(slow.autopilot.pause_at_usage_percent, 90, "the other policy keeps its default");
    assert_eq!(recovery::stall_limit(&slow), std::time::Duration::from_secs(90 * 60));
    assert_eq!(validate_user_pipelines(&[slow.clone()]), Ok(()));
    slow.autopilot.stall_minutes = 0;
    assert!(validate_user_pipelines(&[slow.clone()]).unwrap_err().contains("stallMinutes is 1 to 1440"));
    slow.autopilot.stall_minutes = 1441;
    assert!(validate_user_pipelines(&[slow]).unwrap_err().contains("stallMinutes"));
}

#[test]
fn a_loaded_stall_minutes_out_of_range_uses_the_default_limit() {
    // pipelines.json loads without validation, so the watchdog must not
    // trust a hand-edited value: 0 is not "1 minute" and 100000 is not "off".
    let mut def = user_def("hand_edited");
    let default = std::time::Duration::from_secs(u64::from(DEFAULT_STALL_MINUTES) * 60);
    for bad in [0, MAX_STALL_MINUTES + 1, 100_000] {
        def.autopilot.stall_minutes = bad;
        assert_eq!(recovery::stall_limit(&def), default, "stallMinutes {bad}");
    }
    for good in [1, MAX_STALL_MINUTES] {
        def.autopilot.stall_minutes = good;
        assert_eq!(recovery::stall_limit(&def), std::time::Duration::from_secs(u64::from(good) * 60));
    }
}

#[test]
fn stage_kinds_default_from_the_built_in_role_then_the_loop_back() {
    // The built-ins say their kinds; left out, the role id gives the same.
    for def in builtins() {
        for stage in &def.stages {
            let unset = StageDef { kind: None, ..stage.clone() };
            assert_eq!(stage.kind, Some(unset.kind()), "{} {}", def.id, stage.id);
        }
    }
    let eagle1 = find("eagle1").unwrap();
    let kinds: Vec<StageKind> = eagle1.stages.iter().map(StageDef::kind).collect();
    assert_eq!(
        kinds,
        [StageKind::Planner, StageKind::Reviewer, StageKind::Implementer, StageKind::Reviewer]
    );
    let mut def = user_def("kinds");
    // A copy has its own id: a stage that loops back reviews, any other is generic.
    def.stages[0].role_id = "role_custom_1".into();
    def.stages[1].role_id = "role_custom_2".into();
    assert_eq!(def.stages[0].kind(), StageKind::Generic);
    assert_eq!(def.stages[1].kind(), StageKind::Reviewer);
    // Written in the file, the kind wins.
    let set: StageDef = serde_json::from_value(serde_json::json!({
        "id": "fix", "roleId": "role_custom_1", "title": "Fixer", "kind": "implementer"
    }))
    .unwrap();
    assert_eq!(set.kind(), StageKind::Implementer);
    assert_eq!(serde_json::to_value(&set).unwrap()["kind"], "implementer");
    let unknown = serde_json::from_value::<StageDef>(serde_json::json!({
        "id": "fix", "roleId": "role_custom_1", "title": "Fixer", "kind": "boss"
    }));
    assert!(unknown.is_err(), "an unknown kind is not read as generic");
}

#[test]
fn role_ids_must_exist() {
    let roles: HashSet<String> = ["role_implementer", "role_pr_reviewer", "role_security"]
        .map(String::from)
        .into();
    assert_eq!(validate_user_pipelines_with(&[user_def("ok")], Some(&roles)), Ok(()));
    let mut gone = user_def("gone");
    gone.stages[1].role_id = "role_custom_9".into();
    let err = validate_user_pipelines_with(&[gone.clone()], Some(&roles)).unwrap_err();
    assert!(err.contains("\"role_custom_9\", which does not exist"), "{err}");
    // Parallel reviewers too.
    let mut also = user_def("also");
    also.stages[1].also_reviewers = vec!["role_docs".into()];
    assert!(validate_user_pipelines_with(&[also], Some(&roles)).unwrap_err().contains("role_docs"));
    // Before the roles are known, ids are not checked.
    assert_eq!(validate_user_pipelines_with(&[gone], None), Ok(()));
}

#[test]
fn an_invalid_pipeline_is_kept_disabled_with_the_reason() {
    let roles: HashSet<String> = ["role_implementer", "role_pr_reviewer"].map(String::from).into();
    let mut gone = user_def("gone");
    gone.stages[1].role_id = "role_custom_9".into();
    let broken = parse_user_entry(
        serde_json::json!({ "id": "broken", "name": "Broken", "stages": "not a list" }),
        2,
    );
    let checked = checked_user_pipelines(
        vec![user_def("fine"), gone, broken, user_def("fine")],
        Some(&roles),
    );
    let ids: Vec<&str> = checked.iter().map(|def| def.id.as_str()).collect();
    assert_eq!(ids, ["fine", "gone", "broken", "fine"], "nothing is dropped");
    assert_eq!(checked[0].disabled, None);
    assert!(checked[1].disabled.as_deref().unwrap().contains("role_custom_9"));
    let unreadable = &checked[2];
    assert_eq!(unreadable.name, "Broken");
    assert!(unreadable.disabled.as_deref().unwrap().starts_with("It could not be read"));
    assert_eq!(unreadable.raw.as_ref().unwrap()["stages"], "not a list", "the entry is kept as written");
    assert_eq!(checked[3].disabled.as_deref(), Some("two pipelines use this id."));
    // A role that comes back enables the pipeline again.
    let roles_back: HashSet<String> = ["role_implementer", "role_pr_reviewer", "role_custom_9"]
        .map(String::from)
        .into();
    let again = checked_user_pipelines(checked, Some(&roles_back));
    assert_eq!(again[1].disabled, None);
    assert!(again[2].disabled.is_some(), "an unreadable entry stays disabled");
}

// Rust reads "reviewer" from the loop-back, TS from the kind: a kind written
// in the file that says otherwise is refused, so the two never disagree.
#[test]
fn a_kind_that_contradicts_the_loop_back_is_refused_and_kept_as_written() {
    let err = |def: PipelineDef| validate_user_pipelines_with(&[def], None).unwrap_err();
    for kind in [StageKind::Planner, StageKind::Implementer, StageKind::Generic] {
        let mut looped = user_def("looped");
        looped.stages[1].kind = Some(kind);
        let msg = err(looped);
        assert!(msg.contains("stage \"review\"") && msg.contains("loopBack"), "{kind:?}: {msg}");
    }
    let mut lone = user_def("lone");
    lone.stages[0].kind = Some(StageKind::Reviewer);
    let msg = err(lone);
    assert!(msg.contains("stage \"fix\"") && msg.contains("loopBack"), "{msg}");
    // Written as the defaults would read it: fine.
    let mut said = user_def("said");
    said.stages[0].kind = Some(StageKind::Implementer);
    said.stages[1].kind = Some(StageKind::Reviewer);
    assert_eq!(validate_user_pipelines_with(&[said], None), Ok(()));
    // Kept, disabled with the reason, and the kind stays as written.
    let mut looped = user_def("looped");
    looped.stages[1].kind = Some(StageKind::Implementer);
    let checked = checked_user_pipelines(vec![looped], None);
    assert!(checked[0].disabled.as_deref().unwrap().contains("loopBack"));
    assert_eq!(checked[0].stages[1].kind, Some(StageKind::Implementer));
    assert!(checked[0].stages[1].loop_back.is_some());
}

#[test]
fn a_disabled_pipeline_cannot_drive_a_run() {
    let id = "disabled_registry_test";
    let mut def = user_def(id);
    def.disabled = Some("stage \"review\" uses the role \"role_x\", which does not exist.".into());
    register_for_test(def);
    assert!(find(id).is_some(), "still listed");
    let err = find_enabled(id).unwrap_err();
    unregister_for_test(id);
    assert!(err.contains("is disabled") && err.contains("role_x"), "{err}");
}

#[test]
fn an_optional_gate_round_trips_and_defaults_off() {
    let gate: GateDef = serde_json::from_value(serde_json::json!({ "kind": "command", "run": "auto" })).unwrap();
    assert_eq!(gate, GateDef::Command { run: "auto".into(), timeout_secs: None, optional: false });
    let optional = GateDef::Command { run: "auto".into(), timeout_secs: None, optional: true };
    let json = serde_json::to_value(&optional).unwrap();
    assert_eq!(json, serde_json::json!({ "kind": "command", "run": "auto", "optional": true }));
}
