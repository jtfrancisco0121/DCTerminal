//! `dcterminal bridge mcp`: a stdio MCP server with one tool,
//! `submit_result`. Newline-delimited JSON-RPC 2.0, as Claude Code speaks it
//! (V0 T5: `server/discover` first, which may be refused, then `initialize`,
//! `notifications/initialized`, `tools/list`, `tools/call`). The server
//! lives as long as the stage's `claude`.
//!
//! An accepted result is written to `results/<turn>.json` for the turn in
//! `turn.json` before the tool answers, so the Stop that follows finds it.
//! An Implementer's also goes to the run's `prs.json` (`prs-<lane>.json`).
//! Rejected arguments get a tool error naming each problem; nothing is
//! written. The stage folder is checked again on every call, so a tab that
//! lost its stage to a newer one cannot report into it.

use super::folder::{OpenError, ResultKind, RunPrs, StageDir, StoredResult, SCHEMA};
use super::schema::{self, TOOL_NAME};
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::path::PathBuf;

/// The protocol version answered when the client names none.
const DEFAULT_PROTOCOL: &str = "2025-06-18";

pub struct Server {
    pub run_dir: PathBuf,
    pub run_id: String,
    pub stage_key: String,
    pub tab_id: String,
    pub kind: ResultKind,
}

impl Server {
    fn open(&self) -> Result<StageDir, OpenError> {
        StageDir::open(&self.run_dir, &self.run_id, &self.stage_key, &self.tab_id)
    }
}

/// Serve until stdin closes.
pub fn serve(server: &Server, input: impl BufRead, mut output: impl Write) -> i32 {
    for line in input.lines() {
        let Ok(line) = line else {
            break;
        };
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Value>(&line) {
            Ok(message) => handle(server, &message),
            Err(err) => Some(error(Value::Null, -32700, &format!("parse error: {err}"))),
        };
        if let Some(reply) = reply {
            let written = serde_json::to_string(&reply)
                .map_err(std::io::Error::other)
                .and_then(|text| writeln!(output, "{text}"))
                .and_then(|_| output.flush());
            if written.is_err() {
                break;
            }
        }
    }
    0
}

fn error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn ok(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn tool_text(text: &str, is_error: bool) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "isError": is_error })
}

/// One JSON-RPC message in, at most one reply out (notifications get none).
pub fn handle(server: &Server, message: &Value) -> Option<Value> {
    let method = message.get("method").and_then(Value::as_str).unwrap_or_default();
    let Some(id) = message.get("id").cloned() else {
        // A notification (`notifications/initialized`, `notifications/cancelled`).
        return None;
    };
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    let reply = match method {
        "initialize" => {
            let version = params
                .get("protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or(DEFAULT_PROTOCOL);
            ok(
                id,
                json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": { "name": schema::SERVER_NAME, "version": env!("CARGO_PKG_VERSION") },
                }),
            )
        }
        "ping" => ok(id, json!({})),
        "tools/list" => ok(id, json!({ "tools": [schema::tool_definition(server.kind)] })),
        "tools/call" => ok(id, call(server, &params)),
        _ => error(id, -32601, &format!("method not found: {method}")),
    };
    Some(reply)
}

fn call(server: &Server, params: &Value) -> Value {
    let name = params.get("name").and_then(Value::as_str).unwrap_or_default();
    if name != TOOL_NAME {
        return tool_text(&format!("Unknown tool {name:?}; this server has only {TOOL_NAME}."), true);
    }
    let dir = match server.open() {
        Ok(dir) => dir,
        Err(OpenError::Stale) => {
            return tool_text(
                "This terminal no longer holds its pipeline stage (a newer tab took it over), so DCTerminal did not take this result.",
                true,
            );
        }
        Err(OpenError::Invalid(why)) => {
            return tool_text(&format!("DCTerminal could not take this result: {why}."), true);
        }
    };
    let Some(turn) = dir.turn() else {
        return tool_text(
            "DCTerminal has not seen this turn start yet, so it cannot file the result. Call submit_result again.",
            true,
        );
    };
    let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
    match schema::validate(dir.info.result, &args) {
        Err(problems) => tool_text(&schema::rejected_message(&problems), true),
        Ok(result) => {
            let stored = StoredResult {
                schema: SCHEMA,
                turn: turn.turn.clone(),
                at: super::folder::now(),
                result: result.clone(),
            };
            let saved = match dir.info.result {
                // The run-level copy first: the result is what ends the turn.
                ResultKind::Implementer => dir
                    .write_prs(&RunPrs {
                        schema: SCHEMA,
                        run_id: dir.info.run_id.clone(),
                        stage_key: dir.info.stage_key.clone(),
                        lane: dir.info.lane.clone(),
                        turn: stored.turn.clone(),
                        at: stored.at.clone(),
                        result: result.clone(),
                    })
                    .and_then(|_| dir.write_result(&stored)),
                _ => dir.write_result(&stored),
            };
            match saved {
                Ok(()) => tool_text(&schema::accepted_message(dir.info.result, &result), false),
                Err(err) => {
                    dir.log(&format!("could not save a result: {err}"));
                    tool_text(&format!("DCTerminal could not save the result ({err}). Call submit_result again."), true)
                }
            }
        }
    }
}
