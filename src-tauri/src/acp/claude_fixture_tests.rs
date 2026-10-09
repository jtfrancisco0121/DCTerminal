//! Claude ACP payloads captured on JT's Mac (adapter 0.88.0, Claude Code
//! 2.1.236, `CLAUDE_CONFIG_DIR=~/.claude-account2`, 2026-10-09), redacted.
//! See `docs/claude-acp-observed.md`.

use super::session_connect::{
    advertised_modes, capabilities_from_initialize, mode_to_set, model_requests,
    parse_session_models,
};
use super::session_update::map_session_update;
use crate::provider::{claude::ClaudeProvider, CursorProvider, Provider};
use serde_json::{json, Value};

fn fixture(name: &str) -> Value {
    let path = format!(
        "{}/../fixtures/acp/claude/{name}",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

#[test]
fn initialize_offers_load_and_no_login_methods() {
    let init = fixture("initialize-response.json");
    let result = &init["result"];
    assert!(capabilities_from_initialize(result).load_session);
    assert_eq!(result["authMethods"], json!([]));
    assert_eq!(result["agentInfo"]["version"], json!("0.88.0"));
}

#[test]
fn session_new_advertises_auto_and_bypass_and_claude_models() {
    let new = fixture("session-new.json");
    assert_eq!(
        new["request"]["params"]["_meta"],
        ClaudeProvider::default()
            .session_new_meta(&Default::default())
            .unwrap()
    );
    let result = &new["response"]["result"];
    let modes = advertised_modes(result);
    for mode in [
        "default",
        "acceptEdits",
        "plan",
        "auto",
        "bypassPermissions",
    ] {
        assert!(modes.iter().any(|m| m == mode), "{mode}");
    }
    let claude = ClaudeProvider::default();
    assert_eq!(
        mode_to_set(&claude, "bypassPermissions", result),
        "bypassPermissions"
    );
    assert_eq!(mode_to_set(&claude, "auto", result), "auto");
    let mut no_bypass = result.clone();
    no_bypass["modes"]["availableModes"] = json!([{ "id": "default" }, { "id": "plan" }]);
    assert_eq!(
        mode_to_set(&claude, "bypassPermissions", &no_bypass),
        "default"
    );
    // Cursor modes are never rewritten.
    assert_eq!(mode_to_set(&CursorProvider, "agent", &no_bypass), "agent");

    let models = parse_session_models(result);
    assert_eq!(models.config_id.as_deref(), Some("model"));
    assert_eq!(models.current.as_deref(), Some("opus[1m]"));
    assert!(!models.available.is_empty());
    for id in &models.available {
        assert!(crate::models::is_claude_model_id(id), "adapter model {id}");
    }
    assert!(models.entries.iter().any(|m| m.id == "opus[1m]"));
    assert!(models.entries.iter().any(|m| m.id == "haiku"));
    let fable = models
        .entries
        .iter()
        .find(|m| m.id.contains("fable"))
        .expect("fable is in the adapter list");
    assert_eq!(fable.badge.as_deref(), Some("may use usage credits"));
    // `opusplan` is not in this capture, so it is not offered.
    assert!(models.entries.iter().all(|m| m.id != "opusplan"));
    // The adapter has no session/set_model. Switching uses the model config option.
    let requests = model_requests(&models, "sess", "sonnet");
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].0, "session/set_config_option");
    assert_eq!(requests[0].1["configId"], "model");
    assert_eq!(requests[0].1["value"], "sonnet");
}

#[test]
fn prompt_turn_updates_map_and_extensions_are_ignored() {
    let turn = fixture("prompt-turn.json");
    let messages = turn["messages"].as_array().unwrap();
    let mut text = String::new();
    let mut kinds = Vec::new();
    for msg in messages {
        match msg.get("method").and_then(Value::as_str) {
            Some("session/update") => {
                let evt = map_session_update("tab", "sid", msg).expect("session/update maps");
                kinds.push(evt.kind.clone());
                if evt.kind == "agent_message_chunk" {
                    text.push_str(evt.text_delta.as_deref().unwrap_or(""));
                }
            }
            Some(_) => assert!(map_session_update("tab", "sid", msg).is_none()),
            None => assert_eq!(msg["result"]["stopReason"], json!("end_turn")),
        }
    }
    assert_eq!(text, "OK");
    for kind in [
        "available_commands_update",
        "usage_update",
        "agent_message_chunk",
    ] {
        assert!(kinds.iter().any(|k| k == kind), "{kind} in {kinds:?}");
    }
}

#[test]
fn auth_status_update_names_the_account() {
    let updates = fixture("auth-status-update.json");
    let first = &updates[0]["params"]["authStatus"];
    assert_eq!(first["kind"], json!("account"));
    assert!(first["account"]["email"].as_str().unwrap().contains('@'));
}

#[test]
fn session_load_replays_the_transcript() {
    let load = fixture("session-load.json");
    let messages = load["messages"].as_array().unwrap();
    let kinds: Vec<String> = messages
        .iter()
        .filter_map(|m| map_session_update("tab", "sid", m))
        .map(|e| e.kind)
        .collect();
    assert!(kinds.iter().any(|k| k == "user_message_chunk"));
    assert!(kinds.iter().any(|k| k == "agent_message_chunk"));
    let result = messages
        .iter()
        .find(|m| m.get("id").is_some() && m.get("method").is_none())
        .unwrap();
    assert_eq!(
        result["result"]["modes"]["currentModeId"],
        json!("bypassPermissions")
    );
}
