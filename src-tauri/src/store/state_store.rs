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

    /// Promote an existing draft/awaiting tab to `running`, or create a new tab if none applies.
    pub fn promote_tab_to_running(
        &mut self,
        preferred_tab_id: Option<&str>,
        role: &Role,
        answers: &HashMap<String, String>,
        cwd: &str,
        merged_prompt: &str,
        session: TabSessionRef,
    ) -> Result<String, String> {
        let reuse_id = resolve_tab_for_session_start(self, preferred_tab_id)?;
        let snapshot = RoleSnapshot {
            name: role.name.clone(),
            template_version: role.template_version,
            mode: role.default_mode.clone(),
            injection: role.injection.clone(),
        };
        let label = tab_label(&role.name, answers);
        let merged_hash = template_hash(merged_prompt);

        if let Some(tab_id) = reuse_id {
            let tab = self
                .data
                .tabs
                .iter_mut()
                .find(|t| t.id == tab_id)
                .ok_or_else(|| format!("unknown tab: {tab_id}"))?;
            if tab.phase == "running" {
                return Err("this tab is already running — stop it or open a new tab".to_string());
            }
            tab.label = label;
            tab.role_id = role.id.clone();
            tab.role_snapshot = snapshot;
            tab.cwd = cwd.to_string();
            tab.answers = answers.clone();
            tab.merged_prompt = merged_prompt.to_string();
            tab.merged_prompt_hash = merged_hash;
            tab.phase = "running".to_string();
            tab.session = Some(session);
            self.data.active_tab_id = Some(tab_id.clone());
            self.save()?;
            return Ok(tab_id);
        }

        let tab_id = new_tab_id();
        let record = TabRecord {
            id: tab_id.clone(),
            label,
            role_id: role.id.clone(),
            role_snapshot: snapshot,
            cwd: cwd.to_string(),
            answers: answers.clone(),
            merged_prompt: merged_prompt.to_string(),
            merged_prompt_hash: merged_hash,
            phase: "running".to_string(),
            order: next_tab_order(&self.data),
            created_at: Utc::now().to_rfc3339(),
            session: Some(session),
        };
        self.data.tabs.push(record);
        self.data.active_tab_id = Some(tab_id.clone());
        self.save()?;
        Ok(tab_id)
    }

    /// Keep the active tab chip label/answers in sync while the user edits the form.
    pub fn sync_tab_form(
        &mut self,
        tab_id: &str,
        role: &Role,
        answers: &HashMap<String, String>,
        cwd: &str,
    ) -> Result<(), String> {
        let tab = self
            .data
            .tabs
            .iter_mut()
            .find(|t| t.id == tab_id)
            .ok_or_else(|| format!("unknown tab: {tab_id}"))?;
        if tab.phase == "running" {
            return Ok(());
        }
        tab.label = tab_label(&role.name, answers);
        tab.role_id = role.id.clone();
        tab.cwd = cwd.to_string();
        tab.answers = answers.clone();
        if tab.phase == "draft" {
            tab.role_snapshot = RoleSnapshot {
                name: role.name.clone(),
                template_version: role.template_version,
                mode: role.default_mode.clone(),
                injection: role.injection.clone(),
            };
        }
        self.save()?;
        Ok(())
    }

    /// After relaunch there is no live agent — persisted `running` tabs are idle forms.
    pub fn reconcile_stale_running_tabs(&mut self) -> Result<(), String> {
        let mut changed = false;
        for tab in &mut self.data.tabs {
            if tab.phase == "running" {
                tab.phase = "awaitingInput".to_string();
                tab.session = None;
                changed = true;
            }
        }
        if changed {
            self.save()?;
        }
        Ok(())
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

    pub fn create_draft_tab(
        &mut self,
        role: &Role,
        cwd: &str,
        make_active: bool,
    ) -> Result<String, String> {
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
        if make_active {
            self.data.active_tab_id = Some(tab_id.clone());
        }
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

fn resolve_tab_for_session_start(
    store: &StateStore,
    preferred_tab_id: Option<&str>,
) -> Result<Option<String>, String> {
    if let Some(id) = preferred_tab_id {
        if let Some(tab) = store.tab_by_id(id) {
            if tab.phase == "running" {
                return Err("this tab is already running — stop it or open a new tab".to_string());
            }
            if matches!(tab.phase.as_str(), "draft" | "awaitingInput") {
                return Ok(Some(id.to_string()));
            }
        }
    }
    if let Some(active) = store.data.active_tab_id.clone() {
        if let Some(tab) = store.tab_by_id(&active) {
            if matches!(tab.phase.as_str(), "draft" | "awaitingInput") {
                return Ok(Some(active));
            }
        }
    }
    Ok(None)
}

pub(crate) fn tab_label(role_name: &str, answers: &HashMap<String, String>) -> String {
    if let Some(title) = answers
        .get("title")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        return format!("{role_name} · {title}");
    }
    if let Some(task_type) = answers
        .get("taskType")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        return format!("{role_name} · {task_type}");
    }
    if let Some(cwd) = answers
        .get("cwd")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        let folder = std::path::Path::new(cwd)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(cwd);
        return format!("{role_name} · {folder}");
    }
    role_name.to_string()
}

#[cfg(test)]
mod tests {
    use super::{tab_label, StateStore};
    use crate::store::state_types::{AppStateFile, TabSessionRef};
    use chrono::Utc;
    use std::collections::HashMap;

    #[test]
    fn tab_label_uses_title_when_present() {
        let mut answers = HashMap::new();
        answers.insert("title".to_string(), "Fix login".to_string());
        assert_eq!(tab_label("Implementer", &answers), "Implementer · Fix login");
    }

    #[test]
    fn tab_label_uses_folder_when_no_title() {
        let mut answers = HashMap::new();
        answers.insert("cwd".to_string(), r"C:\Projects\DCTerminal".to_string());
        assert_eq!(tab_label("Developer", &answers), "Developer · DCTerminal");
    }

    #[test]
    fn promote_reuses_draft_tab_instead_of_creating_new() {
        use crate::roles::Role;
        let dir = std::env::temp_dir().join(format!(
            "dcterminal_state_test_{}",
            Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("state.json");
        let role = Role {
            id: "role_dev".to_string(),
            name: "Developer".to_string(),
            template_text: String::new(),
            template_version: 1,
            template_hash: String::new(),
            schema_template_hash: String::new(),
            default_mode: "agent".to_string(),
            injection: "send_on_start".to_string(),
            color: "#fff".to_string(),
            is_built_in: true,
            fields: vec![],
            updated_at: None,
        };
        let mut store = StateStore {
            path,
            data: AppStateFile::default(),
        };
        let draft_id = store.create_draft_tab(&role, "/tmp/proj", true).unwrap();
        let answers = HashMap::from([
            ("cwd".to_string(), "/tmp/proj".to_string()),
            ("title".to_string(), "Onboarding".to_string()),
        ]);
        let session = TabSessionRef {
            acp_session_id: "s1".to_string(),
            mode_id: "agent".to_string(),
            injection_pending: false,
            injected_at: None,
        };
        let running_id = store
            .promote_tab_to_running(
                Some(&draft_id),
                &role,
                &answers,
                "/tmp/proj",
                "merged",
                session,
            )
            .unwrap();
        assert_eq!(running_id, draft_id);
        assert_eq!(store.data.tabs.len(), 1);
        assert_eq!(store.data.tabs[0].phase, "running");
        assert_eq!(store.data.tabs[0].label, "Developer · Onboarding");
        let _ = std::fs::remove_dir_all(dir);
    }
}
