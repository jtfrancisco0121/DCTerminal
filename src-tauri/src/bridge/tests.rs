//! Bridge unit tests: hook decisions, the block-once rule, schema checks,
//! the MCP server, the Planner's ExitPlanMode capture, Needs you, and the
//! app's side of the run folder. The fake-claude
//! run (hooks and MCP driven by a stand-in `claude`) is in
//! `tests/fake_claude.rs`.

use super::folder::{self, OpenError, StageDir, StageInfo, TurnOutcome};
use super::launch::{self, BridgePlan, BridgeTag};
use super::schema::{self, FULL_TOOL_NAME};
use super::watch::InboxEvent;
use super::{hook, mcp, parse_cli, stop_decision, BridgeNeeds, Cli, Mode, NeedsSource, ResultKind, StageMode, StopDecision};
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

/// A run folder with one stage owned by `TAB` (a reviewer unless made with `of`).
struct Stage {
    _root: TempDir,
    runs: PathBuf,
    run_dir: PathBuf,
    key: String,
    kind: ResultKind,
}

impl Stage {
    fn new(tag: &str, autopilot: bool) -> Self {
        Self::of(tag, plan(autopilot))
    }

    fn of(tag: &str, plan: BridgePlan) -> Self {
        let root = TempDir::new(tag);
        let runs = launch::runs_root(root.path());
        let run_dir = launch::prepare_stage(&runs, &plan, TAB).expect("prepare stage");
        Self { _root: root, runs, run_dir, key: plan.stage_key, kind: plan.kind }
    }

    /// The Planner stage of an Eagle-Eye 1 run.
    fn planner(tag: &str, autopilot: bool) -> Self {
        Self::of(
            tag,
            BridgePlan {
                stage_id: "planner".into(),
                role_id: "role_planner".into(),
                stage_key: "planner".into(),
                kind: ResultKind::Planner,
                ..plan(autopilot)
            },
        )
    }

    /// The Implementer stage, in `lane` when given.
    fn implementer(tag: &str, lane: Option<&str>) -> Self {
        Self::of(
            tag,
            BridgePlan {
                stage_id: "implementer".into(),
                role_id: "role_implementer".into(),
                lane: lane.map(str::to_string),
                stage_key: crate::pipelines::autopilot::stage_key("implementer", lane),
                kind: ResultKind::Implementer,
                ..plan(true)
            },
        )
    }

    fn open(&self) -> StageDir {
        StageDir::open(&self.run_dir, RUN, &self.key, TAB).expect("open stage")
    }

    fn hook(&self, event: &str, payload: Value) -> Option<Value> {
        hook::handle(&self.open(), event, &payload).expect("hook")
    }

    fn server(&self) -> mcp::Server {
        mcp::Server {
            run_dir: self.run_dir.clone(),
            run_id: RUN.into(),
            stage_key: self.key.clone(),
            tab_id: TAB.into(),
            kind: self.kind,
        }
    }

    fn submit(&self, args: Value) -> Value {
        let call = json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/call",
            "params": { "name": "submit_result", "arguments": args } });
        mcp::handle(&self.server(), &call).expect("reply")["result"].clone()
    }

    fn events(&self) -> Vec<InboxEvent> {
        let mut events = Vec::new();
        super::watch::drain_inbox(&self.runs, &mut |event| events.push(event));
        events
    }

    fn inbox(&self) -> Vec<super::BridgeTurn> {
        self.events()
            .into_iter()
            .filter_map(|event| match event {
                InboxEvent::Turn(turn) => Some(turn),
                InboxEvent::Needs(_) => None,
            })
            .collect()
    }

    fn needs(&self) -> Vec<BridgeNeeds> {
        self.events()
            .into_iter()
            .filter_map(|event| match event {
                InboxEvent::Needs(needs) => Some(needs),
                InboxEvent::Turn(_) => None,
            })
            .collect()
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
fn an_idle_prompt_closes_out_an_abandoned_turn_without_a_decision() {
    let stage = Stage::new("bridge_idle_abandoned", true);
    let tag = BridgeTag { run_id: RUN.into(), stage: "pr_reviewer".into() };
    stage.hook("UserPromptSubmit", prompt("p-1"));
    // A result was filed, then Esc: no Stop for p-1 (V0 T4).
    stage.submit(approved());
    assert_eq!(stage.hook("Notification", notification("p-1", "idle_prompt")), None);
    let closed = stage.open().turn().unwrap();
    assert_eq!(closed.ended.as_ref().map(|end| end.outcome), Some(TurnOutcome::Abandoned));
    // Autopilot never acts on it: no inbox event, and Continue reads nothing back.
    assert!(stage.events().is_empty());
    assert_eq!(launch::read_stage_turn(&stage.runs, &tag, TAB), None);
    // A late Stop for the closed turn reports nothing either.
    assert_eq!(stage.hook("Stop", stop("p-1", false, "Approved.")), None);
    assert!(stage.events().is_empty());
    // An idle prompt for another turn, or after a turn that ended, changes nothing.
    stage.hook("UserPromptSubmit", prompt("p-2"));
    stage.hook("Notification", notification("p-1", "idle_prompt"));
    assert_eq!(stage.open().turn().unwrap().ended, None, "p-2 is still open");
    stage.submit(approved());
    stage.hook("Stop", stop("p-2", false, "Approved."));
    stage.hook("Notification", notification("p-2", "idle_prompt"));
    assert_eq!(stage.open().turn().unwrap().ended.map(|end| end.outcome), Some(TurnOutcome::Result));
    assert_eq!(stage.inbox().len(), 1);
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
fn reviewer_planner_and_implementer_stages_of_engine_2_runs_are_bridged() {
    let def = crate::pipelines::find("full").unwrap();
    let run = engine2_run(true);
    let pr = launch::plan_for(&run, &def, &chain(4, None), "role_pr_reviewer").expect("PR Reviewer");
    assert_eq!(pr.stage_key, "pr_reviewer");
    assert_eq!(pr.kind, ResultKind::Reviewer);
    assert!(pr.autopilot);
    let plan_review = launch::plan_for(&run, &def, &chain(2, None), "role_plan_reviewer").expect("Plan Reviewer");
    assert_eq!(plan_review.stage_id, "plan_reviewer");
    // V2b: the Planner and the Implementer too; a role off its step is not bridged.
    let planner = launch::plan_for(&run, &def, &chain(1, None), "role_planner").expect("Planner");
    assert_eq!(planner.kind, ResultKind::Planner);
    let implementer = launch::plan_for(&run, &def, &chain(3, None), "role_implementer").expect("Implementer");
    assert_eq!(implementer.kind, ResultKind::Implementer);
    assert_eq!(launch::plan_for(&run, &def, &chain(3, None), "role_planner"), None);
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
fn copied_planner_and_implementer_roles_are_bridged_by_their_stage_kind() {
    use crate::pipelines::StageKind;
    let mut def = crate::pipelines::find("full").unwrap();
    let run = engine2_run(true);
    def.stages[0].role_id = "role_custom_planner".into();
    def.stages[0].kind = Some(StageKind::Planner);
    def.stages[2].role_id = "role_custom_impl".into();
    def.stages[2].kind = Some(StageKind::Implementer);
    let planner = launch::plan_for(&run, &def, &chain(1, None), "role_custom_planner").expect("copied Planner");
    assert_eq!(planner.kind, ResultKind::Planner);
    assert_eq!(planner.stage_key, "planner");
    let implementer = launch::plan_for(&run, &def, &chain(3, None), "role_custom_impl").expect("copied Implementer");
    assert_eq!(implementer.kind, ResultKind::Implementer);
    // A form start of a pipeline whose first stage is a copied Planner.
    let first = launch::new_chain(&def, "eagle1", 7);
    assert_eq!(
        launch::plan_for_new_run(&def, &first, "role_custom_planner").map(|plan| plan.kind),
        Some(ResultKind::Planner)
    );
    // A built-in Planner role on a stage marked generic is not bridged.
    let mut def = crate::pipelines::find("full").unwrap();
    def.stages[0].kind = Some(StageKind::Generic);
    assert_eq!(launch::plan_for(&run, &def, &chain(1, None), "role_planner"), None);
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

/// V3: the run actor follows only runs whose every stage reports through
/// the bridge; any other run starts on engine 1 and is manual only (V6).
#[test]
fn only_a_pipeline_the_bridge_covers_whole_starts_on_engine_2() {
    let builtin = crate::pipelines::find("full").unwrap();
    assert_eq!(launch::engine_for(&builtin), launch::ENGINE_V2);
    assert_eq!(launch::engine_for(&crate::pipelines::find("execute").unwrap()), launch::ENGINE_V2);
    let mut parallel = builtin.clone();
    parallel.stages[3].also_reviewers = vec!["role_security_reviewer".into()];
    assert_eq!(launch::engine_for(&parallel), 1);
    // A generic stage (H4's kind, not the role id) has no bridged result.
    let mut generic = builtin.clone();
    generic.stages[0].role_id = "role_general".into();
    generic.stages[0].kind = Some(crate::pipelines::StageKind::Generic);
    assert_eq!(launch::engine_for(&generic), 1);
    // Its first stage then starts without the bridge.
    let start = launch::new_chain(&parallel, "custom", 1);
    assert_eq!(launch::plan_for_new_run(&parallel, &start, "role_planner"), None);
    assert!(launch::plan_for_new_run(&builtin, &launch::new_chain(&builtin, "eagle1", 1), "role_planner").is_some());
}

/// V3 with H4: engine 2 follows the stage kinds, so a pipeline of copied
/// Planner, reviewer and Implementer roles gets the run actor like Eagle-Eye 1.
#[test]
fn a_pipeline_of_copied_roles_starts_on_engine_2_like_the_built_in_one() {
    let copied: crate::pipelines::PipelineDef = serde_json::from_value(serde_json::json!({
        "id": "copied_all", "name": "Copied",
        "stages": [
            { "id": "plan", "roleId": "role_custom_planner", "title": "Plan", "kind": "planner" },
            { "id": "plan_check", "roleId": "role_custom_plan_check", "title": "Plan check",
              "loopBack": { "to": "plan", "minSeverity": "MEDIUM" } },
            { "id": "build", "roleId": "role_custom_builder", "title": "Build", "kind": "implementer" },
            { "id": "pr_check", "roleId": "role_custom_pr_check", "title": "PR check",
              "loopBack": { "to": "build", "minSeverity": "MEDIUM" } }
        ]
    }))
    .unwrap();
    assert_eq!(launch::engine_for(&copied), launch::ENGINE_V2);
    let start = launch::new_chain(&copied, "copied_all", 1);
    let plan = launch::plan_for_new_run(&copied, &start, "role_custom_planner").expect("the copied Planner is bridged");
    assert_eq!(plan.kind, ResultKind::Planner);
}

/// A bridged role launch as `role_terminal_start` builds it, with H5's
/// status-line settings (`status`) when it applies.
fn bridged_launch(status: Option<Value>, prompt: Option<&str>) -> Vec<String> {
    bridged_launch_as(ResultKind::Reviewer, "role_pr_reviewer", "pr_reviewer", status, prompt)
}

/// [`bridged_launch`] for a stage reporting as `kind`.
fn bridged_launch_as(
    kind: ResultKind,
    role_id: &str,
    stage_key: &str,
    status: Option<Value>,
    prompt: Option<&str>,
) -> Vec<String> {
    use crate::provider::{ProgramArgs, TerminalKind, TerminalLaunch};
    let program = Path::new("/Applications/DCTerminal.app/Contents/MacOS/dcterminal");
    let run_dir = Path::new("/data/runs").join(RUN);
    let flags = launch::launch_flags(kind, program, &run_dir, RUN, stage_key, TAB);
    let request = TerminalLaunch {
        kind: TerminalKind::Role {
            role_id: role_id.into(),
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
    for event in ["UserPromptSubmit", "Stop", "PreToolUse", "PermissionRequest", "Notification"] {
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
fn every_bridged_stage_type_gets_one_settings_with_the_status_line_and_all_its_hooks() {
    let status = crate::status_line::settings("'dct' --dct-status-line '/data/usage/tab.json'");
    for (kind, role, stage, matcher) in [
        (ResultKind::Planner, "role_planner", "planner", "ExitPlanMode"),
        (ResultKind::Reviewer, "role_pr_reviewer", "pr_reviewer", FULL_TOOL_NAME),
        (ResultKind::Implementer, "role_implementer", "implementer", FULL_TOOL_NAME),
    ] {
        let args = bridged_launch_as(kind, role, stage, Some(status.clone()), Some("PROMPT"));
        let settings = settings_of(&args);
        assert_eq!(settings["statusLine"], status["statusLine"], "{kind:?}: {settings}");
        for event in ["UserPromptSubmit", "Stop", "PreToolUse", "PermissionRequest", "Notification"] {
            let hook = &settings["hooks"][event][0]["hooks"][0];
            assert_eq!(hook["type"], "command", "{kind:?} {event}: {settings}");
            assert_eq!(hook["args"].as_array().unwrap().last().unwrap(), event, "{kind:?} {event}");
        }
        assert_eq!(settings["hooks"]["PreToolUse"][0]["matcher"], matcher, "{kind:?}");
        assert_eq!(args.last().map(String::as_str), Some("PROMPT"), "{kind:?}: {args:?}");
        // The Planner reports through ExitPlanMode: no tool to allow or serve.
        let has_tool = args.iter().any(|a| a == "--allowedTools") && args.iter().any(|a| a == "--mcp-config");
        assert_eq!(has_tool, kind != ResultKind::Planner, "{kind:?}: {args:?}");
    }
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

// ---- the Planner: ExitPlanMode capture (D11, V2b) ---------------------------

fn plan_with(tasks: &str) -> String {
    format!(
        "# Plan: token refresh\n\n## HANDOFF: Plan\n1. Refresh tokens.\n\n## HANDOFF: Pull requests\n\
         * `PR1 — Refresh`: Depends on: none\n* `PR2 — UI`: Depends on: PR1\n\n```json\n{tasks}\n```\n\n\
         ## HANDOFF: Open questions\nNone.\n"
    )
}

const TWO_TASKS: &str = r#"{"tasks": [
  {"id": "pr1", "title": "Refresh", "dependsOn": [], "manual": false, "summary": "Refresh expired tokens."},
  {"id": "PR2", "title": "UI", "dependsOn": ["pr1"], "summary": "Show the session state."}
]}"#;

fn exit_plan_mode(turn: &str, plan: &str) -> Value {
    json!({ "session_id": "s1", "prompt_id": turn, "hook_event_name": "PreToolUse",
        "permission_mode": "plan", "tool_name": "ExitPlanMode",
        "tool_input": { "plan": plan, "planFilePath": "/cfg/plans/x.md" }, "tool_use_id": "toolu_1" })
}

fn denial(reply: &Option<Value>) -> String {
    let reply = reply.as_ref().expect("a reply");
    assert_eq!(reply["hookSpecificOutput"]["hookEventName"], "PreToolUse");
    assert_eq!(reply["hookSpecificOutput"]["permissionDecision"], "deny");
    reply["hookSpecificOutput"]["permissionDecisionReason"].as_str().unwrap().to_string()
}

#[test]
fn a_planners_exit_plan_mode_saves_the_plan_and_tasks_and_is_denied_as_received() {
    let stage = Stage::planner("bridge_plan_taken", true);
    stage.hook("UserPromptSubmit", prompt("p-1"));
    let plan = plan_with(TWO_TASKS);
    let reason = denial(&stage.hook("PreToolUse", exit_plan_mode("p-1", &plan)));
    assert_eq!(reason, schema::PLAN_RECEIVED);
    assert!(reason.contains("do not start implementing"));
    assert_eq!(std::fs::read_to_string(stage.run_dir.join("plan.md")).unwrap(), plan);
    let tasks = launch::read_run_tasks(&stage.runs, RUN).expect("tasks.json");
    assert_eq!(tasks.turn, "p-1");
    assert_eq!(tasks.stage_key, "planner");
    let ids: Vec<&str> = tasks.tasks.iter().map(|t| t.id.as_str()).collect();
    assert_eq!(ids, ["pr1", "pr2"], "ids are lower-cased");
    assert_eq!(tasks.tasks[1].depends_on, ["pr1"]);
    assert!(!tasks.tasks[1].manual, "manual defaults to false");
    // The Stop that follows (no block: the plan is the turn's result).
    assert_eq!(stage.hook("Stop", stop("p-1", false, "The plan is written.")), None);
    let turn = stage.inbox().pop().expect("turn ended");
    assert_eq!(turn.outcome, TurnOutcome::Result);
    assert!(!turn.blocked);
    let result = turn.result.unwrap();
    assert_eq!(result["schema"], 1);
    assert_eq!(result["tasks"][0]["title"], "Refresh");
    assert_eq!(result["tasks"][1]["dependsOn"][0], "pr1");
}

#[test]
fn the_first_turn_without_a_user_prompt_submit_still_works_for_the_planner_and_the_implementer() {
    // The Planner: ExitPlanMode's prompt_id opens the turn, the plan is
    // captured and denied as received, and the Stop ends it with the result.
    let stage = Stage::planner("bridge_plan_first_turn", true);
    let reason = denial(&stage.hook("PreToolUse", exit_plan_mode("p-1", &plan_with(TWO_TASKS))));
    assert_eq!(reason, schema::PLAN_RECEIVED);
    assert_eq!(launch::read_run_tasks(&stage.runs, RUN).expect("tasks.json").turn, "p-1");
    assert_eq!(stage.hook("Stop", stop("p-1", false, "Planned.")), None, "no block: the plan is the result");
    let turn = stage.inbox().pop().expect("turn ended");
    assert_eq!((turn.turn.as_str(), turn.outcome), ("p-1", TurnOutcome::Result));

    // The Implementer, via PreToolUse for submit_result: its prs.json and result join the Stop.
    let stage = Stage::implementer("bridge_impl_first_turn_pre_tool", None);
    let pre = json!({ "session_id": "s1", "prompt_id": "p-1", "hook_event_name": "PreToolUse",
        "tool_name": FULL_TOOL_NAME, "tool_input": implemented() });
    assert!(stage.hook("PreToolUse", pre).is_some(), "allowed");
    assert_eq!(stage.submit(implemented())["isError"], false);
    assert_eq!(stage.hook("Stop", stop("p-1", false, "Opened PR #12.")), None);
    let turn = stage.inbox().pop().expect("turn ended");
    assert_eq!((turn.turn.as_str(), turn.outcome), ("p-1", TurnOutcome::Result));
    let prs: Value = serde_json::from_str(&std::fs::read_to_string(stage.run_dir.join("prs.json")).unwrap()).unwrap();
    assert_eq!(prs["turn"], "p-1");

    // The Implementer with neither hook seen: the tool opens a turn and the Stop ends it.
    let stage = Stage::implementer("bridge_impl_first_turn_tool_only", None);
    assert_eq!(stage.submit(implemented())["isError"], false);
    assert_eq!(stage.hook("Stop", stop("p-9", false, "Opened PR #12.")), None);
    let turn = stage.inbox().pop().expect("turn ended");
    assert_eq!(turn.outcome, TurnOutcome::Result);
    assert_eq!(turn.result.unwrap()["prs"][0]["branch"], "feat/refresh");
}

#[test]
fn a_plan_whose_tasks_have_problems_is_denied_naming_them_and_nothing_is_saved() {
    let stage = Stage::planner("bridge_plan_bad", true);
    stage.hook("UserPromptSubmit", prompt("p-1"));
    let bad = r#"{"tasks": [{"id": "pr1", "title": "A", "summary": "x", "dependsOn": ["pr3"], "owner": "me"}]}"#;
    let reason = denial(&stage.hook("PreToolUse", exit_plan_mode("p-1", &plan_with(bad))));
    assert!(reason.contains("pr1 depends on \"pr3\", which is not a task"), "{reason}");
    assert!(reason.contains("`tasks[0].owner` is not a field"), "{reason}");
    assert!(reason.contains("call ExitPlanMode again"), "{reason}");
    assert!(!stage.run_dir.join("plan.md").exists());
    assert_eq!(launch::read_run_tasks(&stage.runs, RUN), None);
    // Ending the turn without a taken plan: blocked once on autopilot, naming ExitPlanMode.
    let block = stage.hook("Stop", stop("p-1", false, "Here is my plan.")).expect("block");
    assert_eq!(block["decision"], "block");
    assert!(block["reason"].as_str().unwrap().contains("ExitPlanMode"));
    // Fixed in the same turn: taken, and the next stop ends with it.
    denial(&stage.hook("PreToolUse", exit_plan_mode("p-1", &plan_with(TWO_TASKS))));
    assert_eq!(stage.hook("Stop", stop("p-1", true, "Done.")), None);
    let turn = stage.inbox().pop().unwrap();
    assert_eq!(turn.outcome, TurnOutcome::Result);
    assert!(turn.blocked);
}

#[test]
fn a_taken_over_planner_gets_the_normal_dialog_and_other_stages_never_capture_plans() {
    let stage = Stage::planner("bridge_plan_takeover", true);
    folder::write_mode(&stage.run_dir.join("stages/planner"), StageMode::Takeover).unwrap();
    stage.hook("UserPromptSubmit", prompt("p-1"));
    assert_eq!(stage.hook("PreToolUse", exit_plan_mode("p-1", &plan_with(TWO_TASKS))), None);
    assert!(!stage.run_dir.join("tasks.json").exists());
    let reviewer = Stage::new("bridge_plan_reviewer", true);
    reviewer.hook("UserPromptSubmit", prompt("p-1"));
    assert_eq!(reviewer.hook("PreToolUse", exit_plan_mode("p-1", &plan_with(TWO_TASKS))), None);
    assert!(!reviewer.run_dir.join("tasks.json").exists());
}

#[test]
fn a_manual_planner_still_hands_its_plan_over() {
    let stage = Stage::planner("bridge_plan_manual", false);
    // No UserPromptSubmit seen: the plan's turn starts at the hook.
    let reason = denial(&stage.hook("PreToolUse", exit_plan_mode("p-9", &plan_with(TWO_TASKS))));
    assert_eq!(reason, schema::PLAN_RECEIVED);
    assert_eq!(stage.open().turn().unwrap().turn, "p-9");
    stage.hook("Stop", stop("p-9", false, ""));
    assert_eq!(stage.inbox().pop().unwrap().outcome, TurnOutcome::Result);
}

#[test]
fn planner_tasks_name_every_problem() {
    let missing = schema::planner_tasks("# Plan\n\nNo block here.").unwrap_err();
    assert!(missing[0].contains("no ```json block with `tasks`"), "{missing:?}");
    let broken = schema::planner_tasks("```json\n{\"tasks\": [\n```").unwrap_err();
    assert!(broken[0].contains("not valid JSON"), "{broken:?}");
    assert!(schema::planner_tasks("").unwrap_err()[0].contains("empty"));
    let problems = schema::planner_tasks(&plan_with(
        r#"{"tasks": [
            {"id": "pr1", "title": "", "summary": "a", "dependsOn": ["pr1"]},
            {"id": "task-2", "title": "B", "summary": "b", "manual": "no"},
            {"id": "pr1", "title": "C", "summary": "c"},
            "pr4"
        ], "extra": 1}"#,
    ))
    .unwrap_err();
    let text = problems.join("\n");
    for expected in [
        "`extra` is not a field",
        "`tasks[0].title` is empty",
        "`tasks[1].id` \"task-2\" must be pr1, pr2",
        "`tasks[1].manual` must be true or false",
        "`tasks[3]` must be an object",
    ] {
        assert!(text.contains(expected), "missing {expected:?} in:\n{text}");
    }
    let dup = schema::planner_tasks(&plan_with(
        r#"{"tasks": [{"id": "pr1", "title": "A", "summary": "a", "dependsOn": ["pr1"]}, {"id": "pr1", "title": "B", "summary": "b"}]}"#,
    ))
    .unwrap_err()
    .join("\n");
    assert!(dup.contains("pr1 depends on itself") && dup.contains("\"pr1\" is used twice"), "{dup}");
    let cycle = schema::planner_tasks(&plan_with(
        r#"{"tasks": [{"id": "pr1", "title": "A", "summary": "a", "dependsOn": ["pr2"]}, {"id": "pr2", "title": "B", "summary": "b", "dependsOn": ["pr1"]}]}"#,
    ))
    .unwrap_err();
    assert!(cycle[0].contains("pr1 → pr2 → pr1"), "{cycle:?}");
    let many: Vec<Value> = (1..=9).map(|n| json!({ "id": format!("pr{n}"), "title": "T", "summary": "s" })).collect();
    let too_many = schema::planner_tasks(&plan_with(&json!({ "tasks": many }).to_string())).unwrap_err();
    assert!(too_many[0].contains("at most 8"), "{too_many:?}");
    assert!(schema::planner_tasks(&plan_with(r#"{"tasks": []}"#)).unwrap_err()[0].contains("one task"));
}

#[test]
fn the_last_tasks_block_counts_and_other_code_blocks_are_ignored() {
    let plan = "```rust\nfn main() {}\n```\n\n```json\n{\"tasks\": [{\"id\": \"pr1\", \"title\": \"Old\", \"summary\": \"o\"}]}\n```\n\n\
                ```json\n{\"verdict\": \"not tasks\"}\n```\n\n````\n{\"tasks\": [{\"id\": \"pr1\", \"title\": \"New\", \"summary\": \"n\"}]}\n````\n";
    let tasks = schema::planner_tasks(plan).unwrap();
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].title, "New");
    assert!(tasks[0].depends_on.is_empty());
}

// ---- the Implementer: prs[] (V2b) -------------------------------------------

fn implemented() -> Value {
    json!({
        "prs": [{ "url": "https://github.com/acme/app/pull/12", "branch": "feat/refresh", "title": "Refresh tokens", "lane": "pr1" }],
        "summary": "Expired tokens are refreshed once.",
        "checks": [{ "command": "npm test", "passed": true }]
    })
}

#[test]
fn a_valid_implementer_result_is_kept_with_only_the_schema_fields() {
    let result = schema::validate(ResultKind::Implementer, &implemented()).unwrap();
    assert_eq!(result["schema"], 1);
    assert_eq!(result["prs"][0]["url"], "https://github.com/acme/app/pull/12");
    assert_eq!(result["prs"][0]["lane"], "pr1");
    assert_eq!(result["checks"][0]["passed"], true);
    let no_checks = schema::validate(
        ResultKind::Implementer,
        &json!({ "prs": [{ "url": "https://x/pull/1", "branch": "b", "title": "t" }], "summary": "s" }),
    )
    .unwrap();
    assert!(no_checks.get("checks").is_none());
    assert!(no_checks["prs"][0].get("lane").is_none());
}

#[test]
fn implementer_results_name_every_problem() {
    let problems = schema::validate(
        ResultKind::Implementer,
        &json!({
            "prs": [
                { "url": "github.com/acme/app/pull/12", "branch": "feat refresh", "title": "" },
                { "url": "https://x/pull/2", "branch": "b", "title": "t", "draft": true },
                "https://x/pull/3"
            ],
            "checks": [{ "command": "npm test" }, { "command": "", "passed": "yes" }],
            "verdict": "APPROVED"
        }),
    )
    .unwrap_err();
    let text = problems.join("\n");
    for expected in [
        "`verdict` is not a field",
        "`prs[0].url` \"github.com/acme/app/pull/12\" is not a link",
        "`prs[0].branch` \"feat refresh\" has spaces",
        "`prs[0].title` is empty",
        "`prs[1].draft` is not a field",
        "`prs[2]` must be an object",
        "`summary` is missing",
        "`checks[0].passed` is missing",
        "`checks[1].command` is empty",
        "`checks[1].passed` must be true or false",
    ] {
        assert!(text.contains(expected), "missing {expected:?} in:\n{text}");
    }
    let none = schema::validate(ResultKind::Implementer, &json!({ "prs": [], "summary": "s" })).unwrap_err();
    assert!(none[0].contains("`prs` is empty"));
    let nine: Vec<Value> = (1..=9).map(|n| json!({ "url": format!("https://x/pull/{n}"), "branch": "b", "title": "t" })).collect();
    let many = schema::validate(ResultKind::Implementer, &json!({ "prs": nine, "summary": "s" })).unwrap_err();
    assert!(many[0].contains("at most 8"));
    assert!(schema::validate(ResultKind::Planner, &json!({})).unwrap_err()[0].contains("ExitPlanMode"));
}

#[test]
fn an_implementer_submit_saves_its_pull_requests_for_the_run_and_lists_its_own_tool() {
    let stage = Stage::implementer("bridge_impl", Some("pr1"));
    let listed = mcp::handle(&stage.server(), &json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" })).unwrap();
    let tool = &listed["result"]["tools"][0];
    assert_eq!(tool["inputSchema"]["required"], json!(["summary"]));
    stage.hook("UserPromptSubmit", prompt("p-1"));
    let reply = stage.submit(implemented());
    assert_eq!(reply["isError"], false, "{reply}");
    assert!(reply["content"][0]["text"].as_str().unwrap().contains("1 pull request(s)"));
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(stage.run_dir.join("prs-pr1.json")).unwrap()).unwrap();
    assert_eq!(saved["lane"], "pr1");
    assert_eq!(saved["turn"], "p-1");
    assert_eq!(saved["result"]["prs"][0]["branch"], "feat/refresh");
    assert!(!stage.run_dir.join("prs.json").exists(), "a lane writes its own file");
    stage.hook("Stop", stop("p-1", false, "Opened PR #12."));
    let turn = stage.inbox().pop().unwrap();
    assert_eq!(turn.outcome, TurnOutcome::Result);
    assert_eq!(turn.result.unwrap()["summary"], "Expired tokens are refreshed once.");
    // Without a lane: prs.json.
    let single = Stage::implementer("bridge_impl_single", None);
    single.hook("UserPromptSubmit", prompt("p-1"));
    single.submit(implemented());
    assert!(single.run_dir.join("prs.json").exists());
}

#[test]
fn a_blocked_implementer_reports_why_with_no_pull_requests() {
    // With no `prs` at all, or an empty list: `blocked` says why.
    let result = schema::validate(
        ResultKind::Implementer,
        &json!({ "summary": "Nothing could be built.", "blocked": "The plan's API does not exist in this repository." }),
    )
    .expect("a blocked Implementer can report");
    assert_eq!(result["blocked"], "The plan's API does not exist in this repository.");
    assert_eq!(result["prs"], json!([]));
    let empty = json!({ "prs": [], "summary": "s", "blocked": "No access to the remote." });
    assert!(schema::validate(ResultKind::Implementer, &empty).is_ok());
    // Some pull requests opened, then blocked on the rest.
    let mut partial = implemented();
    partial["blocked"] = json!("PR2 needs a design decision.");
    assert_eq!(schema::validate(ResultKind::Implementer, &partial).unwrap()["prs"].as_array().unwrap().len(), 1);
    // A blank reason is a problem; without `blocked`, an empty list still is.
    let blank = schema::validate(ResultKind::Implementer, &json!({ "summary": "s", "blocked": "  " })).unwrap_err();
    assert!(blank.iter().any(|p| p.contains("`blocked`")), "{blank:?}");
    assert!(schema::validate(ResultKind::Implementer, &json!({ "prs": [], "summary": "s" })).is_err());
    // The tool and the block both say how.
    let stage = Stage::implementer("bridge_impl_blocked", None);
    let listed = mcp::handle(&stage.server(), &json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" })).unwrap();
    let input = &listed["result"]["tools"][0]["inputSchema"];
    assert!(input["properties"]["blocked"].is_object(), "{input}");
    assert_eq!(input["required"], json!(["summary"]));
    assert!(schema::result_instructions(ResultKind::Implementer).contains("`blocked`"));
    assert!(schema::block_reason(ResultKind::Implementer).contains("blocked"));
    stage.hook("UserPromptSubmit", prompt("p-1"));
    let reply = stage.submit(json!({ "summary": "s", "blocked": "No access to the remote." }));
    assert_eq!(reply["isError"], false, "{reply}");
    stage.hook("Stop", stop("p-1", false, "Blocked."));
    let turn = stage.inbox().pop().unwrap();
    assert_eq!(turn.outcome, TurnOutcome::Result);
    assert_eq!(turn.result.unwrap()["blocked"], "No access to the remote.");
}

#[test]
fn an_implementer_that_forgets_the_tool_is_told_to_report_its_pull_requests() {
    let stage = Stage::implementer("bridge_impl_forgets", None);
    stage.hook("UserPromptSubmit", prompt("p-1"));
    let block = stage.hook("Stop", stop("p-1", false, "Done.")).expect("block");
    let reason = block["reason"].as_str().unwrap();
    assert!(reason.contains(FULL_TOOL_NAME) && reason.contains("\"prs\""), "{reason}");
}

// ---- Needs you: PermissionRequest, then the Notification backup (D22) -------

fn permission_request(turn: &str, tool: &str) -> Value {
    json!({ "session_id": "s1", "prompt_id": turn, "hook_event_name": "PermissionRequest",
        "permission_mode": "default", "tool_name": tool, "tool_input": { "command": "git push" },
        "permission_suggestions": [] })
}

fn notification(turn: &str, kind: &str) -> Value {
    json!({ "session_id": "s1", "prompt_id": turn, "hook_event_name": "Notification",
        "message": "Claude needs your permission", "notification_type": kind })
}

#[test]
fn a_permission_request_posts_needs_you_and_leaves_the_dialog_alone() {
    let stage = Stage::implementer("bridge_needs", None);
    stage.hook("UserPromptSubmit", prompt("p-1"));
    assert_eq!(stage.hook("PermissionRequest", permission_request("p-1", "Bash")), None, "no decision: the dialog stays");
    let needs = stage.needs();
    assert_eq!(needs.len(), 1);
    assert_eq!(needs[0].source, NeedsSource::PermissionRequest);
    assert_eq!(needs[0].tool.as_deref(), Some("Bash"));
    assert_eq!(needs[0].turn, "p-1");
    assert_eq!(needs[0].tab_id, TAB);
    assert_eq!(needs[0].stage_key, "implementer");
    // The late Notification for the same turn is not posted again.
    assert_eq!(stage.hook("Notification", notification("p-1", "permission_prompt")), None);
    assert!(stage.needs().is_empty());
    // An idle notification is not Needs you: it closes out the turn whose
    // permission was rejected (no Stop came, D9a) as abandoned, with no
    // event for autopilot. (This used to assert it did nothing at all.)
    stage.hook("Notification", notification("p-1", "idle_prompt"));
    assert!(stage.events().is_empty());
    let closed = stage.open().turn().unwrap();
    assert_eq!(closed.turn, "p-1");
    assert_eq!(closed.ended.map(|end| end.outcome), Some(TurnOutcome::Abandoned));
    // A turn whose PermissionRequest never came: the Notification is the backup.
    stage.hook("UserPromptSubmit", prompt("p-2"));
    stage.hook("Notification", notification("p-2", "permission_prompt"));
    let backup = stage.needs();
    assert_eq!(backup.len(), 1);
    assert_eq!(backup[0].source, NeedsSource::PermissionPrompt);
    assert_eq!(backup[0].tool, None);
    assert_eq!(backup[0].message, "Claude needs your permission");
    // Needs you never ends a turn.
    assert!(stage.inbox().is_empty());
    let unknown = std::fs::read_to_string(stage.run_dir.join("bridge.log")).unwrap_or_default();
    assert!(!unknown.contains("fields not seen"), "{unknown}");
}

#[test]
fn a_turn_id_with_needs_in_it_still_ends_as_a_turn() {
    let stage = Stage::implementer("bridge_needs_name", None);
    stage.hook("UserPromptSubmit", prompt("p-needs-1"));
    assert_eq!(stage.hook("Stop", stop("p-needs-1", true, "Done.")), None);
    let events = stage.events();
    assert_eq!(events.len(), 1, "{events:?}");
    assert!(matches!(&events[0], InboxEvent::Turn(turn) if turn.turn == "p-needs-1"), "{events:?}");
}

#[test]
fn planner_launch_flags_have_no_tool_and_watch_exit_plan_mode() {
    let program = Path::new("/bin/dcterminal");
    let run_dir = Path::new("/data/runs").join(RUN);
    let extra = launch::launch_flags(ResultKind::Planner, program, &run_dir, RUN, "planner", TAB);
    assert!(extra.args.is_empty(), "{extra:?}");
    let settings = &extra.hooks;
    assert_eq!(settings["hooks"]["PreToolUse"][0]["matcher"], "ExitPlanMode");
    assert!(settings["hooks"]["PermissionRequest"][0].get("matcher").is_none());
    let implementer = launch::launch_flags(ResultKind::Implementer, program, &run_dir, RUN, "implementer", TAB);
    assert_eq!(implementer.args[0], "--allowedTools");
    // A relaunch keeps the stage's own kind.
    let stage = Stage::planner("bridge_plan_relaunch", true);
    let tag = BridgeTag { run_id: RUN.into(), stage: "planner".into() };
    let again = launch::relaunch_flags(&stage.runs, &tag, TAB, program).unwrap();
    assert!(again.args.is_empty(), "{again:?}");
    assert_eq!(again.hooks["hooks"]["PreToolUse"][0]["matcher"], "ExitPlanMode");
}

#[test]
fn the_role_texts_say_how_each_stage_reports() {
    let planner = schema::result_instructions(ResultKind::Planner);
    assert!(planner.contains("ExitPlanMode") && planner.contains("```json") && planner.contains("dependsOn"));
    assert!(!planner.contains(FULL_TOOL_NAME), "the Planner has no tool");
    let implementer = schema::result_instructions(ResultKind::Implementer);
    assert!(implementer.contains(FULL_TOOL_NAME) && implementer.contains("`prs`"));
    assert!(schema::block_reason(ResultKind::Planner).contains("ExitPlanMode"));
}

#[test]
fn a_chain_a_form_start_begins_plans_its_first_stage_as_an_engine_2_run() {
    let eagle1 = crate::pipelines::find("eagle1").unwrap();
    let chain = launch::new_chain(&eagle1, "eagle1", 1_760_000_000_123);
    assert_eq!(chain.chain_id, "ee_1760000000123");
    assert_eq!((chain.step, chain.total, chain.lane.as_deref()), (1, 4, None));
    let planner = launch::plan_for_new_run(&eagle1, &chain, "role_planner").expect("Planner");
    assert_eq!(planner.run_id, "ee_1760000000123");
    assert_eq!(planner.kind, ResultKind::Planner);
    assert!(!planner.autopilot, "a new run starts with autopilot off");
    // The form's role must be the first stage's.
    assert_eq!(launch::plan_for_new_run(&eagle1, &chain, "role_implementer"), None);
    let eagle2 = crate::pipelines::find("eagle2").unwrap();
    let chain = launch::new_chain(&eagle2, "eagle2", 1);
    assert_eq!(chain.total, 2);
    assert_eq!(launch::plan_for_new_run(&eagle2, &chain, "role_implementer").unwrap().kind, ResultKind::Implementer);
}

// ---- L1: a task names a repo from Settings › Repos --------------------------

fn repos(names: &[&str]) -> Vec<String> {
    names.iter().map(|name| name.to_string()).collect()
}

#[test]
fn a_task_may_name_a_known_repo_in_any_case_and_keeps_its_settings_spelling() {
    let block = r#"{"tasks": [
      {"id": "pr1", "title": "API", "summary": "a", "repo": "Backend"},
      {"id": "pr2", "title": "Client", "summary": "b", "dependsOn": ["pr1"], "repo": " engine "},
      {"id": "pr3", "title": "Docs", "summary": "c", "repo": ""},
      {"id": "pr4", "title": "Notes", "summary": "d", "repo": null}
    ]}"#;
    let tasks = schema::planner_tasks_with(&plan_with(block), &repos(&["backend", "engine"])).unwrap();
    let named: Vec<Option<&str>> = tasks.iter().map(|t| t.repo.as_deref()).collect();
    assert_eq!(named, [Some("backend"), Some("engine"), None, None]);
    assert_eq!(tasks[1].depends_on, ["pr1"], "a dependency across repos is a plain dependency");
    // Saved without `repo` when there is none, so tasks.json reads as before L1.
    let saved = serde_json::to_value(&tasks[2]).unwrap();
    assert!(saved.get("repo").is_none(), "{saved}");
    assert_eq!(serde_json::to_value(&tasks[0]).unwrap()["repo"], "backend");
}

#[test]
fn an_unknown_repo_is_rejected_with_the_valid_names_and_every_other_problem() {
    let block = r#"{"tasks": [
      {"id": "pr1", "title": "", "summary": "a", "repo": "web"},
      {"id": "pr2", "title": "B", "summary": "b", "repo": 7}
    ]}"#;
    let problems = schema::planner_tasks_with(&plan_with(block), &repos(&["backend", "engine"])).unwrap_err();
    let text = problems.join("\n");
    for expected in [
        "`tasks[0].title` is empty",
        "`tasks[0].repo` \"web\" is not one of the repos in Settings › Repos (backend, engine)",
        "`tasks[1].repo` must be a repo name such as \"backend\", not 7",
    ] {
        assert!(text.contains(expected), "missing {expected:?} in:\n{text}");
    }
    // No repos set up: a task that names one is told to leave it out.
    let none = schema::planner_tasks(&plan_with(r#"{"tasks": [{"id": "pr1", "title": "A", "summary": "a", "repo": "backend"}]}"#))
        .unwrap_err();
    assert!(none[0].contains("none are set up in DCTerminal's Settings › Repos, so leave `repo` out"), "{none:?}");
    // And a plan without `repo` reads exactly as before, with or without repos.
    let old = schema::planner_tasks_with(&plan_with(TWO_TASKS), &repos(&["backend"])).unwrap();
    assert_eq!(old, schema::planner_tasks(&plan_with(TWO_TASKS)).unwrap());
    assert!(old.iter().all(|t| t.repo.is_none()));
}

#[test]
fn the_planners_hook_checks_repos_against_the_run_folders_repos_json() {
    let stage = Stage::planner("bridge_plan_repos", true);
    stage.hook("UserPromptSubmit", prompt("p-1"));
    let spans = r#"{"tasks": [
      {"id": "pr1", "title": "API", "summary": "a", "repo": "backend"},
      {"id": "pr2", "title": "Client", "summary": "b", "dependsOn": ["pr1"], "repo": "engine"}
    ]}"#;
    // Before the app wrote repos.json (a run folder from before L1): no repos.
    let reason = denial(&stage.hook("PreToolUse", exit_plan_mode("p-1", &plan_with(spans))));
    assert!(reason.contains("`tasks[0].repo` \"backend\" is not a repo: none are set up"), "{reason}");
    assert_eq!(launch::read_run_tasks(&stage.runs, RUN), None);
    // The app writes repos.json at launch; the bridge only reads it.
    let entry = |name: &str| crate::store::RepoEntry { name: name.into(), folder: format!("/src/{name}") };
    launch::write_run_repos(&stage.run_dir, &[entry("backend")]).unwrap();
    let reason = denial(&stage.hook("PreToolUse", exit_plan_mode("p-1", &plan_with(spans))));
    assert!(reason.contains("`tasks[1].repo` \"engine\" is not one of the repos in Settings › Repos (backend)"), "{reason}");
    launch::write_run_repos(&stage.run_dir, &[entry("backend"), entry("engine")]).unwrap();
    let reason = denial(&stage.hook("PreToolUse", exit_plan_mode("p-1", &plan_with(spans))));
    assert_eq!(reason, schema::PLAN_RECEIVED);
    let tasks = launch::read_run_tasks(&stage.runs, RUN).expect("tasks.json");
    let named: Vec<Option<&str>> = tasks.tasks.iter().map(|t| t.repo.as_deref()).collect();
    assert_eq!(named, [Some("backend"), Some("engine")]);
    let file: Value = serde_json::from_str(&std::fs::read_to_string(stage.run_dir.join("repos.json")).unwrap()).unwrap();
    assert_eq!(file["repos"][1], json!({ "name": "engine", "folder": "/src/engine" }));
}

#[test]
fn the_planners_prompt_lists_the_repos_only_when_there_are_some() {
    let entry = |name: &str, folder: &str| crate::store::RepoEntry { name: name.into(), folder: folder.into() };
    let repos = [entry("backend", "/src/koneksi-backend"), entry("engine", "/src/koneksi-engine")];
    let planner = schema::stage_instructions(ResultKind::Planner, &repos);
    assert!(planner.starts_with(&schema::result_instructions(ResultKind::Planner)));
    assert!(planner.contains("- `backend`: /src/koneksi-backend\n- `engine`: /src/koneksi-engine"), "{planner}");
    assert!(planner.contains("add `repo` to each task") && planner.contains("\"repo\": \"backend\""), "{planner}");
    assert_eq!(schema::stage_instructions(ResultKind::Planner, &[]), schema::result_instructions(ResultKind::Planner));
    for kind in [ResultKind::Reviewer, ResultKind::Implementer] {
        assert_eq!(schema::stage_instructions(kind, &repos), schema::result_instructions(kind), "{kind:?}");
    }
}
