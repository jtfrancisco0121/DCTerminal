//! `forms.json`: the last working folder used per role.
//!
//! Older builds also stored the form text here (title, request, plans, …)
//! and filled it into every new tab. That text is no longer read or written:
//! a new tab starts empty. Old entries stay in the file untouched; only the
//! folder (`lastUsed.cwd`) is still used.

use crate::store::forms_types::{FormSnapshot, FormsFile, FORMS_SCHEMA_VERSION};
use crate::store::json_io::{read_json, write_json_atomic};
use chrono::Utc;
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::AppHandle;

pub struct FormsStore {
    pub path: PathBuf,
    pub data: FormsFile,
}

impl FormsStore {
    pub fn load_or_default(app: &AppHandle) -> Result<Self, String> {
        let dir = crate::data_dir::app_data_dir(app).path;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = dir.join("forms.json");
        let data = if path.exists() {
            let loaded: FormsFile = read_json(&path)?;
            if loaded.schema_version != FORMS_SCHEMA_VERSION {
                return Err(format!(
                    "unsupported forms.json schemaVersion {} (expected {})",
                    loaded.schema_version, FORMS_SCHEMA_VERSION
                ));
            }
            loaded
        } else {
            FormsFile::new_empty()
        };
        Ok(Self { path, data })
    }

    pub fn save(&mut self) -> Result<(), String> {
        write_json_atomic(&self.path, &self.data)
    }

    /// The folder this role last started in, or "". Saved form text is
    /// never returned, so old prompts cannot pre-fill a new tab.
    pub fn recall_cwd_for_role(&self, role_id: &str) -> String {
        self.data
            .by_role
            .get(role_id)
            .and_then(|s| s.last_used.as_ref())
            .map(|s| s.cwd.trim().to_string())
            .unwrap_or_default()
    }

    /// Remember the folder a session started in. The answers are not stored.
    pub fn save_after_session_start(&mut self, role_id: &str, cwd: &str) -> Result<(), String> {
        let entry = self.data.by_role.entry(role_id.to_string()).or_default();
        entry.last_used = Some(folder_only(cwd));
        entry.draft = None;
        self.save()
    }

    /// Kept for the `save_form_draft` command. Stores the folder only.
    pub fn save_draft(&mut self, role_id: &str, cwd: &str) -> Result<(), String> {
        let entry = self.data.by_role.entry(role_id.to_string()).or_default();
        entry.draft = Some(folder_only(cwd));
        self.save()
    }
}

fn folder_only(cwd: &str) -> FormSnapshot {
    FormSnapshot {
        cwd: cwd.to_string(),
        values: HashMap::new(),
        saved_at: Utc::now().to_rfc3339(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::forms_types::{RecentValue, RoleFormState};
    use crate::test_support::TempDir;

    fn old_file() -> FormsFile {
        let mut values = HashMap::new();
        values.insert("title".to_string(), "Old title".to_string());
        values.insert("request".to_string(), "Old request".to_string());
        let mut recent = HashMap::new();
        recent.insert(
            "originalTask".to_string(),
            vec![RecentValue {
                value: "Old task".to_string(),
                saved_at: "2026-01-01T00:00:00Z".to_string(),
            }],
        );
        let mut file = FormsFile::new_empty();
        file.by_role.insert(
            "role_planner".to_string(),
            RoleFormState {
                last_used: Some(FormSnapshot {
                    cwd: "/work/app".to_string(),
                    values,
                    saved_at: "2026-01-01T00:00:00Z".to_string(),
                }),
                draft: None,
                recent,
            },
        );
        file
    }

    #[test]
    fn recall_returns_the_folder_only_from_old_data() {
        let dir = TempDir::new("forms_recall");
        let store = FormsStore {
            path: dir.join("forms.json"),
            data: old_file(),
        };
        assert_eq!(store.recall_cwd_for_role("role_planner"), "/work/app");
        assert_eq!(store.recall_cwd_for_role("role_unknown"), "");
    }

    #[test]
    fn session_start_and_drafts_store_no_form_text() {
        let dir = TempDir::new("forms_save");
        let mut store = FormsStore {
            path: dir.join("forms.json"),
            data: FormsFile::new_empty(),
        };
        store
            .save_after_session_start("role_planner", "/work/app")
            .unwrap();
        store.save_draft("role_planner", "/work/other").unwrap();
        let text = std::fs::read_to_string(dir.join("forms.json")).unwrap();
        let saved: FormsFile = serde_json::from_str(&text).unwrap();
        let entry = &saved.by_role["role_planner"];
        assert!(entry.last_used.as_ref().unwrap().values.is_empty());
        assert!(entry.draft.as_ref().unwrap().values.is_empty());
        assert!(entry.recent.is_empty());
        assert_eq!(store.recall_cwd_for_role("role_planner"), "/work/app");
    }

    #[test]
    fn a_new_start_keeps_old_recent_entries_on_disk_but_unused() {
        let dir = TempDir::new("forms_keep_old");
        let mut store = FormsStore {
            path: dir.join("forms.json"),
            data: old_file(),
        };
        store
            .save_after_session_start("role_planner", "/work/next")
            .unwrap();
        let entry = &store.data.by_role["role_planner"];
        assert!(entry.last_used.as_ref().unwrap().values.is_empty());
        assert_eq!(entry.recent["originalTask"][0].value, "Old task");
        assert_eq!(store.recall_cwd_for_role("role_planner"), "/work/next");
    }
}
