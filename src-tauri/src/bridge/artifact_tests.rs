//! F1: the artifact result's path and status rules.

use super::*;
use crate::test_support::TempDir;
use serde_json::json;

fn run_folder(tag: &str) -> TempDir {
    let dir = TempDir::new(&format!("artifact_{tag}"));
    std::fs::write(dir.join("brief.md"), "# Brief\n").unwrap();
    std::fs::create_dir_all(dir.join("docs")).unwrap();
    std::fs::write(dir.join("docs").join("prd.md"), "# PRD\n").unwrap();
    std::fs::write(dir.join("tasks.json"), "{}").unwrap();
    dir
}

fn problems(args: serde_json::Value, dir: &TempDir) -> String {
    validate(&args, Some(dir.path())).unwrap_err().join("\n")
}

#[test]
fn a_complete_result_lists_files_inside_the_run_folder() {
    let dir = run_folder("complete");
    let ok = validate(
        &json!({ "status": "complete", "artifacts": ["./brief.md", "docs/prd.md"], "summary": " The brief. " }),
        Some(dir.path()),
    )
    .unwrap();
    assert_eq!(ok["artifacts"], json!(["brief.md", "docs/prd.md"]), "paths are made plain");
    assert_eq!(ok["summary"], "The brief.");
    assert_eq!(ok["schema"], 1);
    assert_eq!(ok["openQuestions"], json!([]));
}

#[test]
fn paths_must_exist_stay_inside_and_not_be_the_apps_own_files() {
    let dir = run_folder("paths");
    let outside = TempDir::new("artifact_paths_outside");
    std::fs::write(outside.join("secret.md"), "x").unwrap();
    let base = |paths: serde_json::Value| json!({ "status": "complete", "artifacts": paths, "summary": "s" });
    assert!(problems(base(json!(["missing.md"])), &dir).contains("does not exist"));
    assert!(problems(base(json!(["../secret.md"])), &dir).contains("climbs out"));
    let absolute = outside.join("secret.md").display().to_string();
    assert!(problems(base(json!([absolute])), &dir).contains("not relative"));
    assert!(problems(base(json!(["tasks.json"])), &dir).contains("DCTerminal keeps"));
    assert!(problems(base(json!(["stages/x/turn.json"])), &dir).contains("DCTerminal keeps"));
    assert!(problems(base(json!(["prs-pr1.json"])), &dir).contains("DCTerminal keeps"));
    assert!(problems(base(json!([".hidden.md"])), &dir).contains("DCTerminal keeps"));
    assert!(problems(base(json!(["docs"])), &dir).contains("not a file"));
    assert!(problems(base(json!(["brief.md", "brief.md"])), &dir).contains("twice"));
    assert!(problems(base(json!([3])), &dir).contains("must be a path"));
    let many: Vec<String> = (0..21).map(|i| format!("d{i}.md")).collect();
    assert!(problems(base(json!(many)), &dir).contains("at most 20"));
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(outside.join("secret.md"), dir.join("link.md")).unwrap();
        assert!(problems(base(json!(["link.md"])), &dir).contains("leads out of the run folder"));
    }
    // Every problem is named at once.
    let all = problems(base(json!(["missing.md", "../x.md"])), &dir);
    assert!(all.contains("does not exist") && all.contains("climbs out"), "{all}");
}

#[test]
fn the_status_decides_what_else_is_required() {
    let dir = run_folder("status");
    assert!(problems(json!({ "artifacts": [], "summary": "s" }), &dir).contains("`status` is missing"));
    assert!(problems(json!({ "status": "done", "artifacts": [], "summary": "s" }), &dir).contains("not one of"));
    assert!(problems(json!({ "status": "complete", "artifacts": [], "summary": "s" }), &dir).contains("`artifacts` is empty"));
    assert!(
        problems(json!({ "status": "complete", "artifacts": ["brief.md"], "openQuestions": ["Why?"], "summary": "s" }), &dir)
            .contains("use `partial`")
    );
    assert!(problems(json!({ "status": "partial", "artifacts": ["brief.md"], "summary": "s" }), &dir).contains("openQuestions"));
    assert!(
        problems(json!({ "status": "partial", "artifacts": [], "openQuestions": ["  "], "summary": "s" }), &dir)
            .contains("openQuestions")
    );
    let partial = validate(
        &json!({ "status": "partial", "artifacts": [], "openQuestions": ["Is offline in scope?"], "summary": "s" }),
        Some(dir.path()),
    )
    .unwrap();
    assert_eq!(partial["openQuestions"], json!(["Is offline in scope?"]));
    assert!(problems(json!({ "status": "blocked", "artifacts": [], "summary": "s" }), &dir).contains("`reason` is missing"));
    let blocked = validate(&json!({ "status": "blocked", "artifacts": [], "reason": "No access", "summary": "s" }), Some(dir.path())).unwrap();
    assert_eq!(blocked["reason"], "No access");
    assert!(problems(json!({ "status": "complete", "artifacts": ["brief.md"] }), &dir).contains("`summary` is missing"));
    assert!(problems(json!({ "status": "complete", "artifacts": ["brief.md"], "summary": "s", "prs": [] }), &dir).contains("not a field"));
    assert!(problems(json!({ "status": "complete", "summary": "s" }), &dir).contains("`artifacts` is missing"));
}

#[test]
fn the_shape_check_without_a_folder_skips_the_files_and_the_words_name_the_tool() {
    let ok = super::super::schema::validate(
        super::super::ResultKind::Artifact,
        &json!({ "status": "complete", "artifacts": ["brief.md"], "summary": "s" }),
    );
    assert!(ok.is_ok(), "{ok:?}");
    assert!(result_instructions().contains("openQuestions"));
    assert!(block_reason().contains(FULL_TOOL_NAME));
    assert_eq!(tool_definition()["inputSchema"]["properties"]["status"]["enum"], json!(STATUSES));
    let section = super::super::schema::stage_instructions_in(super::super::ResultKind::Artifact, &[], Some(Path::new("/data/runs/ee_1")));
    assert!(section.contains("/data/runs/ee_1") && section.contains("Report your result"), "{section}");
    assert!(accepted_message(&json!({ "status": "partial", "artifacts": ["brief.md"] })).contains("waits for the user"));
}

/// F1: an artifact stage gets the tool, the hooks and the run folder
/// (`--add-dir`), and a pipeline of bridged stages with one is engine 2.
#[test]
fn an_artifact_stage_launches_bridged_with_the_run_folder_added() {
    let flags = super::super::launch::launch_flags(
        super::super::ResultKind::Artifact,
        Path::new("/opt/dcterminal"),
        Path::new("/data/runs/ee_1"),
        "ee_1",
        "analyst",
        "tab_1",
    );
    assert_eq!(flags.args[..2], ["--add-dir".to_string(), "/data/runs/ee_1".to_string()]);
    assert!(flags.args.contains(&FULL_TOOL_NAME.to_string()));
    assert_eq!(flags.hooks["hooks"]["PreToolUse"][0]["matcher"], FULL_TOOL_NAME);
    let def: crate::pipelines::PipelineDef = serde_json::from_value(json!({
        "id": "docs_first", "name": "Docs first",
        "stages": [
            { "id": "analyst", "roleId": "role_general", "title": "Analyst", "kind": "artifact" },
            { "id": "implementer", "roleId": "role_implementer", "title": "Implementer" }
        ]
    }))
    .unwrap();
    assert_eq!(super::super::launch::engine_for(&def), super::super::launch::ENGINE_V2);
}

/// F1: the MCP server checks the documents in the stage's own run folder,
/// and an accepted result lands in `artifacts.json` next to the turn's result.
#[test]
fn the_bridge_takes_a_document_from_the_run_folder_and_lists_it_in_artifacts_json() {
    use super::super::{folder, launch, mcp};
    let root = TempDir::new("artifact_mcp");
    let runs = launch::runs_root(root.path());
    let plan = launch::BridgePlan {
        run_id: "ee_1700000000001".into(),
        stage_id: "analyst".into(),
        role_id: "role_analyst".into(),
        lane: None,
        stage_key: "analyst".into(),
        kind: super::super::ResultKind::Artifact,
        autopilot: true,
    };
    let run_dir = launch::prepare_stage(&runs, &plan, "tab_a").unwrap();
    let server = mcp::Server {
        run_dir: run_dir.clone(),
        run_id: plan.run_id.clone(),
        stage_key: "analyst".into(),
        tab_id: "tab_a".into(),
        kind: plan.kind,
    };
    let submit = |args: serde_json::Value| {
        let call = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "submit_result", "arguments": args } });
        mcp::handle(&server, &call).unwrap()["result"].clone()
    };
    let args = json!({ "status": "complete", "artifacts": ["brief.md"], "summary": "The brief." });
    let refused = submit(args.clone());
    assert_eq!(refused["isError"], true);
    assert!(refused["content"][0]["text"].as_str().unwrap().contains("does not exist"));
    assert!(folder::read_artifacts(&run_dir).is_none(), "nothing written for a refused result");
    std::fs::write(run_dir.join("brief.md"), "# Brief").unwrap();
    let accepted = submit(args);
    assert_eq!(accepted["isError"], false, "{accepted}");
    let file = folder::read_artifacts(&run_dir).expect("artifacts.json");
    assert_eq!(file.stages.len(), 1);
    assert_eq!((file.stages[0].status.as_str(), file.stages[0].artifacts.clone()), ("complete", vec!["brief.md".to_string()]));
    // A later result replaces the stage's entry.
    submit(json!({ "status": "partial", "artifacts": ["brief.md"], "openQuestions": ["Scope?"], "summary": "s" }));
    let file = folder::read_artifacts(&run_dir).unwrap();
    assert_eq!((file.stages.len(), file.stages[0].status.as_str()), (1, "partial"));
}
