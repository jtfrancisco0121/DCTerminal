use crate::orchestrator::TabPhase;
use crate::roles::Role;
use crate::store::json_io::{read_json, write_json_atomic};
use crate::store::state_types::{
    AppStateFile, RoleSnapshot, TabRecord, TabSessionRef, STATE_SCHEMA_VERSION,
};
use crate::template::template_hash;
use chrono::Utc;
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::AppHandle;

pub struct StateStore {
    pub path: PathBuf,
    pub data: AppStateFile,
}

impl StateStore {
    pub fn load_or_default(app: &AppHandle) -> Result<Self, String> {
        let dir = crate::data_dir::app_data_dir(app).path;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = dir.join("state.json");
        let data = if path.exists() {
            let loaded: AppStateFile = read_json(&path)?;
            if loaded.schema_version != STATE_SCHEMA_VERSION {
                return Err(format!(
                    "unsupported state.json schemaVersion {} (expected {})",
                    loaded.schema_version, STATE_SCHEMA_VERSION
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
            if !tab.custom_label {
                tab.label = label;
            }
            tab.role_id = role.id.clone();
            tab.role_snapshot = snapshot;
            tab.cwd = cwd.to_string();
            tab.answers = answers.clone();
            tab.merged_prompt = merged_prompt.to_string();
            tab.merged_prompt_hash = merged_hash;
            tab.phase = TabPhase::AwaitingInput
                .after_session_started()
                .map_err(|err| err.to_string())?
                .as_store_str()
                .to_string();
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
            phase: TabPhase::Running.as_store_str().to_string(),
            order: next_tab_order(&self.data),
            created_at: Utc::now().to_rfc3339(),
            session: Some(session),
            transcript: None,
            startup_prompt_sent: false,
            color: Some(role.color.clone()),
            kind: crate::store::state_types::default_tab_kind(),
            terminal_launch: String::new(),
            model: None,
            custom_label: false,
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
        if tab.phase == "running" || tab.kind == "terminal" || tab.phase == "terminal" {
            return Ok(());
        }
        if !tab.custom_label {
            tab.label = tab_label(&role.name, answers);
        }
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
            if tab.kind == "terminal" || tab.phase == "terminal" {
                continue;
            }
            if tab.phase == "running" {
                tab.phase = TabPhase::Running
                    .after_session_stopped()
                    .as_store_str()
                    .to_string();
                // The process is gone. The ACP session id stays so Continue can session/load.
                changed = true;
            }
        }
        if changed {
            self.save()?;
        }
        Ok(())
    }

    pub fn mark_tab_awaiting_input(
        &mut self,
        tab_id: &str,
        transcript: Option<String>,
    ) -> Result<(), String> {
        let tab = self
            .data
            .tabs
            .iter_mut()
            .find(|t| t.id == tab_id)
            .ok_or_else(|| format!("unknown tab: {tab_id}"))?;
        tab.phase = TabPhase::Running
            .after_session_stopped()
            .as_store_str()
            .to_string();
        if let Some(text) = transcript {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                tab.transcript = Some(trimmed.chars().take(500_000).collect());
                tab.startup_prompt_sent = true;
            }
        }
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
        let tab = self.data.tabs.remove(idx);
        self.data.closed_tabs.retain(|closed| closed.id != tab.id);
        self.data.closed_tabs.insert(
            0,
            crate::store::state_types::ClosedTabRecord {
                id: tab.id.clone(),
                label: tab.label.clone(),
                role_id: tab.role_id.clone(),
                role_snapshot: tab.role_snapshot.clone(),
                cwd: tab.cwd.clone(),
                answers: tab.answers.clone(),
                color: tab.color.clone(),
                merged_prompt: tab.merged_prompt.clone(),
                merged_prompt_hash: tab.merged_prompt_hash.clone(),
                startup_prompt_sent: tab.startup_prompt_sent,
                closed_at: Utc::now().to_rfc3339(),
                kind: tab.kind.clone(),
                terminal_launch: tab.terminal_launch.clone(),
                acp_session_id: tab
                    .session
                    .as_ref()
                    .map(|session| session.acp_session_id.clone()),
                mode_id: tab.session.as_ref().map(|session| session.mode_id.clone()),
                model: tab.model.clone(),
                custom_label: tab.custom_label,
            },
        );
        self.data.closed_tabs.truncate(15);
        if self.data.layout.secondary_tab_id.as_deref() == Some(tab_id) {
            self.data.layout.secondary_tab_id = None;
            self.data.layout = self.data.layout.clone().sanitized();
        }
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

    /// Put the most recently closed tab back. The agent is not restarted.
    pub fn reopen_closed(&mut self, transcript: Option<String>) -> Result<TabRecord, String> {
        let closed = self
            .data
            .closed_tabs
            .first()
            .cloned()
            .ok_or_else(|| "no closed tab to reopen".to_string())?;
        self.data.closed_tabs.remove(0);
        if self.data.tabs.iter().any(|t| t.id == closed.id) {
            return Err("that tab is already open".to_string());
        }
        let has_history = closed.startup_prompt_sent
            || transcript
                .as_ref()
                .is_some_and(|text| !text.trim().is_empty());
        let terminal = closed.kind == "terminal";
        let mode_id = closed
            .mode_id
            .clone()
            .unwrap_or_else(|| closed.role_snapshot.mode.clone());
        let session = if terminal {
            None
        } else {
            closed.acp_session_id.as_ref().map(|id| TabSessionRef {
                acp_session_id: id.clone(),
                mode_id,
                injection_pending: false,
                injected_at: None,
            })
        };
        let record = TabRecord {
            id: closed.id.clone(),
            label: closed.label,
            role_id: closed.role_id,
            role_snapshot: closed.role_snapshot,
            cwd: closed.cwd,
            answers: closed.answers,
            merged_prompt: closed.merged_prompt,
            merged_prompt_hash: closed.merged_prompt_hash,
            phase: if terminal {
                "terminal".to_string()
            } else if has_history {
                "awaitingInput".to_string()
            } else {
                "draft".to_string()
            },
            order: next_tab_order(&self.data),
            created_at: Utc::now().to_rfc3339(),
            session,
            transcript,
            startup_prompt_sent: closed.startup_prompt_sent || has_history,
            color: closed.color,
            kind: closed.kind.clone(),
            terminal_launch: closed.terminal_launch.clone(),
            model: closed.model.clone(),
            custom_label: closed.custom_label,
        };
        let id = record.id.clone();
        self.data.tabs.push(record);
        self.data.active_tab_id = Some(id.clone());
        self.save()?;
        self.tab_by_id(&id)
            .cloned()
            .ok_or_else(|| "reopened tab missing".to_string())
    }

    pub fn set_tab_model(&mut self, tab_id: &str, model: Option<String>) -> Result<(), String> {
        let tab = self
            .data
            .tabs
            .iter_mut()
            .find(|t| t.id == tab_id)
            .ok_or_else(|| format!("unknown tab: {tab_id}"))?;
        tab.model = model;
        self.save()
    }

    pub fn layout(&self) -> &crate::store::LayoutState {
        &self.data.layout
    }

    /// A secondary pane that names a closed tab is dropped.
    pub fn set_layout(&mut self, next: crate::store::LayoutState) -> Result<(), String> {
        let mut next = next.sanitized();
        if let Some(id) = next.secondary_tab_id.clone() {
            if !self.data.tabs.iter().any(|t| t.id == id) {
                next.secondary_tab_id = None;
                next = next.sanitized();
            }
        }
        self.data.layout = next;
        self.save()
    }

    pub fn set_tab_label(&mut self, tab_id: &str, label: &str) -> Result<(), String> {
        let label = label.trim();
        if label.is_empty() {
            return Err("tab name is empty".to_string());
        }
        let label: String = label.chars().take(80).collect();
        let tab = self
            .data
            .tabs
            .iter_mut()
            .find(|t| t.id == tab_id)
            .ok_or_else(|| format!("unknown tab: {tab_id}"))?;
        tab.label = label;
        tab.custom_label = true;
        self.save()
    }

    pub fn set_tab_color(&mut self, tab_id: &str, color: &str) -> Result<(), String> {
        if !valid_tab_color(color) {
            return Err("color must be a #rgb or #rrggbb value".to_string());
        }
        let tab = self
            .data
            .tabs
            .iter_mut()
            .find(|t| t.id == tab_id)
            .ok_or_else(|| format!("unknown tab: {tab_id}"))?;
        tab.color = Some(color.to_string());
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
            transcript: None,
            startup_prompt_sent: false,
            color: Some(role.color.clone()),
            kind: crate::store::state_types::default_tab_kind(),
            terminal_launch: String::new(),
            model: None,
            custom_label: false,
        };
        self.data.tabs.push(record);
        if make_active {
            self.data.active_tab_id = Some(tab_id.clone());
        }
        self.save()?;
        Ok(tab_id)
    }

    /// Convert a draft tab, or create one, for a shell / CLI / role terminal.
    /// A live ACP tab is left alone and a new tab is created instead.
    pub fn save_terminal_tab(
        &mut self,
        preferred_id: Option<&str>,
        draft: TerminalTabDraft,
    ) -> Result<String, String> {
        if let Some(id) = preferred_id {
            if let Some(tab) = self.data.tabs.iter_mut().find(|tab| tab.id == id) {
                if tab.phase != "running" {
                    apply_terminal_draft(tab, &draft);
                    self.data.active_tab_id = Some(id.to_string());
                    self.save()?;
                    return Ok(id.to_string());
                }
            }
        }
        let tab_id = new_tab_id();
        let mut record = TabRecord {
            id: tab_id.clone(),
            label: String::new(),
            role_id: String::new(),
            role_snapshot: draft.role_snapshot.clone(),
            cwd: String::new(),
            answers: HashMap::new(),
            merged_prompt: String::new(),
            merged_prompt_hash: String::new(),
            phase: "terminal".to_string(),
            order: next_tab_order(&self.data),
            created_at: Utc::now().to_rfc3339(),
            session: None,
            transcript: None,
            startup_prompt_sent: false,
            color: None,
            kind: "terminal".to_string(),
            terminal_launch: String::new(),
            model: None,
            custom_label: false,
        };
        apply_terminal_draft(&mut record, &draft);
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
        tab.startup_prompt_sent = true;
        self.save()
    }

    /// Continue without re-sending the merged startup prompt (blueprint E23).
    pub fn should_skip_startup_injection(
        &self,
        tab_id: Option<&str>,
        resend_startup: bool,
    ) -> bool {
        if resend_startup {
            return false;
        }
        let id = match tab_id.or(self.data.active_tab_id.as_deref()) {
            Some(id) => id,
            None => return false,
        };
        let tab = match self.tab_by_id(id) {
            Some(t) => t,
            None => return false,
        };
        tab.phase == "awaitingInput"
            && (tab.startup_prompt_sent
                || tab
                    .transcript
                    .as_ref()
                    .is_some_and(|s| !s.trim().is_empty()))
    }
}

pub struct TerminalTabDraft {
    pub launch: String,
    pub cwd: String,
    pub label: String,
    pub role_id: String,
    pub role_snapshot: RoleSnapshot,
    pub color: String,
    pub answers: HashMap<String, String>,
    pub merged_prompt: String,
    pub startup_prompt_sent: bool,
}

fn apply_terminal_draft(tab: &mut TabRecord, draft: &TerminalTabDraft) {
    if !tab.custom_label {
        tab.label = draft.label.clone();
    }
    tab.role_id = draft.role_id.clone();
    tab.role_snapshot = draft.role_snapshot.clone();
    tab.cwd = draft.cwd.clone();
    tab.answers = draft.answers.clone();
    tab.merged_prompt = draft.merged_prompt.clone();
    tab.merged_prompt_hash = template_hash(&draft.merged_prompt);
    tab.phase = "terminal".to_string();
    tab.kind = "terminal".to_string();
    tab.terminal_launch = draft.launch.clone();
    tab.color = Some(draft.color.clone());
    tab.startup_prompt_sent = draft.startup_prompt_sent;
    tab.session = None;
}

/// Millisecond ids, bumped so two tabs made in the same millisecond still get
/// distinct ids.
fn new_tab_id() -> String {
    use std::sync::atomic::{AtomicI64, Ordering};
    static LAST: AtomicI64 = AtomicI64::new(0);
    let now = Utc::now().timestamp_millis();
    let mut prev = LAST.load(Ordering::Relaxed);
    loop {
        let next = now.max(prev + 1);
        match LAST.compare_exchange_weak(prev, next, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => return format!("tab_{next:x}"),
            Err(actual) => prev = actual,
        }
    }
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
        return format!("{role_name} · {}", label_snippet(title));
    }
    for key in ["request", "description", "originalTask"] {
        if let Some(text) = answers.get(key).map(|s| s.trim()).filter(|s| !s.is_empty()) {
            return format!("{role_name} · {}", label_snippet(text));
        }
    }
    if let Some(cwd) = answers
        .get("cwd")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        let folder = folder_display_name(cwd);
        return format!("{role_name} · {folder}");
    }
    role_name.to_string()
}

fn label_snippet(text: &str) -> String {
    let one_line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let max = 42;
    if one_line.chars().count() <= max {
        return one_line;
    }
    let end = one_line
        .char_indices()
        .nth(max - 1)
        .map(|(index, _)| index)
        .unwrap_or(one_line.len());
    format!("{}…", one_line[..end].trim_end())
}

/// Last path segment, treating both `/` and `\` as separators so Windows
/// paths still label tabs when the host (or a test) is not Windows.
fn valid_tab_color(color: &str) -> bool {
    let Some(rest) = color.strip_prefix('#') else {
        return false;
    };
    (rest.len() == 3 || rest.len() == 6) && rest.chars().all(|ch| ch.is_ascii_hexdigit())
}

fn folder_display_name(cwd: &str) -> &str {
    let trimmed = cwd.trim().trim_end_matches(['/', '\\']);
    trimmed
        .rsplit(['/', '\\'])
        .next()
        .filter(|part| !part.is_empty())
        .unwrap_or(trimmed)
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
        assert_eq!(
            tab_label("Implementer", &answers),
            "Implementer · Fix login"
        );
    }

    #[test]
    fn tab_label_uses_folder_when_no_title() {
        let mut answers = HashMap::new();
        answers.insert("cwd".to_string(), r"C:\Projects\DCTerminal".to_string());
        assert_eq!(tab_label("Developer", &answers), "Developer · DCTerminal");
    }

    #[test]
    fn tab_label_ignores_task_type_and_uses_the_folder() {
        let mut answers = HashMap::new();
        answers.insert("taskType".to_string(), "Feature".to_string());
        answers.insert(
            "cwd".to_string(),
            r"C:\Users\user\Documents\Projects\Encryptor".to_string(),
        );
        assert_eq!(tab_label("Developer", &answers), "Developer · Encryptor");
    }

    #[test]
    fn tab_model_and_layout_survive_close_reopen_and_reload() {
        use crate::roles::Role;
        use crate::store::LayoutState;
        let dir = std::env::temp_dir().join(format!(
            "dcterminal_layout_test_{}",
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
            path: path.clone(),
            data: AppStateFile::default(),
        };
        let first = store.create_draft_tab(&role, "/tmp/a", true).unwrap();
        let second = store.create_draft_tab(&role, "/tmp/b", true).unwrap();
        store
            .set_tab_model(&first, Some("gpt-5".to_string()))
            .unwrap();
        store
            .set_layout(LayoutState {
                split_mode: "horizontal".to_string(),
                secondary_tab_id: Some(second.clone()),
                primary_size: 99.0,
                file_panel_open: true,
                file_panel_width: 300.0,
            })
            .unwrap();
        assert_eq!(store.layout().primary_size, 85.0);
        let loaded: AppStateFile = crate::store::read_json(&path).unwrap();
        assert_eq!(
            loaded.layout.secondary_tab_id.as_deref(),
            Some(second.as_str())
        );
        assert_eq!(
            loaded
                .tabs
                .iter()
                .find(|t| t.id == first)
                .and_then(|t| t.model.clone()),
            Some("gpt-5".to_string())
        );
        store.close_tab(&second).unwrap();
        assert_eq!(store.layout().split_mode, "single");
        assert!(store.layout().secondary_tab_id.is_none());
        store.close_tab(&first).unwrap();
        let reopened = store.reopen_closed(None).unwrap();
        assert_eq!(reopened.id, first);
        assert_eq!(reopened.model.as_deref(), Some("gpt-5"));
        store
            .set_layout(LayoutState {
                split_mode: "vertical".to_string(),
                secondary_tab_id: Some("gone".to_string()),
                ..LayoutState::default()
            })
            .unwrap();
        assert_eq!(store.layout().split_mode, "single");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn tab_ids_made_back_to_back_are_unique() {
        let ids: std::collections::HashSet<String> =
            (0..1000).map(|_| super::new_tab_id()).collect();
        assert_eq!(ids.len(), 1000);
    }

    #[test]
    fn old_state_files_without_layout_or_model_load() {
        let raw = r#"{"schemaVersion":1,"activeTabId":null,"tabs":[]}"#;
        let parsed: AppStateFile = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.layout.split_mode, "single");
        assert!(!parsed.layout.file_panel_open);
    }

    #[test]
    fn renamed_tab_keeps_its_name_through_form_sync_start_reopen_and_reload() {
        let dir = std::env::temp_dir().join(format!(
            "dcterminal_rename_{}",
            Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let role = crate::roles::Role {
            id: "role_dev".to_string(),
            name: "Developer".to_string(),
            template_text: String::new(),
            template_version: 1,
            template_hash: String::new(),
            schema_template_hash: String::new(),
            default_mode: "agent".to_string(),
            injection: "send_on_start".to_string(),
            color: "#3fb950".to_string(),
            is_built_in: true,
            fields: vec![],
            updated_at: None,
        };
        let path = dir.join("state.json");
        let mut store = StateStore {
            path: path.clone(),
            data: AppStateFile::default(),
        };
        let id = store.create_draft_tab(&role, "/tmp/app", true).unwrap();
        store.set_tab_label(&id, "  Auth bug  ").unwrap();
        let answers = HashMap::from([
            ("cwd".to_string(), "/tmp/app".to_string()),
            ("title".to_string(), "Onboarding".to_string()),
        ]);
        store
            .sync_tab_form(&id, &role, &answers, "/tmp/app")
            .unwrap();
        assert_eq!(store.tab_by_id(&id).unwrap().label, "Auth bug");
        store
            .promote_tab_to_running(
                Some(&id),
                &role,
                &answers,
                "/tmp/app",
                "merged",
                TabSessionRef {
                    acp_session_id: "s1".to_string(),
                    mode_id: "agent".to_string(),
                    injection_pending: false,
                    injected_at: None,
                },
            )
            .unwrap();
        assert_eq!(store.tab_by_id(&id).unwrap().label, "Auth bug");
        store.close_tab(&id).unwrap();
        let reopened = store.reopen_closed(None).unwrap();
        assert_eq!(reopened.label, "Auth bug");
        assert!(reopened.custom_label);
        let reloaded: AppStateFile =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(reloaded.tabs[0].label, "Auth bug");
        assert!(reloaded.tabs[0].custom_label);
        assert!(store.set_tab_label(&id, "   ").is_err());
        let _ = std::fs::remove_dir_all(dir);
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

    #[test]
    fn close_then_reopen_restores_the_tab_without_a_session() {
        let dir = std::env::temp_dir().join(format!(
            "dcterminal_reopen_{}",
            Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let role = crate::roles::Role {
            id: "role_dev".to_string(),
            name: "Developer".to_string(),
            template_text: String::new(),
            template_version: 1,
            template_hash: String::new(),
            schema_template_hash: String::new(),
            default_mode: "agent".to_string(),
            injection: "send_on_start".to_string(),
            color: "#3fb950".to_string(),
            is_built_in: true,
            fields: vec![],
            updated_at: None,
        };
        let mut store = StateStore {
            path: dir.join("state.json"),
            data: AppStateFile::default(),
        };
        let id = store.create_draft_tab(&role, r"C:\Work\App", true).unwrap();
        store.close_tab(&id).unwrap();
        assert!(store.data.tabs.is_empty());
        let restored = store
            .reopen_closed(Some("saved scrollback".into()))
            .unwrap();
        assert_eq!(restored.id, id);
        assert!(restored.session.is_none());
        assert_eq!(restored.phase, "awaitingInput");
        assert_eq!(restored.transcript.as_deref(), Some("saved scrollback"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn stop_and_relaunch_keep_the_acp_session_id() {
        let dir = std::env::temp_dir().join(format!(
            "dcterminal_keep_sid_{}",
            Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let role = crate::roles::Role {
            id: "role_dev".to_string(),
            name: "Developer".to_string(),
            template_text: String::new(),
            template_version: 1,
            template_hash: String::new(),
            schema_template_hash: String::new(),
            default_mode: "agent".to_string(),
            injection: "send_on_start".to_string(),
            color: "#3fb950".to_string(),
            is_built_in: true,
            fields: vec![],
            updated_at: None,
        };
        let mut store = StateStore {
            path: dir.join("state.json"),
            data: AppStateFile::default(),
        };
        let id = store.create_draft_tab(&role, r"C:\Work\App", true).unwrap();
        store
            .promote_tab_to_running(
                Some(&id),
                &role,
                &HashMap::from([("cwd".to_string(), r"C:\Work\App".to_string())]),
                r"C:\Work\App",
                "merged",
                TabSessionRef {
                    acp_session_id: "11111111-2222-3333-4444-555555555555".to_string(),
                    mode_id: "agent".to_string(),
                    injection_pending: false,
                    injected_at: None,
                },
            )
            .unwrap();
        store
            .mark_tab_awaiting_input(&id, Some("scrollback".into()))
            .unwrap();
        assert_eq!(
            store
                .tab_by_id(&id)
                .unwrap()
                .session
                .as_ref()
                .unwrap()
                .acp_session_id,
            "11111111-2222-3333-4444-555555555555"
        );
        store.data.tabs[0].phase = "running".to_string();
        store.reconcile_stale_running_tabs().unwrap();
        assert_eq!(store.data.tabs[0].phase, "awaitingInput");
        assert_eq!(
            store.data.tabs[0].session.as_ref().unwrap().acp_session_id,
            "11111111-2222-3333-4444-555555555555"
        );
        store.close_tab(&id).unwrap();
        let restored = store.reopen_closed(Some("scrollback".into())).unwrap();
        assert_eq!(
            restored.session.as_ref().unwrap().acp_session_id,
            "11111111-2222-3333-4444-555555555555"
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
