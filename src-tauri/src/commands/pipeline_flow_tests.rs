//! Pipeline edge cases against the scripted fake agent (`acp/fake_agent.py`):
//! plan mode loops, cards that overlap, cancels that settle late, sessions
//! that die between turns, two tabs at once, long quiet tool runs, plan
//! files, and the per-role permission modes. Same harness as
//! `session_flow_tests` (no Tauri `AppHandle`).

use super::agent_requests::{
    claude_permission_route, exit_plan_body, exit_plan_file, permission_response, plan_response,
    read_plan_file, reject_option_id, ClaudeRoute,
};
use super::dev_session::{LiveSession, PendingPlan, SessionRegistry};
use super::session_flow_tests::{
    claude_scenario, claude_tool_options, connect, exit_plan_request, is_text, kill,
    permission_request, reply, start,
};
use crate::acp::connection::{AcpConnection, LineDispatch, TurnControl};
use crate::acp::map_session_update;
use crate::acp::test_agent::FakeAgent;
use crate::permissions::ToolCallCache;
use crate::provider::{ClaudeProvider, CursorProvider, Provider, ProviderId};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

macro_rules! fake {
    ($name:expr, $scenario:expr) => {
        match FakeAgent::new($name, &$scenario) {
            Some(agent) => agent,
            None => return,
        }
    };
}

/// The "keep planning" answer the plan card sends for Hand off and Keep planning.
fn keep_planning(request: &Value) -> Value {
    plan_response(
        &PendingPlan::ClaudeExit {
            reject_option_id: reject_option_id(&request["params"]),
        },
        "accepted",
    )
}

fn nowait(mut step: Value) -> Value {
    step["nowait"] = json!(true);
    step
}

fn echoed(note: &Value, id: u64) -> bool {
    note.pointer("/params/update/content/text")
        .and_then(Value::as_str)
        .is_some_and(|text| text.starts_with(&format!("[reply {id}]")))
}

/// Every answer the client wrote for agent request `id`.
fn answers_to(agent: &FakeAgent, id: u64) -> Vec<Value> {
    agent
        .received()
        .into_iter()
        .filter(|msg| msg.get("method").is_none() && msg["id"] == json!(id))
        .map(|msg| msg["result"].clone())
        .collect()
}

// ---------- plan mode ----------

#[test]
fn planner_keeps_planning_and_each_later_exit_plan_gets_its_own_card() {
    // Hand off (or Keep planning) answers "plan"; Claude revises and asks
    // again in the same turn, then once more in the next turn.
    let agent = fake!(
        "keep-planning",
        claude_scenario(json!([
            [exit_plan_request(90), { "say": "revising" }, exit_plan_request(91)],
            [exit_plan_request(92)]
        ]))
    );
    let client = connect(&agent, ProviderId::Claude, "plan");
    let keep = json!({ "outcome": { "outcome": "selected", "optionId": "plan" } });

    let run = start(client, "role_planner", "plan it", vec![]);
    for id in [90u64, 91] {
        let (request, routed) = run.next_ask();
        assert_eq!((request["id"].as_u64(), routed), (Some(id), None));
        run.answer(id, keep_planning(&request));
        run.wait_note(|n| echoed(n, id));
    }
    let (client, result, _, _) = run.finish();
    let text = result.unwrap().agent_text;
    assert_eq!(reply(&text, 90), keep);
    assert_eq!(reply(&text, 91), keep);

    let run = start(client, "role_planner", "keep going", vec![]);
    let (request, routed) = run.next_ask();
    assert_eq!((request["id"].as_u64(), routed), (Some(92), None));
    run.answer(92, keep_planning(&request));
    let (client, result, _, _) = run.finish();
    kill(&client);
    assert_eq!(reply(&result.unwrap().agent_text, 92), keep);
    // One answer per card, and never a "Yes" option.
    for id in [90, 91, 92] {
        assert_eq!(answers_to(&agent, id), vec![keep.clone()], "request {id}");
    }
}

#[test]
fn exit_plan_outside_the_planner_is_auto_answered_only_when_it_offers_allow_once() {
    let without_allow_once = permission_request(
        93,
        json!({ "toolCallId": "toolu_exit_2", "title": "Ready to code?", "kind": "switch_mode",
            "rawInput": { "plan": "# P" } }),
        json!([
            { "optionId": "acceptEdits", "name": "Yes, and auto-accept edits", "kind": "allow_always" },
            { "optionId": "plan", "name": "No, keep planning", "kind": "reject_once" }
        ]),
    );
    // Every non-Planner built-in role answers the usual ExitPlanMode with
    // its allow_once option ("manually approve edits").
    let usual = exit_plan_request(1)["request"]["params"].clone();
    for role in [
        "role_general",
        "role_plan_reviewer",
        "role_implementer",
        "role_pr_reviewer",
        "role_developer",
        "role_recommendation",
        "role_codebase_audit",
    ] {
        assert_eq!(
            claude_permission_route(role, &usual),
            ClaudeRoute::AutoAllow {
                result: json!({ "outcome": { "outcome": "selected", "optionId": "default" } }),
                exit_plan: true
            },
            "{role}"
        );
        assert_eq!(
            claude_permission_route(role, &without_allow_once["request"]["params"]),
            ClaudeRoute::Card,
            "{role}: no allow_once, so the user decides"
        );
    }

    let agent = fake!(
        "exit-plan-no-allow-once",
        claude_scenario(json!([[exit_plan_request(94), without_allow_once]]))
    );
    let client = connect(&agent, ProviderId::Claude, "bypassPermissions");
    let run = start(client, "role_implementer", "go", vec![]);
    let (_, first) = run.next_ask();
    assert_eq!(
        first,
        Some(json!({ "outcome": { "outcome": "selected", "optionId": "default" } }))
    );
    let (request, routed) = run.next_ask();
    assert_eq!((request["id"].as_u64(), routed), (Some(93), None));
    let offered = vec![
        ("acceptEdits".to_string(), "allow_always".to_string()),
        ("plan".to_string(), "reject_once".to_string()),
    ];
    let (answer, decision) = permission_response("selected", Some("plan".into()), &offered);
    assert_eq!(decision, "user_reject");
    run.answer(93, answer.clone());
    let (client, result, _, _) = run.finish();
    kill(&client);
    assert_eq!(reply(&result.unwrap().agent_text, 93), answer);
    // allow_always is never picked.
    assert_eq!(answers_to(&agent, 93), vec![answer]);
}

#[test]
fn a_permission_request_while_the_plan_card_is_up_is_answered_at_once() {
    // Parallel tool calls: ExitPlanMode waits on the card while another
    // tool asks; the second must not wait behind the card.
    let steps = json!([
        nowait(exit_plan_request(95)),
        nowait(permission_request(
            96,
            json!({ "toolCallId": "toolu_ls", "title": "`ls`", "kind": "execute" }),
            claude_tool_options()
        )),
        { "await": 96 },
        { "await": 95 },
    ]);
    let agent = fake!("plan-card-overlap", claude_scenario(json!([steps])));
    let client = connect(&agent, ProviderId::Claude, "plan");
    let run = start(client, "role_planner", "plan", vec![]);
    let (plan, routed) = run.next_ask();
    assert_eq!((plan["id"].as_u64(), routed), (Some(95), None));
    let (tool, routed) = run.next_ask();
    assert_eq!(tool["id"].as_u64(), Some(96));
    assert_eq!(
        routed,
        Some(json!({ "outcome": { "outcome": "selected", "optionId": "allow" } }))
    );
    run.wait_note(|n| echoed(n, 96));
    std::thread::sleep(Duration::from_millis(150));
    assert!(
        !run.handle.is_finished(),
        "the plan card still holds the turn"
    );
    run.answer(95, keep_planning(&plan));
    let (client, result, _, _) = run.finish();
    kill(&client);
    let text = result.unwrap().agent_text;
    assert!(text.find("[reply 96]") < text.find("[reply 95]"), "{text}");
    assert_eq!(reply(&text, 95)["outcome"]["optionId"], "plan");
}

#[test]
fn exit_plan_with_an_empty_plan_reads_the_plan_file_the_turn_wrote() {
    let dir = crate::test_support::TempDir::new("plan_file");
    let plans = dir.join("claude-config").join("plans");
    std::fs::create_dir_all(&plans).unwrap();
    let plan_path = plans.join("fix-login.md");
    std::fs::write(&plan_path, "# Fix login\n1. Reproduce\n2. Patch\n").unwrap();
    let other = plans.join("old-idea.md");
    std::fs::write(&other, "# Old").unwrap();
    let path = plan_path.display().to_string();
    let steps = json!([
        // A read of another plan file is not "the plan".
        { "update": { "sessionUpdate": "tool_call", "toolCallId": "toolu_read", "title": "Read",
            "kind": "read", "rawInput": { "file_path": other.display().to_string() } } },
        { "update": { "sessionUpdate": "tool_call", "toolCallId": "toolu_write", "title": "Write fix-login.md",
            "kind": "edit", "status": "pending",
            "rawInput": { "file_path": path, "content": "# Fix login" },
            "locations": [{ "path": path }] } },
        { "update": { "sessionUpdate": "tool_call_update", "toolCallId": "toolu_write", "status": "completed" } },
        permission_request(97,
            json!({ "toolCallId": "toolu_exit", "title": "Ready to code?", "kind": "switch_mode",
                "rawInput": { "plan": "" } }),
            json!([
                { "optionId": "default", "name": "Yes, and manually approve edits", "kind": "allow_once" },
                { "optionId": "plan", "name": "No, keep planning", "kind": "reject_once" }
            ])),
    ]);
    let agent = fake!("plan-file", claude_scenario(json!([steps])));
    let client = connect(&agent, ProviderId::Claude, "plan");
    let run = start(client, "role_planner", "plan", vec![]);
    let (request, routed) = run.next_ask();
    assert_eq!(routed, None, "the Planner's ExitPlanMode is a card");
    let notes: Vec<Value> = run.notes.try_iter().collect();

    // The prompt worker's cache saw the Write; the UI got its path.
    let mut cache = ToolCallCache::new();
    let mut emitted = Vec::new();
    for note in &notes {
        cache.observe_notification(note);
        if let Some(event) = map_session_update("tab", "fake-session-1", note) {
            emitted.extend(event.plan_path);
        }
    }
    // Only the Write carries the path; the read and the status update do not.
    assert_eq!(emitted, vec![path.clone()]);
    assert_eq!(cache.last_plan_file(), Some(path.as_str()));

    let params = &request["params"];
    assert_eq!(exit_plan_body(params), None, "rawInput.plan is empty");
    assert_eq!(
        exit_plan_file(params, &cache).as_deref(),
        Some(path.as_str())
    );
    assert_eq!(
        read_plan_file(&path, Some(&plans)).as_deref(),
        Some("# Fix login\n1. Reproduce\n2. Patch\n")
    );
    // Only plan files, and only under the provider's plans folder.
    assert_eq!(read_plan_file(&path, Some(&dir.join("elsewhere"))), None);
    let not_a_plan = dir.join("notes.md");
    std::fs::write(&not_a_plan, "x").unwrap();
    assert_eq!(
        read_plan_file(&not_a_plan.display().to_string(), None),
        None
    );
    assert_eq!(read_plan_file("plans/relative.md", None), None);

    // A plan file named in ExitPlanMode itself wins over the cache.
    let named =
        json!({ "toolCall": { "rawInput": { "planFilePath": other.display().to_string() } } });
    assert_eq!(
        exit_plan_file(&named, &cache),
        Some(other.display().to_string())
    );
    // The plan as ACP content blocks (no rawInput.plan) is still the body.
    let blocks = json!({ "toolCall": { "content": [
        { "type": "content", "content": { "type": "text", "text": "# From content" } }
    ] } });
    assert_eq!(exit_plan_body(&blocks).as_deref(), Some("# From content"));

    run.answer(97, keep_planning(&request));
    let (client, result, _, _) = run.finish();
    kill(&client);
    assert_eq!(
        reply(&result.unwrap().agent_text, 97)["outcome"]["optionId"],
        "plan"
    );
}

// ---------- turns ----------

#[test]
fn a_prompt_sent_while_the_last_cancel_is_still_settling_gets_none_of_its_output() {
    // The agent ignores the cancel past the grace period, then finishes the
    // old turn late (with a stray permission request) before reading the
    // next prompt.
    let late_ask = permission_request(
        98,
        json!({ "toolCallId": "toolu_late", "title": "`ls`", "kind": "execute" }),
        claude_tool_options(),
    );
    let agent = fake!(
        "settle",
        claude_scenario(json!([
            [
                { "say": "working" },
                { "wait_cancel": true },
                { "sleep": 3 },
                { "say": "late from turn 1" },
                late_ask,
                { "say": "still turn 1" }
            ],
            [{ "say": "turn 2" }]
        ]))
    );
    let client = connect(&agent, ProviderId::Claude, "bypassPermissions");
    let run = start(client, "role_implementer", "long job", vec![]);
    run.wait_note(|n| is_text(n, "working"));
    let cancelled_at = Instant::now();
    run.cancel.store(true, Ordering::SeqCst);
    let (client, result, _, _) = run.finish();
    assert_eq!(result.unwrap().stop_reason.as_deref(), Some("cancelled"));
    assert!(
        cancelled_at.elapsed() < Duration::from_millis(2900),
        "gave up after the grace"
    );

    let (client, result, notes, asks) = start(client, "role_implementer", "next", vec![]).finish();
    kill(&client);
    let result = result.unwrap();
    assert_eq!(result.agent_text, "turn 2");
    assert_eq!(result.stop_reason.as_deref(), Some("end_turn"));
    assert!(
        notes.iter().all(|n| !n.to_string().contains("turn 1")),
        "{notes:?}"
    );
    assert!(
        asks.is_empty(),
        "the old turn's request never reached the new turn"
    );
    assert_eq!(
        answers_to(&agent, 98),
        vec![json!({ "outcome": { "outcome": "cancelled" } })]
    );
}

#[test]
fn an_answer_queued_after_a_turn_ended_is_not_sent_into_the_next_turn() {
    // A cancel that races the end of a turn queues answers for cards that no
    // longer exist; the next turn must not send them.
    let card = permission_request(
        99,
        json!({ "toolCallId": "toolu_rm", "title": "`rm -rf build`", "kind": "delete" }),
        json!([
            { "optionId": "allow_always", "name": "Always Allow", "kind": "allow_always" },
            { "optionId": "reject", "name": "Reject", "kind": "reject_once" }
        ]),
    );
    let agent = fake!(
        "stale-outbox",
        claude_scenario(json!([[{ "say": "one" }], [card]]))
    );
    let client = connect(&agent, ProviderId::Claude, "bypassPermissions");
    let (client, result, _, _) = start(client, "role_implementer", "first", vec![]).finish();
    result.unwrap();
    client.outbox().lock().unwrap().push((
        99,
        json!({ "outcome": { "outcome": "selected", "optionId": "allow_always" } }),
    ));
    let run = start(client, "role_implementer", "right after", vec![]);
    let (request, routed) = run.next_ask();
    assert_eq!((request["id"].as_u64(), routed), (Some(99), None));
    let reject = json!({ "outcome": { "outcome": "selected", "optionId": "reject" } });
    run.answer(99, reject.clone());
    let (client, result, _, _) = run.finish();
    kill(&client);
    assert_eq!(reply(&result.unwrap().agent_text, 99), reject);
    assert_eq!(answers_to(&agent, 99), vec![reject]);
}

#[test]
fn two_tabs_on_the_same_account_run_at_once_without_crosstalk() {
    let scenario = |sid: &str, word: &str| {
        let mut s = claude_scenario(json!([[
            { "say": format!("{word} one") },
            { "sleep": 0.3 },
            { "say": format!(" {word} two") }
        ]]));
        s["session_id"] = json!(sid);
        s
    };
    let a = fake!("tab-a", scenario("sess-a", "alpha"));
    let b = fake!("tab-b", scenario("sess-b", "beta"));
    let run_a = start(
        connect(&a, ProviderId::Claude, "bypassPermissions"),
        "role_implementer",
        "a",
        vec![],
    );
    let run_b = start(
        connect(&b, ProviderId::Claude, "bypassPermissions"),
        "role_implementer",
        "b",
        vec![],
    );
    let (client_a, result_a, notes_a, _) = run_a.finish();
    let (client_b, result_b, notes_b, _) = run_b.finish();
    kill(&client_a);
    kill(&client_b);
    assert_eq!(result_a.unwrap().agent_text, "alpha one alpha two");
    assert_eq!(result_b.unwrap().agent_text, "beta one beta two");
    assert!(notes_a.iter().all(|n| n["params"]["sessionId"] == "sess-a"));
    assert!(notes_b.iter().all(|n| n["params"]["sessionId"] == "sess-b"));
    assert_eq!(a.sent("session/prompt")[0]["sessionId"], "sess-a");
    assert_eq!(b.sent("session/prompt")[0]["sessionId"], "sess-b");
}

#[test]
fn an_agent_that_exits_between_turns_is_seen_as_exited_and_can_be_restarted() {
    let agent = fake!(
        "exit-between",
        claude_scenario(json!([[{ "say": "bye" }, { "end_exit": 0 }]]))
    );
    let client = connect(&agent, ProviderId::Claude, "bypassPermissions");
    let (client, result, _, _) = start(client, "role_implementer", "go", vec![]).finish();
    assert_eq!(result.unwrap().agent_text, "bye");

    let live = LiveSession::from_client("tab-exit", "role_implementer", client);
    let deadline = Instant::now() + Duration::from_secs(5);
    while !live.is_dead() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(live.is_dead(), "the exit is noticed without a turn");
    assert!(live.live_info().exited, "a reloaded webview offers Restart");
    let err = live
        .client
        .lock()
        .unwrap()
        .send_prompt("again", &[], None, None)
        .unwrap_err();
    assert!(err.contains("agent exited"), "{err}");

    // Restart is not refused as "already has a live session".
    let mut registry = SessionRegistry::new();
    registry.insert(live);
    registry
        .try_begin_start("tab-exit")
        .expect("restart allowed");
    assert!(registry.get("tab-exit").is_none());
    registry.finish_start("tab-exit");
}

#[test]
fn a_long_tool_run_with_sparse_heartbeats_does_not_hit_the_idle_limit() {
    let mut steps = vec![
        json!({ "update": { "sessionUpdate": "tool_call", "toolCallId": "toolu_build",
        "title": "`cargo build`", "kind": "execute", "status": "in_progress",
        "rawInput": { "command": "cargo build" } } }),
    ];
    for _ in 0..6 {
        steps.push(json!({ "sleep": 0.35 }));
        steps.push(json!({ "update": { "sessionUpdate": "tool_call_update",
            "toolCallId": "toolu_build", "status": "in_progress" } }));
    }
    steps.push(json!({ "say": "built" }));
    let agent = fake!("heartbeat", json!({ "prompts": [steps] }));
    let mut conn =
        AcpConnection::spawn_program(&agent.program(), None, agent.provider(ProviderId::Claude))
            .unwrap();
    let cancel = AtomicBool::new(false);
    let mut next_id = 100;
    let mut turn = TurnControl {
        cancel: &cancel,
        session_id: "fake-session-1",
        next_id: &mut next_id,
        outbox: None,
        followups: None,
    };
    let mut dispatch = LineDispatch::new();
    // The whole run takes ~2.1 s; the idle limit is 0.8 s.
    let result = conn.call_with_dispatch(
        7,
        "session/prompt",
        json!({ "sessionId": "fake-session-1", "prompt": [] }),
        Duration::from_millis(800),
        &mut dispatch,
        Some(&mut turn),
    );
    conn.kill();
    assert_eq!(result.unwrap()["stopReason"], "end_turn");
}

// ---------- permission modes per role ----------

#[test]
fn every_built_in_role_starts_in_its_intended_mode_on_both_providers() {
    let claude_modes = [
        "default",
        "acceptEdits",
        "plan",
        "auto",
        "bypassPermissions",
    ]
    .map(String::from);
    let claude = ClaudeProvider::with_config(
        &Default::default(),
        crate::provider::claude_config::ConfigDirInfo {
            path: "/nonexistent/dct-claude-config".into(),
            display: "test".into(),
            source: crate::provider::claude_config::ConfigDirSource::Setting,
            exists: false,
        },
    );
    for spec in crate::template::all_role_specs() {
        let (want_claude, want_cursor) = match spec.id {
            "role_planner" => ("plan", "plan"),
            "role_general" => ("auto", "ask"),
            "role_recommendation" => ("bypassPermissions", "plan"),
            _ => ("bypassPermissions", "agent"),
        };
        assert_eq!(
            claude.mode_for_role(spec.id, spec.default_mode, &claude_modes),
            want_claude,
            "{} on Claude",
            spec.id
        );
        assert_eq!(
            CursorProvider.mode_for_role(spec.id, spec.default_mode, &[]),
            want_cursor,
            "{} on Cursor",
            spec.id
        );
    }
    // Without bypass on offer, reviewers fall back to default (still auto-approved).
    assert_eq!(
        claude.mode_for_role(
            "role_pr_reviewer",
            "agent",
            &["default".into(), "plan".into()]
        ),
        "default"
    );

    // The reviewers that must not implement still start in bypassPermissions,
    // and say so in the session/set_mode the adapter receives.
    for role in ["role_plan_reviewer", "role_pr_reviewer"] {
        let agent = fake!("reviewer-mode", claude_scenario(json!([])));
        let provider = agent.provider(ProviderId::Claude);
        let mode = provider.mode_for_role(role, "agent", &[]);
        let client = connect(&agent, ProviderId::Claude, &mode);
        kill(&client);
        assert_eq!(
            agent.sent("session/set_mode")[0]["modeId"],
            "bypassPermissions",
            "{role}"
        );
    }
}
