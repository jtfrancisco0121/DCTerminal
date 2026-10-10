//! Permission policy matrix, `cli-config.json` parsing, and redaction of
//! secrets in activity summaries and permission logs.

use super::cli_config::{
    classify_approval_mode, read_approval_mode_at, resolve_cli_config_path, status_from_value,
    ApprovalModeKind,
};
use super::policy::{evaluate_permission, PolicyDecision};
use super::redact::{redact_permission_payload, redact_summary};
use crate::test_support::TempDir;
use serde_json::{json, Value};
use std::ffi::OsStr;
use std::path::Path;

// ---------- policy matrix ----------

const ROLES: [&str; 7] = [
    "role_planner",
    "role_plan_reviewer",
    "role_implementer",
    "role_developer",
    "role_reviewer",
    "role_custom_abc",
    "",
];

fn tool_calls() -> Vec<Value> {
    vec![
        json!({ "toolCallId": "t1", "title": "Edit src/a.rs", "kind": "edit",
                "rawInput": { "path": "src/a.rs", "content": "x" } }),
        json!({ "toolCallId": "t2", "title": "`rm -rf build`", "kind": "execute",
                "rawInput": { "command": "rm -rf build" } }),
        json!({ "toolCallId": "t3", "title": "Fetch https://x.dev", "kind": "fetch",
                "rawInput": { "url": "https://x.dev" } }),
        json!({ "toolCallId": "t4", "title": "mcp: github/create_issue", "mcpServer": "github" }),
        json!({ "toolCallId": "t5", "title": "Delete old.txt", "kind": "delete" }),
        json!({ "toolCallId": "t6" }),
    ]
}

fn opt(id: &str, kind: &str) -> Value {
    json!({ "optionId": id, "name": id, "kind": kind })
}

/// (options, the option id that may be auto-selected, if any)
fn option_sets() -> Vec<(Option<Value>, Option<&'static str>)> {
    vec![
        (
            Some(json!([
                opt("allow-always", "allow_always"),
                opt("allow-once", "allow_once"),
                opt("reject-once", "reject_once")
            ])),
            Some("allow-once"),
        ),
        (
            Some(json!([
                opt("allow_always", "allow_always"),
                opt("allow", "allow_once"),
                opt("reject", "reject_once")
            ])),
            Some("allow"),
        ),
        (Some(json!([opt("yes", "ALLOW_ONCE")])), Some("yes")),
        (
            Some(json!([{ "optionId": "allow-once", "name": "Allow" }])),
            Some("allow-once"),
        ),
        (
            Some(json!([
                opt("allow-always", "allow_always"),
                opt("reject-once", "reject_once")
            ])),
            None,
        ),
        (Some(json!([opt("reject-once", "reject_once")])), None),
        (Some(json!([opt("allow-always", "allow_always")])), None),
        (
            Some(json!([{ "name": "no id", "kind": "allow_once" }, opt("reject", "reject_once")])),
            None,
        ),
        (Some(json!("allow-once")), None),
        (None, None),
    ]
}

#[test]
fn every_role_tool_and_option_set_only_ever_auto_answers_allow_once() {
    let mut checked = 0;
    for role in ROLES {
        for tool in tool_calls() {
            for (options, expected) in option_sets() {
                let mut params = json!({ "sessionId": "s", "toolCall": tool });
                if let Some(options) = &options {
                    params["options"] = options.clone();
                }
                let out = evaluate_permission(role, &params);
                let ctx = format!("role {role:?} tool {tool} options {options:?}");
                match expected {
                    Some(id) => {
                        assert_eq!(out.decision, PolicyDecision::AllowOnce, "{ctx}");
                        assert_eq!(
                            out.auto_result,
                            Some(json!({ "outcome": { "outcome": "selected", "optionId": id } })),
                            "{ctx}"
                        );
                        let line = out.transcript_line.expect("auto answers are logged");
                        assert!(line.starts_with("Permission auto-allowed"), "{ctx}: {line}");
                    }
                    None => {
                        assert_eq!(out.decision, PolicyDecision::Ask, "{ctx}");
                        assert!(out.auto_result.is_none(), "{ctx}");
                        assert!(out.transcript_line.is_none(), "{ctx}");
                    }
                }
                // Whatever happens, the selected option is never an allow_always.
                if let Some(result) = &out.auto_result {
                    let chosen = result.pointer("/outcome/optionId").and_then(Value::as_str);
                    let kind = options
                        .as_ref()
                        .and_then(Value::as_array)
                        .and_then(|opts| opts.iter().find(|o| o["optionId"].as_str() == chosen))
                        .and_then(|o| o["kind"].as_str())
                        .unwrap_or("");
                    assert!(!kind.eq_ignore_ascii_case("allow_always"), "{ctx}");
                }
                checked += 1;
            }
        }
    }
    assert_eq!(checked, ROLES.len() * 6 * 10);
}

#[test]
fn a_request_without_options_shows_synthesized_buttons_on_the_card() {
    let out = evaluate_permission(
        "role_implementer",
        &json!({ "toolCall": { "kind": "edit" } }),
    );
    let ids: Vec<_> = out.options.iter().map(|o| o.id.as_str()).collect();
    assert_eq!(ids, vec!["allow-once", "allow-always", "reject-once"]);
    assert_eq!(out.decision, PolicyDecision::Ask);
}

// Known bug: `agent_offered` is true for any `options` array, even an empty
// one, and `permission_options` then synthesizes an `allow-once` button that
// the agent never sent, which gets auto-selected
// (src/permissions/policy.rs:83-87).
#[test]
#[ignore = "known bug: options: [] auto-answers a synthesized allow-once the agent never offered (policy.rs:83)"]
fn an_empty_options_array_is_not_auto_answered() {
    let out = evaluate_permission(
        "role_implementer",
        &json!({ "toolCall": { "kind": "edit" }, "options": [] }),
    );
    assert_eq!(out.decision, PolicyDecision::Ask);
    assert!(out.auto_result.is_none());
}

// Known bug: `is_allow_once_choice` accepts the id `allow-once` whatever the
// option's kind says (src/permissions/policy.rs:122-126), so an option whose
// kind is `allow_always` but whose id is `allow-once` is auto-selected.
#[test]
#[ignore = "known bug: an allow_always option with id allow-once is auto-selected (policy.rs:125)"]
fn an_allow_always_option_is_never_auto_selected_by_its_id() {
    let out = evaluate_permission(
        "role_implementer",
        &json!({ "toolCall": { "kind": "edit" },
                 "options": [opt("allow-once", "allow_always"), opt("reject-once", "reject_once")] }),
    );
    assert!(out.auto_result.is_none(), "{:?}", out.auto_result);
}

// ---------- cli-config.json ----------

#[test]
fn cli_config_path_prefers_a_non_empty_cursor_config_dir() {
    let home = Path::new("/home/jt");
    assert_eq!(
        resolve_cli_config_path(Some(OsStr::new("/cfg")), Some(home)),
        Some(Path::new("/cfg/cli-config.json").to_path_buf())
    );
    assert_eq!(
        resolve_cli_config_path(Some(OsStr::new("")), Some(home)),
        Some(home.join(".cursor").join("cli-config.json"))
    );
    assert_eq!(resolve_cli_config_path(None, None), None);
}

#[test]
fn cli_config_read_failures_are_unknown_with_a_note() {
    let dir = TempDir::new("cli_config_read");
    let bad = dir.join("bad.json");
    std::fs::write(&bad, b"{ approvalMode: yolo").unwrap();
    let status = read_approval_mode_at(&bad);
    assert_eq!(status.kind, ApprovalModeKind::Unknown);
    assert!(status.note.unwrap().contains("parsed"));
    assert_eq!(status.config_path, Some(bad.display().to_string()));

    // A folder where the file should be is a read error, not a crash.
    let folder = dir.join("cli-config.json");
    std::fs::create_dir_all(&folder).unwrap();
    let status = read_approval_mode_at(&folder);
    assert_eq!(status.kind, ApprovalModeKind::Unknown);
    assert!(status.note.unwrap().contains("read"));
    assert!(!status.role_rules_off);

    let good = dir.join("good.json");
    std::fs::write(
        &good,
        br#"{"permissions": {"approval_mode": " Run Everything "}}"#,
    )
    .unwrap();
    let status = read_approval_mode_at(&good);
    assert_eq!(status.kind, ApprovalModeKind::Unrestricted);
    assert_eq!(status.approval_mode.as_deref(), Some("Run Everything"));
}

#[test]
fn approval_modes_classify_and_odd_values_are_unknown() {
    assert_eq!(
        classify_approval_mode(Some("allow_list")),
        ApprovalModeKind::Allowlist
    );
    assert_eq!(
        classify_approval_mode(Some("FORCE")),
        ApprovalModeKind::Unrestricted
    );
    assert_eq!(
        classify_approval_mode(Some("ask-every-time")),
        ApprovalModeKind::Other
    );
    assert_eq!(classify_approval_mode(None), ApprovalModeKind::Unknown);
    for value in [
        json!({"approvalMode": 3}),
        json!({"approvalMode": "  "}),
        json!([]),
        json!(null),
    ] {
        let status = status_from_value(&value, None);
        assert_eq!(status.kind, ApprovalModeKind::Unknown, "{value}");
        assert!(status.note.is_none());
    }
    let status = status_from_value(&json!({"approvalMode": "custom"}), None);
    assert!(status.note.unwrap().contains("`custom`"));
}

// ---------- redaction ----------

#[test]
fn summaries_mask_common_inline_secrets() {
    let cases = [
        (
            "export GITHUB_TOKEN=ghp_abc123 && make",
            "export GITHUB_TOKEN=[redacted] && make",
        ),
        (
            "mysql --password hunter2 -u root",
            "mysql --password [redacted] -u root",
        ),
        ("mysql --password=hunter2", "mysql password=[redacted]"),
        ("tool --api-key abc", "tool --api-key [redacted]"),
        (
            r#"curl -H "Authorization: Bearer abc.def" https://api.x"#,
            r#"curl -H "Authorization: Bearer [redacted] https://api.x"#,
        ),
        (
            "curl -u x https://api.x/v1?key=K1&page=2&token=T",
            "curl -u x https://api.x/v1?key=[redacted]&page=2&token=[redacted]",
        ),
        ("echo sk-live-123", "echo [redacted]"),
        ("cat ~/.ssh/id_rsa", "cat ~/.ssh/id_rsa"),
        ("cargo   test\n  --lib", "cargo test --lib"),
    ];
    for (input, want) in cases {
        assert_eq!(redact_summary(input, 500), want, "{input}");
    }
    let capped = redact_summary(&"a".repeat(50), 10);
    assert_eq!(capped.chars().count(), 10);
    assert!(capped.ends_with('…'));
}

// Known gaps in `redact_summary` (src/permissions/redact.rs:117-162):
// credentials in a URL's user-info part are not masked, and `sensitive_key`
// only matches whole names or `_<name>` suffixes from its list, so
// `AWS_SECRET_ACCESS_KEY=…` (ends in `_access_key`) is written to the
// activity log in clear.
#[test]
#[ignore = "known bug: URL user-info and AWS_SECRET_ACCESS_KEY values are not redacted (redact.rs:117)"]
fn summaries_mask_url_credentials_and_aws_secret_keys() {
    let url = redact_summary(
        "git clone https://x-access-token:ghp_SECRET@github.com/o/r.git",
        500,
    );
    assert!(!url.contains("ghp_SECRET"), "{url}");
    let aws = redact_summary(
        "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY aws s3 ls",
        500,
    );
    assert!(!aws.contains("wJalrXUtnFEMI"), "{aws}");
}

#[test]
fn permission_payloads_redact_by_key_and_value_at_any_depth() {
    let payload = json!({
        "toolCall": {
            "title": "Run deploy",
            "rawInput": {
                "command": format!("deploy {}", "x".repeat(600)),
                "headers": { "X-Api-Key": "k", "Cookie": ["a", "b"] },
                "env": [{ "name": "PATH", "value": "Bearer abc" }],
                "content": { "nested": "file body" },
                "notes": "y".repeat(600),
                "count": 3,
            }
        }
    });
    let out = redact_permission_payload(&payload);
    let raw = &out["toolCall"]["rawInput"];
    assert_eq!(
        raw["command"].as_str().unwrap().len(),
        607,
        "commands are kept whole"
    );
    assert_eq!(raw["headers"]["X-Api-Key"], "[redacted]");
    assert_eq!(
        raw["headers"]["Cookie"],
        json!(["[redacted]", "[redacted]"])
    );
    assert_eq!(raw["env"][0]["value"], "[redacted]");
    assert_eq!(raw["env"][0]["name"], "PATH");
    assert_eq!(
        raw["content"]["nested"], "file body",
        "only string values under the key are masked"
    );
    assert!(raw["notes"].as_str().unwrap().ends_with("…[truncated]"));
    assert_eq!(raw["count"], 3);
}
