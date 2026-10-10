//! `StateStore`: opening, window binding, layout and grid sanitizing,
//! per-window layouts, tab name/color checks, and the window migration.

use crate::store::{read_json, AppStateFile, LayoutState, StateStore, WindowRecord};
use crate::test_support::{role, TempDir};

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

#[test]
fn an_unknown_state_schema_is_refused_and_left_on_disk() {
    let dir = TempDir::new("state_schema");
    let path = dir.join("state.json");
    std::fs::write(&path, r#"{"schemaVersion": 2, "tabs": []}"#).unwrap();
    let err = StateStore::open_path(path.clone()).err().expect("refused");
    assert!(err.contains("schemaVersion 2"), "{err}");
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        r#"{"schemaVersion": 2, "tabs": []}"#
    );
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
