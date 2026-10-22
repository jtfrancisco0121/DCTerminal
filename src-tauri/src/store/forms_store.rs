//! `forms.json`: the last working folder used per role.
//!
//! Older builds also stored the form text here (title, request, plans, …)
//! and filled it into every new tab. That text is no longer read or written:
//! a new tab starts empty. Old entries stay in the file untouched; only the
//! folder (`lastUsed.cwd`) is still used.

use crate::store::forms_types::{FormSnapshot, FormsFile, FORMS_SCHEMA_VERSION};
use crate::store::json_io::{
    read_json_or_recover_with, set_aside_other_version, write_json_atomic,
};
use chrono::Utc;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

pub struct FormsStore {
    pub path: PathBuf,
    pub data: FormsFile,
}

impl FormsStore {
    pub fn load_or_default(app: &AppHandle) -> Result<Self, String> {
        Self::open(&crate::data_dir::app_data_dir(app).path)
    }

    pub fn open(dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let path = dir.join("forms.json");
        // A damaged file or one from another build must not stop the app
        // from opening: it is moved aside and an empty file is used.
        let mut data = read_json_or_recover_with(&path, FormsFile::new_empty)?;
        if data.schema_version != FORMS_SCHEMA_VERSION {
            set_aside_other_version(&path, data.schema_version);
            data = FormsFile::new_empty();
        }
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

    // Regression: a damaged forms.json used to stop the app from opening.
    #[test]
    fn a_damaged_forms_file_does_not_block_open() {
        let dir = TempDir::new("forms_damaged");
        std::fs::write(dir.join("forms.json"), b"{oops").unwrap();
        let store = FormsStore::open(dir.path()).expect("opens");
        assert!(store.data.by_role.is_empty());
        assert_eq!(store.data.schema_version, FORMS_SCHEMA_VERSION);
        assert!(crate::test_support::names_in(dir.path())
            .iter()
            .any(|name| name.starts_with("forms.json.corrupt-")));
    }

    #[test]
    fn a_forms_file_from_another_version_is_set_aside() {
        let dir = TempDir::new("forms_version");
        let original = r#"{"schemaVersion": 3, "byRole": {}}"#;
        std::fs::write(dir.join("forms.json"), original).unwrap();
        let store = FormsStore::open(dir.path()).expect("opens");
        assert_eq!(store.data.schema_version, FORMS_SCHEMA_VERSION);
        let kept = crate::test_support::names_in(dir.path())
            .into_iter()
            .find(|name| name.starts_with("forms.json.from-v3-"))
            .expect("set-aside file");
        assert_eq!(std::fs::read_to_string(dir.join(kept)).unwrap(), original);
    }
}
