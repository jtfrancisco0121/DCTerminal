//! Scratch, settings, projects (recent folders) and workspace stores.

use crate::provider::ProviderId;
use crate::store::settings_store::{valid_effort, ClaudeAccount};
use crate::store::{
    ModelSettings, ProjectsStore, ScratchStore, SettingsStore, TerminalSettings, UiSettings,
    WorkspaceStore,
};
use crate::test_support::{names_in, TempDir};
use chrono::{DateTime, Utc};
use std::collections::{HashMap, HashSet};

// ---------- scratch ----------

#[test]
fn scratch_history_is_trimmed_deduped_and_capped_at_fifty() {
    let dir = TempDir::new("scratch_hist");
    let mut store = ScratchStore::open(dir.path()).unwrap();
    let mut history: Vec<String> = vec!["  ".into(), "first".into(), " first ".into()];
    history.extend((0..80).map(|i| format!("line {i}")));
    store.upsert("tab_1", "body", &history, "2026-10-10T00:00:00Z");
    store.save().unwrap();

    let loaded = ScratchStore::open(dir.path()).unwrap();
    let pad = &loaded.data.pads["tab_1"];
    assert_eq!(pad.history.len(), 50);
    assert_eq!(pad.history[0], "first");
    assert_eq!(pad.history[1], "line 0");
    assert_eq!(pad.content, "body");
}

#[test]
fn a_newer_scratch_schema_is_set_aside_not_overwritten() {
    let dir = TempDir::new("scratch_schema");
    std::fs::write(
        dir.join("scratch.json"),
        r#"{"schemaVersion": 9, "pads": {"t": {"content": "future", "updatedAt": "x"}}}"#,
    )
    .unwrap();
    let store = ScratchStore::open(dir.path()).unwrap();
    assert!(store.data.pads.is_empty());
    assert!(names_in(dir.path()).contains(&"scratch.json.corrupt-schema-9".to_string()));
}

#[test]
fn scratch_prune_keeps_pads_with_unreadable_dates_and_recent_orphans() {
    let dir = TempDir::new("scratch_prune");
    let mut store = ScratchStore::open(dir.path()).unwrap();
    store.upsert("bad_date", "x", &[], "yesterday-ish");
    store.upsert("recent", "x", &[], "2026-10-01T00:00:00Z");
    store.upsert("old", "x", &[], "2026-08-01T00:00:00Z");
    let now: DateTime<Utc> = "2026-10-10T00:00:00Z".parse().unwrap();
    assert_eq!(store.prune_orphans(&HashSet::new(), now), 1);
    let mut left: Vec<_> = store.data.pads.keys().cloned().collect();
    left.sort();
    assert_eq!(left, vec!["bad_date", "recent"]);
}

// ---------- settings ----------

#[test]
fn valid_effort_accepts_only_short_lowercase_words() {
    for ok in ["low", "medium", "high", "xhigh", "max", "abcdefghijklmnop"] {
        assert!(valid_effort(ok), "{ok}");
    }
    for bad in [
        "",
        "LOW",
        "High",
        "x-high",
        "high ",
        "hïgh",
        "abcdefghijklmnopq",
        "1",
    ] {
        assert!(!valid_effort(bad), "{bad}");
    }
}

#[test]
fn claude_role_effort_is_trimmed_and_survives_a_restart() {
    let dir = TempDir::new("settings_effort");
    let mut store = SettingsStore::open(dir.path()).unwrap();
    let mut next = ModelSettings::claude_default();
    next.default_model = " gpt-5 ".into(); // a Cursor id is not a Claude default
    next.role_models = HashMap::from([
        ("role_planner".into(), " opus ".into()),
        ("role_reviewer".into(), "composer-2.5".into()),
        ("  ".into(), "sonnet".into()),
    ]);
    next.role_effort = HashMap::from([
        ("role_planner".into(), " high ".into()),
        ("role_reviewer".into(), "default".into()),
        ("role_dev".into(), "HIGH".into()),
        ("".into(), "low".into()),
    ]);
    store.set_models_for(ProviderId::Claude, next).unwrap();

    let reopened = SettingsStore::open(dir.path()).unwrap();
    let claude = reopened.models_for(ProviderId::Claude);
    assert_eq!(claude.default_model, "default");
    assert_eq!(
        claude.role_models,
        HashMap::from([("role_planner".to_string(), "opus".to_string())])
    );
    assert_eq!(
        claude.role_effort,
        HashMap::from([("role_planner".to_string(), "high".to_string())])
    );
    // The Cursor side is untouched and never carries effort.
    assert!(reopened
        .models_for(ProviderId::Cursor)
        .role_effort
        .is_empty());
}

#[test]
fn cursor_models_drop_effort_and_flag_like_ids() {
    let dir = TempDir::new("settings_cursor_models");
    let mut store = SettingsStore::open(dir.path()).unwrap();
    let next = ModelSettings {
        default_model: "--dangerous".into(),
        role_models: HashMap::from([("role_dev".into(), "gpt 5".into())]),
        role_effort: HashMap::from([("role_dev".into(), "high".into())]),
    };
    store.set_models_for(ProviderId::Cursor, next).unwrap();
    let cursor = store.models_for(ProviderId::Cursor);
    assert_eq!(cursor.default_model, crate::models::DEFAULT_MODEL_ID);
    assert!(cursor.role_models.is_empty());
    assert!(cursor.role_effort.is_empty());
}

#[test]
fn a_corrupt_settings_file_opens_with_defaults() {
    let dir = TempDir::new("settings_corrupt");
    std::fs::write(
        dir.join("settings.json"),
        b"{\"schemaVersion\": 1, \"ui\": ",
    )
    .unwrap();
    let store = SettingsStore::open(dir.path()).unwrap();
    assert_eq!(store.ui().theme, "github-dark");
    assert!(!dir.join("settings.json").exists());
}

#[test]
fn a_newer_settings_schema_opens_with_defaults() {
    let dir = TempDir::new("settings_newer");
    std::fs::write(
        dir.join("settings.json"),
        r#"{"schemaVersion": 7, "ui": {"theme": "github-light"}}"#,
    )
    .unwrap();
    let store = SettingsStore::open(dir.path()).unwrap();
    assert_eq!(store.ui().theme, "github-dark");
}

// Known bug: `SettingsStore::open` returns the error from
// `normalize_claude_accounts` (src/store/settings_store.rs:469), and
// `lib.rs` setup propagates it with `?`, so one hand-edited or synced
// settings.json with a duplicate account id stops the app from starting.
// Every other store falls back instead of failing open.
#[test]
#[ignore = "known bug: invalid Claude accounts in settings.json make SettingsStore::open fail (settings_store.rs:469)"]
fn invalid_claude_accounts_on_disk_do_not_block_open() {
    let dir = TempDir::new("settings_bad_accounts");
    std::fs::write(
        dir.join("settings.json"),
        r#"{"schemaVersion": 1, "providers": {"claude": {"accounts": [
            {"id": "default", "name": "Personal"},
            {"id": "default", "name": "Work"}
        ]}}}"#,
    )
    .unwrap();
    let store = SettingsStore::open(dir.path());
    assert!(store.is_ok(), "open failed: {:?}", store.err());
}

#[test]
fn set_providers_refuses_bad_accounts_and_keeps_the_old_ones() {
    let dir = TempDir::new("settings_accounts");
    let mut store = SettingsStore::open(dir.path()).unwrap();
    let before = store.providers().clone();
    let mut next = before.clone();
    next.claude.accounts = vec![
        ClaudeAccount {
            id: "a".into(),
            name: "One".into(),
            config_dir: None,
        },
        ClaudeAccount {
            id: "a".into(),
            name: "Two".into(),
            config_dir: None,
        },
    ];
    assert!(store.set_providers(next.clone()).is_err());
    next.claude.accounts[1].id = "../b".into();
    assert!(store.set_providers(next.clone()).is_err());
    next.claude.accounts[1].id = "b".into();
    next.claude.accounts[1].name = "   ".into();
    assert!(store.set_providers(next.clone()).is_err());
    next.claude.accounts[1].name = "Two".into();
    next.claude.accounts[1].config_dir = Some("/tmp/a\nb".into());
    assert!(store.set_providers(next).is_err());
    assert_eq!(store.providers(), &before);
}

#[test]
fn terminal_settings_are_cleaned_and_run_modes_checked() {
    let dir = TempDir::new("settings_terminal");
    let mut store = SettingsStore::open(dir.path()).unwrap();
    let next = TerminalSettings {
        shell: "/bin/zsh\n-c evil".into(),
        ..TerminalSettings::default()
    };
    assert!(store.set_terminal(next).is_err());

    let next = TerminalSettings {
        shell: "  /bin/zsh  ".into(),
        font_size: 200,
        role_surface: HashMap::from([
            ("a".into(), "terminal".into()),
            ("b".into(), "popup".into()),
        ]),
        role_run_mode: HashMap::from([("a".into(), "yolo".into()), ("b".into(), "rm -rf".into())]),
    };
    store.set_terminal(next).unwrap();
    let terminal = SettingsStore::open(dir.path()).unwrap().terminal().clone();
    assert_eq!(terminal.shell, "/bin/zsh");
    assert_eq!(terminal.font_size, 32);
    assert_eq!(terminal.role_surface.len(), 1);
    assert_eq!(store.run_mode_for("a"), "yolo");
    assert_eq!(store.run_mode_for("b"), "default");
    assert_eq!(store.run_mode_for("missing"), "default");

    store
        .set_terminal(TerminalSettings {
            font_size: 1,
            ..TerminalSettings::default()
        })
        .unwrap();
    assert_eq!(store.terminal().font_size, 8);
}

#[test]
fn ui_settings_clamp_the_pad_and_cap_tips() {
    let dir = TempDir::new("settings_ui");
    let mut store = SettingsStore::open(dir.path()).unwrap();
    let mut tips: Vec<String> = vec![" a ".into(), "a".into(), "".into(), "x".repeat(65)];
    tips.extend((0..80).map(|i| format!("tip{i}")));
    store
        .set_ui(UiSettings {
            theme: "solarized".into(),
            tips_seen: tips,
            pad_height: 5,
            ..UiSettings::default()
        })
        .unwrap();
    let ui = store.ui().clone();
    assert_eq!(ui.theme, "github-dark");
    assert_eq!(ui.tips_seen.len(), 50);
    assert_eq!(ui.tips_seen[0], "a");
    assert_eq!(ui.pad_height, 40);
    for (asked, kept) in [(0, 0), (9999, 600), (300, 300)] {
        store
            .set_ui(UiSettings {
                theme: "github-light".into(),
                pad_height: asked,
                ..UiSettings::default()
            })
            .unwrap();
        assert_eq!(store.ui().pad_height, kept);
        assert_eq!(store.ui().theme, "github-light");
    }
}

#[test]
fn provider_for_role_ignores_unknown_values() {
    let dir = TempDir::new("settings_role_provider");
    let mut store = SettingsStore::open(dir.path()).unwrap();
    let mut next = store.providers().clone();
    next.role_provider = HashMap::from([
        ("role_a".into(), "cursor".into()),
        ("role_b".into(), "openai".into()),
        (" ".into(), "claude".into()),
    ]);
    store.set_providers(next).unwrap();
    assert_eq!(store.provider_for_role("role_a"), ProviderId::Cursor);
    assert_eq!(store.provider_for_role("role_b"), store.default_provider());
    assert_eq!(store.providers().role_provider.len(), 1);
}

// ---------- projects (recent folders) ----------

#[test]
fn remember_dedupes_trailing_slashes_and_keeps_newest_first() {
    let dir = TempDir::new("projects_remember");
    let mut store = ProjectsStore::open(dir.path()).unwrap();
    store.remember("/work/app/", "t1");
    store.remember("/work/other", "t2");
    store.remember("  /work/app  ", "t3");
    store.remember("   ", "t4");
    let paths: Vec<_> = store.data.recent.iter().map(|p| p.path.as_str()).collect();
    assert_eq!(paths, vec!["/work/app", "/work/other"]);
    assert_eq!(store.data.recent[0].last_used_at, "t3");
    // POSIX paths are case-sensitive; Windows paths are not.
    store.remember("/WORK/APP", "t5");
    store.remember(r"C:\Proj", "t6");
    store.remember("c:/proj/", "t7");
    let paths: Vec<_> = store.data.recent.iter().map(|p| p.path.as_str()).collect();
    assert_eq!(
        paths,
        vec!["c:/proj/", "/WORK/APP", "/work/app", "/work/other"]
    );
}

#[test]
fn recent_folders_cap_at_twenty_and_survive_a_restart() {
    let dir = TempDir::new("projects_cap");
    let mut store = ProjectsStore::open(dir.path()).unwrap();
    for i in 0..25 {
        store.remember(&format!("/p/{i}"), &format!("t{i}"));
    }
    store.save().unwrap();
    let reopened = ProjectsStore::open(dir.path()).unwrap();
    assert_eq!(reopened.data.recent.len(), 20);
    assert_eq!(reopened.data.recent[0].path, "/p/24");
    assert_eq!(reopened.data.recent[19].path, "/p/5");
}

#[test]
fn remembering_a_favorite_refreshes_it_and_list_hides_the_duplicate() {
    let dir = TempDir::new("projects_fav");
    let real = TempDir::new("projects_fav_real");
    let real_path = real.path().display().to_string();
    let mut store = ProjectsStore::open(dir.path()).unwrap();
    assert!(store.toggle_favorite(&real_path, "t1"));
    store.remember(&format!("{real_path}/"), "t2");
    store.remember("/definitely/not/here", "t3");
    assert_eq!(store.data.favorites[0].last_used_at, "t2");

    let (favorites, recent) = store.list();
    assert_eq!(favorites.len(), 1);
    assert!(favorites[0].favorite && favorites[0].available);
    assert_eq!(recent.len(), 1);
    assert_eq!(recent[0].path, "/definitely/not/here");
    assert!(!recent[0].available);

    assert!(
        !store.toggle_favorite(&real_path, "t4"),
        "second toggle removes"
    );
    assert!(!store.toggle_favorite("  ", "t5"));
    store.remove("/definitely/not/here", false);
    assert_eq!(store.data.recent.len(), 1);
}

#[test]
fn a_newer_projects_schema_starts_empty() {
    let dir = TempDir::new("projects_schema");
    std::fs::write(
        dir.join("projects.json"),
        r#"{"schemaVersion": 4, "recent": [{"path": "/x", "lastUsedAt": "t"}]}"#,
    )
    .unwrap();
    let store = ProjectsStore::open(dir.path()).unwrap();
    assert!(store.data.recent.is_empty());
}

// ---------- workspaces ----------

fn ws_tab(label: &str, role: &str, kind: &str, launch: &str) -> crate::store::WorkspaceTab {
    serde_json::from_value(serde_json::json!({
        "label": label,
        "roleId": role,
        "roleSnapshot": {"name": role, "templateVersion": 1, "mode": "agent", "injection": "send_on_start"},
        "cwd": "/tmp/p",
        "kind": kind,
        "terminalLaunch": launch,
    }))
    .unwrap()
}

#[test]
fn the_active_tab_follows_its_tab_when_earlier_tabs_are_skipped() {
    let dir = TempDir::new("ws_active");
    let mut store = WorkspaceStore::open(dir.path()).unwrap();
    let tabs = vec![
        ws_tab("gone chat", "role_gone", "role", ""),
        ws_tab("gone role term", "role_gone", "terminal", "role"),
        ws_tab("shell", "role_gone", "terminal", "shell"),
        ws_tab("kept", "role_dev", "role", ""),
    ];
    let saved = store
        .save_workspace("Mixed", tabs, Some(3), None, false, "2026-10-10T00:00:00Z")
        .unwrap();
    let (usable, skipped) = saved.with_current_roles(|id| {
        (id == "role_dev").then(|| crate::store::RoleSnapshot {
            name: "Developer v2".into(),
            template_version: 2,
            mode: "agent".into(),
            injection: "send_on_start".into(),
        })
    });
    assert_eq!(skipped, vec!["gone chat", "gone role term"]);
    let labels: Vec<_> = usable.tabs.iter().map(|t| t.label.as_str()).collect();
    assert_eq!(labels, vec!["shell", "kept"]);
    assert_eq!(usable.active_index, Some(1));
    assert_eq!(usable.tabs[1].role_snapshot.name, "Developer v2");

    // The active tab itself being skipped leaves no active tab.
    let saved = store
        .save_workspace(
            "Only gone",
            vec![
                ws_tab("g", "role_gone", "role", ""),
                ws_tab("s", "x", "terminal", "shell"),
            ],
            Some(0),
            None,
            false,
            "t",
        )
        .unwrap();
    let (usable, _) = saved.with_current_roles(|_| None);
    assert_eq!(usable.active_index, None);
}

#[test]
fn workspace_names_are_trimmed_capped_and_the_store_is_capped() {
    let dir = TempDir::new("ws_caps");
    let mut store = WorkspaceStore::open(dir.path()).unwrap();
    let long = format!("  {}  ", "n".repeat(120));
    let saved = store
        .save_workspace(
            &long,
            vec![ws_tab("a", "r", "role", "")],
            None,
            None,
            false,
            "t",
        )
        .unwrap();
    assert_eq!(saved.name.chars().count(), 80);
    assert!(store
        .save_workspace(
            "   ",
            vec![ws_tab("a", "r", "role", "")],
            None,
            None,
            false,
            "t"
        )
        .is_err());
    assert!(store
        .save_workspace("empty", vec![], None, None, false, "t")
        .is_err());
    // 100 = MAX_WORKSPACES; one is already saved above.
    for i in 1..100 {
        store
            .save_workspace(
                &format!("w{i}"),
                vec![ws_tab("a", "r", "role", "")],
                None,
                None,
                false,
                "t",
            )
            .unwrap();
    }
    let err = store
        .save_workspace(
            "one too many",
            vec![ws_tab("a", "r", "role", "")],
            None,
            None,
            false,
            "t",
        )
        .unwrap_err();
    assert!(err.contains("Delete one first"), "{err}");
    // Replacing an existing one still works at the cap.
    store
        .save_workspace(
            "W1",
            vec![ws_tab("b", "r", "role", "")],
            None,
            None,
            true,
            "t2",
        )
        .unwrap();
    assert!(store.delete("ws_missing").is_err());
}
