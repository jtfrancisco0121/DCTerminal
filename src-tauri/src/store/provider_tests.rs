//! Plan Task 2.1: provider ids on tabs, workspaces, and settings. Old
//! `state.json` / `settings.json` / `workspaces.json` files load with no
//! provider (resolved as Cursor) and keep their session ids in
//! `sessions.cursor`.

use crate::provider::ProviderId;
use crate::roles::Role;
use crate::store::settings_store::{ProvidersSettings, SettingsFile};
use crate::store::{SettingsStore, StateStore, TabSessionRef, WorkspaceStore};
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

const LEGACY_STATE: &str = include_str!("../../../fixtures/state/legacy-state.json");
const LEGACY_SETTINGS: &str = include_str!("../../../fixtures/state/legacy-settings.json");
const LEGACY_WORKSPACES: &str = include_str!("../../../fixtures/state/legacy-workspaces.json");

fn temp_dir(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("dcterminal_provider_{tag}_{nanos}"));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn role() -> Role {
    serde_json::from_value(serde_json::json!({
        "id": "role_implementer",
        "name": "Implementer",
        "color": "#3fb950",
        "templateText": "Do [TASK]",
        "templateVersion": 1,
        "templateHash": "",
        "schemaTemplateHash": "",
        "defaultMode": "agent",
        "injection": "send_on_start",
        "isBuiltIn": true,
        "fields": []
    }))
    .unwrap()
}

#[test]
fn legacy_state_migrates_to_claude_and_keeps_the_cursor_id() {
    let dir = temp_dir("state");
    let path = dir.join("state.json");
    std::fs::write(&path, LEGACY_STATE).unwrap();
    let store = StateStore::open_path(path.clone()).unwrap();
    let chat = store.tab_by_id("tab_chat").unwrap();
    assert_eq!(chat.provider, Some(ProviderId::Claude));
    assert_eq!(
        chat.sessions.cursor.as_deref(),
        Some("11111111-2222-3333-4444-555555555555")
    );
    assert_eq!(chat.sessions.claude, None);
    assert!(chat.session.is_none(), "a Cursor id must not resume under Claude");
    assert!(chat.provider_notice.as_deref().unwrap().contains("Now using Claude"));
    let term = store.tab_by_id("tab_term").unwrap();
    assert_eq!(term.provider, Some(ProviderId::Claude));
    assert!(term.sessions.claude.is_none());
    assert!(term.provider_notice.is_none());
    let closed = &store.data.closed_tabs[0];
    assert_eq!(closed.provider, Some(ProviderId::Claude));
    assert!(closed.acp_session_id.is_none());
    assert_eq!(
        closed.sessions.cursor.as_deref(),
        Some("66666666-7777-8888-9999-000000000000")
    );
    assert!(path.with_file_name("state.pre-claude-first.json").exists());
    assert!(store.data.migrations.claude_first);
    // A second open does not migrate again or rewrite the backup.
    let again = StateStore::open_path(path).unwrap();
    assert!(again.data.migrations.claude_first);
    assert_eq!(
        again.tab_by_id("tab_chat").unwrap().sessions.cursor.as_deref(),
        Some("11111111-2222-3333-4444-555555555555")
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn state_round_trips_provider_and_sessions() {
    let dir = temp_dir("roundtrip");
    let path = dir.join("state.json");
    std::fs::write(&path, LEGACY_STATE).unwrap();
    let mut store = StateStore::open_path(path.clone()).unwrap();
    store.save().unwrap();
    let raw: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    let tab = &raw["tabs"][0];
    assert_eq!(tab["provider"], "claude");
    assert_eq!(raw["migrations"]["claudeFirst"], true);
    assert_eq!(
        tab["sessions"]["cursor"],
        "11111111-2222-3333-4444-555555555555"
    );
    store
        .set_tab_provider("tab_chat", ProviderId::Claude)
        .unwrap();
    let again = StateStore::open_path(path).unwrap();
    let chat = again.tab_by_id("tab_chat").unwrap();
    assert_eq!(chat.provider, Some(ProviderId::Claude));
    // The Cursor id is kept for switching back; no Claude id is invented.
    assert_eq!(
        chat.sessions.cursor.as_deref(),
        Some("11111111-2222-3333-4444-555555555555")
    );
    assert_eq!(chat.sessions.claude, None);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn switching_a_migrated_tab_back_to_cursor_resumes_the_cursor_id() {
    let dir = temp_dir("switch");
    let path = dir.join("state.json");
    std::fs::write(&path, LEGACY_STATE).unwrap();
    let mut store = StateStore::open_path(path).unwrap();
    store
        .set_tab_provider("tab_chat", ProviderId::Cursor)
        .unwrap();
    let chat = store.tab_by_id("tab_chat").unwrap();
    assert_eq!(chat.provider, Some(ProviderId::Cursor));
    assert_eq!(
        super::state_store::displayed_acp_session(chat).as_deref(),
        Some("11111111-2222-3333-4444-555555555555")
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn new_tabs_get_the_default_provider() {
    let dir = temp_dir("new");
    let mut store = StateStore::open_path(dir.join("state.json")).unwrap();
    assert_eq!(store.new_tab_provider, ProviderId::Claude);
    let id = store
        .create_draft_tab(&role(), "/w/app", true, None)
        .unwrap();
    assert_eq!(
        store.tab_by_id(&id).unwrap().provider,
        Some(ProviderId::Claude)
    );
    assert_eq!(store.provider_for_start(Some(&id)), ProviderId::Claude);
    assert_eq!(store.provider_for_start(None), ProviderId::Claude);
    store.new_tab_provider = ProviderId::Cursor;
    let other = store
        .create_draft_tab(&role(), "/w/app", true, None)
        .unwrap();
    assert_eq!(
        store.tab_by_id(&other).unwrap().provider,
        Some(ProviderId::Cursor)
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_started_session_is_saved_under_its_provider_and_survives_close() {
    let dir = temp_dir("start");
    let mut store = StateStore::open_path(dir.join("state.json")).unwrap();
    store.new_tab_provider = ProviderId::Cursor;
    let id = store
        .create_draft_tab(&role(), "/w/app", true, None)
        .unwrap();
    store
        .promote_tab_to_running(
            Some(&id),
            &role(),
            &HashMap::from([("cwd".to_string(), "/w/app".to_string())]),
            "/w/app",
            "merged",
            TabSessionRef {
                acp_session_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee".into(),
                mode_id: "agent".into(),
                injection_pending: false,
                injected_at: None,
            },
            ProviderId::Cursor,
        )
        .unwrap();
    let tab = store.tab_by_id(&id).unwrap();
    assert_eq!(tab.provider, Some(ProviderId::Cursor));
    assert_eq!(
        tab.sessions.cursor.as_deref(),
        Some("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
    );
    assert!(store.set_tab_provider(&id, ProviderId::Claude).is_err());
    store.close_tab(&id).unwrap();
    let closed = &store.data.closed_tabs[0];
    assert_eq!(closed.provider, Some(ProviderId::Cursor));
    assert_eq!(
        closed.sessions.cursor.as_deref(),
        Some("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
    );
    let reopened = store.reopen_closed(None).unwrap();
    assert_eq!(reopened.provider, Some(ProviderId::Cursor));
    assert_eq!(
        reopened.sessions.cursor.as_deref(),
        Some("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn legacy_settings_default_to_claude_and_keep_cursor_models() {
    let parsed: SettingsFile = serde_json::from_str(LEGACY_SETTINGS).unwrap();
    assert_eq!(parsed.providers.default, ProviderId::Claude);
    assert_eq!(parsed.providers.claude.config_dir, None);
    assert_eq!(parsed.models.cursor.default_model, "gpt-5");
    assert_eq!(
        parsed
            .models
            .cursor
            .role_models
            .get("role_planner")
            .map(String::as_str),
        Some("sonnet-4.5")
    );
    assert_eq!(parsed.models.claude.default_model, "default");

    let dir = temp_dir("settings");
    std::fs::write(dir.join("settings.json"), LEGACY_SETTINGS).unwrap();
    let store = SettingsStore::open(&dir).unwrap();
    assert_eq!(store.models().default_model, "gpt-5");
    assert_eq!(store.default_provider(), ProviderId::Claude);
    assert_eq!(store.provider_for_role("role_planner"), ProviderId::Claude);
    store.save().unwrap();
    let raw: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("settings.json")).unwrap()).unwrap();
    assert_eq!(raw["models"]["cursor"]["defaultModel"], "gpt-5");
    assert_eq!(raw["models"]["claude"]["defaultModel"], "default");
    assert_eq!(raw["providers"]["default"], "claude");
    let again = SettingsStore::open(&dir).unwrap();
    assert_eq!(again.data, store.data);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn provider_settings_are_cleaned_on_save() {
    let dir = temp_dir("providers");
    let mut store = SettingsStore::open(&dir).unwrap();
    let mut next = ProvidersSettings {
        default: ProviderId::Cursor,
        ..ProvidersSettings::default()
    };
    next.role_provider = HashMap::from([
        ("role_planner".to_string(), "claude".to_string()),
        ("role_general".to_string(), "gpt".to_string()),
        (" ".to_string(), "cursor".to_string()),
    ]);
    next.claude.config_dir = Some("  ~/.claude-account2  ".to_string());
    next.claude.claude_path = Some("   ".to_string());
    store.set_providers(next).unwrap();
    let again = SettingsStore::open(&dir).unwrap();
    assert_eq!(again.default_provider(), ProviderId::Cursor);
    assert_eq!(again.provider_for_role("role_planner"), ProviderId::Claude);
    assert_eq!(again.provider_for_role("role_general"), ProviderId::Cursor);
    assert_eq!(again.providers().role_provider.len(), 1);
    assert_eq!(
        again.providers().claude.config_dir.as_deref(),
        Some("~/.claude-account2")
    );
    assert_eq!(again.providers().claude.claude_path, None);
    let mut bad = again.providers().clone();
    bad.claude.config_dir = Some("/tmp/a\nb".to_string());
    let mut store = again;
    assert!(store.set_providers(bad).is_err());
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn claude_accounts_migrate_from_config_dir_and_env_is_only_the_first() {
    use crate::provider::claude_config::ConfigDirSource;
    use crate::store::settings_store::{account_config, ClaudeAccount};
    let dir = temp_dir("accounts");
    let mut store = SettingsStore::open(&dir).unwrap();
    let mut next = ProvidersSettings::default();
    next.claude.config_dir = Some("~/.claude-account2".into());
    store.set_providers(next).unwrap();
    let accounts = &store.providers().claude.accounts;
    assert_eq!(accounts.len(), 1);
    assert_eq!(accounts[0].id, "default");
    assert_eq!(accounts[0].name, "Personal");
    assert_eq!(accounts[0].config_dir.as_deref(), Some("~/.claude-account2"));

    let mut named = store.providers().clone();
    named.claude.accounts.push(ClaudeAccount {
        id: "company".into(),
        name: "Company".into(),
        config_dir: Some("~/.claude".into()),
    });
    named.claude.config_dir = named.claude.accounts[0].config_dir.clone();
    store.set_providers(named).unwrap();
    let home = std::env::temp_dir();
    let first = account_config(
        &store.providers().claude,
        "default",
        Some("/env/claude"),
        Some(&home),
    );
    let second = account_config(
        &store.providers().claude,
        "company",
        Some("/env/claude"),
        Some(&home),
    );
    assert_eq!(first.source, ConfigDirSource::Env);
    assert!(first.path.contains("env"));
    assert_eq!(second.source, ConfigDirSource::Setting);
    assert!(second.display.ends_with(".claude") || second.path.ends_with(".claude"));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn legacy_workspaces_migrate_to_claude() {
    let dir = temp_dir("ws");
    std::fs::write(dir.join("workspaces.json"), LEGACY_WORKSPACES).unwrap();
    let store = WorkspaceStore::open(&dir).unwrap();
    let tab = &store.data.workspaces[0].tabs[0];
    assert_eq!(tab.provider, Some(ProviderId::Claude));
    assert!(dir.join("workspaces.pre-claude-first.json").exists());
    assert!(store.data.migrations.claude_first);

    let state_dir = temp_dir("ws_state");
    let mut state = StateStore::open_path(state_dir.join("state.json")).unwrap();
    let ids = state
        .open_workspace(&store.data.workspaces[0], false)
        .unwrap();
    assert_eq!(
        state.tab_by_id(&ids[0]).unwrap().provider,
        Some(ProviderId::Claude)
    );
    let saved = crate::store::WorkspaceTab::from_record(state.tab_by_id(&ids[0]).unwrap());
    assert_eq!(saved.provider, Some(ProviderId::Claude));
    let _ = std::fs::remove_dir_all(dir);
    let _ = std::fs::remove_dir_all(state_dir);
}
