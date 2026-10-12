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
        stages("full"),
        [
            ("planner", "role_planner"),
            ("plan_reviewer", "role_plan_reviewer"),
            ("implementer", "role_implementer"),
            ("pr_reviewer", "role_pr_reviewer"),
        ]
        .map(|(a, b)| (a.to_string(), b.to_string()))
    );
    assert_eq!(stages("execute"), stages("eagle2"));
    assert_eq!(stages("eagle2").len(), 2);
    assert_eq!(run_kind_for_chain("eagle1").as_deref(), Some("full"));
    assert_eq!(run_kind_for_chain("eagle2").as_deref(), Some("execute"));
    assert_eq!(chain_kind_for_run("execute"), "eagle2");
    assert!(run_kind_for_chain("nope").is_none());
    // Unknown run kinds read as Eagle-Eye 1, like runs from before pipelines were data.
    assert_eq!(stages("mystery").len(), 4);
    assert!(builtins().iter().all(|def| def.built_in));
}

#[test]
fn built_in_loop_backs_caps_and_gates() {
    let eagle1 = find("eagle1").unwrap();
    let review = eagle1.stage("pr_reviewer").unwrap();
    let back = review.loop_back.as_ref().unwrap();
    assert_eq!((back.to.as_str(), back.max_rounds, back.min_severity), ("implementer", 3, Severity::Medium));
    let implementer = eagle1.stage("implementer").unwrap();
    assert!(implementer.checkpoint);
    assert_eq!(
        implementer.gates,
        vec![
            GateDef::Command { run: "auto".into(), timeout_secs: None },
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
    assert_eq!(stages(id)[1].1, "role_pr_reviewer");
    let back = def.stage("review").unwrap().loop_back.clone().unwrap();
    assert_eq!(back.max_rounds, DEFAULT_MAX_ROUNDS);
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
        max_rounds: 3,
        min_severity: Severity::Medium,
    });
    assert!(err(forward).contains("not an earlier stage"));
    let mut empty = user_def("empty");
    empty.stages.clear();
    assert!(err(empty).contains("1 to"));
    let mut gate = user_def("gate");
    gate.stages[0].gates = vec![GateDef::Command { run: " ".into(), timeout_secs: None }];
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
    no_loop.stages[0].also_reviewers = vec!["role_security".into()];
    assert!(validate_user_pipelines(&[no_loop]).unwrap_err().contains("loopBack"));
}
