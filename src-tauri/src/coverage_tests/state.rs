//! `StateStore`: opening, window binding, layout and grid sanitizing,
//! per-window layouts, tab name/color checks, and the window migration.

use crate::store::{read_json, AppStateFile, LayoutState, StateStore, WindowRecord};
use crate::test_support::{names_in, role, TempDir};

fn store_at(dir: &TempDir) -> StateStore {
    StateStore::open_path(dir.join("state.json")).unwrap()
}

#[test]
fn a_missing_state_file_opens_empty_on_the_main_window() {
    let dir = TempDir::new("state_missing");
    let store = store_at(&dir);
    assert!(store.data.tabs.is_empty());
    assert_eq!(store.focus_window(), "main");
    assert_eq!(store.data.windows.len(), 1);
    assert_eq!(store.account_for_window("main"), "default");
    assert_eq!(store.account_for_window("win-9"), "default");
}

// Regression: a state.json from another build used to stop the app from
// opening on every launch. It is now moved aside and the app opens empty.
#[test]
fn a_state_file_from_another_version_is_set_aside_and_the_app_opens_empty() {
    let dir = TempDir::new("state_schema");
    let path = dir.join("state.json");
    let original = r#"{"schemaVersion": 2, "tabs": []}"#;
    std::fs::write(&path, original).unwrap();
    let store = StateStore::open_path(path.clone()).expect("opens");
    assert!(store.data.tabs.is_empty());
    let kept = names_in(dir.path())
        .into_iter()
        .find(|name| name.starts_with("state.json.from-v2-"))
        .expect("set-aside file");
    assert_eq!(std::fs::read_to_string(dir.join(kept)).unwrap(), original);
}

// Regression: a damaged state.json falls back to state.json.bak instead of blocking startup.
#[test]
fn a_corrupt_state_file_falls_back_to_the_backup() {
    let dir = TempDir::new("state_corrupt");
    let mut store = store_at(&dir);
    store
        .create_draft_tab(&role("role_dev", "Developer"), "/tmp/a", true, None)
        .unwrap();
    store.save().unwrap(); // state.json.bak now holds the one-tab file
    std::fs::write(dir.join("state.json"), b"{\"schemaVersion\":1,\"tabs\":[").unwrap();
    let reopened = StateStore::open_path(dir.join("state.json"));
    assert!(reopened.is_ok(), "{:?}", reopened.err());
    assert_eq!(reopened.unwrap().data.tabs.len(), 1);
}

#[test]
fn bind_window_accepts_plain_ids_only() {
    let dir = TempDir::new("state_bind");
    let mut store = store_at(&dir);
    store.bind_window(Some("win-2"));
    assert_eq!(store.focus_window(), "win-2");
    for bad in ["../main", "win 3", "win/3", "wïn", "a\nb"] {
        store.bind_window(Some(bad));
        assert_eq!(store.focus_window(), "win-2", "{bad:?} is ignored");
    }
    store.bind_window(Some(&"w".repeat(100)));
    assert_eq!(store.focus_window(), "w".repeat(64));
    store.bind_window(Some("   "));
    assert_eq!(store.focus_window(), "main");
    store.bind_window(Some("win-2"));
    store.bind_window(None);
    assert_eq!(store.focus_window(), "main");
}

#[test]
fn layout_sanitizing_handles_bad_modes_sizes_and_grids() {
    let bad = LayoutState {
        split_mode: "diagonal".into(),
        secondary_tab_id: Some("t1".into()),
        grid_tab_ids: vec!["a".into(), "b".into()],
        primary_size: f64::NAN,
        file_panel_open: true,
        file_panel_width: f64::INFINITY,
    }
    .sanitized();
    assert_eq!(bad.split_mode, "single");
    assert!(bad.secondary_tab_id.is_none());
    assert!(bad.grid_tab_ids.is_empty());
    assert_eq!(bad.primary_size, 50.0);
    assert_eq!(bad.file_panel_width, 280.0);

    let tiny = LayoutState {
        split_mode: "vertical".into(),
        secondary_tab_id: Some("t1".into()),
        primary_size: -5.0,
        file_panel_width: 10.0,
        ..LayoutState::default()
    }
    .sanitized();
    assert_eq!(tiny.split_mode, "vertical");
    assert_eq!(tiny.primary_size, 15.0);
    assert_eq!(tiny.file_panel_width, 160.0);

    let huge = LayoutState {
        file_panel_width: 5000.0,
        ..LayoutState::default()
    }
    .sanitized();
    assert_eq!(huge.file_panel_width, 900.0);

    let no_partner = LayoutState {
        split_mode: "horizontal".into(),
        ..LayoutState::default()
    }
    .sanitized();
    assert_eq!(no_partner.split_mode, "single");

    let grid = LayoutState {
        split_mode: "grid".into(),
        grid_tab_ids: vec![" ".into(), "a".into(), "".into(), "a".into(), "b".into()],
        ..LayoutState::default()
    }
    .sanitized();
    assert_eq!(grid.grid_tab_ids, vec!["a", "b"]);
    assert_eq!(grid.split_mode, "grid");

    let lonely = LayoutState {
        split_mode: "grid".into(),
        grid_tab_ids: vec!["a".into(), "a".into(), " ".into()],
        ..LayoutState::default()
    }
    .sanitized();
    assert_eq!(lonely.split_mode, "single");
    assert!(lonely.grid_tab_ids.is_empty());
}

#[test]
fn each_window_keeps_its_own_layout() {
    let dir = TempDir::new("state_window_layout");
    let mut store = store_at(&dir);
    let dev = role("role_dev", "Developer");
    let a = store.create_draft_tab(&dev, "/tmp/a", true, None).unwrap();
    let b = store.create_draft_tab(&dev, "/tmp/b", true, None).unwrap();
    store.ensure_window("win-2", "work").unwrap();
    store.bind_window(Some("win-2"));
    store
        .set_layout(LayoutState {
            split_mode: "grid".into(),
            grid_tab_ids: vec![a.clone(), b.clone()],
            ..LayoutState::default()
        })
        .unwrap();
    assert_eq!(store.layout().split_mode, "grid");
    assert_eq!(store.account_for_window("win-2"), "work");

    store.bind_window(None);
    assert_eq!(store.layout().split_mode, "single", "main is untouched");

    let saved: AppStateFile = read_json(&dir.join("state.json")).unwrap();
    let win2 = saved.windows.iter().find(|w| w.id == "win-2").unwrap();
    assert_eq!(win2.layout.grid_tab_ids, vec![a, b]);
    assert_eq!(saved.layout.split_mode, "single");
}

#[test]
fn closing_a_tab_in_another_window_drops_it_from_that_grid() {
    let dir = TempDir::new("state_window_close");
    let mut store = store_at(&dir);
    let dev = role("role_dev", "Developer");
    store.ensure_window("win-2", "default").unwrap();
    store.bind_window(Some("win-2"));
    let ids: Vec<String> = (0..3)
        .map(|i| {
            let id = store
                .create_draft_tab(&dev, &format!("/tmp/{i}"), true, None)
                .unwrap();
            store
                .data
                .tabs
                .iter_mut()
                .find(|t| t.id == id)
                .unwrap()
                .window_id = "win-2".into();
            id
        })
        .collect();
    store
        .set_layout(LayoutState {
            split_mode: "grid".into(),
            grid_tab_ids: ids.clone(),
            ..LayoutState::default()
        })
        .unwrap();
    store.close_tab(&ids[2]).unwrap();
    assert_eq!(store.layout().grid_tab_ids, ids[..2].to_vec());
    store.close_tab(&ids[1]).unwrap();
    assert_eq!(store.layout().split_mode, "single");
}

#[test]
fn tab_colors_and_names_are_checked() {
    let dir = TempDir::new("state_color");
    let mut store = store_at(&dir);
    let id = store
        .create_draft_tab(&role("role_dev", "Developer"), "/tmp/a", true, None)
        .unwrap();
    for ok in ["#abc", "#A1B2C3"] {
        store.set_tab_color(&id, ok).unwrap();
    }
    for bad in ["abc", "#abcd", "#ggg", "red", "", "#abc ", "#1234567"] {
        assert!(store.set_tab_color(&id, bad).is_err(), "{bad:?}");
    }
    assert!(store.set_tab_color("tab_missing", "#fff").is_err());
    assert_eq!(
        store.tab_by_id(&id).unwrap().color.as_deref(),
        Some("#A1B2C3")
    );

    assert!(store.set_tab_label(&id, "   ").is_err());
    store
        .set_tab_label(&id, &format!("  {}  ", "é".repeat(100)))
        .unwrap();
    let tab = store.tab_by_id(&id).unwrap();
    assert_eq!(tab.label.chars().count(), 80);
    assert!(tab.custom_label);
    assert!(store.set_tab_label("tab_missing", "x").is_err());
}

#[test]
fn window_migration_runs_once_and_keeps_an_existing_main_window() {
    let dir = TempDir::new("state_win_mig");
    let path = dir.join("state.json");
    let mut file = AppStateFile::default();
    file.migrations.windows = false;
    file.windows = vec![WindowRecord {
        id: "main".into(),
        account_id: "work".into(),
        active_tab_id: None,
        layout: LayoutState::default(),
    }];
    crate::store::write_json_atomic(&path, &file).unwrap();

    let store = StateStore::open_path(path.clone()).unwrap();
    assert_eq!(store.data.windows.len(), 1);
    assert_eq!(store.account_for_window("main"), "work");
    assert!(store.data.migrations.windows);
    assert!(dir.join("state.pre-windows.json").is_file());

    // A second open has nothing to migrate and writes no new backup.
    std::fs::remove_file(dir.join("state.pre-windows.json")).unwrap();
    StateStore::open_path(path).unwrap();
    assert!(!dir.join("state.pre-windows.json").exists());
}

/// `count` draft tabs in `window`, in creation order.
fn tabs_in(store: &mut StateStore, window: &str, count: usize) -> Vec<String> {
    let dev = role("role_dev", "Developer");
    store.bind_window(Some(window));
    (0..count)
        .map(|i| {
            let id = store
                .create_draft_tab(&dev, &format!("/tmp/{window}/{i}"), true, None)
                .unwrap();
            store
                .data
                .tabs
                .iter_mut()
                .find(|t| t.id == id)
                .unwrap()
                .window_id = window.into();
            id
        })
        .collect()
}

fn closed_in(store: &StateStore, window: &str) -> usize {
    store
        .data
        .closed_tabs
        .iter()
        .filter(|t| crate::store::window_matches(&t.window_id, window))
        .count()
}

// Regression: archiving a window closed its tabs one by one into a global
// list capped at 15, so a window with 20 tabs lost 5 of them.
#[test]
fn archiving_a_window_keeps_all_its_tabs_past_fifteen() {
    let dir = TempDir::new("state_archive_20");
    let mut store = store_at(&dir);
    store.ensure_window("win-2", "work").unwrap();
    tabs_in(&mut store, "win-2", 20);
    store.archive_window("win-2").unwrap();
    assert!(store.data.tabs.is_empty());
    assert_eq!(closed_in(&store, "win-2"), 20);
    assert_eq!(closed_in(&store_at(&dir), "win-2"), 20, "saved too");
}

// Regression: the 15 cap was global, so closing tabs in one window pushed
// another window's closed tabs out of the list.
#[test]
fn closing_tabs_in_one_window_does_not_evict_another_windows_closed_tabs() {
    let dir = TempDir::new("state_closed_cap");
    let mut store = store_at(&dir);
    for id in tabs_in(&mut store, "main", 3) {
        store.close_tab(&id).unwrap();
    }
    store.ensure_window("win-2", "default").unwrap();
    for id in tabs_in(&mut store, "win-2", 16) {
        store.close_tab(&id).unwrap();
    }
    assert_eq!(closed_in(&store, "main"), 3);
    assert_eq!(
        closed_in(&store, "win-2"),
        15,
        "each window keeps its newest 15"
    );
}

// Regression: a freed label was reused, so a new window (maybe on another
// account) inherited an archived window's closed tabs.
#[test]
fn a_new_window_label_does_not_reuse_an_archived_window() {
    let dir = TempDir::new("state_label_reuse");
    let mut store = store_at(&dir);
    store.ensure_window("win-2", "work").unwrap();
    tabs_in(&mut store, "win-2", 2);
    store.archive_window("win-2").unwrap();
    assert_eq!(store.next_window_label(), "win-3");
}

#[test]
fn reopening_a_closed_window_restores_its_tabs_and_account() {
    let dir = TempDir::new("state_reopen_window");
    let mut store = store_at(&dir);
    store.ensure_window("win-2", "work").unwrap();
    let ids = tabs_in(&mut store, "win-2", 3);
    store.bind_window(Some("main"));
    store.archive_window("win-2").unwrap();
    assert!(store.data.windows.iter().all(|w| w.id != "win-2"));

    let reopened = store
        .reopen_archived_window(|id| Some(format!("chat of {id}")))
        .unwrap()
        .expect("an archived window");
    assert_eq!(reopened.id, "win-2");
    assert_eq!(reopened.account_id, "work");
    assert_eq!(store.account_for_window("win-2"), "work");
    let open: Vec<String> = store
        .tabs_in_window("win-2")
        .into_iter()
        .map(|t| t.id.clone())
        .collect();
    assert_eq!(open, ids, "same tabs, same order");
    assert_eq!(
        store.tab_by_id(&ids[0]).unwrap().transcript.as_deref(),
        Some(format!("chat of {}", ids[0]).as_str())
    );
    assert_eq!(closed_in(&store, "win-2"), 0);
    assert_eq!(
        store.focus_window(),
        "main",
        "the caller's window binding is kept"
    );
    let saved: AppStateFile = read_json(&dir.join("state.json")).unwrap();
    assert!(saved.archived_windows.is_empty());
    assert_eq!(saved.tabs.len(), 3);
    assert!(store.reopen_archived_window(|_| None).unwrap().is_none());
}

// Regression: closing main while another window stayed open archived it as
// "main". After a relaunch Tauri opens a new main, so the archived tabs showed
// in its Reopen Closed Tab list, and Reopen Closed Window put the old record
// (and its account) onto the live main under its running sessions.
#[test]
fn an_archived_main_window_reopens_as_its_own_window_after_a_relaunch() {
    let dir = TempDir::new("state_reopen_main");
    let mut store = store_at(&dir);
    store.ensure_window("main", "work").unwrap();
    store.ensure_window("win-2", "default").unwrap();
    let ids = tabs_in(&mut store, "main", 2);
    store.bind_window(Some("win-2"));
    store.archive_window("main").unwrap();

    let mut store = store_at(&dir);
    store.ensure_window("main", "default").unwrap();
    assert_eq!(
        closed_in(&store, "main"),
        0,
        "the new main has none of the old main's closed tabs"
    );
    assert!(store.has_archived_windows(), "the old main is still kept");

    let reopened = store
        .reopen_archived_window(|_| None)
        .unwrap()
        .expect("an archived window");
    assert_ne!(reopened.id, "main", "never the live main's label");
    assert_eq!(reopened.account_id, "work");
    assert_eq!(store.account_for_window("main"), "default", "unchanged");
    assert!(store.tabs_in_window("main").is_empty());
    let open: Vec<String> = store
        .tabs_in_window(&reopened.id)
        .into_iter()
        .map(|t| t.id.clone())
        .collect();
    assert_eq!(open, ids, "the tabs are in the reopened window");
    assert_eq!(store.account_for_tab(Some(&ids[0])), "work");
    assert!(!store.has_archived_windows());
}

// Regression: a reopen that failed partway had already moved the window back
// to the open list and dropped its archive entry, with only some tabs back.
#[test]
fn a_failed_window_reopen_changes_nothing() {
    let dir = TempDir::new("state_reopen_fails");
    let mut store = store_at(&dir);
    store.ensure_window("win-2", "work").unwrap();
    let ids = tabs_in(&mut store, "win-2", 2);
    store.archive_window("win-2").unwrap();
    // The second tab is somehow open again, so reopening it fails.
    tabs_in(&mut store, "main", 1);
    store.data.tabs[0].id = ids[1].clone();
    store.save().unwrap();
    let before = store.data.clone();

    assert!(store.reopen_archived_window(|_| None).is_err());
    let after = serde_json::to_value(&store.data).unwrap();
    assert_eq!(after, serde_json::to_value(&before).unwrap(), "in memory");
    let saved: serde_json::Value = read_json(&dir.join("state.json")).unwrap();
    assert_eq!(saved, after, "on disk");
    assert_eq!(store.focus_window(), "main");
}

// Regression: when the window could not be built after its store reopen,
// its record and tabs stayed open in the store with no window on screen.
#[test]
fn a_window_that_fails_to_build_goes_back_to_reopen_closed_window() {
    let dir = TempDir::new("state_reopen_build_fails");
    let mut store = store_at(&dir);
    store.ensure_window("win-2", "work").unwrap();
    let ids = tabs_in(&mut store, "win-2", 2);
    store.bind_window(Some("main"));
    store.archive_window("win-2").unwrap();
    let state = std::sync::Mutex::new(store);

    let err = crate::windows::reopen_archived_window_with(
        &state,
        |_| None,
        |_| Err("no window".to_string()),
    )
    .unwrap_err();
    assert_eq!(err, "no window");
    let store = state.lock().unwrap();
    assert!(store.data.windows.iter().all(|w| w.id != "win-2"));
    assert!(store.tabs_in_window("win-2").is_empty());
    assert_eq!(closed_in(&store, "win-2"), 2);
    let archived = &store.data.archived_windows[0];
    assert_eq!(archived.window.id, "win-2");
    assert_eq!(archived.window.account_id, "work");
    assert_eq!(archived.tab_ids, ids);
    let saved: AppStateFile = read_json(&dir.join("state.json")).unwrap();
    assert_eq!(saved.archived_windows.len(), 1, "on disk");
    drop(store);

    let reopened =
        crate::windows::reopen_archived_window_with(&state, |_| None, |_| Ok(())).unwrap();
    assert_eq!(
        reopened.as_deref(),
        Some("win-2"),
        "it can still be reopened"
    );
}

// Regression: transcripts loaded with the state lock held, so every other
// window's state command waited on the disk reads.
#[test]
fn reopening_a_window_loads_transcripts_without_holding_the_state_lock() {
    let dir = TempDir::new("state_reopen_unlocked");
    let mut store = store_at(&dir);
    store.ensure_window("win-2", "work").unwrap();
    let ids = tabs_in(&mut store, "win-2", 2);
    store.bind_window(Some("main"));
    store.archive_window("win-2").unwrap();
    let state = std::sync::Mutex::new(store);

    let reopened = crate::windows::reopen_archived_window_with(
        &state,
        |id| {
            assert!(
                state.try_lock().is_ok(),
                "state is locked while loading {id}"
            );
            Some(format!("chat of {id}"))
        },
        |_| Ok(()),
    )
    .unwrap();
    assert_eq!(reopened.as_deref(), Some("win-2"));
    let store = state.lock().unwrap();
    assert_eq!(
        store.tab_by_id(&ids[1]).unwrap().transcript.as_deref(),
        Some(format!("chat of {}", ids[1]).as_str())
    );
}

// Regression: when putting the window back in the archive failed too, that
// save error replaced the build error, so the real cause was lost.
#[cfg(unix)]
#[test]
fn a_failed_build_reports_the_build_error_even_when_the_archive_save_fails() {
    use std::os::unix::fs::PermissionsExt;
    let dir = TempDir::new("state_reopen_build_and_save_fail");
    let mut store = store_at(&dir);
    store.ensure_window("win-2", "work").unwrap();
    tabs_in(&mut store, "win-2", 1);
    store.bind_window(Some("main"));
    store.archive_window("win-2").unwrap();
    let state = std::sync::Mutex::new(store);
    let data_dir = dir.join("state.json").parent().unwrap().to_path_buf();

    let err = crate::windows::reopen_archived_window_with(
        &state,
        |_| None,
        |_| {
            // The data folder turns read-only, so the archive save fails.
            std::fs::set_permissions(&data_dir, std::fs::Permissions::from_mode(0o555)).unwrap();
            Err("no window".to_string())
        },
    )
    .unwrap_err();
    std::fs::set_permissions(&data_dir, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(err.contains("no window"), "build error kept: {err}");
}
