use crate::orchestrator::TabPhase;
use crate::roles::Role;
use crate::store::json_io::{read_json_or_recover, write_json_atomic};
use crate::store::state_types::{
    AppStateFile, PipelineRun, RoleSnapshot, TabRecord, TabSessionRef, STATE_SCHEMA_VERSION,
};
use crate::provider::ProviderId;
use crate::template::template_hash;
use chrono::Utc;
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::AppHandle;

pub struct StateStore {
    pub path: PathBuf,
    pub data: AppStateFile,
    /// Settings `providers.default`, given to new agent tabs. Not saved in
    /// `state.json`; `lib.rs` sets it from settings on startup.
    pub new_tab_provider: ProviderId,
    /// Window the command in progress is acting for. Not saved. Set at the
    /// start of each command so two windows do not share a sticky focus.
    pub draft_window: String,
}

impl StateStore {
    pub fn load_or_default(app: &AppHandle) -> Result<Self, String> {
        let dir = crate::data_dir::app_data_dir(app).path;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        Self::open_path(dir.join("state.json"))
    }

    /// Load `state.json` at `path` (missing file = empty state).
    pub fn open_path(path: PathBuf) -> Result<Self, String> {
        let mut data = if path.exists() {
            // A damaged file falls back to state.json.bak instead of blocking startup.
            let loaded: AppStateFile = read_json_or_recover(&path)?;
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
        normalize_provider_sessions(&mut data);
        let claude_migrated = crate::store::claude_migration::migrate_state(&mut data);
        let windows_migrated = crate::store::window_migration::migrate_windows(&mut data);
        let mut store = Self {
            path: path.clone(),
            data,
            new_tab_provider: ProviderId::DEFAULT,
            draft_window: crate::store::state_types::MAIN_WINDOW_ID.to_string(),
        };
        if claude_migrated {
            // The file on disk is still the pre-migration copy.
            crate::store::claude_migration::backup_pre_claude_first(&path)?;
            store.save()?;
        }
        if windows_migrated {
            crate::store::window_migration::backup_pre_windows(&path)?;
            store.save()?;
        }
        // The save keeps the unpruned file as state.json.bak.
        if store.prune_pipeline_runs() {
            store.save()?;
        }
        Ok(store)
    }

    /// The window a command should read and write. Unknown ids stay on main.
    pub fn bind_window(&mut self, window_id: Option<&str>) {
        let id = window_id.unwrap_or("").trim();
        if id.is_empty() {
            self.draft_window = crate::store::state_types::MAIN_WINDOW_ID.to_string();
            return;
        }
        let safe = id.chars().take(64).collect::<String>();
        if safe
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            self.draft_window = safe;
        }
    }

    pub fn focus_window(&self) -> &str {
        &self.draft_window
    }

    pub fn account_for_window(&self, window_id: &str) -> String {
        self.data
            .windows
            .iter()
            .find(|window| window.id == window_id)
            .map(|window| window.account_id.clone())
            .filter(|id| !id.is_empty())
            .unwrap_or_else(|| "default".to_string())
    }

    /// Account for a tab's window, or the command's window when the tab is new.
    pub fn account_for_tab(&self, tab_id: Option<&str>) -> String {
        let window = tab_id
            .and_then(|id| self.tab_by_id(id))
            .map(|tab| tab.window_id.as_str())
            .filter(|id| !id.is_empty())
            .unwrap_or(self.draft_window.as_str());
        self.account_for_window(window)
    }

    pub fn active_for_window(&self, window_id: &str) -> Option<String> {
        if let Some(window) = self.data.windows.iter().find(|window| window.id == window_id) {
            if window.active_tab_id.is_some() {
                return window.active_tab_id.clone();
            }
        }
        if crate::store::state_types::window_matches(
            crate::store::state_types::MAIN_WINDOW_ID,
            window_id,
        ) {
            return self.data.active_tab_id.clone();
        }
        None
    }

    fn remember_active(&mut self, window_id: &str, tab_id: Option<String>) {
        if let Some(window) = self
            .data
            .windows
            .iter_mut()
            .find(|window| window.id == window_id)
        {
            window.active_tab_id = tab_id.clone();
        }
        if crate::store::state_types::window_matches(
            crate::store::state_types::MAIN_WINDOW_ID,
            window_id,
        ) {
            self.data.active_tab_id = tab_id;
        }
    }

    pub fn ensure_window(&mut self, window_id: &str, account_id: &str) -> Result<(), String> {
        if let Some(window) = self
            .data
            .windows
            .iter_mut()
            .find(|window| window.id == window_id)
        {
            window.account_id = account_id.to_string();
            return self.save();
        }
        self.data.windows.push(crate::store::WindowRecord {
            id: window_id.to_string(),
            account_id: account_id.to_string(),
            active_tab_id: None,
            layout: crate::store::LayoutState::default(),
        });
        self.save()
    }

    /// Mark this window's running chats stopped. The processes are already gone.
    pub fn stop_window_tabs(&mut self, window_id: &str) -> Result<(), String> {
        let mut changed = false;
        for tab in &mut self.data.tabs {
            if !crate::store::state_types::window_matches(&tab.window_id, window_id) {
                continue;
            }
            if tab.kind == "terminal" || tab.phase == "terminal" {
                continue;
            }
            if tab.phase == "running" {
                tab.phase = TabPhase::Running
                    .after_session_stopped()
                    .as_store_str()
                    .to_string();
                changed = true;
            }
        }
        if changed {
            self.save()?;
        }
        Ok(())
    }

    /// Drop a window that was closed while another stayed open.
    pub fn archive_window(&mut self, window_id: &str) -> Result<(), String> {
        let ids: Vec<String> = self
            .data
            .tabs
            .iter()
            .filter(|tab| crate::store::state_types::window_matches(&tab.window_id, window_id))
            .map(|tab| tab.id.clone())
            .collect();
        for id in ids {
            self.close_tab(&id)?;
        }
        self.data.windows.retain(|window| window.id != window_id);
        self.save()
    }

    pub fn tabs_in_window(&self, window_id: &str) -> Vec<&TabRecord> {
        self.sorted_tabs()
            .into_iter()
            .filter(|tab| crate::store::state_types::window_matches(&tab.window_id, window_id))
            .collect()
    }

    /// Provider a session start for `tab_id` would use: the tab's saved
    /// provider (legacy tabs resolve to Cursor), or the default for a tab
    /// that does not exist yet.
    pub fn provider_for_start(&self, tab_id: Option<&str>) -> ProviderId {
        match tab_id.and_then(|id| self.tab_by_id(id)) {
            Some(tab) => ProviderId::resolve(tab.provider),
            None => self.new_tab_provider,
        }
    }

    /// Start-card provider chip. A running tab keeps its provider.
    pub fn set_tab_provider(&mut self, tab_id: &str, provider: ProviderId) -> Result<(), String> {
        let tab = self
            .data
            .tabs
            .iter_mut()
            .find(|t| t.id == tab_id)
            .ok_or_else(|| format!("unknown tab: {tab_id}"))?;
        if tab.phase == "running" {
            return Err("Stop this tab before switching its provider.".to_string());
        }
        tab.provider = Some(provider);
        self.save()
    }

    pub fn remember_provider_session(
        &mut self,
        tab_id: &str,
        provider: ProviderId,
        session_id: Option<String>,
    ) -> Result<(), String> {
        let tab = self
            .data
            .tabs
            .iter_mut()
            .find(|t| t.id == tab_id)
            .ok_or_else(|| format!("unknown tab: {tab_id}"))?;
        tab.sessions.set(provider, session_id);
        self.save()
    }

    pub fn remember_claude_config(&mut self, tab_id: &str, config_dir: &str) -> Result<(), String> {
        let tab = self
            .data
            .tabs
            .iter_mut()
            .find(|t| t.id == tab_id)
            .ok_or_else(|| format!("unknown tab: {tab_id}"))?;
        tab.sessions.claude_config_dir = Some(config_dir.to_string());
        self.save()
    }

    pub fn set_provider_notice(&mut self, tab_id: &str, notice: Option<String>) -> Result<(), String> {
        let tab = self
            .data
            .tabs
            .iter_mut()
            .find(|t| t.id == tab_id)
            .ok_or_else(|| format!("unknown tab: {tab_id}"))?;
        tab.provider_notice = notice.filter(|text| !text.trim().is_empty());
        self.save()
    }

    pub fn set_permission_note(&mut self, tab_id: &str, note: Option<String>) -> Result<(), String> {
        let tab = self
            .data
            .tabs
            .iter_mut()
            .find(|t| t.id == tab_id)
            .ok_or_else(|| format!("unknown tab: {tab_id}"))?;
        tab.permission_note = note.filter(|text| !text.trim().is_empty());
        self.save()
    }

    pub fn set_tab_chain(
        &mut self,
        tab_id: &str,
        chain: Option<crate::store::ChainRef>,
        handoff_text: Option<&str>,
    ) -> Result<(), String> {
        let tab = self
            .data
            .tabs
            .iter_mut()
            .find(|t| t.id == tab_id)
            .ok_or_else(|| format!("unknown tab: {tab_id}"))?;
        tab.chain = chain.clone();
        // Each chain keeps one run so its overview can list every stage.
        if let Some(chain) = chain {
            self.record_chain_step(tab_id, &chain, handoff_text);
        }
        self.save()
    }

    pub fn save(&mut self) -> Result<(), String> {
        write_json_atomic(&self.path, &self.data)
    }

    pub fn tab_by_id(&self, tab_id: &str) -> Option<&TabRecord> {
        self.data.tabs.iter().find(|t| t.id == tab_id)
    }

    /// Promote an existing draft/awaiting tab to `running`, or create a new tab if none applies.
    #[allow(clippy::too_many_arguments)]
    pub fn promote_tab_to_running(
        &mut self,
        preferred_tab_id: Option<&str>,
        role: &Role,
        answers: &HashMap<String, String>,
        cwd: &str,
        merged_prompt: &str,
        session: TabSessionRef,
        provider: ProviderId,
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
            tab.provider = Some(provider);
            tab.sessions
                .set(provider, Some(session.acp_session_id.clone()));
            tab.session = Some(session);
            let window_id = tab.window_id.clone();
            self.remember_active(&window_id, Some(tab_id.clone()));
            self.save()?;
            return Ok(tab_id);
        }

        let tab_id = new_tab_id();
        let mut sessions = crate::provider::ProviderSessions::default();
        sessions.set(provider, Some(session.acp_session_id.clone()));
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
            worktree: None,
            pipeline_run_id: None,
            provider: Some(provider),
            sessions,
            provider_notice: None,
            chain: None,
            permission_note: None,
            window_id: self.draft_window.clone(),
        };
        self.data.tabs.push(record);
        let window_id = self.draft_window.clone();
        self.remember_active(&window_id, Some(tab_id.clone()));
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
        let window_id = self
            .data
            .tabs
            .iter()
            .find(|tab| tab.id == tab_id)
            .map(|tab| tab.window_id.clone())
            .ok_or_else(|| format!("unknown tab: {tab_id}"))?;
        self.remember_active(&window_id, Some(tab_id.to_string()));
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
                worktree: tab.worktree.clone(),
                provider: tab.provider,
                sessions: tab.sessions.clone(),
                provider_notice: tab.provider_notice.clone(),
                chain: tab.chain.clone(),
                permission_note: tab.permission_note.clone(),
                window_id: tab.window_id.clone(),
            },
        );
        self.data.closed_tabs.truncate(15);
        let window_id = tab.window_id.clone();
        let closed_id = tab.id.clone();
        if self.data.layout.secondary_tab_id.as_deref() == Some(closed_id.as_str()) {
            self.data.layout.secondary_tab_id = None;
            self.data.layout = self.data.layout.clone().sanitized();
        }
        if self.data.layout.grid_tab_ids.contains(&closed_id) {
            self.data.layout.grid_tab_ids.retain(|id| id != &closed_id);
            self.data.layout = self.data.layout.clone().sanitized();
        }
        if let Some(window) = self
            .data
            .windows
            .iter_mut()
            .find(|window| window.id == window_id)
        {
            if window.layout.secondary_tab_id.as_deref() == Some(closed_id.as_str()) {
                window.layout.secondary_tab_id = None;
                window.layout = window.layout.clone().sanitized();
            }
            if window.layout.grid_tab_ids.contains(&closed_id) {
                window.layout.grid_tab_ids.retain(|id| id != &closed_id);
                window.layout = window.layout.clone().sanitized();
            }
        }
        if self.active_for_window(&window_id).as_deref() == Some(closed_id.as_str()) {
            let next = self
                .data
                .tabs
                .iter()
                .filter(|candidate| {
                    crate::store::state_types::window_matches(&candidate.window_id, &window_id)
                })
                .max_by_key(|candidate| candidate.order)
                .map(|candidate| candidate.id.clone());
            self.remember_active(&window_id, next);
        }
        self.save()
    }

    /// Put the most recently closed tab back. The agent is not restarted.
    pub fn reopen_closed(&mut self, transcript: Option<String>) -> Result<TabRecord, String> {
        self.reopen_closed_id(None, transcript)
    }

    /// Put a closed tab back: `tab_id`, or the most recent one when `None`.
    pub fn reopen_closed_id(
        &mut self,
        tab_id: Option<&str>,
        transcript: Option<String>,
    ) -> Result<TabRecord, String> {
        let focus = self.draft_window.clone();
        let index = match tab_id {
            Some(id) => {
                let index = self
                    .data
                    .closed_tabs
                    .iter()
                    .position(|t| t.id == id)
                    .ok_or_else(|| "that closed tab is no longer in the list".to_string())?;
                if !crate::store::state_types::window_matches(
                    &self.data.closed_tabs[index].window_id,
                    &focus,
                ) {
                    return Err("that closed tab is in another window".to_string());
                }
                index
            }
            None => self
                .data
                .closed_tabs
                .iter()
                .position(|tab| {
                    crate::store::state_types::window_matches(&tab.window_id, &focus)
                })
                .ok_or_else(|| "no closed tab to reopen".to_string())?,
        };
        let closed = self.data.closed_tabs.remove(index);
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
            worktree: closed.worktree.clone(),
            pipeline_run_id: None,
            provider: closed.provider,
            sessions: closed.sessions,
            provider_notice: closed.provider_notice,
            chain: closed.chain,
            permission_note: closed.permission_note,
            window_id: if closed.window_id.trim().is_empty() {
                self.draft_window.clone()
            } else {
                closed.window_id.clone()
            },
        };
        let id = record.id.clone();
        let window_id = record.window_id.clone();
        self.data.tabs.push(record);
        self.remember_active(&window_id, Some(id.clone()));
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
        if !crate::store::state_types::window_matches(
            crate::store::state_types::MAIN_WINDOW_ID,
            &self.draft_window,
        ) {
            if let Some(window) = self
                .data
                .windows
                .iter()
                .find(|window| window.id == self.draft_window)
            {
                return &window.layout;
            }
        }
        &self.data.layout
    }

    /// A secondary pane or grid cell that names a closed tab is dropped.
    pub fn set_layout(&mut self, next: crate::store::LayoutState) -> Result<(), String> {
        let mut next = next.sanitized();
        if let Some(id) = next.secondary_tab_id.clone() {
            if !self.data.tabs.iter().any(|t| t.id == id) {
                next.secondary_tab_id = None;
                next = next.sanitized();
            }
        }
        if !next.grid_tab_ids.is_empty() {
            let tabs = &self.data.tabs;
            next.grid_tab_ids.retain(|id| tabs.iter().any(|t| &t.id == id));
            next = next.sanitized();
        }
        let window_id = self.draft_window.clone();
        if crate::store::state_types::window_matches(
            crate::store::state_types::MAIN_WINDOW_ID,
            &window_id,
        ) {
            self.data.layout = next.clone();
        }
        if let Some(window) = self
            .data
            .windows
            .iter_mut()
            .find(|window| window.id == window_id)
        {
            window.layout = next;
        }
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

    /// Draft tab whose folder is a worktree the user just created.
    pub fn create_worktree_tab(
        &mut self,
        role: &Role,
        worktree: crate::worktree::WorktreeRef,
    ) -> Result<String, String> {
        let tab_id = self.create_draft_tab(role, &worktree.path, true, None)?;
        if let Some(tab) = self.data.tabs.iter_mut().find(|t| t.id == tab_id) {
            tab.worktree = Some(worktree);
        }
        self.save()?;
        Ok(tab_id)
    }

    /// Worktree of an open or recently closed tab.
    pub fn worktree_for(&self, tab_id: &str) -> Option<crate::worktree::WorktreeRef> {
        self.data
            .tabs
            .iter()
            .find(|t| t.id == tab_id)
            .and_then(|t| t.worktree.clone())
            .or_else(|| {
                self.data
                    .closed_tabs
                    .iter()
                    .find(|t| t.id == tab_id)
                    .and_then(|t| t.worktree.clone())
            })
    }

    pub fn is_tab_open(&self, tab_id: &str) -> bool {
        self.data.tabs.iter().any(|t| t.id == tab_id)
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
        pipeline_run_id: Option<&str>,
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
            worktree: None,
            pipeline_run_id: pipeline_run_id.map(|id| id.to_string()),
            provider: Some(self.new_tab_provider),
            sessions: Default::default(),
            provider_notice: None,
            chain: None,
            permission_note: None,
            window_id: self.draft_window.clone(),
        };
        self.data.tabs.push(record);
        if make_active {
            let window_id = self.draft_window.clone();
            self.remember_active(&window_id, Some(tab_id.clone()));
        }
        self.save()?;
        Ok(tab_id)
    }

    pub fn pipeline_run_by_id(&self, run_id: &str) -> Option<&PipelineRun> {
        self.data.pipeline_runs.iter().find(|run| run.id == run_id)
    }

    pub fn pipeline_run_by_id_mut(&mut self, run_id: &str) -> Option<&mut PipelineRun> {
        self.data
            .pipeline_runs
            .iter_mut()
            .find(|run| run.id == run_id)
    }

    pub fn create_pipeline_overview_tab(
        &mut self,
        cwd: &str,
        run_id: &str,
        title: &str,
    ) -> Result<String, String> {
        let tab_id = new_tab_id();
        let record = TabRecord {
            id: tab_id.clone(),
            label: title.to_string(),
            role_id: "pipeline_overview".to_string(),
            role_snapshot: RoleSnapshot {
                name: "Pipeline".to_string(),
                template_version: 1,
                mode: "agent".to_string(),
                injection: String::new(),
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
            color: Some("#F0B429".to_string()),
            kind: "pipeline_overview".to_string(),
            terminal_launch: String::new(),
            model: None,
            custom_label: false,
            worktree: None,
            pipeline_run_id: Some(run_id.to_string()),
            provider: None,
            sessions: Default::default(),
            provider_notice: None,
            chain: None,
            permission_note: None,
            window_id: self.draft_window.clone(),
        };
        self.data.tabs.push(record);
        let window_id = self.draft_window.clone();
        self.remember_active(&window_id, Some(tab_id.clone()));
        self.save()?;
        Ok(tab_id)
    }

    pub fn create_pipeline_workspace(
        &mut self,
        roles: &crate::store::RolesStore,
        cwd: &str,
        kind: &str,
        role_ids: &[&str],
        initial_stage: &str,
    ) -> Result<String, String> {
        if kind != "full" && kind != "execute" {
            return Err("pipeline kind must be full or execute".into());
        }
        let run_id = new_tab_id();
        let overview_title = if kind == "execute" {
            "Pipeline · Execute".to_string()
        } else {
            "Pipeline · Plan".to_string()
        };
        let mut tab_ids = HashMap::new();
        for role_id in role_ids {
            let role = roles
                .role_by_id(role_id)
                .ok_or_else(|| format!("unknown role: {role_id}"))?;
            let tab_id = self.create_draft_tab(role, cwd, false, Some(&run_id))?;
            tab_ids.insert(role_id.to_string(), tab_id);
        }
        let overview_tab_id = self.create_pipeline_overview_tab(cwd, &run_id, &overview_title)?;
        let run = PipelineRun {
            id: run_id,
            kind: kind.to_string(),
            cwd: cwd.to_string(),
            stage: initial_stage.to_string(),
            overview_tab_id: overview_tab_id.clone(),
            tab_ids,
            candidate_plan: None,
            approved_plan: None,
            original_request: None,
            created_at: Utc::now().to_rfc3339(),
            chain_id: None,
            handoffs: HashMap::new(),
            updated_at: None,
            round: 1,
            verdicts: Vec::new(),
        };
        self.data.pipeline_runs.push(run);
        self.save()?;
        Ok(overview_tab_id)
    }

    pub fn pipeline_promote_plan(
        &mut self,
        run_id: &str,
        approved_plan: &str,
    ) -> Result<(), String> {
        let plan = approved_plan.trim();
        if plan.is_empty() {
            return Err("approved plan is empty".into());
        }
        let (implementer_tab_id, original_request) = {
            let run = self
                .pipeline_run_by_id(run_id)
                .ok_or_else(|| format!("unknown pipeline run: {run_id}"))?;
            let implementer_tab_id = run
                .tab_ids
                .get("role_implementer")
                .cloned()
                .ok_or_else(|| "pipeline has no implementer tab".to_string())?;
            (implementer_tab_id, run.original_request.clone())
        };
        {
            let run = self
                .pipeline_run_by_id_mut(run_id)
                .ok_or_else(|| format!("unknown pipeline run: {run_id}"))?;
            run.approved_plan = Some(plan.to_string());
            run.stage = "implementer".to_string();
        }
        let tab = self
            .data
            .tabs
            .iter_mut()
            .find(|t| t.id == implementer_tab_id)
            .ok_or_else(|| "implementer tab missing".to_string())?;
        tab.answers.insert("approvedPlan".to_string(), plan.to_string());
        if let Some(request) = original_request {
            if !request.trim().is_empty() {
                tab.answers
                    .insert("description".to_string(), request.trim().to_string());
            }
        }
        self.save()?;
        Ok(())
    }

    pub fn pipeline_set_candidate_plan(
        &mut self,
        run_id: &str,
        candidate_plan: &str,
    ) -> Result<(), String> {
        let text = candidate_plan.trim();
        if text.is_empty() {
            return Err("candidate plan is empty".into());
        }
        let run = self
            .pipeline_run_by_id_mut(run_id)
            .ok_or_else(|| format!("unknown pipeline run: {run_id}"))?;
        run.candidate_plan = Some(text.to_string());
        if run.kind == "full" && run.stage == "planner" {
            run.stage = "plan_reviewer".to_string();
        }
        self.save()?;
        Ok(())
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
                    let window_id = tab.window_id.clone();
                    self.remember_active(&window_id, Some(id.to_string()));
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
            worktree: None,
            pipeline_run_id: None,
            provider: None,
            sessions: Default::default(),
            provider_notice: None,
            chain: None,
            permission_note: None,
            window_id: self.draft_window.clone(),
        };
        apply_terminal_draft(&mut record, &draft);
        self.data.tabs.push(record);
        let window_id = self.draft_window.clone();
        self.remember_active(&window_id, Some(tab_id.clone()));
        self.save()?;
        Ok(tab_id)
    }

    /// F7: open a saved workspace as new tabs (titles, folders, roles,
    /// terminal kinds). Chat tabs come back as drafts and nothing is started.
    /// With `replace`, the tabs open now are closed afterwards (they go to the
    /// reopen list like any closed tab); the command stops their sessions and
    /// PTYs first. Returns the new tab ids in order.
    pub fn open_workspace(
        &mut self,
        workspace: &crate::store::Workspace,
        replace: bool,
    ) -> Result<Vec<String>, String> {
        if workspace.tabs.is_empty() {
            return Err("That workspace has no tabs.".into());
        }
        let focus = self.draft_window.clone();
        let old: Vec<String> = if replace {
            self.sorted_tabs()
                .iter()
                .filter(|tab| crate::store::state_types::window_matches(&tab.window_id, &focus))
                .map(|tab| tab.id.clone())
                .collect()
        } else {
            Vec::new()
        };
        let mut ids = Vec::with_capacity(workspace.tabs.len());
        for item in &workspace.tabs {
            let tab_id = new_tab_id();
            let is_terminal = item.kind == "terminal";
            let mut answers = item.answers.clone();
            answers.insert("cwd".to_string(), item.cwd.clone());
            answers.remove("resumeSessionId");
            let record = TabRecord {
                id: tab_id.clone(),
                label: item.label.clone(),
                role_id: item.role_id.clone(),
                role_snapshot: item.role_snapshot.clone(),
                cwd: item.cwd.clone(),
                answers,
                merged_prompt: String::new(),
                merged_prompt_hash: String::new(),
                phase: if is_terminal { "terminal" } else { "draft" }.to_string(),
                order: next_tab_order(&self.data),
                created_at: Utc::now().to_rfc3339(),
                session: None,
                transcript: None,
                startup_prompt_sent: false,
                color: item.color.clone(),
                kind: if is_terminal {
                    "terminal".to_string()
                } else {
                    crate::store::state_types::default_tab_kind()
                },
                terminal_launch: match (is_terminal, item.terminal_launch.as_str()) {
                    (false, _) => String::new(),
                    (true, "") => "shell".to_string(),
                    (true, launch) => launch.to_string(),
                },
                model: item.model.clone(),
                // Keep the saved title even when the form changes later.
                custom_label: true,
                worktree: item.worktree.clone(),
                pipeline_run_id: None,
                provider: item.provider,
                sessions: Default::default(),
                provider_notice: None,
                chain: None,
                permission_note: None,
                window_id: self.draft_window.clone(),
            };
            self.data.tabs.push(record);
            ids.push(tab_id);
        }
        for id in &old {
            self.close_tab(id)?;
        }
        let active = workspace
            .active_index
            .and_then(|i| ids.get(i).cloned())
            .or_else(|| ids.first().cloned());
        let window_id = self.draft_window.clone();
        self.remember_active(&window_id, active);
        if let Some(layout) = workspace.layout.clone() {
            let layout = layout.sanitized();
            if crate::store::state_types::window_matches(
                crate::store::state_types::MAIN_WINDOW_ID,
                &window_id,
            ) {
                self.data.layout = layout.clone();
            }
            if let Some(window) = self
                .data
                .windows
                .iter_mut()
                .find(|window| window.id == window_id)
            {
                window.layout = layout;
            }
        }
        self.save()?;
        Ok(ids)
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
    /// Provider of the CLI this terminal runs (`None` for a plain shell).
    pub provider: Option<ProviderId>,
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
    if draft.provider.is_some() {
        tab.provider = draft.provider;
    }
}

/// Session id the UI may resume for this tab's current provider.
/// A Claude tab never reports a Cursor id.
pub(crate) fn displayed_acp_session(tab: &TabRecord) -> Option<String> {
    let provider = ProviderId::resolve(tab.provider);
    if let Some(id) = tab.sessions.get(provider) {
        return Some(id.to_string());
    }
    if provider == ProviderId::Cursor {
        return tab
            .session
            .as_ref()
            .map(|session| session.acp_session_id.clone());
    }
    None
}

/// Terminal `--resume` id for the current provider. A leftover Cursor id is
/// not returned on a Claude tab.
pub(crate) fn displayed_resume_session(tab: &TabRecord) -> Option<String> {
    let provider = ProviderId::resolve(tab.provider);
    if tab.kind == "terminal" {
        if let Some(id) = tab.sessions.get(provider) {
            return Some(id.to_string());
        }
    }
    let from_answers = tab
        .answers
        .get("resumeSessionId")
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty());
    if provider == ProviderId::Claude && tab.sessions.cursor.as_deref() == from_answers.as_deref() {
        return None;
    }
    from_answers
}

/// Copy a legacy single session id into `sessions.cursor`. Only records
/// written before providers existed have a session but no `sessions`; their
/// ids are always Cursor ids, even if the tab is switched to Claude later
/// (a Cursor id must never resume under Claude).
pub(crate) fn normalize_provider_sessions(data: &mut AppStateFile) {
    for tab in &mut data.tabs {
        if tab.sessions.is_empty() {
            if let Some(session) = &tab.session {
                tab.sessions.cursor = Some(session.acp_session_id.clone());
            }
        }
    }
    for closed in &mut data.closed_tabs {
        if closed.sessions.is_empty() {
            closed.sessions.cursor = closed.acp_session_id.clone();
        }
    }
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
        let dir = crate::test_support::test_root().join(format!(
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
            handoff_targets: None,
        };
        let mut store = StateStore {
            path: path.clone(),
            data: AppStateFile::default(),
            new_tab_provider: crate::provider::ProviderId::DEFAULT,
            draft_window: crate::store::state_types::MAIN_WINDOW_ID.to_string(),
        };
        let first = store.create_draft_tab(&role, "/tmp/a", true, None).unwrap();
        let second = store.create_draft_tab(&role, "/tmp/b", true, None).unwrap();
        store
            .set_tab_model(&first, Some("gpt-5".to_string()))
            .unwrap();
        store
            .set_layout(LayoutState {
                split_mode: "horizontal".to_string(),
                secondary_tab_id: Some(second.clone()),
                grid_tab_ids: Vec::new(),
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
    fn grid_layout_keeps_open_tabs_and_closes_below_two() {
        let dir = crate::test_support::test_root().join(format!(
            "dcterminal_grid_{}",
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
            color: "#0969da".to_string(),
            is_built_in: true,
            fields: vec![],
            updated_at: None,
            handoff_targets: None,
        };
        let mut store = StateStore {
            path: dir.join("state.json"),
            data: AppStateFile::default(),
            new_tab_provider: crate::provider::ProviderId::DEFAULT,
            draft_window: crate::store::state_types::MAIN_WINDOW_ID.to_string(),
        };
        let a = store.create_draft_tab(&role, "/tmp/a", true, None).unwrap();
        let b = store.create_draft_tab(&role, "/tmp/b", true, None).unwrap();
        let c = store.create_draft_tab(&role, "/tmp/c", true, None).unwrap();
        store
            .set_layout(crate::store::LayoutState {
                split_mode: "grid".to_string(),
                secondary_tab_id: Some(b.clone()),
                grid_tab_ids: vec![a.clone(), b.clone(), "gone".to_string(), b.clone(), c.clone()],
                ..crate::store::LayoutState::default()
            })
            .unwrap();
        assert_eq!(store.layout().split_mode, "grid");
        assert_eq!(store.layout().grid_tab_ids, vec![a.clone(), b.clone(), c.clone()]);
        assert!(store.layout().secondary_tab_id.is_none());
        store.close_tab(&c).unwrap();
        assert_eq!(store.layout().grid_tab_ids, vec![a.clone(), b.clone()]);
        store.close_tab(&b).unwrap();
        assert_eq!(store.layout().split_mode, "single");
        assert!(store.layout().grid_tab_ids.is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn grid_layout_caps_at_six_tabs_and_other_modes_drop_the_list() {
        let ids: Vec<String> = (0..9).map(|i| format!("t{i}")).collect();
        let grid = crate::store::LayoutState {
            split_mode: "grid".to_string(),
            grid_tab_ids: ids.clone(),
            ..crate::store::LayoutState::default()
        }
        .sanitized();
        assert_eq!(grid.grid_tab_ids.len(), 6);
        let split = crate::store::LayoutState {
            split_mode: "horizontal".to_string(),
            secondary_tab_id: Some("t1".to_string()),
            grid_tab_ids: ids,
            ..crate::store::LayoutState::default()
        }
        .sanitized();
        assert!(split.grid_tab_ids.is_empty());
        assert_eq!(split.split_mode, "horizontal");
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
    fn worktree_tab_keeps_its_worktree_through_close_and_reopen() {
        let dir = crate::test_support::test_root().join(format!(
            "dcterminal_wt_tab_{}",
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
            handoff_targets: None,
        };
        let mut store = StateStore {
            path: dir.join("state.json"),
            data: AppStateFile::default(),
            new_tab_provider: crate::provider::ProviderId::DEFAULT,
            draft_window: crate::store::state_types::MAIN_WINDOW_ID.to_string(),
        };
        let wt = crate::worktree::WorktreeRef {
            repo_root: "/r/app".to_string(),
            path: "/r/app-worktrees/feat-x".to_string(),
            branch: "feat/x".to_string(),
        };
        let plain = store.create_draft_tab(&role, "/r/app", false, None).unwrap();
        let id = store.create_worktree_tab(&role, wt.clone()).unwrap();
        let tab = store.tab_by_id(&id).unwrap();
        assert_eq!(tab.cwd, "/r/app-worktrees/feat-x");
        assert_eq!(
            tab.answers.get("cwd").map(String::as_str),
            Some("/r/app-worktrees/feat-x")
        );
        assert_eq!(store.data.active_tab_id.as_deref(), Some(id.as_str()));
        assert_eq!(store.worktree_for(&id), Some(wt.clone()));
        assert_eq!(store.worktree_for(&plain), None);
        assert!(store.is_tab_open(&id));
        store.close_tab(&id).unwrap();
        assert!(!store.is_tab_open(&id));
        assert_eq!(store.worktree_for(&id), Some(wt.clone()));
        let reopened = store.reopen_closed(None).unwrap();
        assert_eq!(reopened.worktree, Some(wt));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn renamed_tab_keeps_its_name_through_form_sync_start_reopen_and_reload() {
        let dir = crate::test_support::test_root().join(format!(
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
            handoff_targets: None,
        };
        let path = dir.join("state.json");
        let mut store = StateStore {
            path: path.clone(),
            data: AppStateFile::default(),
            new_tab_provider: crate::provider::ProviderId::DEFAULT,
            draft_window: crate::store::state_types::MAIN_WINDOW_ID.to_string(),
        };
        let id = store.create_draft_tab(&role, "/tmp/app", true, None).unwrap();
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
                crate::provider::ProviderId::Cursor,
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
        let dir = crate::test_support::test_root().join(format!(
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
            handoff_targets: None,
        };
        let mut store = StateStore {
            path,
            data: AppStateFile::default(),
            new_tab_provider: crate::provider::ProviderId::DEFAULT,
            draft_window: crate::store::state_types::MAIN_WINDOW_ID.to_string(),
        };
        let draft_id = store.create_draft_tab(&role, "/tmp/proj", true, None).unwrap();
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
                crate::provider::ProviderId::Cursor,
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
        let dir = crate::test_support::test_root().join(format!(
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
            handoff_targets: None,
        };
        let mut store = StateStore {
            path: dir.join("state.json"),
            data: AppStateFile::default(),
            new_tab_provider: crate::provider::ProviderId::DEFAULT,
            draft_window: crate::store::state_types::MAIN_WINDOW_ID.to_string(),
        };
        let id = store.create_draft_tab(&role, r"C:\Work\App", true, None).unwrap();
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
    fn a_specific_closed_tab_can_be_reopened() {
        let dir = crate::test_support::test_root().join(format!(
            "dcterminal_reopen_id_{}",
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
            handoff_targets: None,
        };
        let mut store = StateStore {
            path: dir.join("state.json"),
            data: AppStateFile::default(),
            new_tab_provider: crate::provider::ProviderId::DEFAULT,
            draft_window: crate::store::state_types::MAIN_WINDOW_ID.to_string(),
        };
        let older = store.create_draft_tab(&role, "/w/a", true, None).unwrap();
        let newer = store.create_draft_tab(&role, "/w/b", true, None).unwrap();
        store.close_tab(&older).unwrap();
        store.close_tab(&newer).unwrap();
        let restored = store
            .reopen_closed_id(Some(&older), Some("old text".into()))
            .unwrap();
        assert_eq!(restored.id, older);
        assert_eq!(store.data.closed_tabs.len(), 1);
        assert_eq!(store.data.closed_tabs[0].id, newer);
        assert!(store.reopen_closed_id(Some("tab_gone"), None).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn stop_and_relaunch_keep_the_acp_session_id() {
        let dir = crate::test_support::test_root().join(format!(
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
            handoff_targets: None,
        };
        let mut store = StateStore {
            path: dir.join("state.json"),
            data: AppStateFile::default(),
            new_tab_provider: crate::provider::ProviderId::DEFAULT,
            draft_window: crate::store::state_types::MAIN_WINDOW_ID.to_string(),
        };
        let id = store.create_draft_tab(&role, r"C:\Work\App", true, None).unwrap();
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
                crate::provider::ProviderId::Cursor,
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

    #[test]
    fn a_workspace_restores_titles_folders_roles_and_can_replace_open_tabs() {
        use crate::store::{Workspace, WorkspaceTab};
        let dir = crate::test_support::test_root().join(format!(
            "dcterminal_ws_open_{}",
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
            handoff_targets: None,
        };
        let mut store = StateStore {
            path: dir.join("state.json"),
            data: AppStateFile::default(),
            new_tab_provider: crate::provider::ProviderId::DEFAULT,
            draft_window: crate::store::state_types::MAIN_WINDOW_ID.to_string(),
        };
        let before = store.create_draft_tab(&role, "/w/old", true, None).unwrap();
        let snapshot = store.tab_by_id(&before).unwrap().role_snapshot.clone();
        let chat = WorkspaceTab {
            label: "Developer · Login fix".into(),
            custom_label: false,
            role_id: "role_dev".into(),
            role_snapshot: snapshot.clone(),
            cwd: "/w/Koneksi".into(),
            kind: "role".into(),
            terminal_launch: String::new(),
            color: Some("#f85149".into()),
            model: Some("gpt-5".into()),
            answers: HashMap::from([
                ("title".to_string(), "Login fix".to_string()),
                ("resumeSessionId".to_string(), "nope".to_string()),
            ]),
            worktree: None,
            provider: None,
        };
        let shell = WorkspaceTab {
            label: "Shell · api".into(),
            custom_label: true,
            role_id: String::new(),
            role_snapshot: snapshot,
            cwd: "/w/api".into(),
            kind: "terminal".into(),
            terminal_launch: "shell".into(),
            color: None,
            model: None,
            answers: HashMap::new(),
            worktree: None,
            provider: None,
        };
        let ws = Workspace {
            id: "ws_1".into(),
            name: "Daily".into(),
            saved_at: "2026-10-06T00:00:00Z".into(),
            tabs: vec![chat, shell],
            active_index: Some(1),
            layout: None,
        };

        let added = store.open_workspace(&ws, false).unwrap();
        assert_eq!(added.len(), 2);
        assert_eq!(store.data.tabs.len(), 3);
        assert_eq!(store.data.active_tab_id.as_deref(), Some(added[1].as_str()));
        let restored = store.tab_by_id(&added[0]).unwrap();
        assert_eq!(restored.label, "Developer · Login fix");
        assert_eq!(restored.role_id, "role_dev");
        assert_eq!(restored.cwd, "/w/Koneksi");
        assert_eq!(restored.phase, "draft");
        assert_eq!(restored.kind, "role");
        assert!(restored.custom_label);
        assert!(restored.session.is_none());
        assert_eq!(restored.model.as_deref(), Some("gpt-5"));
        assert_eq!(
            restored.answers.get("cwd").map(String::as_str),
            Some("/w/Koneksi")
        );
        assert!(!restored.answers.contains_key("resumeSessionId"));
        let term = store.tab_by_id(&added[1]).unwrap();
        assert_eq!(term.kind, "terminal");
        assert_eq!(term.terminal_launch, "shell");
        assert_eq!(term.phase, "terminal");

        let replaced = store.open_workspace(&ws, true).unwrap();
        let open: Vec<_> = store.sorted_tabs().iter().map(|t| t.id.clone()).collect();
        assert_eq!(open, replaced);
        assert!(store.data.closed_tabs.iter().any(|t| t.id == before));
        assert_eq!(
            store.data.active_tab_id.as_deref(),
            Some(replaced[1].as_str())
        );
        let reloaded: AppStateFile = crate::store::read_json(&dir.join("state.json")).unwrap();
        let labels: Vec<_> = reloaded.tabs.iter().map(|t| t.label.clone()).collect();
        assert_eq!(labels, vec!["Developer · Login fix", "Shell · api"]);
        let _ = std::fs::remove_dir_all(dir);
    }
}
