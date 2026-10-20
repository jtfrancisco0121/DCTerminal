//! Bridge unit tests: hook decisions, the block-once rule, schema checks,
//! the MCP server, and the app's side of the run folder. The fake-claude
//! run (hooks and MCP driven by a stand-in `claude`) is in
//! `tests/fake_claude.rs`.

use super::folder::{self, OpenError, StageDir, StageInfo, TurnOutcome};
use super::launch::{self, BridgePlan, BridgeTag};
use super::schema::{self, FULL_TOOL_NAME};
use super::{hook, mcp, parse_cli, stop_decision, Cli, Mode, ResultKind, StageMode, StopDecision};
use crate::store::{ChainRef, PipelineRun, RunAutopilot, RunStatus};
use crate::test_support::TempDir;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

const RUN: &str = "ee_1700000000000";
const TAB: &str = "tab_reviewer_1";

fn plan(autopilot: bool) -> BridgePlan {
    BridgePlan {
        run_id: RUN.into(),
        stage_id: "pr_reviewer".into(),
        role_id: "role_pr_reviewer".into(),
        lane: None,
        stage_key: "pr_reviewer".into(),
        kind: ResultKind::Reviewer,
        autopilot,
    }
}

/// A run folder with one reviewer stage owned by `TAB`.
struct Stage {
    _root: TempDir,
    runs: PathBuf,
    run_dir: PathBuf,
}

impl Stage {
    fn new(tag: &str, autopilot: bool) -> Self {
        let root = TempDir::new(tag);
        let runs = launch::runs_root(root.path());
        let run_dir = launch::prepare_stage(&runs, &plan(autopilot), TAB).expect("prepare stage");
        Self { _root: root, runs, run_dir }
    }

    fn open(&self) -> StageDir {
        StageDir::open(&self.run_dir, RUN, "pr_reviewer", TAB).expect("open stage")
    }

    fn hook(&self, event: &str, payload: Value) -> Option<Value> {
        hook::handle(&self.open(), event, &payload).expect("hook")
    }

    fn server(&self) -> mcp::Server {
        mcp::Server {
            run_dir: self.run_dir.clone(),
            run_id: RUN.into(),
            stage_key: "pr_reviewer".into(),
            tab_id: TAB.into(),
            kind: ResultKind::Reviewer,
        }
    }

    fn submit(&self, args: Value) -> Value {
        let call = json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/call",
            "params": { "name": "submit_result", "arguments": args } });
        mcp::handle(&self.server(), &call).expect("reply")["result"].clone()
    }

    fn inbox(&self) -> Vec<super::BridgeTurn> {
        let mut events = Vec::new();
        super::watch::drain_inbox(&self.runs, &mut |event| events.push(event));
        events
    }
}

fn prompt(turn: &str) -> Value {
    json!({ "session_id": "s1", "prompt_id": turn, "hook_event_name": "UserPromptSubmit",
        "permission_mode": "auto", "prompt": "Review PR1" })
}

fn stop(turn: &str, active: bool, message: &str) -> Value {
    json!({ "session_id": "s1", "prompt_id": turn, "hook_event_name": "Stop",
        "stop_hook_active": active, "last_assistant_message": message,
        "background_tasks": [], "session_crons": [] })
}

fn approved() -> Value {
    json!({ "verdict": "APPROVED", "findings": [] })
}

// ---- hook decisions -------------------------------------------------------

#[test]
fn stop_decision_blocks_once_only_on_autopilot() {
    use StageMode::*;
    use StopDecision::*;
    // A result ends the turn whatever else holds.
    assert_eq!(stop_decision(Autopilot, false, true, false), End(TurnOutcome::Result));
    assert_eq!(stop_decision(Manual, true, true, true), End(TurnOutcome::Result));
    // No result on autopilot: blocked once, never twice.
    assert_eq!(stop_decision(Autopilot, false, false, false), Block);
    assert_eq!(stop_decision(Autopilot, false, false, true), End(TurnOutcome::NoResult));
    // Claude is already continuing for a Stop hook: never block on top (D10).
    assert_eq!(stop_decision(Autopilot, true, false, false), End(TurnOutcome::NoResult));
    // Manual and taken over: nothing is enforced (D13).
    assert_eq!(stop_decision(Manual, false, false, false), End(TurnOutcome::NoResult));
    assert_eq!(stop_decision(Takeover, false, false, false), End(TurnOutcome::NoResult));
}

#[test]
fn user_prompt_submit_starts_the_turn_with_claudes_prompt_id() {
    let stage = Stage::new("bridge_ups", true);
    assert_eq!(stage.hook("UserPromptSubmit", prompt("p-1")), None);
    let turn = stage.open().turn().expect("turn.json");
    assert_eq!(turn.turn, "p-1");
    assert!(!turn.blocked);
    assert!(turn.ended.is_none());
    let kept = stage.run_dir.join("stages/pr_reviewer/payloads/UserPromptSubmit.json");
    let kept: Value = serde_json::from_str(&std::fs::read_to_string(kept).unwrap()).unwrap();
    assert_eq!(kept, prompt("p-1"), "the raw payload is kept");
}

#[test]
fn a_reviewer_that_forgets_the_tool_is_blocked_once_then_ends_with_no_result() {
    let stage = Stage::new("bridge_block_once", true);
    stage.hook("UserPromptSubmit", prompt("p-1"));
    let block = stage.hook("Stop", stop("p-1", false, "Looks good.")).expect("a block");
    assert_eq!(block["decision"], "block");
    let reason = block["reason"].as_str().unwrap();
    // The reason names the exact tool and its arguments (V0 T3).
    assert!(reason.contains(FULL_TOOL_NAME), "{reason}");
    assert!(reason.contains("\"verdict\"") && reason.contains("CHANGES_REQUIRED"), "{reason}");
    assert!(stage.open().turn().unwrap().blocked);
    assert!(stage.inbox().is_empty(), "a blocked stop is not a turn end");

    // The next Stop is another hook process (a fresh StageDir): with
    // stop_hook_active false, only turn.json's blocked flag ends the turn.
    assert_eq!(stage.hook("Stop", stop("p-1", false, "Still looks good.")), None);
    let events = stage.inbox();
    assert_eq!(events.len(), 1);
    let event = &events[0];
    assert_eq!(event.outcome, TurnOutcome::NoResult);
    assert!(event.blocked);
    assert_eq!(event.turn, "p-1");
    assert_eq!(event.tab_id, TAB);
    assert_eq!(event.stage_id, "pr_reviewer");
    assert_eq!(event.last_assistant_message, "Still looks good.");
    assert!(event.result.is_none());
    // The end is reported once, even if Claude stops again.
    assert_eq!(stage.hook("Stop", stop("p-1", false, "again")), None);
    assert!(stage.inbox().is_empty());
}

#[test]
fn a_blocked_reviewer_that_then_submits_ends_with_its_result() {
    let stage = Stage::new("bridge_block_then_submit", true);
    stage.hook("UserPromptSubmit", prompt("p-1"));
    assert!(stage.hook("Stop", stop("p-1", false, "Done.")).is_some());
    let reply = stage.submit(json!({ "verdict": "CHANGES_REQUIRED",
        "findings": [{ "severity": "HIGH", "summary": "Token not refreshed.", "file": "src/a.ts:3" }] }));
    assert_eq!(reply["isError"], false, "{reply}");
    assert_eq!(stage.hook("Stop", stop("p-1", true, "Submitted.")), None);
    let events = stage.inbox();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].outcome, TurnOutcome::Result);
    assert!(events[0].blocked);
    let result = events[0].result.clone().unwrap();
    assert_eq!(result["verdict"], "CHANGES_REQUIRED");
    assert_eq!(result["findings"][0]["severity"], "HIGH");
}

#[test]
fn a_result_before_the_stop_ends_the_turn_without_a_block() {
    let stage = Stage::new("bridge_result_first", true);
    stage.hook("UserPromptSubmit", prompt("p-1"));
    assert_eq!(stage.submit(approved())["isError"], false);
    assert_eq!(stage.hook("Stop", stop("p-1", false, "Approved.")), None);
    let events = stage.inbox();
    assert_eq!(events[0].outcome, TurnOutcome::Result);
    assert!(!events[0].blocked);
}

#[test]
fn each_turn_gets_its_own_block() {
    let stage = Stage::new("bridge_block_per_turn", true);
    stage.hook("UserPromptSubmit", prompt("p-1"));
    assert!(stage.hook("Stop", stop("p-1", false, "")).is_some());
    assert_eq!(stage.hook("Stop", stop("p-1", false, "")), None, "blocked once per turn");
    stage.hook("UserPromptSubmit", prompt("p-2"));
    assert!(stage.hook("Stop", stop("p-2", false, "")).is_some(), "a new turn is blocked again");
}

#[test]
fn a_result_from_an_earlier_turn_does_not_count() {
    let stage = Stage::new("bridge_old_result", true);
    stage.hook("UserPromptSubmit", prompt("p-1"));
    stage.submit(approved());
    stage.hook("Stop", stop("p-1", false, ""));
    stage.hook("UserPromptSubmit", prompt("p-2"));
    assert!(stage.hook("Stop", stop("p-2", false, "")).is_some());
}

#[test]
fn manual_runs_and_stop_hook_active_are_never_blocked() {
    let manual = Stage::new("bridge_manual", false);
    manual.hook("UserPromptSubmit", prompt("p-1"));
    assert_eq!(manual.hook("Stop", stop("p-1", false, "Hi.")), None);
    assert_eq!(manual.inbox()[0].outcome, TurnOutcome::NoResult);

    let other_hook = Stage::new("bridge_active", true);
    other_hook.hook("UserPromptSubmit", prompt("p-1"));
    assert_eq!(other_hook.hook("Stop", stop("p-1", true, "")), None);
    assert_eq!(other_hook.inbox()[0].outcome, TurnOutcome::NoResult);
}

#[test]
fn an_abandoned_turn_is_replaced_by_the_next_prompt_and_never_reported() {
    let stage = Stage::new("bridge_abandoned", true);
    stage.hook("UserPromptSubmit", prompt("p-1"));
    // Esc: no Stop for p-1 (V0 T4).
    stage.hook("UserPromptSubmit", prompt("p-2"));
    assert_eq!(stage.open().turn().unwrap().turn, "p-2");
    stage.submit(approved());
    stage.hook("Stop", stop("p-2", false, ""));
    let events = stage.inbox();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].turn, "p-2");
}

#[test]
fn a_stop_with_no_prompt_seen_starts_its_own_turn() {
    let stage = Stage::new("bridge_no_ups", true);
    assert!(stage.hook("Stop", stop("p-9", false, "")).is_some());
    assert_eq!(stage.open().turn().unwrap().turn, "p-9");
}

#[test]
fn a_stop_without_a_prompt_id_belongs_to_the_open_turn() {
    let stage = Stage::new("bridge_no_prompt_id", true);
    stage.hook("UserPromptSubmit", json!({ "prompt": "Review" }));
    stage.submit(approved());
    let mut payload = stop("", false, "Approved.");
    payload.as_object_mut().unwrap().remove("prompt_id");
    assert_eq!(stage.hook("Stop", payload), None, "the result filed for the open turn counts");
    assert_eq!(stage.inbox()[0].outcome, TurnOutcome::Result);
}

#[test]
fn pre_tool_use_allows_only_submit_result() {
    let stage = Stage::new("bridge_pretool", false);
    let allow = stage
        .hook("PreToolUse", json!({ "tool_name": FULL_TOOL_NAME, "tool_input": {}, "prompt_id": "p" }))
        .expect("allow");
    assert_eq!(allow["hookSpecificOutput"]["permissionDecision"], "allow");
    assert_eq!(allow["hookSpecificOutput"]["hookEventName"], "PreToolUse");
    assert_eq!(stage.hook("PreToolUse", json!({ "tool_name": "Bash", "tool_input": {} })), None);
}

#[test]
fn unknown_payload_fields_are_logged() {
    let stage = Stage::new("bridge_unknown_fields", false);
    let mut payload = prompt("p-1");
    payload["brand_new_field"] = json!(1);
    stage.hook("UserPromptSubmit", payload);
    let log = std::fs::read_to_string(stage.run_dir.join("bridge.log")).unwrap();
    assert!(log.contains("brand_new_field"), "{log}");
    assert!(!log.contains("prompt_id"), "{log}");
}

// ---- the run folder is checked (D37) --------------------------------------

#[test]
fn a_tab_that_lost_its_stage_is_stale_and_its_hooks_do_nothing() {
    let stage = Stage::new("bridge_stale", true);
    // A newer round's tab takes the stage over.
    launch::prepare_stage(&stage.runs, &plan(true), "tab_reviewer_2").unwrap();
    assert_eq!(
        StageDir::open(&stage.run_dir, RUN, "pr_reviewer", TAB).err(),
        Some(OpenError::Stale)
    );
    let cli = cli_for(&stage.run_dir, "Stop");
    let mut out = Vec::new();
    let code = super::run_hook(&cli, "Stop", stop("p-1", false, "").to_string().as_bytes(), &mut out);
    assert_eq!(code, 0);
    assert!(out.is_empty(), "no block from a stale tab");
    assert!(stage.inbox().is_empty());
    let reply = stage.submit(approved());
    assert_eq!(reply["isError"], true);
}

#[test]
fn the_run_id_stage_and_folder_must_match() {
    let stage = Stage::new("bridge_checks", true);
    let invalid = |dir: &Path, run: &str, key: &str, tab: &str| {
        matches!(StageDir::open(dir, run, key, tab), Err(OpenError::Invalid(_)))
    };
    assert!(invalid(&stage.run_dir, "ee_other", "pr_reviewer", TAB), "run id is not the folder's");
    assert!(invalid(&stage.run_dir, RUN, "planner", TAB), "no such stage");
    assert!(invalid(&stage.run_dir, RUN, "../../etc", TAB), "climbs out");
    assert!(invalid(&stage.run_dir, RUN, "..", TAB));
    assert!(invalid(&stage.run_dir, "../x", "pr_reviewer", TAB));
    assert!(invalid(&stage.run_dir, RUN, "pr_reviewer", "../tab"));
    // A folder named like the run but without its run.json.
    let fake = stage.runs.join("elsewhere").join(RUN);
    std::fs::create_dir_all(&fake).unwrap();
    assert!(invalid(&fake, RUN, "pr_reviewer", TAB));
}

#[test]
fn a_hook_with_a_bad_setup_exits_1_and_writes_nothing() {
    let root = TempDir::new("bridge_bad_setup");
    let dir = root.join(RUN);
    let cli = cli_for(&dir, "Stop");
    let mut out = Vec::new();
    assert_eq!(super::run_hook(&cli, "Stop", &b"{}"[..], &mut out), 1);
    assert!(out.is_empty());
    assert!(!dir.exists(), "nothing created outside a prepared run folder");
    // A command line that does not parse exits 1 too: exit 2 would block a
    // Stop or erase a prompt.
    let args: Vec<String> = ["hook", "--run", RUN].iter().map(|s| s.to_string()).collect();
    assert_eq!(super::run_cli(&args), 1);
}

#[test]
fn odd_turn_ids_are_hashed_into_a_safe_file_name() {
    assert_eq!(folder::turn_file_name("4bb9dfae-c4ce-43d9"), "4bb9dfae-c4ce-43d9.json");
    let odd = folder::turn_file_name("../../x");
    assert!(odd.starts_with("t-") && odd.ends_with(".json") && !odd.contains('/'), "{odd}");
}

fn cli_for(dir: &Path, event: &str) -> Cli {
    Cli {
        mode: Mode::Hook { event: event.into() },
        run_dir: dir.to_path_buf(),
        run_id: RUN.into(),
        stage_key: "pr_reviewer".into(),
        tab_id: TAB.into(),
    }
}

#[test]
fn the_command_line_is_parsed_and_checked() {
    let args = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    let cli = parse_cli(&args(&[
        "hook", "--run-dir", "/r/ee_1", "--run", "ee_1", "--stage", "pr_reviewer", "--tab", "t1", "--event", "Stop",
    ]))
    .unwrap();
    assert_eq!(cli.mode, Mode::Hook { event: "Stop".into() });
    assert_eq!(cli.run_dir, PathBuf::from("/r/ee_1"));
    let mcp = parse_cli(&args(&["mcp", "--run-dir", "/r/ee_1", "--run", "ee_1", "--stage", "s", "--tab", "t"])).unwrap();
    assert_eq!(mcp.mode, Mode::Mcp);
    assert!(parse_cli(&args(&["hook", "--run-dir", "/r", "--run", "x", "--stage", "s", "--tab", "t"])).is_err());
    assert!(parse_cli(&args(&["serve"])).is_err());
    assert!(parse_cli(&args(&["mcp", "--run-dir"])).is_err());
    assert!(parse_cli(&args(&["mcp", "--nope", "1"])).is_err());
}

// ---- schema checks ----------------------------------------------------------

#[test]
fn a_valid_review_is_kept_with_only_the_schema_fields() {
    let result = schema::validate(
        ResultKind::Reviewer,
        &json!({ "schema": 1, "verdict": "APPROVED_WITH_CHANGES", "findings": [
            { "severity": "LOW", "summary": "  Rename x. ", "pr": "PR1", "file": "a.rs:1", "regression": false },
            { "severity": "INFO", "summary": "Nice.", "pr": "" }
        ] }),
    )
    .unwrap();
    assert_eq!(
        result,
        json!({ "schema": 1, "verdict": "APPROVED_WITH_CHANGES", "findings": [
            { "severity": "LOW", "summary": "Rename x.", "pr": "PR1", "file": "a.rs:1", "regression": false },
            { "severity": "INFO", "summary": "Nice." }
        ] })
    );
}

#[test]
fn every_problem_is_named_at_once() {
    let long = "x".repeat(schema::MAX_SUMMARY_CHARS + 1);
    let problems = schema::validate(
        ResultKind::Reviewer,
        &json!({ "schema": 2, "verdict": "REQUEST CHANGES", "extra": true, "findings": [
            { "severity": "SEVERE", "summary": "a" },
            { "summary": long, "lines": 3 },
            "not an object",
            { "severity": "LOW", "summary": "", "regression": "yes", "file": 3 }
        ] }),
    )
    .unwrap_err();
    let all = problems.join("\n");
    for expected in [
        "`schema` must be 1",
        "`extra` is not a field",
        "`verdict` \"REQUEST CHANGES\" is not one of APPROVED, APPROVED_WITH_CHANGES, CHANGES_REQUIRED",
        "REQUEST CHANGES and REQUIRES REVISION are CHANGES_REQUIRED",
        "`findings[0].severity` \"SEVERE\" is not one of",
        "`findings[1].severity` is missing",
        "`findings[1].summary` is 301 characters; at most 300",
        "`findings[1].lines` is not a field",
        "`findings[2]` must be an object",
        "`findings[3].summary` is empty",
        "`findings[3].regression` must be true or false",
        "`findings[3].file` must be a string",
    ] {
        assert!(all.contains(expected), "missing {expected:?} in:\n{all}");
    }
}

#[test]
fn missing_fields_and_wrong_shapes_are_named() {
    let problems = schema::validate(ResultKind::Reviewer, &json!({})).unwrap_err().join("\n");
    assert!(problems.contains("`verdict` is missing"), "{problems}");
    assert!(problems.contains("`findings` is missing"), "{problems}");
    let problems = schema::validate(ResultKind::Reviewer, &json!({ "verdict": 3, "findings": {} }))
        .unwrap_err()
        .join("\n");
    assert!(problems.contains("`verdict` must be a string"), "{problems}");
    assert!(problems.contains("`findings` must be a list"), "{problems}");
    assert!(schema::validate(ResultKind::Reviewer, &json!("APPROVED")).is_err());
}

#[test]
fn changes_required_needs_a_finding_and_findings_are_capped() {
    let empty = schema::validate(ResultKind::Reviewer, &json!({ "verdict": "CHANGES_REQUIRED", "findings": [] }))
        .unwrap_err();
    assert!(empty[0].contains("CHANGES_REQUIRED but `findings` is empty"), "{empty:?}");
    let many: Vec<Value> = (0..=schema::MAX_FINDINGS)
        .map(|i| json!({ "severity": "LOW", "summary": format!("f{i}") }))
        .collect();
    let capped = schema::validate(ResultKind::Reviewer, &json!({ "verdict": "APPROVED", "findings": many }))
        .unwrap_err();
    assert_eq!(capped, vec!["`findings` has 101 items; at most 100".to_string()]);
}

#[test]
fn the_texts_name_the_tool_and_its_arguments() {
    let instructions = schema::result_instructions(ResultKind::Reviewer);
    for word in [FULL_TOOL_NAME, "`verdict`", "`findings`", "APPROVED_WITH_CHANGES", "HANDOFF"] {
        assert!(instructions.contains(word), "{word}");
    }
    let tool = schema::tool_definition(ResultKind::Reviewer);
    assert_eq!(tool["name"], "submit_result");
    assert_eq!(tool["inputSchema"]["required"], json!(["verdict", "findings"]));
}

// ---- the MCP server ---------------------------------------------------------

#[test]
fn the_server_answers_the_handshake_and_lists_one_tool() {
    let stage = Stage::new("bridge_mcp_handshake", true);
    let server = stage.server();
    let init = mcp::handle(&server, &json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": { "protocolVersion": "2025-11-25", "capabilities": {} } }))
    .unwrap();
    assert_eq!(init["result"]["protocolVersion"], "2025-11-25");
    assert_eq!(init["result"]["serverInfo"]["name"], "dcterminal");
    assert!(init["result"]["capabilities"]["tools"].is_object());
    assert_eq!(mcp::handle(&server, &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })), None);
    // Claude Code asks this first; refusing it is fine (V0).
    let discover = mcp::handle(&server, &json!({ "jsonrpc": "2.0", "id": 0, "method": "server/discover" })).unwrap();
    assert_eq!(discover["error"]["code"], -32601);
    let list = mcp::handle(&server, &json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" })).unwrap();
    let tools = list["result"]["tools"].as_array().unwrap();
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0]["name"], "submit_result");
}

#[test]
fn rejected_arguments_get_a_tool_error_and_nothing_is_saved() {
    let stage = Stage::new("bridge_mcp_reject", true);
    stage.hook("UserPromptSubmit", prompt("p-1"));
    let reply = stage.submit(json!({ "verdict": "LGTM", "findings": [] }));
    assert_eq!(reply["isError"], true);
    let text = reply["content"][0]["text"].as_str().unwrap();
    assert!(text.contains("`verdict` \"LGTM\" is not one of"), "{text}");
    assert!(stage.open().result("p-1").is_none());
    // Fixed in the same turn: accepted and filed under the turn.
    let reply = stage.submit(approved());
    assert_eq!(reply["isError"], false);
    assert!(reply["content"][0]["text"].as_str().unwrap().contains("APPROVED"));
    assert_eq!(stage.open().result("p-1").unwrap().result["verdict"], "APPROVED");
}

#[test]
fn the_startup_prompt_turn_counts_even_without_a_user_prompt_submit() {
    // V0 did not check that UserPromptSubmit fires for the positional
    // startup prompt. PreToolUse for the tool carries the prompt_id: it
    // opens the turn, so the result and the Stop join up.
    let stage = Stage::new("bridge_first_turn_pre_tool", true);
    let pre = json!({ "session_id": "s1", "prompt_id": "p-1", "hook_event_name": "PreToolUse",
        "tool_name": FULL_TOOL_NAME, "tool_input": approved() });
    assert!(stage.hook("PreToolUse", pre).is_some(), "allowed");
    assert_eq!(stage.open().turn().unwrap().turn, "p-1");
    assert_eq!(stage.submit(approved())["isError"], false);
    assert_eq!(stage.hook("Stop", stop("p-1", false, "Approved.")), None, "no block: the result is in");
    let events = stage.inbox();
    assert_eq!(events.len(), 1);
    assert_eq!((events[0].turn.as_str(), events[0].outcome), ("p-1", TurnOutcome::Result));

    // Neither hook seen: the tool opens the turn itself and the Stop ends it.
    let stage = Stage::new("bridge_first_turn_tool_only", true);
    assert_eq!(stage.submit(approved())["isError"], false);
    assert_eq!(stage.hook("Stop", stop("p-9", false, "Approved.")), None);
    let events = stage.inbox();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].outcome, TurnOutcome::Result);
    assert!(!events[0].blocked);
    // The next turn starts clean.
    stage.hook("UserPromptSubmit", prompt("p-10"));
    assert!(stage.hook("Stop", stop("p-10", false, "")).is_some(), "a new turn without a result is blocked");
}

#[test]
fn a_call_to_another_tool_is_refused() {
    let stage = Stage::new("bridge_mcp_no_turn", true);
    let other = mcp::handle(&stage.server(), &json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call",
        "params": { "name": "other_tool", "arguments": {} } }))
    .unwrap();
    assert_eq!(other["result"]["isError"], true);
    assert!(stage.open().turn().is_none(), "only submit_result opens a fallback turn");
}

#[test]
fn the_server_reads_lines_until_stdin_closes() {
    let stage = Stage::new("bridge_mcp_serve", true);
    let input = [
        json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {} }).to_string(),
        "not json".to_string(),
        json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }).to_string(),
        json!({ "jsonrpc": "2.0", "id": 2, "method": "ping" }).to_string(),
    ]
    .join("\n");
    let mut out = Vec::new();
    assert_eq!(mcp::serve(&stage.server(), input.as_bytes(), &mut out), 0);
    let replies: Vec<Value> = String::from_utf8(out)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(replies.len(), 3);
    assert_eq!(replies[0]["id"], 1);
    assert_eq!(replies[1]["error"]["code"], -32700);
    assert_eq!(replies[2]["id"], 2);
}

// ---- the app's side ---------------------------------------------------------

fn engine2_run(autopilot: bool) -> PipelineRun {
    let mut run: PipelineRun = serde_json::from_value(json!({
        "id": RUN, "kind": "full", "cwd": "/repo", "stage": "pr_reviewer",
        "tabIds": {}, "createdAt": "2026-10-19T00:00:00Z", "status": "running"
    }))
    .unwrap();
    run.engine = launch::ENGINE_V2;
    run.status = RunStatus::Running;
    run.autopilot = Some(RunAutopilot { enabled: autopilot, ..RunAutopilot::default() });
    run
}

fn chain(step: u32, lane: Option<&str>) -> ChainRef {
    serde_json::from_value(json!({ "chainId": RUN, "kind": "eagle1", "step": step, "total": 4, "lane": lane }))
        .unwrap()
}

#[test]
fn a_saved_run_without_an_engine_is_engine_1_and_is_never_bridged() {
    let run: PipelineRun = serde_json::from_value(json!({
        "id": RUN, "kind": "full", "cwd": "/repo", "stage": "planner",
        "tabIds": {}, "createdAt": "2026-10-19T00:00:00Z"
    }))
    .unwrap();
    assert_eq!(run.engine, 1);
    let def = crate::pipelines::find("full").unwrap();
    assert_eq!(launch::plan_for(&run, &def, &chain(4, None), "role_pr_reviewer"), None);
}

#[test]
fn only_reviewer_stages_of_engine_2_runs_are_bridged() {
    let def = crate::pipelines::find("full").unwrap();
    let run = engine2_run(true);
    let pr = launch::plan_for(&run, &def, &chain(4, None), "role_pr_reviewer").expect("PR Reviewer");
    assert_eq!(pr.stage_key, "pr_reviewer");
    assert_eq!(pr.kind, ResultKind::Reviewer);
    assert!(pr.autopilot);
    let plan_review = launch::plan_for(&run, &def, &chain(2, None), "role_plan_reviewer").expect("Plan Reviewer");
    assert_eq!(plan_review.stage_id, "plan_reviewer");
    // Planner and Implementer wait for V2b; a role off its step is not bridged.
    assert_eq!(launch::plan_for(&run, &def, &chain(1, None), "role_planner"), None);
    assert_eq!(launch::plan_for(&run, &def, &chain(3, None), "role_implementer"), None);
    assert_eq!(launch::plan_for(&run, &def, &chain(4, None), "role_general"), None);
    assert!(!launch::plan_for(&engine2_run(false), &def, &chain(4, None), "role_pr_reviewer").unwrap().autopilot);
}

#[test]
fn a_copied_reviewer_is_bridged_by_its_stage_kind_like_the_built_in_one() {
    let mut def = crate::pipelines::find("full").unwrap();
    let run = engine2_run(true);
    let built_in = launch::plan_for(&run, &def, &chain(4, None), "role_pr_reviewer").unwrap();
    // A copy of the PR Reviewer on the same stage, its kind set explicitly.
    def.stages[3].role_id = "role_custom_7".into();
    def.stages[3].kind = Some(crate::pipelines::StageKind::Reviewer);
    let copied = launch::plan_for(&run, &def, &chain(4, None), "role_custom_7").expect("copied reviewer");
    assert_eq!(copied.kind, built_in.kind);
    assert_eq!(copied.stage_key, built_in.stage_key);
    // A reviewer stage with no loop-back still reports through the bridge.
    def.stages[3].loop_back = None;
    assert!(launch::plan_for(&run, &def, &chain(4, None), "role_custom_7").is_some());
    // A stage marked generic is not a reviewer, even with a loop-back.
    let mut def = crate::pipelines::find("full").unwrap();
    def.stages[3].kind = Some(crate::pipelines::StageKind::Generic);
    assert_eq!(launch::plan_for(&run, &def, &chain(4, None), "role_pr_reviewer"), None);
}

#[test]
fn a_lane_names_its_own_stage_folder() {
    let def = crate::pipelines::find("full").unwrap();
    let mut run = engine2_run(true);
    run.lanes = serde_json::from_value(json!([{ "id": "pr1", "title": "PR1", "status": "active" }])).unwrap();
    let plan = launch::plan_for(&run, &def, &chain(4, Some("pr1")), "role_pr_reviewer").unwrap();
    assert_eq!(plan.stage_key, "pr_reviewer@pr1");
    assert_eq!(plan.lane.as_deref(), Some("pr1"));
    // An unknown lane is ignored, as the decision ignores it.
    let plan = launch::plan_for(&run, &def, &chain(4, Some("pr9")), "role_pr_reviewer").unwrap();
    assert_eq!(plan.stage_key, "pr_reviewer");
}

#[test]
fn a_stage_with_parallel_reviewers_keeps_the_v1_path() {
    let mut def = crate::pipelines::find("full").unwrap();
    def.stages[3].also_reviewers = vec!["role_security_reviewer".into()];
    assert_eq!(launch::plan_for(&engine2_run(true), &def, &chain(4, None), "role_pr_reviewer"), None);
}

/// A bridged role launch as `role_terminal_start` builds it, with H5's
/// status-line settings (`status`) when it applies.
fn bridged_launch(status: Option<Value>, prompt: Option<&str>) -> Vec<String> {
    use crate::provider::{ProgramArgs, TerminalKind, TerminalLaunch};
    let program = Path::new("/Applications/DCTerminal.app/Contents/MacOS/dcterminal");
    let run_dir = Path::new("/data/runs").join(RUN);
    let flags = launch::launch_flags(program, &run_dir, RUN, "pr_reviewer", TAB);
    let request = TerminalLaunch {
        kind: TerminalKind::Role {
            role_id: "role_pr_reviewer".into(),
            run_mode: crate::pty::RunMode::Default,
            prompt: prompt.map(str::to_string),
            stage_kind: None,
        },
        model: Some("opus".into()),
        session_id: Some("6a1d3b0f-2c3d-4e5f-9a51-0123456789cd".into()),
        settings: status,
    };
    launch::bridged_command(request, Some(flags), |req| {
        Ok(ProgramArgs::new("claude", crate::provider::claude::claude_terminal_args(req)?))
    })
    .unwrap()
    .args
}

fn settings_of(args: &[String]) -> Value {
    assert_eq!(args.iter().filter(|a| *a == "--settings").count(), 1, "exactly one --settings: {args:?}");
    let at = args.iter().position(|a| a == "--settings").unwrap();
    serde_json::from_str(&args[at + 1]).unwrap()
}

#[test]
fn a_bridged_launch_merges_the_hooks_and_the_status_line_into_one_settings_flag() {
    let status = crate::status_line::settings("'dct' --dct-status-line '/data/usage/tab.json'");
    let args = bridged_launch(Some(status.clone()), Some("PROMPT"));
    let settings = settings_of(&args);
    assert_eq!(settings["statusLine"], status["statusLine"], "{settings}");
    for event in ["UserPromptSubmit", "Stop", "PreToolUse"] {
        let hook = &settings["hooks"][event][0]["hooks"][0];
        assert_eq!(hook["type"], "command", "{event}");
        let hook_args: Vec<&str> = hook["args"].as_array().unwrap().iter().map(|a| a.as_str().unwrap()).collect();
        assert_eq!(&hook_args[..2], &["bridge", "hook"], "{event}");
        assert_eq!(hook_args.last(), Some(&event), "{event}");
        assert!(hook_args.contains(&TAB) && hook_args.contains(&RUN) && hook_args.contains(&"pr_reviewer"));
    }
    assert_eq!(settings["hooks"]["PreToolUse"][0]["matcher"], FULL_TOOL_NAME);
    // The variadic flags end at --settings (one value), so the prompt stays positional and last.
    let tools = args.iter().position(|a| a == "--allowedTools").unwrap();
    let mcp_at = args.iter().position(|a| a == "--mcp-config").unwrap();
    let settings_at = args.iter().position(|a| a == "--settings").unwrap();
    assert_eq!(args[tools + 1], FULL_TOOL_NAME);
    assert!(tools < mcp_at && mcp_at + 2 == settings_at, "{args:?}");
    assert_eq!(args.last().map(String::as_str), Some("PROMPT"));
    let mcp: Value = serde_json::from_str(&args[mcp_at + 1]).unwrap();
    let server = &mcp["mcpServers"]["dcterminal"];
    assert_eq!(server["type"], "stdio");
    assert_eq!(server["args"][0], "bridge");
    assert_eq!(server["args"][1], "mcp");
}

#[test]
fn when_your_own_status_line_wins_the_bridged_settings_hold_only_the_hooks() {
    let args = bridged_launch(None, None);
    let settings = settings_of(&args);
    assert!(settings.get("statusLine").is_none(), "{settings}");
    assert!(settings["hooks"]["Stop"].is_array(), "{settings}");
    let settings_at = args.iter().position(|a| a == "--settings").unwrap();
    assert_eq!(args[settings_at - 2], "--mcp-config");
}

#[test]
fn turning_autopilot_on_and_off_rewrites_each_stage_mode() {
    let stage = Stage::new("bridge_mode", false);
    assert_eq!(stage.open().mode(), StageMode::Manual);
    launch::set_run_mode(&stage.runs, RUN, true).unwrap();
    assert_eq!(stage.open().mode(), StageMode::Autopilot);
    launch::set_run_mode(&stage.runs, RUN, false).unwrap();
    assert_eq!(stage.open().mode(), StageMode::Manual);
    // A run with no folder (never bridged) is fine.
    launch::set_run_mode(&stage.runs, "ee_never", true).unwrap();
}

#[test]
fn the_latest_finished_turn_is_read_back_for_its_own_tab_only() {
    let stage = Stage::new("bridge_read_back", true);
    let tag = BridgeTag { run_id: RUN.into(), stage: "pr_reviewer".into() };
    assert_eq!(launch::read_stage_turn(&stage.runs, &tag, TAB), None, "no turn yet");
    stage.hook("UserPromptSubmit", prompt("p-1"));
    assert_eq!(launch::read_stage_turn(&stage.runs, &tag, TAB), None, "still running");
    stage.submit(approved());
    stage.hook("Stop", stop("p-1", false, "Approved."));
    let turn = launch::read_stage_turn(&stage.runs, &tag, TAB).expect("ended turn");
    assert_eq!(turn.outcome, TurnOutcome::Result);
    assert_eq!(turn.result.unwrap()["verdict"], "APPROVED");
    assert_eq!(turn.last_assistant_message, "Approved.");
    assert_eq!(launch::read_stage_turn(&stage.runs, &tag, "tab_other"), None);
    // A new tab on the stage starts with no turn.
    launch::prepare_stage(&stage.runs, &plan(true), "tab_reviewer_2").unwrap();
    assert_eq!(launch::read_stage_turn(&stage.runs, &tag, "tab_reviewer_2"), None);
}

#[test]
fn the_inbox_is_drained_once_and_temp_files_are_left_alone() {
    let stage = Stage::new("bridge_inbox", false);
    stage.hook("UserPromptSubmit", prompt("p-1"));
    stage.hook("Stop", stop("p-1", false, ""));
    let inbox = stage.run_dir.join("inbox");
    std::fs::write(inbox.join(".half-written.json.1.2.tmp"), b"{").unwrap();
    std::fs::write(inbox.join("garbage.json"), b"{nope").unwrap();
    assert_eq!(stage.inbox().len(), 1);
    assert!(stage.inbox().is_empty());
    let left: Vec<String> = crate::test_support::names_in(&inbox);
    assert_eq!(left, vec![".half-written.json.1.2.tmp".to_string()]);
    assert_eq!(super::watch::clear_inbox(&stage.runs), 0);
}

#[test]
fn stage_info_round_trips_camel_case() {
    let info: StageInfo = serde_json::from_value(json!({
        "schema": 1, "runId": RUN, "stageKey": "pr_reviewer@pr1", "stageId": "pr_reviewer",
        "roleId": "role_pr_reviewer", "lane": "pr1", "tabId": TAB, "result": "reviewer"
    }))
    .unwrap();
    assert_eq!(info.lane.as_deref(), Some("pr1"));
    assert_eq!(serde_json::to_value(&info).unwrap()["stageKey"], "pr_reviewer@pr1");
}
