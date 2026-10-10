//! End-to-end ACP session tests against a scripted fake agent
//! (`acp/fake_agent.py`): handshake, models and effort, streamed turns,
//! permission / plan / question cards answered through the outbox, cancel,
//! images, crashes, and the activity log. Nothing here needs a Tauri
//! `AppHandle`; agent requests are routed with the same pure decisions the
//! prompt worker uses (`claude_permission_route`, `evaluate_permission`,
//! `plan_response`, `permission_response`).

use super::agent_requests::{
    claude_permission_route, permission_response, plan_response, reject_option_id, ClaudeRoute,
};
use super::dev_session::PendingPlan;
use crate::acp::connection::{AcpConnection, AgentOutbox, LineDispatch, TurnControl};
use crate::acp::test_agent::{claude_fixture_result, FakeAgent};
use crate::acp::{map_session_update, AcpClient, ModelVia, PromptResult};
use crate::attachments::PromptImage;
use crate::permissions::activity::{patch_for_permission, patch_for_update};
use crate::permissions::{cancelled_permission_result, evaluate_permission, ToolCallCache};
use crate::provider::{AgentRequestKind, ProviderId, SharedProvider};
use crate::store::ActivityStore;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

const WAIT: Duration = Duration::from_secs(10);

// ---------- scenario helpers ----------

/// Claude adapter 0.88 as captured: initialize + session/new (models, effort).
fn claude_scenario(prompts: Value) -> Value {
    json!({
        "initialize": claude_fixture_result("initialize-response.json", "/result"),
        "session_new": claude_fixture_result("session-new.json", "/response/result"),
        "strict_permission": true,
        "prompts": prompts,
    })
}

fn cursor_scenario(prompts: Value) -> Value {
    json!({
        "initialize": { "protocolVersion": 1, "agentCapabilities": { "loadSession": true } },
        "session_new": {
            "modes": { "currentModeId": "agent", "availableModes": [] },
            "models": { "currentModelId": "auto", "availableModels": [{ "modelId": "auto" }, { "modelId": "gpt-5" }] }
        },
        "set_model": true,
        "prompts": prompts,
    })
}

macro_rules! fake {
    ($name:expr, $scenario:expr) => {
        match FakeAgent::new($name, &$scenario) {
            Some(agent) => agent,
            None => return,
        }
    };
}

fn connect(agent: &FakeAgent, base: ProviderId, mode: &str) -> AcpClient {
    AcpClient::connect_with_model(agent.provider(base), &agent.work_dir(), mode, None)
        .expect("handshake with fake agent")
        .0
}

fn kill(client: &AcpClient) {
    client.process_handle().kill_tree();
}

/// The JSON the fake agent echoed for its request `id` ("[reply id] {...}").
fn reply(text: &str, id: u64) -> Value {
    let tag = format!("[reply {id}] ");
    let start = text
        .find(&tag)
        .unwrap_or_else(|| panic!("no {tag} in {text:?}"))
        + tag.len();
    let mut stream = serde_json::Deserializer::from_str(&text[start..]).into_iter::<Value>();
    stream.next().unwrap().unwrap()
}

fn permission_request(id: u64, tool_call: Value, options: Value) -> Value {
    json!({ "id": id, "request": {
        "method": "session/request_permission",
        "params": { "sessionId": "fake-session-1", "toolCall": tool_call, "options": options }
    }})
}

/// Claude's usual options for a tool call (adapter 0.88).
fn claude_tool_options() -> Value {
    json!([
        { "optionId": "allow_always", "name": "Always Allow", "kind": "allow_always" },
        { "optionId": "allow", "name": "Allow", "kind": "allow_once" },
        { "optionId": "reject", "name": "Reject", "kind": "reject_once" }
    ])
}

/// ExitPlanMode as a permission request ("Ready to code?").
fn exit_plan_request(id: u64) -> Value {
    permission_request(
        id,
        json!({
            "toolCallId": "toolu_exit_plan",
            "title": "Ready to code?",
            "kind": "switch_mode",
            "rawInput": { "plan": "# Plan\n1. Add tests" }
        }),
        json!([
            { "optionId": "bypassPermissions", "name": "Yes, and bypass permissions", "kind": "allow_always" },
            { "optionId": "default", "name": "Yes, and manually approve edits", "kind": "allow_once" },
            { "optionId": "plan", "name": "No, keep planning", "kind": "reject_once" }
        ]),
    )
}

// ---------- a turn running on its own thread ----------

/// What the router did with an agent request: `Some` answered at once,
/// `None` handed to the user (a card).
type Routed = (Value, Option<Value>);

struct Running {
    notes: Receiver<Value>,
    asks: Receiver<Routed>,
    outbox: AgentOutbox,
    cancel: Arc<AtomicBool>,
    handle: JoinHandle<(AcpClient, Result<PromptResult, String>)>,
}

/// The prompt worker's routing (`prompt_worker.rs`) without the AppHandle:
/// the same pure decisions, with "card" meaning `Ok(None)`.
fn route(provider: &SharedProvider, role_id: &str, request: &Value) -> Option<Value> {
    let method = request["method"].as_str().unwrap_or("");
    let params = request.get("params").unwrap_or(&Value::Null);
    match provider.classify_request(method, params) {
        AgentRequestKind::Permission if provider.id() == ProviderId::Claude => {
            match claude_permission_route(role_id, params) {
                ClaudeRoute::AutoAllow { result, .. } => Some(result),
                ClaudeRoute::PlanCard | ClaudeRoute::Card => None,
            }
        }
        AgentRequestKind::Permission => evaluate_permission(role_id, params).auto_result,
        AgentRequestKind::Plan | AgentRequestKind::Question => None,
        _ => Some(crate::acp::request_handler::response_for_agent_request(
            request,
        )),
    }
}

fn start(
    client: AcpClient,
    role_id: &'static str,
    text: &str,
    images: Vec<PromptImage>,
) -> Running {
    let (note_tx, notes) = mpsc::channel();
    let (ask_tx, asks) = mpsc::channel();
    let outbox = client.outbox();
    let cancel = client.cancel_flag();
    let text = text.to_string();
    let handle = std::thread::spawn(move || {
        let mut client = client;
        let provider = client.provider();
        let on_note = Box::new(move |value: &Value| {
            let _ = note_tx.send(value.clone());
        });
        let on_ask = Box::new(move |value: &Value| -> Result<Option<Value>, String> {
            let routed = route(&provider, role_id, value);
            let _ = ask_tx.send((value.clone(), routed.clone()));
            Ok(routed)
        });
        let result = client.send_prompt(&text, &images, Some(on_note), Some(on_ask));
        (client, result)
    });
    Running {
        notes,
        asks,
        outbox,
        cancel,
        handle,
    }
}

impl Running {
    fn next_ask(&self) -> Routed {
        self.asks.recv_timeout(WAIT).expect("agent request")
    }

    fn wait_note(&self, pred: impl Fn(&Value) -> bool) -> Value {
        let deadline = Instant::now() + WAIT;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let note = self.notes.recv_timeout(left).expect("notification");
            if pred(&note) {
                return note;
            }
        }
    }

    fn answer(&self, id: u64, result: Value) {
        self.outbox.lock().unwrap().push((id, result));
    }

    fn finish(
        self,
    ) -> (
        AcpClient,
        Result<PromptResult, String>,
        Vec<Value>,
        Vec<Routed>,
    ) {
        let (client, result) = self.handle.join().expect("turn thread");
        let notes = self.notes.try_iter().collect();
        let asks = self.asks.try_iter().collect();
        (client, result, notes, asks)
    }
}

fn is_text(note: &Value, text: &str) -> bool {
    note.pointer("/params/update/content/text")
        .and_then(Value::as_str)
        == Some(text)
}

// ---------- handshake, models, effort ----------

#[test]
fn claude_handshake_parses_models_and_effort_and_sets_effort_by_config_option() {
    let agent = fake!("handshake", claude_scenario(json!([])));
    let mut client = connect(&agent, ProviderId::Claude, "bypassPermissions");

    assert_eq!(client.session_id(), "fake-session-1");
    assert_eq!(client.mode_id(), "bypassPermissions");
    assert_eq!(client.current_model(), Some("opus[1m]"));
    let ids: Vec<&str> = client
        .model_entries()
        .iter()
        .map(|m| m.id.as_str())
        .collect();
    assert!(
        ids.contains(&"opus[1m]") && ids.contains(&"haiku"),
        "{ids:?}"
    );
    assert_eq!(client.current_effort(), Some("default"));
    assert_eq!(
        client.effort_options(),
        ["default", "low", "medium", "high", "xhigh", "max"]
    );
    assert!(client.supports_images());

    let methods: Vec<String> = agent
        .received()
        .iter()
        .filter_map(|m| m["method"].as_str().map(String::from))
        .collect();
    // Claude never authenticates.
    assert_eq!(methods, ["initialize", "session/new", "session/set_mode"]);
    let new = &agent.sent("session/new")[0];
    assert_eq!(
        new["_meta"]["claudeCode"]["options"]["allowDangerouslySkipPermissions"],
        true
    );
    assert_eq!(new["cwd"], agent.work_dir().display().to_string());
    assert_eq!(
        agent.sent("session/set_mode")[0],
        json!({ "sessionId": "fake-session-1", "modeId": "bypassPermissions" })
    );

    client.apply_effort("high").unwrap();
    assert_eq!(client.current_effort(), Some("high"));
    assert_eq!(
        agent.sent("session/set_config_option"),
        [json!({ "sessionId": "fake-session-1", "configId": "effort", "value": "high" })]
    );
    // Same value again, and a value the session never offered: nothing sent.
    client.apply_effort("high").unwrap();
    assert!(client
        .apply_effort("turbo")
        .unwrap_err()
        .contains("not an effort level"));
    assert_eq!(agent.sent("session/set_config_option").len(), 1);
    kill(&client);
}

#[test]
fn claude_model_switch_uses_config_option_and_never_sends_slash_model() {
    let agent = fake!("model", claude_scenario(json!([])));
    let (mut client, via) = AcpClient::connect_with_model(
        agent.provider(ProviderId::Claude),
        &agent.work_dir(),
        "default",
        Some("sonnet"),
    )
    .unwrap();
    assert_eq!(via, ModelVia::ConfigOption);
    assert_eq!(client.current_model(), Some("sonnet"));
    assert_eq!(
        agent.sent("session/set_config_option"),
        [json!({ "sessionId": "fake-session-1", "configId": "model", "value": "sonnet" })]
    );

    // A slash command or a Cursor id never reaches the Claude adapter.
    assert!(client.apply_model("/model haiku").is_err());
    assert!(client.apply_model("gpt-5").is_err());
    // A Claude id the adapter rejects: no set_model API, so a restart is asked for.
    assert_eq!(
        client.apply_model("claude-sonnet-4-5").unwrap(),
        ModelVia::Unsupported
    );
    let result = {
        let run = start(client, "role_implementer", "hello", vec![]);
        run.finish()
    };
    kill(&result.0);
    result.1.unwrap();
    assert!(
        !agent.received_text().contains("/model"),
        "{}",
        agent.received_text()
    );
    assert!(agent.sent("session/set_model").is_empty());
}

#[test]
fn cursor_handshake_authenticates_and_switches_model_with_set_model() {
    let agent = fake!("cursor-handshake", cursor_scenario(json!([])));
    let (client, via) = AcpClient::connect_with_model(
        agent.provider(ProviderId::Cursor),
        &agent.work_dir(),
        "agent",
        Some("gpt-5"),
    )
    .unwrap();
    assert_eq!(via, ModelVia::SetModel);
    assert_eq!(
        agent.sent("authenticate"),
        [json!({ "methodId": "cursor_login" })]
    );
    assert_eq!(
        agent.sent("session/new")[0],
        json!({ "cwd": agent.work_dir().display().to_string(), "mcpServers": [] })
    );
    assert_eq!(
        agent.sent("session/set_model"),
        [json!({ "sessionId": "fake-session-1", "modelId": "gpt-5" })]
    );
    assert!(!client.supports_images());
    kill(&client);
}

// ---------- streamed turns ----------

#[test]
fn streamed_turn_collects_agent_text_stop_reason_and_usage() {
    // The captured Claude turn, verbatim, minus its final response.
    let messages = claude_fixture_result("prompt-turn.json", "/messages");
    let mut steps: Vec<Value> = messages
        .as_array()
        .unwrap()
        .iter()
        .take_while(|m| m.get("id").is_none())
        .map(|m| json!({ "raw": m }))
        .collect();
    steps.push(json!({ "update": { "sessionUpdate": "plan", "entries": [
        { "content": "Write tests", "status": "in_progress", "priority": "high" }
    ]}}));
    steps.push(json!({ "say": " and done" }));
    steps.push(json!({ "end": "max_tokens" }));
    let agent = fake!("stream", claude_scenario(json!([steps])));
    let client = connect(&agent, ProviderId::Claude, "bypassPermissions");
    let (client, result, notes, asks) =
        start(client, "role_implementer", "Reply OK", vec![]).finish();
    kill(&client);
    let result = result.unwrap();
    assert_eq!(result.stop_reason.as_deref(), Some("max_tokens"));
    assert_eq!(result.agent_text, "OK and done");
    assert_eq!(result.update_count, notes.len());
    assert!(asks.is_empty());
    assert_eq!(
        agent.sent("session/prompt"),
        [
            json!({ "sessionId": "fake-session-1", "prompt": [{ "type": "text", "text": "Reply OK" }] })
        ]
    );

    let kinds: Vec<String> = notes
        .iter()
        .filter_map(|n| map_session_update("t1", "s", n).map(|e| e.kind))
        .collect();
    for kind in [
        "available_commands_update",
        "usage_update",
        "agent_message_chunk",
        "plan",
    ] {
        assert!(kinds.iter().any(|k| k == kind), "{kind} in {kinds:?}");
    }

    // The usage meter reads the same notifications.
    let data = agent.work_dir().join("app-data");
    let mut usage = crate::usage::UsageStore::open(&data);
    for note in &notes {
        if let Some(event) = map_session_update("t1", "s", note) {
            usage.note("/fake/claude", "t1", &event.raw_json, 1_000);
        }
    }
    let snap = usage.snapshot("/fake/claude");
    assert_eq!(snap.windows.len(), 1);
    assert_eq!(snap.windows[0].rate_limit_type, "five_hour");
    assert_eq!(snap.context_by_tab["t1"].used, 26504);
    assert_eq!(snap.context_by_tab["t1"].size, 1_000_000);
}

// ---------- permissions ----------

#[test]
fn claude_permission_with_allow_once_is_answered_without_a_card() {
    let steps = json!([permission_request(
        50,
        json!({ "toolCallId": "toolu_1", "title": "`ls`", "kind": "execute" }),
        claude_tool_options()
    ),]);
    let agent = fake!("perm-auto", claude_scenario(json!([steps])));
    let client = connect(&agent, ProviderId::Claude, "default");
    let (client, result, _, asks) = start(client, "role_implementer", "go", vec![]).finish();
    kill(&client);
    let result = result.unwrap();
    assert_eq!(result.stop_reason.as_deref(), Some("end_turn"));
    assert_eq!(asks.len(), 1);
    // allow_once, never allow_always.
    let expected = json!({ "outcome": { "outcome": "selected", "optionId": "allow" } });
    assert_eq!(asks[0].1.as_ref(), Some(&expected));
    assert_eq!(reply(&result.agent_text, 50), expected);
}

#[test]
fn claude_permission_without_allow_once_waits_for_the_user_and_the_outbox_resumes_it() {
    let options = json!([
        { "optionId": "allow_always", "name": "Always Allow", "kind": "allow_always" },
        { "optionId": "reject", "name": "Reject", "kind": "reject_once" }
    ]);
    let steps = json!([
        { "say": "asking" },
        permission_request(51, json!({ "toolCallId": "toolu_2", "title": "`rm x`", "kind": "delete" }), options.clone()),
        { "say": "after" },
    ]);
    let agent = fake!("perm-card", claude_scenario(json!([steps])));
    let client = connect(&agent, ProviderId::Claude, "default");
    let run = start(client, "role_implementer", "go", vec![]);
    let (request, routed) = run.next_ask();
    assert_eq!(routed, None, "no allow_once: the card decides");
    assert_eq!(request["id"], 51);
    std::thread::sleep(Duration::from_millis(200));
    assert!(!run.handle.is_finished(), "the turn waits for the card");
    // JT picks Reject on the card (respond_permission_request).
    let offered: Vec<(String, String)> = options
        .as_array()
        .unwrap()
        .iter()
        .map(|o| {
            (
                o["optionId"].as_str().unwrap().into(),
                o["kind"].as_str().unwrap().into(),
            )
        })
        .collect();
    let (answer, decision) = permission_response("selected", Some("reject".into()), &offered);
    assert_eq!(decision, "user_reject");
    run.answer(51, answer.clone());
    let (client, result, _, _) = run.finish();
    kill(&client);
    let result = result.unwrap();
    assert_eq!(result.stop_reason.as_deref(), Some("end_turn"));
    assert_eq!(reply(&result.agent_text, 51), answer);
    assert!(result.agent_text.ends_with("after"));
}

#[test]
fn cursor_permission_policy_auto_answers_only_allow_once() {
    let shell = |id: u64, options: Value| {
        permission_request(
            id,
            json!({ "toolCallId": format!("c{id}"), "title": "`ls -la`", "kind": "execute" }),
            options,
        )
    };
    let steps = json!([
        shell(
            60,
            json!([
                { "optionId": "allow-once", "name": "Allow once", "kind": "allow_once" },
                { "optionId": "allow-always", "name": "Allow always", "kind": "allow_always" },
                { "optionId": "reject-once", "name": "Reject", "kind": "reject_once" }
            ])
        ),
        shell(
            61,
            json!([
                { "optionId": "allow-always", "name": "Allow always", "kind": "allow_always" },
                { "optionId": "reject-once", "name": "Reject", "kind": "reject_once" }
            ])
        ),
    ]);
    let agent = fake!("cursor-perm", cursor_scenario(json!([steps])));
    let client = connect(&agent, ProviderId::Cursor, "agent");
    let run = start(client, "role_implementer", "go", vec![]);
    let (_, first) = run.next_ask();
    assert_eq!(
        first,
        Some(json!({ "outcome": { "outcome": "selected", "optionId": "allow-once" } }))
    );
    let (second, routed) = run.next_ask();
    assert_eq!(second["id"], 61);
    assert_eq!(routed, None, "only allow_always on offer: ask");
    run.answer(61, cancelled_permission_result());
    let (client, result, _, _) = run.finish();
    kill(&client);
    let text = result.unwrap().agent_text;
    assert_eq!(reply(&text, 60)["outcome"]["optionId"], "allow-once");
    assert_eq!(reply(&text, 61), cancelled_permission_result());
}

#[test]
fn a_turn_waiting_on_a_card_outlives_the_idle_limit_and_resumes_from_the_outbox() {
    let agent = fake!(
        "idle-card",
        json!({ "prompts": [[
            permission_request(70, json!({ "title": "`ls`", "kind": "execute" }), json!([])),
        ]] })
    );
    let mut conn =
        AcpConnection::spawn_program(&agent.program(), None, agent.provider(ProviderId::Claude))
            .unwrap();
    let outbox: AgentOutbox = Arc::new(Mutex::new(Vec::new()));
    let answer_later = {
        let outbox = Arc::clone(&outbox);
        std::thread::spawn(move || {
            // Three idle limits of silence while the card is up.
            std::thread::sleep(Duration::from_millis(1200));
            outbox
                .lock()
                .unwrap()
                .push((70, cancelled_permission_result()));
        })
    };
    let cancel = AtomicBool::new(false);
    let mut next_id = 100;
    let mut turn = TurnControl {
        cancel: &cancel,
        session_id: "fake-session-1",
        next_id: &mut next_id,
        outbox: Some(Arc::clone(&outbox)),
        followups: None,
    };
    let mut dispatch = LineDispatch::new();
    dispatch.set_on_agent_request(Box::new(|_| Ok(None)));
    let result = conn.call_with_dispatch(
        7,
        "session/prompt",
        json!({ "sessionId": "fake-session-1", "prompt": [] }),
        Duration::from_millis(400),
        &mut dispatch,
        Some(&mut turn),
    );
    answer_later.join().unwrap();
    conn.kill();
    assert_eq!(result.unwrap()["stopReason"], "end_turn");
}

#[test]
fn a_card_left_over_from_an_earlier_turn_does_not_disable_the_idle_limit() {
    // Turn 1: the agent asks, then ends the turn without waiting for the card.
    // Turn 2: the agent hangs. Turn 2 must still time out.
    let ask = json!({ "jsonrpc": "2.0", "id": 80, "method": "session/request_permission",
        "params": { "sessionId": "fake-session-1", "toolCall": {}, "options": [] } });
    let agent = fake!(
        "stale-card",
        json!({ "prompts": [[{ "raw": ask }], [{ "sleep": 4 }]] })
    );
    let mut conn =
        AcpConnection::spawn_program(&agent.program(), None, agent.provider(ProviderId::Claude))
            .unwrap();
    let cancel = AtomicBool::new(false);
    let mut next_id = 100;
    let mut run_turn = |conn: &mut AcpConnection, id: u64| {
        let mut turn = TurnControl {
            cancel: &cancel,
            session_id: "fake-session-1",
            next_id: &mut next_id,
            outbox: None,
            followups: None,
        };
        let mut dispatch = LineDispatch::new();
        dispatch.set_on_agent_request(Box::new(|_| Ok(None)));
        conn.call_with_dispatch(
            id,
            "session/prompt",
            json!({}),
            Duration::from_millis(500),
            &mut dispatch,
            Some(&mut turn),
        )
    };
    assert_eq!(run_turn(&mut conn, 7).unwrap()["stopReason"], "end_turn");
    let started = Instant::now();
    let second = run_turn(&mut conn, 8);
    conn.kill();
    assert!(
        second
            .as_ref()
            .is_err_and(|e| e.contains("timeout waiting for response id=8")),
        "{second:?}"
    );
    assert!(started.elapsed() < Duration::from_secs(3));
}

// ---------- plans and questions ----------

#[test]
fn claude_planner_exit_plan_goes_to_the_card_and_never_approves() {
    let agent = fake!(
        "claude-plan",
        claude_scenario(json!([[exit_plan_request(90)], [exit_plan_request(91)]]))
    );
    let client = connect(&agent, ProviderId::Claude, "plan");

    // Accept on the card ("Hand off") still keeps planning in this tab.
    let run = start(client, "role_planner", "plan it", vec![]);
    let (request, routed) = run.next_ask();
    assert_eq!(routed, None);
    let pending = PendingPlan::ClaudeExit {
        reject_option_id: reject_option_id(&request["params"]),
    };
    let accepted = plan_response(&pending, "accepted");
    assert_eq!(
        accepted,
        json!({ "outcome": { "outcome": "selected", "optionId": "plan" } })
    );
    run.answer(90, accepted.clone());
    let (client, result, _, _) = run.finish();
    assert_eq!(reply(&result.unwrap().agent_text, 90), accepted);

    // Any other role: allow_once ("manually approve edits"), no card.
    let run = start(client, "role_implementer", "go", vec![]);
    let (client, result, _, asks) = run.finish();
    kill(&client);
    let allow = json!({ "outcome": { "outcome": "selected", "optionId": "default" } });
    assert_eq!(asks[0].1.as_ref(), Some(&allow));
    assert_eq!(reply(&result.unwrap().agent_text, 91), allow);
}

#[test]
fn cursor_plan_and_question_cards_answer_with_the_users_choice() {
    let plan = |id: u64| {
        json!({ "id": id, "request": { "method": "cursor/create_plan",
        "params": { "title": "Plan", "entries": [{ "content": "Step 1" }] } } })
    };
    let question = json!({ "id": 102, "request": { "method": "cursor/ask_question",
        "params": { "title": "Pick", "prompt": "Which?", "choices": [{ "id": "flag", "label": "Flag" }] } } });
    let agent = fake!(
        "cursor-plan",
        cursor_scenario(json!([[plan(100), plan(101), question]]))
    );
    let client = connect(&agent, ProviderId::Cursor, "plan");
    let run = start(client, "role_planner", "plan", vec![]);
    for (id, outcome) in [(100, "accepted"), (101, "rejected")] {
        let (request, routed) = run.next_ask();
        assert_eq!((request["id"].as_u64(), routed), (Some(id), None));
        run.answer(id, plan_response(&PendingPlan::Cursor, outcome));
        // Wait for the echo so answers stay in order.
        run.wait_note(|n| {
            n.pointer("/params/update/content/text")
                .and_then(Value::as_str)
                .is_some_and(|t| t.starts_with(&format!("[reply {id}]")))
        });
    }
    let (request, routed) = run.next_ask();
    assert_eq!((request["id"].as_u64(), routed), (Some(102), None));
    run.answer(102, json!({ "outcome": "answered", "choiceId": "flag" }));
    let (client, result, _, _) = run.finish();
    kill(&client);
    let text = result.unwrap().agent_text;
    assert_eq!(reply(&text, 100), json!({ "outcome": "accepted" }));
    assert_eq!(reply(&text, 101), json!({ "outcome": "cancelled" }));
    assert_eq!(
        reply(&text, 102),
        json!({ "choiceId": "flag", "outcome": "answered" })
    );
}

// ---------- cancel ----------

#[test]
fn cancel_mid_turn_ends_with_cancelled_well_inside_the_grace_period() {
    let agent = fake!(
        "cancel",
        claude_scenario(json!([[{ "say": "working" }, { "wait_cancel": true }]]))
    );
    let client = connect(&agent, ProviderId::Claude, "default");
    let run = start(client, "role_implementer", "long job", vec![]);
    run.wait_note(|n| is_text(n, "working"));
    let started = Instant::now();
    run.cancel.store(true, Ordering::SeqCst);
    let (client, result, _, _) = run.finish();
    kill(&client);
    assert_eq!(result.unwrap().stop_reason.as_deref(), Some("cancelled"));
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_eq!(
        agent.sent("session/cancel"),
        [json!({ "sessionId": "fake-session-1" })]
    );
}

#[test]
fn cancel_with_cards_up_answers_them_in_the_shape_each_request_needs() {
    // What dev_session_cancel queues: a permission card and a Claude plan card.
    let steps = json!([
        { "say": "working" },
        permission_request(110, json!({ "toolCallId": "t", "title": "`rm`", "kind": "delete" }),
            json!([{ "optionId": "reject", "name": "Reject", "kind": "reject_once" }])),
        { "wait_cancel": true },
    ]);
    let agent = fake!(
        "cancel-cards",
        claude_scenario(json!([steps, [exit_plan_request(111), { "wait_cancel": true }]]))
    );
    let client = connect(&agent, ProviderId::Claude, "plan");

    let run = start(client, "role_planner", "go", vec![]);
    let _ = run.next_ask();
    run.answer(110, cancelled_permission_result());
    run.cancel.store(true, Ordering::SeqCst);
    let (client, result, _, _) = run.finish();
    let result = result.unwrap();
    assert_eq!(result.stop_reason.as_deref(), Some("cancelled"));
    assert_eq!(
        reply(&result.agent_text, 110),
        cancelled_permission_result()
    );

    let run = start(client, "role_planner", "plan", vec![]);
    let _ = run.next_ask();
    let pending = PendingPlan::ClaudeExit {
        reject_option_id: Some("plan".into()),
    };
    run.answer(111, pending.cancelled_result());
    run.cancel.store(true, Ordering::SeqCst);
    let (client, result, _, _) = run.finish();
    kill(&client);
    // ExitPlanMode is a permission request: `{outcome: {outcome: cancelled}}`.
    let result = result.expect("adapter accepts the cancel answer");
    assert_eq!(result.stop_reason.as_deref(), Some("cancelled"));
    assert_eq!(
        reply(&result.agent_text, 111),
        cancelled_permission_result()
    );
    assert_eq!(
        PendingPlan::Cursor.cancelled_result(),
        json!({ "outcome": "cancelled" })
    );
}

// ---------- images ----------

#[test]
fn image_prompts_send_text_then_image_blocks() {
    let agent = fake!("images", claude_scenario(json!([])));
    let client = connect(&agent, ProviderId::Claude, "default");
    let png = PromptImage {
        mime: "image/png".into(),
        data_base64: "iVBORw0KGgo=".into(),
    };
    let jpeg = PromptImage {
        mime: "image/jpeg".into(),
        data_base64: "/9j/4AAQ".into(),
    };
    let (client, result, _, _) = start(
        client,
        "role_implementer",
        "what is this?",
        vec![png.clone(), jpeg],
    )
    .finish();
    result.unwrap();
    let (client, result, _, _) = start(client, "role_implementer", "  ", vec![png]).finish();
    kill(&client);
    result.unwrap();
    let prompts = agent.sent("session/prompt");
    assert_eq!(
        prompts[0]["prompt"],
        json!([
            { "type": "text", "text": "what is this?" },
            { "type": "image", "mimeType": "image/png", "data": "iVBORw0KGgo=" },
            { "type": "image", "mimeType": "image/jpeg", "data": "/9j/4AAQ" }
        ])
    );
    // Image only: no empty text block.
    assert_eq!(
        prompts[1]["prompt"],
        json!([{ "type": "image", "mimeType": "image/png", "data": "iVBORw0KGgo=" }])
    );
}

#[test]
fn cursor_sessions_refuse_images_before_sending_anything() {
    let agent = fake!("cursor-images", cursor_scenario(json!([])));
    let mut client = connect(&agent, ProviderId::Cursor, "agent");
    let image = PromptImage {
        mime: "image/png".into(),
        data_base64: "AA==".into(),
    };
    let err = client
        .send_prompt("look", &[image], None, None)
        .unwrap_err();
    kill(&client);
    assert!(err.contains("does not accept images"), "{err}");
    assert!(agent.sent("session/prompt").is_empty());
}

// ---------- crashes ----------

#[test]
fn agent_crash_mid_turn_is_a_readable_error_with_its_stderr() {
    for round in 0..3 {
        let agent = fake!(
            "crash",
            claude_scenario(json!([[
                { "say": "partial" },
                { "stderr": "TypeError: adapter fell over" },
                { "exit": 3 }
            ]]))
        );
        let client = connect(&agent, ProviderId::Claude, "default");
        let (client, result, _, _) = start(client, "role_implementer", "go", vec![]).finish();
        kill(&client);
        let err = result.unwrap_err();
        assert!(
            err.contains("agent exited") || err.contains("Claude ACP adapter exited"),
            "round {round}: {err}"
        );
        assert!(err.contains("adapter fell over"), "round {round}: {err}");
    }
}

#[test]
fn agent_logged_out_crash_is_an_auth_error() {
    let agent = fake!(
        "crash-auth",
        claude_scenario(json!([[
            { "stderr": "Not logged in · Please run /login" },
            { "exit": 1 }
        ]]))
    );
    let client = connect(&agent, ProviderId::Claude, "default");
    let (client, result, _, _) = start(client, "role_implementer", "go", vec![]).finish();
    kill(&client);
    let err = result.unwrap_err();
    assert!(err.starts_with("AUTH_ERROR:"), "{err}");
}

#[test]
fn an_answer_written_just_before_the_agent_exits_is_not_lost() {
    for round in 0..3 {
        let agent = fake!(
            "answer-exit",
            claude_scenario(json!([[
                { "say": "done" },
                { "raw": { "jsonrpc": "2.0", "id": 5, "result": { "stopReason": "end_turn" } } },
                { "exit": 0 }
            ]]))
        );
        let client = connect(&agent, ProviderId::Claude, "default");
        let (client, result, _, _) = start(client, "role_implementer", "go", vec![]).finish();
        kill(&client);
        let result = result.unwrap_or_else(|e| panic!("round {round}: {e}"));
        assert_eq!(result.stop_reason.as_deref(), Some("end_turn"));
        assert_eq!(result.agent_text, "done");
    }
}

// ---------- activity log ----------

#[test]
fn activity_log_records_tool_calls_and_permission_decisions() {
    let steps = json!([
        { "update": { "sessionUpdate": "tool_call", "toolCallId": "toolu_ls", "title": "`ls -la`",
            "kind": "execute", "status": "pending", "rawInput": { "command": "ls -la" } } },
        { "update": { "sessionUpdate": "tool_call_update", "toolCallId": "toolu_ls", "status": "in_progress" } },
        { "update": { "sessionUpdate": "tool_call_update", "toolCallId": "toolu_ls", "status": "completed" } },
        { "update": { "sessionUpdate": "tool_call", "toolCallId": "toolu_rm", "title": "`rm -rf build`",
            "kind": "execute", "status": "pending", "rawInput": { "command": "rm -rf build" } } },
        permission_request(120, json!({ "toolCallId": "toolu_rm", "title": "`rm -rf build`" }), claude_tool_options()),
        { "update": { "sessionUpdate": "tool_call_update", "toolCallId": "toolu_rm", "status": "failed" } },
    ]);
    let agent = fake!("activity", claude_scenario(json!([steps])));
    let client = connect(&agent, ProviderId::Claude, "default");
    let (client, result, notes, asks) = start(client, "role_implementer", "go", vec![]).finish();
    kill(&client);
    result.unwrap();

    // What the prompt worker's hooks do with each line (commands/activity.rs).
    let store = ActivityStore::with_limits(agent.work_dir().join("activity"), 1 << 20, 10);
    let mut cache = ToolCallCache::new();
    let mut asks = asks.into_iter();
    for note in &notes {
        cache.observe_notification(note);
        if let Some(patch) = patch_for_update("tab1", note, &cache, "2026-10-10T00:00:00Z") {
            store.append(&patch).unwrap();
        }
        // The permission arrived after the rm tool_call.
        if note.pointer("/params/update/toolCallId") == Some(&json!("toolu_rm"))
            && note.pointer("/params/update/sessionUpdate") == Some(&json!("tool_call"))
        {
            let (request, routed) = asks.next().unwrap();
            assert!(routed.is_some());
            let enriched = cache.enrich_params(&request["params"]);
            let patch = patch_for_permission(
                "tab1",
                120,
                &enriched,
                Some("auto_allow"),
                "2026-10-10T00:00:01Z",
            );
            store.append(&patch).unwrap();
        }
    }
    let entries = store.list("tab1", None).unwrap();
    assert_eq!(entries.len(), 2, "{entries:?}");
    let ls = entries.iter().find(|e| e.id == "toolu_ls").unwrap();
    assert_eq!(ls.status.as_deref(), Some("completed"));
    assert!(
        ls.title.contains("ls -la") || ls.summary.contains("ls -la"),
        "{ls:?}"
    );
    assert_eq!(ls.decision, "none");
    let rm = entries.iter().find(|e| e.id == "toolu_rm").unwrap();
    assert_eq!(rm.status.as_deref(), Some("failed"));
    assert_eq!(rm.decision, "auto_allow");
}
