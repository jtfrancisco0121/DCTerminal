use super::connection::{default_io_timeout, AcpConnection, LineDispatch};
use crate::provider::{Provider, SessionOpts};
use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;

/// Blueprint §16: `session/load` may replay a long transcript.
pub const LOAD_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentCapabilities {
    pub load_session: bool,
    pub session_list: bool,
    pub session_resume: bool,
    pub session_close: bool,
}

pub fn capabilities_from_initialize(result: &Value) -> AgentCapabilities {
    let caps = result.get("agentCapabilities");
    let session = caps.and_then(|value| value.get("sessionCapabilities"));
    AgentCapabilities {
        load_session: caps
            .and_then(|value| value.get("loadSession"))
            .and_then(|value| value.as_bool())
            .unwrap_or(false),
        session_list: session.and_then(|value| value.get("list")).is_some(),
        session_resume: session.and_then(|value| value.get("resume")).is_some(),
        session_close: session.and_then(|value| value.get("close")).is_some(),
    }
}

pub fn load_session_params(session_id: &str, cwd: &str) -> Value {
    json!({
        "sessionId": session_id,
        "cwd": cwd,
        "mcpServers": []
    })
}

/// What `session/new` (or `session/load`) said about models.
/// `configOptions` (category `model`) is preferred over the older `models` field.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionModels {
    pub current: Option<String>,
    pub available: Vec<String>,
    /// Id of the `configOptions` entry whose category (or id) is `model`.
    pub config_id: Option<String>,
    /// `models` was present, so `session/set_model` is worth trying.
    pub set_model_api: bool,
    /// Claude model options (id + label) from the `model` config option.
    /// Empty for Cursor, which uses `agent --list-models` instead.
    pub entries: Vec<crate::models::ModelEntry>,
    /// Claude reasoning effort: the `configOptions` entry of category
    /// `thought_level` (id `effort`). Empty when the agent does not offer it.
    pub effort_config_id: Option<String>,
    pub effort_current: Option<String>,
    pub effort_available: Vec<String>,
}

fn collect_labeled_options(options: &Value, out: &mut Vec<(String, String)>) {
    let Some(items) = options.as_array() else {
        return;
    };
    for item in items {
        if let Some(value) = item.get("value").and_then(Value::as_str) {
            let label = item
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(value);
            out.push((value.to_string(), label.to_string()));
        } else if let Some(nested) = item.get("options") {
            collect_labeled_options(nested, out);
        }
    }
}

fn option_values(options: &Value, out: &mut Vec<String>) {
    let Some(items) = options.as_array() else {
        return;
    };
    for item in items {
        if let Some(value) = item.get("value").and_then(Value::as_str) {
            out.push(value.to_string());
        } else if let Some(nested) = item.get("options") {
            option_values(nested, out);
        }
    }
}

pub fn parse_session_models(result: &Value) -> SessionModels {
    let mut info = SessionModels::default();
    if let Some(options) = result.get("configOptions").and_then(Value::as_array) {
        let model_option = options
            .iter()
            .find(|opt| opt.get("category").and_then(Value::as_str) == Some("model"))
            .or_else(|| {
                options
                    .iter()
                    .find(|opt| opt.get("id").and_then(Value::as_str) == Some("model"))
            });
        if let Some(opt) = model_option {
            info.config_id = opt.get("id").and_then(Value::as_str).map(String::from);
            info.current = opt
                .get("currentValue")
                .and_then(Value::as_str)
                .map(String::from);
            if let Some(values) = opt.get("options") {
                option_values(values, &mut info.available);
                let mut labeled = Vec::new();
                collect_labeled_options(values, &mut labeled);
                info.entries = crate::models::claude_models_from_options(&labeled);
            }
        }
    }
    if let Some(options) = result.get("configOptions").and_then(Value::as_array) {
        let effort = options
            .iter()
            .find(|opt| opt.get("category").and_then(Value::as_str) == Some("thought_level"))
            .or_else(|| {
                options
                    .iter()
                    .find(|opt| opt.get("id").and_then(Value::as_str) == Some("effort"))
            });
        if let Some(opt) = effort {
            info.effort_config_id = opt.get("id").and_then(Value::as_str).map(String::from);
            info.effort_current = opt
                .get("currentValue")
                .and_then(Value::as_str)
                .map(String::from);
            if let Some(values) = opt.get("options") {
                option_values(values, &mut info.effort_available);
            }
        }
    }
    if let Some(models) = result.get("models").filter(|m| m.is_object()) {
        info.set_model_api = true;
        if info.current.is_none() {
            info.current = models
                .get("currentModelId")
                .and_then(Value::as_str)
                .map(String::from);
        }
        if info.available.is_empty() {
            if let Some(list) = models.get("availableModels").and_then(Value::as_array) {
                info.available = list
                    .iter()
                    .filter_map(|m| m.get("modelId").and_then(Value::as_str).map(String::from))
                    .collect();
            }
        }
    }
    info
}

/// Requests to try, in order, to switch the session's model. Empty when the
/// agent advertised neither `configOptions` nor `models`.
pub fn model_requests(
    models: &SessionModels,
    session_id: &str,
    model: &str,
) -> Vec<(String, Value)> {
    let mut requests = Vec::new();
    if let Some(config_id) = &models.config_id {
        requests.push((
            "session/set_config_option".to_string(),
            json!({ "sessionId": session_id, "configId": config_id, "value": model }),
        ));
    }
    if models.set_model_api {
        requests.push((
            "session/set_model".to_string(),
            json!({ "sessionId": session_id, "modelId": model }),
        ));
    }
    requests
}

/// The provider's auth step (Cursor: `authenticate cursor_login`; Claude:
/// none). An auth failure becomes `AUTH_ERROR: …`.
fn run_auth_step(conn: &mut AcpConnection, provider: &dyn Provider) -> Result<(), String> {
    let Some((method, params)) = provider.auth_step() else {
        return Ok(());
    };
    match conn.call(2, &method, params, default_io_timeout()) {
        Ok(_) => Ok(()),
        Err(e) if is_auth_failure(&e) => Err(format!("AUTH_ERROR: {e}")),
        Err(e) => Err(e),
    }
}

/// `session/new` params, with the provider's `_meta` when it has one.
pub fn new_session_params(provider: &dyn Provider, cwd: &Path, opts: &SessionOpts) -> Value {
    let mut params = json!({
        "cwd": cwd.display().to_string(),
        "mcpServers": []
    });
    if let Some(meta) = provider.session_new_meta(opts) {
        params["_meta"] = meta;
    }
    params
}

/// Mode ids the session advertised (`modes.availableModes[].id`).
pub fn advertised_modes(result: &Value) -> Vec<String> {
    result
        .get("modes")
        .and_then(|m| m.get("availableModes"))
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|m| m.get("id").and_then(Value::as_str).map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

/// Claude: a mode the session did not advertise (bypass disabled, `auto`
/// unavailable for the account) falls back to `default`; requests are
/// auto-approved either way. Cursor keeps the caller's mode.
pub fn mode_to_set(provider: &dyn Provider, wanted: &str, result: &Value) -> String {
    if provider.id() != crate::provider::ProviderId::Claude {
        return wanted.to_string();
    }
    let available = advertised_modes(result);
    if available.is_empty() || available.iter().any(|m| m == wanted) {
        wanted.to_string()
    } else {
        "default".to_string()
    }
}

/// Claude has no `authenticate` step, so a missing login surfaces as an
/// error from `session/new` / `session/load`; mark it like Cursor's.
fn mark_auth(provider: &dyn Provider, err: String) -> String {
    if provider.id() == crate::provider::ProviderId::Claude && is_auth_failure(&err) {
        format!("AUTH_ERROR: {err}")
    } else {
        err
    }
}

/// FR-003–004, FR-009: initialize → (provider auth) → session/new → set_mode.
pub fn handshake(
    conn: &mut AcpConnection,
    provider: &dyn Provider,
    cwd: &Path,
    mode_id: &str,
) -> Result<(String, String, SessionModels), String> {
    let timeout = default_io_timeout();

    conn.call(1, "initialize", initialize_params(), timeout)?;

    run_auth_step(conn, provider)?;

    let new_result = conn
        .call(
            3,
            "session/new",
            new_session_params(provider, cwd, &SessionOpts::default()),
            timeout,
        )
        .map_err(|e| mark_auth(provider, e))?;

    let session_id = new_result
        .get("sessionId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "session/new missing sessionId".to_string())?
        .to_string();

    let models = parse_session_models(&new_result);
    let mode_id = mode_to_set(provider, mode_id, &new_result);

    conn.call(
        4,
        "session/set_mode",
        json!({
            "sessionId": session_id,
            "modeId": mode_id
        }),
        timeout,
    )?;

    Ok((session_id, mode_id, models))
}

/// Resume one ACP session. Caller must already know `loadSession` may be false;
/// this checks the live `initialize` result and refuses `session/load` when it is.
pub fn handshake_load(
    conn: &mut AcpConnection,
    provider: &dyn Provider,
    cwd: &Path,
    mode_id: &str,
    session_id: &str,
) -> Result<(String, String, Vec<Value>, SessionModels), String> {
    let timeout = default_io_timeout();
    let init = conn.call(1, "initialize", initialize_params(), timeout)?;
    let caps = capabilities_from_initialize(&init);
    if !caps.load_session {
        return Err(format!(
            "LOAD_UNSUPPORTED: this {} agent did not advertise agentCapabilities.loadSession, so session/load was not sent",
            provider.id().label()
        ));
    }
    // `session/resume` is a different method. This path only sends `session/load`.

    run_auth_step(conn, provider)?;

    let mut dispatch = LineDispatch::default();
    let load_result = conn
        .call_with_dispatch(
            3,
            "session/load",
            load_session_params(session_id, &cwd.display().to_string()),
            LOAD_TIMEOUT,
            &mut dispatch,
            None,
        )
        .map_err(|e| mark_auth(provider, e))?;
    let mode_id = mode_to_set(provider, mode_id, &load_result);

    conn.call(
        4,
        "session/set_mode",
        json!({
            "sessionId": session_id,
            "modeId": mode_id
        }),
        timeout,
    )?;

    Ok((
        session_id.to_string(),
        mode_id,
        dispatch.notifications,
        parse_session_models(&load_result),
    ))
}

fn is_auth_failure(err: &str) -> bool {
    let lower = err.to_lowercase();
    lower.contains("auth")
        || lower.contains("login")
        || lower.contains("unauthorized")
        || lower.contains("not authenticated")
}

pub(crate) fn initialize_params() -> Value {
    json!({
        "protocolVersion": 1,
        "clientCapabilities": {
            "fs": { "readTextFile": false, "writeTextFile": false },
            "terminal": false
        },
        "clientInfo": {
            "name": "DCTerminal",
            "title": "DCTerminal",
            "version": "0.1.0"
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn captured_initialize_advertises_load_and_list_but_not_resume() {
        let raw = include_str!("../../../fixtures/acp/initialize-response-2026-10-06.ndjson");
        let value: Value = serde_json::from_str(raw).unwrap();
        let result = value.get("result").cloned().unwrap_or(value);
        let caps = capabilities_from_initialize(&result);
        assert!(caps.load_session);
        assert!(caps.session_list);
        assert!(!caps.session_resume);
        assert!(!caps.session_close);
    }

    #[test]
    fn load_params_carry_the_same_session_id_and_cwd() {
        let params = load_session_params("sess_789xyz", r"C:\Work\App");
        assert_eq!(params["sessionId"], "sess_789xyz");
        assert_eq!(params["cwd"], r"C:\Work\App");
        assert_eq!(params["mcpServers"], serde_json::json!([]));
    }

    #[test]
    fn config_option_model_is_preferred_over_models_field() {
        let result = json!({
            "sessionId": "s",
            "models": { "currentModelId": "auto", "availableModels": [{ "modelId": "auto" }] },
            "configOptions": [
                { "id": "mode", "category": "mode", "currentValue": "agent", "options": [] },
                {
                    "id": "model_picker",
                    "category": "model",
                    "currentValue": "composer-2.5",
                    "options": [
                        { "group": "a", "name": "A", "options": [{ "value": "composer-2.5", "name": "C" }] },
                        { "value": "gpt-5", "name": "G" }
                    ]
                }
            ]
        });
        let models = parse_session_models(&result);
        assert_eq!(models.config_id.as_deref(), Some("model_picker"));
        assert_eq!(models.current.as_deref(), Some("composer-2.5"));
        assert_eq!(models.available, vec!["composer-2.5", "gpt-5"]);
        assert!(models.set_model_api);
        let requests = model_requests(&models, "s", "gpt-5");
        assert_eq!(requests[0].0, "session/set_config_option");
        assert_eq!(requests[0].1["configId"], "model_picker");
        assert_eq!(requests[0].1["value"], "gpt-5");
        assert_eq!(requests[1].0, "session/set_model");
        assert_eq!(requests[1].1["modelId"], "gpt-5");
    }

    #[test]
    fn models_field_alone_uses_set_model() {
        let models = parse_session_models(&json!({
            "models": { "currentModelId": "auto", "availableModels": [{ "modelId": "auto" }, { "modelId": "gpt-5" }] }
        }));
        assert_eq!(models.current.as_deref(), Some("auto"));
        assert_eq!(models.available, vec!["auto", "gpt-5"]);
        let requests = model_requests(&models, "s", "gpt-5");
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].0, "session/set_model");
    }

    #[test]
    fn no_model_info_means_no_requests() {
        let models = parse_session_models(&json!({ "sessionId": "s" }));
        assert_eq!(models, SessionModels::default());
        assert!(model_requests(&models, "s", "gpt-5").is_empty());
    }

    #[test]
    fn cursor_session_new_has_no_meta() {
        let params = new_session_params(
            &crate::provider::CursorProvider,
            Path::new("/w/app"),
            &SessionOpts::default(),
        );
        assert_eq!(params, json!({ "cwd": "/w/app", "mcpServers": [] }));
    }

    #[test]
    fn missing_load_session_is_not_treated_as_supported() {
        let caps = capabilities_from_initialize(&json!({ "agentCapabilities": {} }));
        assert!(!caps.load_session);
        assert!(!caps.session_list);
    }
}
