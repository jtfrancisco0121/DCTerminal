//! The GitHub monitor tab: one per window, no terminal process behind it.
//! It keeps no data of its own; the feed and filters live in `github.json`.

use super::state_store::{new_tab_id, next_tab_order};
use crate::store::state_types::{window_matches, RoleSnapshot, TabRecord};
use crate::store::StateStore;
use chrono::Utc;
use std::collections::HashMap;

pub const GITHUB_TAB_KIND: &str = "github";
const GITHUB_TAB_LABEL: &str = "GitHub";

impl StateStore {
    /// The window's GitHub tab, when it has one.
    pub fn github_tab_in_window(&self, window_id: &str) -> Option<&TabRecord> {
        self.data
            .tabs
            .iter()
            .find(|tab| tab.kind == GITHUB_TAB_KIND && window_matches(&tab.window_id, window_id))
    }

    /// Opens the GitHub tab of the window in focus and makes it active. When
    /// the window already has one, that one is focused instead.
    pub fn open_github_tab(&mut self) -> Result<String, String> {
        let window_id = self.draft_window.clone();
        if let Some(existing) = self
            .github_tab_in_window(&window_id)
            .map(|tab| tab.id.clone())
        {
            self.remember_active(&window_id, Some(existing.clone()));
            self.save()?;
            return Ok(existing);
        }
        self.create_github_tab()
    }

    fn create_github_tab(&mut self) -> Result<String, String> {
        let tab_id = new_tab_id();
        let record = TabRecord {
            id: tab_id.clone(),
            label: GITHUB_TAB_LABEL.to_string(),
            role_id: String::new(),
            role_snapshot: RoleSnapshot {
                name: GITHUB_TAB_LABEL.to_string(),
                template_version: 1,
                mode: "agent".to_string(),
                injection: String::new(),
            },
            cwd: String::new(),
            answers: HashMap::new(),
            merged_prompt: String::new(),
            merged_prompt_hash: String::new(),
            phase: "draft".to_string(),
            order: next_tab_order(&self.data),
            created_at: Utc::now().to_rfc3339(),
            session: None,
            transcript: None,
            startup_prompt_sent: false,
            color: None,
            kind: GITHUB_TAB_KIND.to_string(),
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
        self.data.tabs.push(record);
        let window_id = self.draft_window.clone();
        self.remember_active(&window_id, Some(tab_id.clone()));
        self.save()?;
        Ok(tab_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::state_types::AppStateFile;

    fn store() -> StateStore {
        StateStore {
            path: crate::test_support::temp_path("gh_tabs").join("state.json"),
            data: AppStateFile::default(),
            draft_window: crate::store::MAIN_WINDOW_ID.to_string(),
            new_tab_provider: crate::provider::ProviderId::DEFAULT,
        }
    }

    fn github_tabs(store: &StateStore, window: &str) -> usize {
        store
            .data
            .tabs
            .iter()
            .filter(|t| t.kind == GITHUB_TAB_KIND && window_matches(&t.window_id, window))
            .count()
    }

    #[test]
    fn opening_it_twice_focuses_the_existing_tab() {
        let mut store = store();
        let first = store.open_github_tab().unwrap();
        let other = store.create_preview_tab("http://localhost:3000").unwrap();
        assert_eq!(store.data.active_tab_id.as_deref(), Some(other.as_str()));
        let second = store.open_github_tab().unwrap();
        assert_eq!(first, second);
        assert_eq!(github_tabs(&store, crate::store::MAIN_WINDOW_ID), 1);
        assert_eq!(store.data.active_tab_id.as_deref(), Some(first.as_str()));
    }

    #[test]
    fn a_tab_has_no_role_or_session_and_is_its_own_kind() {
        let mut store = store();
        let id = store.open_github_tab().unwrap();
        let tab = store.tab_by_id(&id).unwrap();
        assert_eq!(tab.kind, "github");
        assert_eq!(tab.label, "GitHub");
        assert!(tab.session.is_none() && tab.role_id.is_empty());
    }

    #[test]
    fn each_window_gets_its_own() {
        let mut store = store();
        let main = store.open_github_tab().unwrap();
        store.draft_window = "win_two".to_string();
        let second = store.open_github_tab().unwrap();
        assert_ne!(main, second);
        assert_eq!(github_tabs(&store, "win_two"), 1);
        assert_eq!(github_tabs(&store, crate::store::MAIN_WINDOW_ID), 1);
        assert_eq!(store.open_github_tab().unwrap(), second);
    }

    #[test]
    fn reopening_a_closed_github_tab_never_duplicates_it() {
        let mut store = store();
        let first = store.open_github_tab().unwrap();
        store.close_tab(&first).unwrap();
        assert_eq!(github_tabs(&store, crate::store::MAIN_WINDOW_ID), 0);
        // Reopen with none open: it comes back.
        let back = store.reopen_closed_id(Some(&first), None).unwrap();
        assert_eq!(back.id, first);
        // Close it, open a new one, then reopen the closed one.
        store.close_tab(&first).unwrap();
        let fresh = store.open_github_tab().unwrap();
        let again = store.reopen_closed_id(Some(&first), None).unwrap();
        assert_eq!(again.id, fresh, "the open tab is focused instead");
        assert_eq!(github_tabs(&store, crate::store::MAIN_WINDOW_ID), 1);
        assert!(
            store.data.closed_tabs.iter().all(|t| t.id != first),
            "the closed record is dropped"
        );
        assert_eq!(store.data.active_tab_id.as_deref(), Some(fresh.as_str()));
    }

    fn workspace_tab(kind: &str, label: &str) -> crate::store::WorkspaceTab {
        crate::store::WorkspaceTab {
            label: label.to_string(),
            custom_label: false,
            role_id: String::new(),
            role_snapshot: RoleSnapshot {
                name: label.to_string(),
                template_version: 1,
                mode: "agent".to_string(),
                injection: String::new(),
            },
            cwd: String::new(),
            kind: kind.to_string(),
            terminal_launch: String::new(),
            color: None,
            model: None,
            answers: HashMap::new(),
            worktree: None,
            provider: None,
        }
    }

    fn workspace(
        tabs: Vec<crate::store::WorkspaceTab>,
        active_index: Option<usize>,
    ) -> crate::store::Workspace {
        crate::store::Workspace {
            id: "ws".into(),
            name: "ws".into(),
            saved_at: "now".into(),
            tabs,
            active_index,
            layout: None,
        }
    }

    #[test]
    fn a_workspace_brings_its_github_tab_back() {
        let mut store = store();
        let ws = workspace(
            vec![
                workspace_tab("preview", "Preview"),
                workspace_tab("github", "GitHub"),
            ],
            Some(1),
        );
        let ids = store.open_workspace(&ws, true).unwrap();
        assert_eq!(github_tabs(&store, crate::store::MAIN_WINDOW_ID), 1);
        assert_eq!(store.data.active_tab_id.as_deref(), Some(ids[1].as_str()));
        assert_eq!(store.tab_by_id(&ids[1]).unwrap().kind, "github");
    }

    #[test]
    fn opening_a_workspace_without_replace_keeps_one_github_tab() {
        let mut store = store();
        let existing = store.open_github_tab().unwrap();
        let ws = workspace(
            vec![
                workspace_tab("preview", "Preview"),
                workspace_tab("github", "GitHub"),
            ],
            Some(1),
        );
        let ids = store.open_workspace(&ws, false).unwrap();
        assert_eq!(github_tabs(&store, crate::store::MAIN_WINDOW_ID), 1);
        assert_eq!(
            ids[1], existing,
            "the skipped tab maps to the one already open"
        );
        assert_eq!(
            store.data.active_tab_id.as_deref(),
            Some(existing.as_str()),
            "active_index still resolves"
        );
    }

    #[test]
    fn a_workspace_with_two_github_tabs_opens_one() {
        let mut store = store();
        let ws = workspace(
            vec![
                workspace_tab("github", "GitHub"),
                workspace_tab("github", "GitHub 2"),
                workspace_tab("preview", "P"),
            ],
            Some(1),
        );
        let ids = store.open_workspace(&ws, true).unwrap();
        assert_eq!(github_tabs(&store, crate::store::MAIN_WINDOW_ID), 1);
        assert_eq!(ids[0], ids[1]);
        assert_eq!(store.data.active_tab_id.as_deref(), Some(ids[0].as_str()));
    }

    #[test]
    fn replacing_a_workspace_swaps_the_old_github_tab_for_the_new_one() {
        let mut store = store();
        let old = store.open_github_tab().unwrap();
        let ws = workspace(vec![workspace_tab("github", "GitHub")], Some(0));
        let ids = store.open_workspace(&ws, true).unwrap();
        assert_ne!(ids[0], old);
        assert_eq!(github_tabs(&store, crate::store::MAIN_WINDOW_ID), 1);
        assert!(store.tab_by_id(&old).is_none());
    }

    #[test]
    fn saving_a_github_tab_into_a_workspace_needs_no_role() {
        let ws = workspace(vec![workspace_tab("github", "GitHub")], Some(0));
        let (usable, skipped) = ws.with_current_roles(|_| None);
        assert_eq!(usable.tabs.len(), 1);
        assert!(skipped.is_empty());
        assert_eq!(usable.active_index, Some(0));
    }

    #[test]
    fn syncing_a_form_never_touches_a_github_tab() {
        let mut store = store();
        let id = store.open_github_tab().unwrap();
        let role: crate::roles::Role = serde_json::from_value(serde_json::json!({
            "id": "role_implementer", "name": "Implementer", "color": "#3fb950",
            "templateText": "Do [TASK]", "templateVersion": 1, "templateHash": "",
            "schemaTemplateHash": "", "defaultMode": "agent", "injection": "send_on_start",
            "isBuiltIn": true, "fields": []
        }))
        .unwrap();
        store
            .sync_tab_form(
                &id,
                &role,
                &HashMap::from([("x".into(), "y".into())]),
                "/tmp",
            )
            .unwrap();
        let tab = store.tab_by_id(&id).unwrap();
        assert!(tab.answers.is_empty());
        assert_eq!(tab.label, "GitHub");
    }
}
