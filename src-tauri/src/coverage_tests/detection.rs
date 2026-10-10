//! CLI detection, the Claude config folder, model lists, Claude history
//! parsing, Cursor plan lookup and the pure window helpers. Fake binaries are
//! tiny shell scripts in a temp folder; no real `claude` or `agent` runs.

use crate::claude_history::{list_claude_history, projects_dir};
use crate::cli_detect::parse_login_status;
use crate::models::{
    choose_list, claude_model_list, claude_models_from_options, is_claude_model_id,
    parse_list_models, read_provider_cache, remember_claude_models, valid_model_id,
    write_provider_cache, ModelCache, ModelEntry,
};
use crate::provider::claude_config::{resolve_with, ConfigDirInfo, ConfigDirSource};
use crate::provider::claude_detect::{
    claude_login_status, parse_claude_auth_status, read_claude_version, resolve_adapter_with,
    resolve_claude_with, Lookup,
};
use crate::pty::plans::newest_plan_since;
use crate::test_support::{names_in, TempDir};
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

// ---------- Cursor `agent status` ----------

#[test]
fn agent_status_json_shapes() {
    let out = parse_login_status(r#"{"isAuthenticated": false, "email": "a@b.c"}"#, "", true);
    assert_eq!((out.state.as_str(), out.account), ("loggedOut", None));
    let out = parse_login_status(r#"{"LoggedIn": true, "user": {"name": "JT"}}"#, "", true);
    assert_eq!(
        (out.state.as_str(), out.account.as_deref()),
        ("loggedIn", Some("JT"))
    );
    let out = parse_login_status(r#"{"status": "logged_out"}"#, "", false);
    assert_eq!(out.state, "loggedOut");
    let out = parse_login_status(r#"{"status": "Authenticated", "username": "jt"}"#, "", true);
    assert_eq!(
        (out.state.as_str(), out.account.as_deref()),
        ("loggedIn", Some("jt"))
    );
    // JSON without a recognisable flag falls through to the text rules.
    let out = parse_login_status(r#"{"version": "1.2"}"#, "", true);
    assert_eq!(out.state, "unknown");
}

#[test]
fn agent_status_text_with_colour_and_noise() {
    let out = parse_login_status(
        "\u{1b}[32m✓ Logged in as jt@example.com.\u{1b}[0m\nTip: …",
        "",
        true,
    );
    assert_eq!(out.state, "loggedIn");
    assert_eq!(out.account.as_deref(), Some("jt@example.com"));
    let out = parse_login_status("", "Error: please log in first", false);
    assert_eq!(out.state, "loggedOut");
    let out = parse_login_status("", "", false);
    assert_eq!((out.state.as_str(), out.detail), ("unknown", None));
    let out = parse_login_status(&"x".repeat(1000), "", false);
    assert_eq!(out.detail.unwrap().chars().count(), 200);
}

// ---------- Claude binary lookup, version and auth ----------

fn config_info(dir: &Path, exists: bool) -> ConfigDirInfo {
    ConfigDirInfo {
        path: dir.display().to_string(),
        display: "test".into(),
        source: ConfigDirSource::Setting,
        exists,
    }
}

#[cfg(unix)]
fn fake_binary(dir: &Path, name: &str, body: &str) -> std::path::PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let path = dir.join(name);
    std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
}

#[test]
fn overrides_must_name_a_file_and_nothing_found_is_none() {
    let dir = TempDir::new("detect_override");
    std::fs::create_dir_all(dir.join("a_dir")).unwrap();
    let lookup = Lookup {
        env_override: Some(dir.join("a_dir").display().to_string()),
        setting: Some("   ".into()),
        path_dirs: vec![dir.join("empty_path")],
        known: vec![dir.join("nope").join("claude")],
    };
    assert_eq!(resolve_claude_with(&lookup), None);
    assert_eq!(resolve_adapter_with(&lookup), None);

    std::fs::write(dir.join("claude"), b"").unwrap();
    let lookup = Lookup {
        env_override: Some(dir.join("missing").display().to_string()),
        setting: Some(format!("  {}  ", dir.join("claude").display())),
        ..Lookup::default()
    };
    assert_eq!(resolve_claude_with(&lookup), Some(dir.join("claude")));
}

#[cfg(unix)]
#[test]
fn version_is_the_first_line_and_runs_with_the_resolved_config_dir() {
    let bin = TempDir::new("detect_version_bin");
    let config = TempDir::new("detect_version_cfg");
    let seen = bin.join("seen_env");
    let claude = fake_binary(
        bin.path(),
        "claude",
        &format!(
            "echo \"$CLAUDE_CONFIG_DIR|$NO_COLOR|$*\" > '{}'\nprintf '2.1.236 (Claude Code)\\nsecond line\\n'",
            seen.display()
        ),
    );
    let info = config_info(config.path(), true);
    assert_eq!(
        read_claude_version(&claude, &info).as_deref(),
        Some("2.1.236 (Claude Code)")
    );
    assert_eq!(
        std::fs::read_to_string(&seen).unwrap().trim(),
        format!("{}|1|--version", config.path().display())
    );
    assert!(
        names_in(config.path()).is_empty(),
        "nothing written to the config dir"
    );

    let failing = fake_binary(
        bin.path(),
        "claude_fail",
        "echo 'boom: bad install' >&2\nexit 3",
    );
    assert_eq!(
        read_claude_version(&failing, &info).as_deref(),
        Some("boom: bad install")
    );
    let silent = fake_binary(bin.path(), "claude_silent", "exit 0");
    assert_eq!(read_claude_version(&silent, &info), None);
    assert_eq!(read_claude_version(&bin.join("not_there"), &info), None);
}

#[cfg(unix)]
#[test]
fn auth_status_needs_a_binary_and_an_existing_config_folder() {
    let bin = TempDir::new("detect_auth_bin");
    let marker = bin.join("ran");
    let claude = fake_binary(
        bin.path(),
        "claude",
        &format!(
            "touch '{}'\necho '{{\"loggedIn\": true, \"email\": \"jt@x\"}}'",
            marker.display()
        ),
    );
    let missing = bin.join("no_config");
    assert_eq!(
        claude_login_status(None, &config_info(&missing, false)).state,
        "noCli"
    );
    let status = claude_login_status(Some(&claude), &config_info(&missing, false));
    assert_eq!(status.state, "noConfigDir");
    assert!(status.detail.unwrap().contains("not found"));
    assert!(
        !marker.exists(),
        "claude must not run against a missing folder"
    );
    assert!(!missing.exists(), "the folder is never created");

    let config = TempDir::new("detect_auth_cfg");
    let status = claude_login_status(Some(&claude), &config_info(config.path(), true));
    assert_eq!(status.state, "loggedIn");
    assert_eq!(status.account.as_deref(), Some("jt@x"));
    assert!(marker.exists());
}

#[test]
fn claude_auth_status_edge_shapes() {
    let out = parse_claude_auth_status(
        r#"{"loggedIn": true, "authMethod": "none", "subscriptionType": "", "orgName": "Acme"}"#,
        "",
    );
    assert_eq!(out.state, "loggedIn");
    assert_eq!(out.method, None);
    assert_eq!(out.account.as_deref(), Some("Acme"));
    let out = parse_claude_auth_status(r#"{"loggedIn": true, "subscriptionType": "max"}"#, "");
    assert_eq!((out.method.as_deref(), out.account), (Some("max"), None));
    let out = parse_claude_auth_status(r#"{"loggedIn": "yes"}"#, "Not logged in");
    assert_eq!(
        out.state, "loggedOut",
        "a non-bool flag falls back to the text"
    );
    let out = parse_claude_auth_status("garbage", "");
    assert_eq!(
        (out.state.as_str(), out.detail.as_deref()),
        ("unknown", Some("garbage"))
    );
}

// ---------- Claude config folder ----------

#[test]
fn the_config_dir_resolves_under_the_given_home_and_is_never_created() {
    let home = TempDir::new("cfg_home");
    let info = resolve_with(None, None, Some(home.path()));
    assert_eq!(info.source, ConfigDirSource::Default);
    assert_eq!(Path::new(&info.path), home.join(".claude"));
    assert!(!info.exists);
    assert!(
        names_in(home.path()).is_empty(),
        "~/.claude was not created"
    );

    let info = resolve_with(Some("  "), Some("~/.claude-work"), Some(home.path()));
    assert_eq!(info.source, ConfigDirSource::Setting);
    assert_eq!(Path::new(&info.path), home.join(".claude-work"));
    assert_eq!(info.display, "~/.claude-work");

    std::fs::create_dir_all(home.join("env-dir")).unwrap();
    let info = resolve_with(Some("env-dir"), Some("~/.claude-work"), Some(home.path()));
    assert_eq!(info.source, ConfigDirSource::Env);
    assert!(info.exists);
    assert_eq!(info.display, "~/env-dir");
    assert!(info.missing_message().is_none());
    assert!(names_in(home.path()) == vec!["env-dir"]);
}

// ---------- model lists ----------

#[test]
fn list_models_parsing_edge_cases() {
    let out = "Available models\r\n\
               \r\n\
               * composer-2.5 - Composer 2.5 (current) (default)\r\n\
               > gpt-5 - (current)\r\n\
               --rm-rf - Not a model\r\n\
               two words - Nope\r\n\
               auto - Auto\u{200B}\r\n\
               auto - Duplicate\r\n\
               Tip: run agent --list-models - for more\r\n";
    let models = parse_list_models(out);
    let pairs: Vec<_> = models
        .iter()
        .map(|m| (m.id.as_str(), m.label.as_str()))
        .collect();
    assert_eq!(
        pairs,
        vec![
            ("composer-2.5", "Composer 2.5"),
            ("gpt-5", "gpt-5"),
            ("auto", "Auto")
        ]
    );
    assert!(parse_list_models("").is_empty());
    assert!(!valid_model_id(&"a".repeat(500)));
}

#[test]
fn claude_model_ids() {
    for ok in [
        "opus",
        "sonnet[1m]",
        "claude-opus-4-5-20251101",
        "claude-sonnet-4.5",
        " claude-haiku-4 ",
        "best",
    ] {
        assert!(is_claude_model_id(ok), "{ok}");
    }
    for bad in [
        "",
        "[1m]",
        "claude-",
        "claude-opus",
        "claude-opus-",
        "claude-opus-x1",
        "claude-Opus-4",
        "claude-4.5-sonnet",
        "claude-gpt-5",
        "composer-2.5",
        "opus[2m]",
    ] {
        assert!(!is_claude_model_id(bad), "{bad}");
    }
    let models = claude_models_from_options(&[
        ("opus".into(), "".into()),
        ("gpt-5".into(), "GPT".into()),
        ("opus".into(), "dup".into()),
        ("fable".into(), "Fable".into()),
    ]);
    let ids: Vec<_> = models.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(ids, vec!["opus", "fable"]);
    assert_eq!(models[0].label, "opus");
    assert!(models[1].badge.is_some());
}

fn entry(id: &str) -> ModelEntry {
    ModelEntry {
        id: id.into(),
        label: id.into(),
        fast: false,
        badge: None,
    }
}

#[test]
fn model_caches_are_per_provider_and_damage_falls_back() {
    let dir = TempDir::new("models_cache");
    write_provider_cache(
        dir.path(),
        "cursor",
        &ModelCache {
            fetched_at_ms: 1,
            models: vec![entry("gpt-5")],
        },
    )
    .unwrap();
    remember_claude_models(dir.path(), &[entry("opus")]).unwrap();
    remember_claude_models(dir.path(), &[]).unwrap();
    assert_eq!(
        read_provider_cache(dir.path(), "cursor").unwrap().models[0].id,
        "gpt-5"
    );
    assert_eq!(
        read_provider_cache(dir.path(), "claude").unwrap().models[0].id,
        "opus"
    );

    // Stale Claude cache → the static aliases.
    let far_future = i64::MAX / 2;
    let list = claude_model_list(dir.path(), far_future);
    assert_eq!(list.source, "fallback");
    assert_eq!(list.models[0].id, "default");

    std::fs::write(dir.join("models-cache.json"), b"{broken").unwrap();
    assert!(read_provider_cache(dir.path(), "cursor").is_none());
    assert_eq!(claude_model_list(dir.path(), 0).source, "fallback");
}

#[test]
fn refresh_skips_a_fresh_cache_and_an_empty_cli_list_is_an_error() {
    let cache = ModelCache {
        fetched_at_ms: 1_000,
        models: vec![entry("cached")],
    };
    let (list, fresh) = choose_list(true, 1_001, Some(cache.clone()), || Ok(vec![entry("live")]));
    assert_eq!(
        (list.source.as_str(), list.models[0].id.as_str()),
        ("cli", "live")
    );
    assert_eq!(fresh.unwrap().fetched_at_ms, 1_001);

    let (list, fresh) = choose_list(true, 1_001, Some(cache), || Ok(vec![]));
    assert_eq!(list.source, "cache");
    assert!(list.error.unwrap().contains("no models"));
    assert!(fresh.is_none());

    let (list, _) = choose_list(false, 0, None, || Err("spawn failed".into()));
    assert_eq!(list.source, "fallback");
    assert_eq!(list.error.as_deref(), Some("spawn failed"));
}

// ---------- Claude history (jsonl) ----------

fn session_line(kind: &str, cwd: &str, extra: serde_json::Value) -> String {
    let mut value = serde_json::json!({ "type": kind, "cwd": cwd, "sessionId": "sess-1" });
    if let (Some(obj), Some(more)) = (value.as_object_mut(), extra.as_object()) {
        for (k, v) in more {
            obj.insert(k.clone(), v.clone());
        }
    }
    value.to_string()
}

#[test]
fn history_skips_bad_lines_and_odd_files() {
    let config = TempDir::new("hist_bad_lines");
    let work = TempDir::new("hist_work");
    let cwd = work.path().display().to_string();
    let project = projects_dir(config.path()).join("-encoded-folder");
    std::fs::create_dir_all(&project).unwrap();
    let body = [
        "{torn json".to_string(),
        "".to_string(),
        "[1, 2, 3]".to_string(),
        session_line(
            "user",
            &cwd,
            serde_json::json!({"message": {"content": [{"type": "text", "text": "  Fix"}, {"type": "image"}, {"type": "text", "text": "the   build "}]}}),
        ),
        session_line("assistant", &cwd, serde_json::json!({})),
    ]
    .join("\n");
    std::fs::write(project.join("a.jsonl"), &body).unwrap();
    std::fs::write(project.join("empty.jsonl"), "").unwrap();
    std::fs::write(project.join("notes.json"), &body).unwrap();
    std::fs::create_dir_all(project.join("dir.jsonl")).unwrap();
    std::fs::write(projects_dir(config.path()).join("loose.jsonl"), &body).unwrap();

    let entries = list_claude_history(config.path(), &cwd);
    assert_eq!(entries.len(), 1, "{entries:?}");
    assert_eq!(entries[0].id, "sess-1");
    assert_eq!(entries[0].title, "Fix the build");
    assert_eq!(entries[0].source, "claude");
}

#[test]
fn history_titles_prefer_custom_then_ai_then_user_and_are_capped() {
    let config = TempDir::new("hist_titles");
    let work = TempDir::new("hist_titles_work");
    let cwd = work.path().display().to_string();
    let project = projects_dir(config.path()).join("p");
    std::fs::create_dir_all(&project).unwrap();
    let long = "word ".repeat(60);
    let lines = [
        session_line(
            "user",
            &cwd,
            serde_json::json!({"message": {"content": long}}),
        ),
        session_line("ai-title", &cwd, serde_json::json!({"aiTitle": "AI title"})),
        session_line(
            "custom-title",
            &cwd,
            serde_json::json!({"customTitle": "  Mine  "}),
        ),
    ];
    std::fs::write(project.join("custom.jsonl"), lines.join("\n")).unwrap();
    std::fs::write(project.join("ai.jsonl"), lines[..2].join("\n")).unwrap();
    std::fs::write(project.join("user.jsonl"), &lines[0]).unwrap();
    // No sessionId: the file stem is the id. No user text: a stock title.
    std::fs::write(
        project.join("bare.jsonl"),
        serde_json::json!({"type": "system", "cwd": cwd}).to_string(),
    )
    .unwrap();
    let mut titles: Vec<(String, String)> = list_claude_history(config.path(), &cwd)
        .into_iter()
        .map(|e| (e.id, e.title))
        .collect();
    titles.sort();
    let user_title = titles.iter().find(|(_, t)| t.ends_with('…')).unwrap();
    assert_eq!(user_title.1.chars().count(), 121);
    assert!(titles.contains(&("bare".to_string(), "Claude session".to_string())));
    assert!(titles.iter().any(|(_, t)| t == "Mine"));
    assert!(titles.iter().any(|(_, t)| t == "AI title"));
}

#[test]
fn history_for_a_blank_folder_or_missing_projects_is_empty_and_creates_nothing() {
    let config = TempDir::new("hist_missing");
    assert!(list_claude_history(config.path(), "/some/folder").is_empty());
    assert!(list_claude_history(config.path(), "   ").is_empty());
    assert!(names_in(config.path()).is_empty());
}

// Known bug: `read_session` stops at the first line that is not valid UTF-8
// (`reader.read_line(&mut line).ok()?`, src/claude_history.rs:106) and drops
// the whole session, while torn JSON lines are skipped. The 256 KB read cap
// can also cut a multi-byte character in half and hit the same path.
#[test]
#[ignore = "known bug: one non-UTF-8 line hides the whole Claude session (claude_history.rs:106)"]
fn history_skips_a_non_utf8_line_instead_of_dropping_the_session() {
    let config = TempDir::new("hist_utf8");
    let work = TempDir::new("hist_utf8_work");
    let cwd = work.path().display().to_string();
    let project = projects_dir(config.path()).join("p");
    std::fs::create_dir_all(&project).unwrap();
    let mut body = b"{\"type\":\"progress\",\"blob\":\"\xff\xfe\"}\n".to_vec();
    body.extend_from_slice(
        session_line(
            "user",
            &cwd,
            serde_json::json!({"message": {"content": "hi"}}),
        )
        .as_bytes(),
    );
    std::fs::write(project.join("s.jsonl"), body).unwrap();
    assert_eq!(list_claude_history(config.path(), &cwd).len(), 1);
}

// ---------- Cursor plan files ----------

fn touch_at(path: &Path, body: &str, when: SystemTime) {
    std::fs::write(path, body).unwrap();
    let file = std::fs::OpenOptions::new().write(true).open(path).unwrap();
    file.set_modified(when).unwrap();
}

#[test]
fn plan_lookup_ties_boundaries_and_non_folders() {
    let dir = TempDir::new("plans_edges");
    let started = UNIX_EPOCH + Duration::from_secs(1_800_000_000);
    touch_at(&dir.join("at_start.md"), "same instant", started);
    assert!(
        newest_plan_since(dir.path(), started).unwrap().is_none(),
        "strictly after"
    );

    let later = started + Duration::from_secs(10);
    touch_at(&dir.join("a.md"), "plan a", later);
    touch_at(&dir.join("b.md"), "plan b", later);
    let found = newest_plan_since(dir.path(), started).unwrap().unwrap();
    assert_eq!(
        (found.name.as_str(), found.text.as_str()),
        ("b.md", "plan b")
    );
    assert_eq!(found.modified, later);

    let file = dir.join("a.md");
    assert!(
        newest_plan_since(&file, started).unwrap().is_none(),
        "a file is not a plans dir"
    );
}
