use crate::roles::Role;
use crate::store::json_io::{read_json, write_json_atomic};
use crate::store::state_types::{
    AppStateFile, RoleSnapshot, TabRecord, TabSessionRef, STATE_SCHEMA_VERSION,
};
use crate::template::template_hash;
use chrono::Utc;
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

pub struct StateStore {
    pub path: PathBuf,
    pub data: AppStateFile,
}

impl StateStore {
    pub fn load_or_default(app: &AppHandle) -> Result<Self, String> {
        let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = dir.join("state.json");
        let data = if path.exists() {
            let loaded: AppStateFile = read_json(&path)?;
            if loaded.schema_version != STATE_SCHEMA_VERSION {
                return Err(format!(
                    "unsupported state.json schemaVersion {} (expected {})",
                    loaded.schema_version,
                    STATE_SCHEMA_VERSION
                ));
            }
            loaded
        } else {
            AppStateFile::default()
        };
        Ok(Self { path, data })
    }

    pub fn save(&mut self) -> Result<(), String> {
        write_json_atomic(&self.path, &self.data)
    }

    pub fn tab_by_id(&self, tab_id: &str) -> Option<&TabRecord> {
        self.data.tabs.iter().find(|t| t.id == tab_id)
    }

    pub fn upsert_running_tab(
        &mut self,
        role: &Role,
        answers: &HashMap<String, String>,
        cwd: &str,
        merged_prompt: &str,
        session: TabSessionRef,
        startup_injected: bool,
    ) -> Result<String, String> {
        let tab_id = new_tab_id();
        let label = tab_label(&role.name, answers);
        let record = TabRecord {
            id: tab_id.clone(),
            label,
            role_id: role.id.clone(),
            role_snapshot: RoleSnapshot {
                name: role.name.clone(),
                template_version: role.template_version,
                mode: role.default_mode.clone(),
                injection: role.injection.clone(),
            },
            cwd: cwd.to_string(),
            answers: answers.clone(),
            merged_prompt: merged_prompt.to_string(),
            merged_prompt_hash: template_hash(merged_prompt),
            phase: "running".to_string(),
            order: next_tab_order(&self.data),
            created_at: Utc::now().to_rfc3339(),
            session: Some(session),
        };
        self.data.tabs.push(record);
        self.data.active_tab_id = Some(tab_id.clone());
        self.save()?;
        let _ = startup_injected;
        Ok(tab_id)
    }

    pub fn mark_tab_awaiting_input(&mut self, tab_id: &str) -> Result<(), String> {
        let tab = self
            .data
            .tabs
            .iter_mut()
            .find(|t| t.id == tab_id)
            .ok_or_else(|| format!("unknown tab: {tab_id}"))?;
        tab.phase = "awaitingInput".to_string();
        tab.session = None;
        self.save()
    }

    pub fn set_active_tab(&mut self, tab_id: &str) -> Result<(), String> {
        if !self.data.tabs.iter().any(|t| t.id == tab_id) {
            return Err(format!("unknown tab: {tab_id}"));
        }
        self.data.active_tab_id = Some(tab_id.to_string());
        self.save()
    }

    pub fn close_tab(&mut self, tab_id: &str) -> Result<(), String> {
        let idx = self
            .data
            .tabs
            .iter()
            .position(|t| t.id == tab_id)
            .ok_or_else(|| format!("unknown tab: {tab_id}"))?;
        let tab = &self.data.tabs[idx];
        if tab.phase == "running" {
            return Err("cannot close a running tab — stop the session first".to_string());
        }
        self.data.tabs.remove(idx);
        if self.data.active_tab_id.as_deref() == Some(tab_id) {
            self.data.active_tab_id = self
                .data
                .tabs
                .iter()
                .max_by_key(|t| t.order)
                .map(|t| t.id.clone());
        }
        self.save()
    }

    pub fn create_draft_tab(&mut self, role: &Role, cwd: &str) -> Result<String, String> {
        let tab_id = new_tab_id();
        let label = format!("New · {}", role.name);
        let record = TabRecord {
            id: tab_id.clone(),
            label,
            role_id: role.id.clone(),
            role_snapshot: RoleSnapshot {
                name: role.name.clone(),
                template_version: role.template_version,
                mode: role.default_mode.clone(),
                injection: role.injection.clone(),
            },
            cwd: cwd.to_string(),
            answers: HashMap::from([("cwd".to_string(), cwd.to_string())]),
            merged_prompt: String::new(),
            merged_prompt_hash: String::new(),
            phase: "draft".to_string(),
            order: next_tab_order(&self.data),
            created_at: Utc::now().to_rfc3339(),
            session: None,
        };
        self.data.tabs.push(record);
        self.data.active_tab_id = Some(tab_id.clone());
        self.save()?;
        Ok(tab_id)
    }

    pub fn sorted_tabs(&self) -> Vec<&TabRecord> {
        let mut tabs: Vec<&TabRecord> = self.data.tabs.iter().collect();
        tabs.sort_by_key(|t| t.order);
        tabs
    }

    pub fn set_injection_complete(&mut self, tab_id: &str) -> Result<(), String> {
        let tab = self
            .data
            .tabs
            .iter_mut()
            .find(|t| t.id == tab_id)
            .ok_or_else(|| format!("unknown tab: {tab_id}"))?;
        if let Some(session) = &mut tab.session {
            session.injection_pending = false;
            session.injected_at = Some(Utc::now().to_rfc3339());
        }
        self.save()
    }
}

fn new_tab_id() -> String {
    format!("tab_{:x}", Utc::now().timestamp_millis())
}

fn next_tab_order(data: &AppStateFile) -> u32 {
    data.tabs.iter().map(|t| t.order).max().unwrap_or(0) + 1
}

pub(crate) fn tab_label(role_name: &str, answers: &HashMap<String, String>) -> String {
    let title = answers
        .get("title")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty());
    match title {
        Some(t) => format!("{role_name} · {t}"),
        None => role_name.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::tab_label;
    use std::collections::HashMap;

    #[test]
    fn tab_label_uses_title_when_present() {
        let mut answers = HashMap::new();
        answers.insert("title".to_string(), "Fix login".to_string());
        assert_eq!(tab_label("Implementer", &answers), "Implementer · Fix login");
    }
}
