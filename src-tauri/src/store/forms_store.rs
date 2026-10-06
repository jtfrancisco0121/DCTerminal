use crate::roles::Role;
use crate::store::forms_types::{push_recent, FormSnapshot, FormsFile, FORMS_SCHEMA_VERSION};
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

    pub fn recall_for_role(&self, role_id: &str) -> Option<FormSnapshot> {
        self.data
            .by_role
            .get(role_id)
            .and_then(|s| s.last_used.clone())
    }

    pub fn apply_recall_to_values(
        &self,
        role: &Role,
        recall: &FormSnapshot,
    ) -> HashMap<String, String> {
        let mut values = HashMap::new();
        // Keep this role's fields, plus Title / What to work on. Drop another
        // role's answers (a Developer tab must not keep taskType "Feature").
        let mut allowed: Vec<String> = role.fields.iter().map(|field| field.key.clone()).collect();
        for key in ["title", "request"] {
            if !allowed.iter().any(|existing| existing == key) {
                allowed.push(key.to_string());
            }
        }
        for key in allowed {
            if let Some(value) = recall.values.get(&key) {
                values.insert(key, value.clone());
            }
        }
        // An empty saved folder stays empty. Callers must not invent a path.
        if recall.cwd.trim().is_empty() {
            values.remove("cwd");
        } else {
            values.insert("cwd".to_string(), recall.cwd.clone());
        }
        for field in &role.fields {
            if field.remember != Some(true) {
                continue;
            }
            if values
                .get(&field.key)
                .map(|s| !s.is_empty())
                .unwrap_or(false)
            {
                continue;
            }
            if let Some(recent) = self.recent_value(&role.id, &field.key) {
                values.insert(field.key.clone(), recent);
            }
        }
        values
    }

    pub fn recent_value(&self, role_id: &str, field_key: &str) -> Option<String> {
        self.data
            .by_role
            .get(role_id)
            .and_then(|s| s.recent.get(field_key))
            .and_then(|list| list.first())
            .map(|r| r.value.clone())
    }

    pub fn save_after_session_start(
        &mut self,
        role: &Role,
        cwd: &str,
        values: &HashMap<String, String>,
    ) -> Result<(), String> {
        let saved_at = Utc::now().to_rfc3339();
        let mut form_values = values.clone();
        form_values.remove("cwd");

        let snapshot = FormSnapshot {
            cwd: cwd.to_string(),
            values: form_values,
            saved_at: saved_at.clone(),
        };

        let entry = self.data.by_role.entry(role.id.clone()).or_default();
        entry.last_used = Some(snapshot);
        entry.draft = None;

        for field in &role.fields {
            if field.remember != Some(true) {
                continue;
            }
            let value = values.get(&field.key).map(|s| s.trim()).unwrap_or("");
            if value.is_empty() {
                continue;
            }
            let list = entry.recent.entry(field.key.clone()).or_default();
            push_recent(list, value.to_string(), saved_at.clone());
        }

        self.save()
    }

    pub fn save_draft(
        &mut self,
        role_id: &str,
        cwd: &str,
        values: &HashMap<String, String>,
    ) -> Result<(), String> {
        let mut form_values = values.clone();
        form_values.remove("cwd");
        let snapshot = FormSnapshot {
            cwd: cwd.to_string(),
            values: form_values,
            saved_at: Utc::now().to_rfc3339(),
        };
        let entry = self.data.by_role.entry(role_id.to_string()).or_default();
        entry.draft = Some(snapshot);
        self.save()
    }
}
