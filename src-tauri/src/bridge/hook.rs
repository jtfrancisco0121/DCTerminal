//! `dcterminal bridge hook`: one hook event per process. Claude Code passes
//! the event's JSON payload on stdin; the reply (if any) goes to stdout as
//! JSON with exit 0 (V0 T3, T7).
//!
//! - **UserPromptSubmit** starts a turn: `turn.json` with Claude's
//!   `prompt_id` (D9). A turn that never got its Stop (Esc, a rejected
//!   permission) is simply replaced (D9a); nothing acts on it.
//! - **Stop** ends a turn. On autopilot, a stop with no accepted result is
//!   blocked once, only while `stop_hook_active` is false (D10); the next
//!   stop ends the turn as `no_result`. Every end lands in `inbox/` for the
//!   app and in `turn.json` for Continue.
//! - **PreToolUse** answers `allow` for `submit_result`, which plan mode
//!   would otherwise prompt for despite `--allowedTools` (D12, V0 T6). When
//!   no turn is open under its `prompt_id` (V0 did not verify that the
//!   positional startup prompt sends UserPromptSubmit), it opens that turn.
//! - **PreToolUse(ExitPlanMode)** on a Planner stage takes the plan (D11,
//!   V0 T7): with a valid tasks block it saves `plan.md`, `tasks.json` and
//!   the turn's result, then answers `deny` with "Plan received", which ends
//!   the turn with no approval dialog; with problems it answers `deny`
//!   naming each one, so Claude fixes the block and calls it again. A
//!   taken-over stage gets the normal dialog. Like `submit_result`, it opens
//!   the turn from its `prompt_id` when no hook opened one.
//! - **PermissionRequest** is the Needs you signal (D22, V0 amendment): the
//!   dialog is up now. It drops a Needs you in `inbox/` and answers nothing,
//!   so the dialog stays for you. The `permission_prompt` **Notification**
//!   (about 6 s late) is the backup: posted only when no PermissionRequest
//!   was posted for that turn. Other notifications are kept, not acted on.

use super::folder::{
    BridgeNeeds, BridgeTurn, NeedsSource, RunTasks, StageDir, StageMode, StoredResult, TurnEnd, TurnOutcome,
    TurnState, SCHEMA,
};
use super::schema::{self, block_reason, FULL_TOOL_NAME};
use super::ResultKind;
use serde_json::{json, Value};

/// What a Stop does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopDecision {
    /// Keep the turn going and tell Claude to call `submit_result`.
    Block,
    /// The turn is over.
    End(TurnOutcome),
}

/// D10: block at most once per turn, only on autopilot, and never when
/// Claude is already continuing because of a Stop hook.
pub fn stop_decision(mode: StageMode, stop_hook_active: bool, has_result: bool, blocked: bool) -> StopDecision {
    if has_result {
        return StopDecision::End(TurnOutcome::Result);
    }
    if mode == StageMode::Autopilot && !blocked && !stop_hook_active {
        return StopDecision::Block;
    }
    StopDecision::End(TurnOutcome::NoResult)
}

/// Payload fields Claude Code 2.1.287 sends (docs/claude-hooks-observed.md).
/// Others are logged once per event, so a new version shows up (D24).
const COMMON_FIELDS: [&str; 6] = [
    "session_id",
    "transcript_path",
    "cwd",
    "scratchpad_dir",
    "prompt_id",
    "hook_event_name",
];

fn known_fields(event: &str) -> &'static [&'static str] {
    match event {
        "UserPromptSubmit" => &["permission_mode", "prompt"],
        "Stop" => &[
            "permission_mode",
            "stop_hook_active",
            "last_assistant_message",
            "background_tasks",
            "session_crons",
            "effort",
        ],
        "PreToolUse" => &["permission_mode", "tool_name", "tool_input", "tool_use_id", "mcp_server"],
        "PermissionRequest" => &["permission_mode", "tool_name", "tool_input", "permission_suggestions", "mcp_server"],
        "Notification" => &["message", "notification_type"],
        _ => &[],
    }
}

fn note_unknown_fields(dir: &StageDir, event: &str, payload: &Value) {
    let Some(object) = payload.as_object() else {
        return;
    };
    let known = known_fields(event);
    let unknown: Vec<&str> = object
        .keys()
        .map(String::as_str)
        .filter(|key| !COMMON_FIELDS.contains(key) && !known.contains(key))
        .collect();
    if !unknown.is_empty() {
        dir.log(&format!("{event} payload has fields not seen on 2.1.287: {}", unknown.join(", ")));
    }
}

fn text<'a>(payload: &'a Value, key: &str) -> Option<&'a str> {
    payload.get(key).and_then(Value::as_str)
}

/// Claude's `prompt_id` (D9), when the payload has one.
fn prompt_id(payload: &Value) -> Option<String> {
    text(payload, "prompt_id")
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
}

fn new_turn_id() -> String {
    format!("turn-{}", uuid::Uuid::new_v4())
}

/// A turn `submit_result` opened because no hook had started one (the
/// startup prompt, if Claude Code sends no UserPromptSubmit for it).
const TOOL_TURN_PREFIX: &str = "tool-";

pub(crate) fn tool_turn_id() -> String {
    format!("{TOOL_TURN_PREFIX}{}", uuid::Uuid::new_v4())
}

/// Handle one hook event for a checked stage folder. `Ok(Some(reply))` is
/// printed to stdout.
pub fn handle(dir: &StageDir, event: &str, payload: &Value) -> Result<Option<Value>, String> {
    dir.keep_payload(event, payload);
    note_unknown_fields(dir, event, payload);
    match event {
        "UserPromptSubmit" => {
            // Without a `prompt_id` the turn gets an id of its own (D9's fallback).
            let state = TurnState::new(&prompt_id(payload).unwrap_or_else(new_turn_id));
            dir.write_turn(&state).map_err(|err| format!("write turn.json: {err}"))?;
            Ok(None)
        }
        "Stop" => on_stop(dir, payload),
        "PreToolUse" if text(payload, "tool_name") == Some(FULL_TOOL_NAME) => {
            // No UserPromptSubmit seen for this turn (the startup prompt was
            // not verified to send one): the tool call's prompt_id opens it.
            if let Some(id) = prompt_id(payload) {
                if dir.turn().is_none_or(|open| open.turn != id) {
                    dir.write_turn(&TurnState::new(&id)).map_err(|err| format!("write turn.json: {err}"))?;
                }
            }
            Ok(Some(json!({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "allow",
                "permissionDecisionReason": "DCTerminal's own result tool"
            }
        })))
        }
        "PreToolUse"
            if text(payload, "tool_name") == Some("ExitPlanMode")
                && dir.info.result == ResultKind::Planner
                && dir.mode() != StageMode::Takeover =>
        {
            on_plan(dir, payload)
        }
        "PermissionRequest" => {
            let tool = text(payload, "tool_name").map(str::to_string);
            post_needs(dir, payload, NeedsSource::PermissionRequest, tool, String::new())?;
            Ok(None)
        }
        "Notification" if text(payload, "notification_type") == Some("permission_prompt") => {
            let turn = prompt_id(payload).unwrap_or_default();
            // The backup: the PermissionRequest of this turn said so already.
            let told = dir
                .needs_mark()
                .is_some_and(|mark| mark.turn == turn && mark.source == NeedsSource::PermissionRequest);
            if !told {
                let message = text(payload, "message").unwrap_or_default().to_string();
                post_needs(dir, payload, NeedsSource::PermissionPrompt, None, message)?;
            }
            Ok(None)
        }
        "Notification" if text(payload, "notification_type") == Some("idle_prompt") => close_abandoned(dir, payload),
        _ => Ok(None),
    }
}

/// D9a: Claude sits idle while its turn has a start and no end (Esc or a
/// rejected permission fires no Stop). The turn is closed out as abandoned
/// in `turn.json` only: nothing goes to `inbox/`, so autopilot never acts
/// on it, whatever result it filed. An idle prompt naming another turn, or
/// one after a turn that ended, changes nothing.
fn close_abandoned(dir: &StageDir, payload: &Value) -> Result<Option<Value>, String> {
    let Some(mut state) = dir.turn().filter(|t| t.ended.is_none()) else {
        return Ok(None);
    };
    if prompt_id(payload).is_some_and(|id| id != state.turn) {
        return Ok(None);
    }
    state.ended = Some(TurnEnd {
        at: super::folder::now(),
        outcome: TurnOutcome::Abandoned,
        last_assistant_message: String::new(),
    });
    dir.write_turn(&state).map_err(|err| format!("write turn.json: {err}"))?;
    Ok(None)
}

fn post_needs(
    dir: &StageDir,
    payload: &Value,
    source: NeedsSource,
    tool: Option<String>,
    message: String,
) -> Result<(), String> {
    let turn = prompt_id(payload).unwrap_or_default();
    let needs = BridgeNeeds::new(&dir.info, &turn, source, tool, message);
    dir.post_needs(&needs).map_err(|err| format!("write inbox: {err}"))
}

fn deny(reason: &str) -> Value {
    json!({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason
        }
    })
}

/// The turn a hook in the middle of a turn belongs to: Claude's
/// `prompt_id`, else the open turn, else a new one (written to `turn.json`).
fn current_turn(dir: &StageDir, payload: &Value) -> Result<TurnState, String> {
    let open = dir.turn().filter(|t| t.ended.is_none());
    let turn = prompt_id(payload)
        .or_else(|| open.as_ref().map(|t| t.turn.clone()))
        .unwrap_or_else(new_turn_id);
    match open {
        Some(state) if state.turn == turn => Ok(state),
        _ => {
            let state = TurnState::new(&turn);
            dir.write_turn(&state).map_err(|err| format!("write turn.json: {err}"))?;
            Ok(state)
        }
    }
}

/// PreToolUse(ExitPlanMode) on a Planner stage (D11).
fn on_plan(dir: &StageDir, payload: &Value) -> Result<Option<Value>, String> {
    let plan = payload
        .pointer("/tool_input/plan")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let tasks = match schema::planner_tasks(plan) {
        Ok(tasks) => tasks,
        Err(problems) => return Ok(Some(deny(&schema::plan_rejected_message(&problems)))),
    };
    let state = current_turn(dir, payload)?;
    let at = super::folder::now();
    let file = RunTasks {
        schema: SCHEMA,
        run_id: dir.info.run_id.clone(),
        stage_key: dir.info.stage_key.clone(),
        turn: state.turn.clone(),
        at: at.clone(),
        tasks,
    };
    dir.write_plan(plan, &file).map_err(|err| format!("write plan.md and tasks.json: {err}"))?;
    let stored = StoredResult {
        schema: SCHEMA,
        turn: state.turn.clone(),
        at,
        result: schema::planner_result(&file.tasks),
    };
    dir.write_result(&stored).map_err(|err| format!("write the plan's result: {err}"))?;
    Ok(Some(deny(schema::PLAN_RECEIVED)))
}

fn on_stop(dir: &StageDir, payload: &Value) -> Result<Option<Value>, String> {
    let open = dir.turn();
    // Without a `prompt_id` the Stop belongs to the turn still open.
    let turn = prompt_id(payload)
        .or_else(|| open.as_ref().filter(|t| t.ended.is_none()).map(|t| t.turn.clone()))
        .unwrap_or_else(new_turn_id);
    let mut state = match open {
        Some(state) if state.turn == turn => state,
        // A turn the tool opened (no hook had started one): this Stop ends it.
        Some(state) if state.ended.is_none() && state.turn.starts_with(TOOL_TURN_PREFIX) => state,
        // No UserPromptSubmit seen for this turn: it starts here.
        _ => TurnState::new(&turn),
    };
    if state.ended.is_some() {
        // Claude went on after the turn ended (another Stop hook blocked
        // it): the end was reported already, once is enough.
        return Ok(None);
    }
    let active = payload.get("stop_hook_active").and_then(Value::as_bool).unwrap_or(false);
    let result = dir.result(&state.turn);
    match stop_decision(dir.mode(), active, result.is_some(), state.blocked) {
        StopDecision::Block => {
            state.blocked = true;
            dir.write_turn(&state).map_err(|err| format!("write turn.json: {err}"))?;
            Ok(Some(json!({ "decision": "block", "reason": block_reason(dir.info.result) })))
        }
        StopDecision::End(outcome) => {
            let end = TurnEnd {
                at: super::folder::now(),
                outcome,
                last_assistant_message: text(payload, "last_assistant_message").unwrap_or_default().to_string(),
            };
            state.ended = Some(end.clone());
            dir.write_turn(&state).map_err(|err| format!("write turn.json: {err}"))?;
            let event = BridgeTurn::new(&dir.info, &state, &end, result.map(|r| r.result));
            dir.post(&event).map_err(|err| format!("write inbox: {err}"))?;
            Ok(None)
        }
    }
}
