//! One-time move of the single-window tab list onto window `"main"`.
//!
//! The file on disk is copied to `state.pre-windows.json` before the new
//! file is written. Nothing here touches `~/.claude` or `~/.cursor`.

use super::state_types::{AppStateFile, WindowRecord, MAIN_WINDOW_ID};
use std::path::Path;

/// Copy `state.json` to `state.pre-windows.json` beside it. A second run
/// does not overwrite the backup.
pub fn backup_pre_windows(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("state.json");
    let stem = name.trim_end_matches(".json");
    let backup = path.with_file_name(format!("{stem}.pre-windows.json"));
    if backup.exists() {
        return Ok(());
    }
    std::fs::copy(path, &backup).map_err(|err| format!("backup {name}: {err}"))?;
    Ok(())
}

/// `true` when the caller should back up the on-disk file, then save.
pub fn migrate_windows(data: &mut AppStateFile) -> bool {
    if data.migrations.windows {
        return false;
    }
    for tab in &mut data.tabs {
        if tab.window_id.trim().is_empty() {
            tab.window_id = MAIN_WINDOW_ID.to_string();
        }
    }
    for closed in &mut data.closed_tabs {
        if closed.window_id.trim().is_empty() {
            closed.window_id = MAIN_WINDOW_ID.to_string();
        }
    }
    if !data.windows.iter().any(|window| window.id == MAIN_WINDOW_ID) {
        data.windows.insert(
            0,
            WindowRecord {
                id: MAIN_WINDOW_ID.to_string(),
                account_id: "default".to_string(),
                active_tab_id: data.active_tab_id.clone(),
                layout: data.layout.clone(),
            },
        );
    }
    data.migrations.windows = true;
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::json_io::write_json_atomic;
    use crate::store::state_types::{LayoutState, Migrations, TabRecord};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn bare_tab(id: &str) -> TabRecord {
        serde_json::from_value(serde_json::json!({
            "id": id,
            "label": id,
            "roleId": "role_implementer",
            "roleSnapshot": {"name": "Implementer", "templateVersion": 1, "mode": "agent", "injection": "send_on_start"},
            "cwd": "/tmp/proj",
            "answers": {},
            "mergedPrompt": "",
            "mergedPromptHash": "",
            "phase": "draft",
            "order": 1,
            "createdAt": "2026-10-10T00:00:00Z"
        }))
        .unwrap()
    }

    #[test]
    fn existing_tabs_land_on_main_and_the_file_is_backed_up_once() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let dir = crate::test_support::test_root().join(format!("dct_windows_mig_{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("state.json");
        let mut data = AppStateFile {
            schema_version: 1,
            active_tab_id: Some("tab-1".into()),
            tabs: vec![bare_tab("tab-1")],
            closed_tabs: Vec::new(),
            layout: LayoutState::default(),
            pipeline_runs: Vec::new(),
            migrations: Migrations {
                claude_first: true,
                windows: false,
            },
            windows: Vec::new(),
        };
        // An old file has no window id. Serde default fills "main" on load;
        // a blank id is still moved onto main.
        data.tabs[0].window_id.clear();
        write_json_atomic(&path, &data).unwrap();
        assert!(migrate_windows(&mut data));
        assert!(!migrate_windows(&mut data));
        assert_eq!(data.tabs[0].window_id, "main");
        assert_eq!(data.windows.len(), 1);
        assert_eq!(data.windows[0].id, "main");
        assert_eq!(data.windows[0].account_id, "default");
        assert_eq!(data.windows[0].active_tab_id.as_deref(), Some("tab-1"));
        assert!(data.migrations.windows);
        backup_pre_windows(&path).unwrap();
        backup_pre_windows(&path).unwrap();
        let backup = dir.join("state.pre-windows.json");
        assert!(backup.is_file());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn two_windows_may_use_the_same_account() {
        let mut data = AppStateFile::default();
        data.windows.push(WindowRecord {
            id: "win-2".into(),
            account_id: "default".into(),
            active_tab_id: None,
            layout: LayoutState::default(),
        });
        let accounts: Vec<_> = data.windows.iter().map(|w| w.account_id.as_str()).collect();
        assert_eq!(accounts, ["default", "default"]);
    }
}
