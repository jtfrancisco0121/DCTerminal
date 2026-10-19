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
//!   would otherwise prompt for despite `--allowedTools` (D12, V0 T6).

use super::folder::{BridgeTurn, StageDir, StageMode, TurnEnd, TurnOutcome, TurnState};
use super::schema::{block_reason, FULL_TOOL_NAME};
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
        "PreToolUse" if text(payload, "tool_name") == Some(FULL_TOOL_NAME) => Ok(Some(json!({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "allow",
                "permissionDecisionReason": "DCTerminal's own result tool"
            }
        }))),
        _ => Ok(None),
    }
}

fn on_stop(dir: &StageDir, payload: &Value) -> Result<Option<Value>, String> {
    let open = dir.turn();
    // Without a `prompt_id` the Stop belongs to the turn still open.
    let turn = prompt_id(payload)
        .or_else(|| open.as_ref().filter(|t| t.ended.is_none()).map(|t| t.turn.clone()))
        .unwrap_or_else(new_turn_id);
    let mut state = match open {
        Some(state) if state.turn == turn => state,
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
