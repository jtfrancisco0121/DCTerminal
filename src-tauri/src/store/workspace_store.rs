//! F7 workspaces (`workspaces.json` in DCTerminal's app data): named sets of
//! tabs (title, folder, role, kind). Adapted from ADE's workspace presets.
//! Never written to a repo or `~/.cursor`.

use crate::store::json_io::{read_json_or_recover, write_json_atomic};
use crate::store::state_types::{LayoutState, RoleSnapshot, TabRecord};
use crate::worktree::WorktreeRef;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const WORKSPACES_SCHEMA_VERSION: u32 = 1;
pub const WORKSPACES_FILE: &str = "workspaces.json";
pub const MAX_WORKSPACES: usize = 100;
pub const MAX_WORKSPACE_TABS: usize = 50;
pub const MAX_WORKSPACE_NAME_CHARS: usize = 80;

/// One tab of a workspace: enough to rebuild it, never a live session.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTab {
    pub label: String,
    #[serde(default)]
    pub custom_label: bool,
    pub role_id: String,
    pub role_snapshot: RoleSnapshot,
    pub cwd: String,
    /// `role` (chat) or `terminal`.
    pub kind: String,
    /// `shell`, `cursor-cli`, or `role` on terminal tabs.
    #[serde(default)]
    pub terminal_launch: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    /// Startup form answers of a chat tab (title, task, folder...).
    #[serde(default)]
    pub answers: HashMap<String, String>,
    #[serde(default)]
    pub worktree: Option<WorktreeRef>,
    /// Provider of the tab when saved. `None` on workspaces saved before
    /// providers existed (resolves to Cursor until Task 6.3).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<crate::provider::ProviderId>,
}

impl WorkspaceTab {
    pub fn from_record(tab: &TabRecord) -> Self {
        let mut answers = tab.answers.clone();
        // A workspace is a layout, not a session: never resume a specific chat.
        answers.remove("resumeSessionId");
        Self {
            label: tab.label.clone(),
            custom_label: tab.custom_label,
            role_id: tab.role_id.clone(),
            role_snapshot: tab.role_snapshot.clone(),
            cwd: tab.cwd.clone(),
            kind: tab.kind.clone(),
            terminal_launch: tab.terminal_launch.clone(),
            color: tab.color.clone(),
            model: tab.model.clone(),
            answers,
            worktree: tab.worktree.clone(),
            provider: tab.provider,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub saved_at: String,
    pub tabs: Vec<WorkspaceTab>,
    /// Index into `tabs` of the tab that was active when saved.
    #[serde(default)]
    pub active_index: Option<usize>,
    /// Split view and file panel when the workspace was saved.
    #[serde(default)]
    pub layout: Option<LayoutState>,
}

impl Workspace {
    /// Tabs whose role still exists, with a fresh role snapshot. Chat tabs and
    /// role terminals need their role; shells and Cursor CLI tabs do not.
    /// Returns the usable workspace and the labels of tabs that were left out.
    pub fn with_current_roles(
        &self,
        role_for: impl Fn(&str) -> Option<RoleSnapshot>,
    ) -> (Workspace, Vec<String>) {
        let mut kept = Vec::new();
        let mut skipped = Vec::new();
        let mut active_index = None;
        for (i, tab) in self.tabs.iter().enumerate() {
            let needs_role = tab.kind != "terminal" || tab.terminal_launch == "role";
            let mut tab = tab.clone();
            match role_for(&tab.role_id) {
                Some(snapshot) => tab.role_snapshot = snapshot,
                None if needs_role => {
                    skipped.push(tab.label.clone());
                    continue;
                }
                None => {}
            }
            if self.active_index == Some(i) {
                active_index = Some(kept.len());
            }
            kept.push(tab);
        }
        let usable = Workspace {
            tabs: kept,
            active_index,
            ..self.clone()
        };
        (usable, skipped)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacesFile {
    pub schema_version: u32,
    #[serde(default)]
    pub workspaces: Vec<Workspace>,
}

impl Default for WorkspacesFile {
    fn default() -> Self {
        Self {
            schema_version: WORKSPACES_SCHEMA_VERSION,
            workspaces: Vec::new(),
        }
    }
}

pub struct WorkspaceStore {
    pub path: PathBuf,
    pub data: WorkspacesFile,
}

impl WorkspaceStore {
    pub fn open(dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(dir).map_err(|e| format!("workspaces dir: {e}"))?;
        let path = dir.join(WORKSPACES_FILE);
        let mut data = read_json_or_recover::<WorkspacesFile>(&path)?;
        if data.schema_version > WORKSPACES_SCHEMA_VERSION {
            let _ = std::fs::rename(
                &path,
                path.with_extension(format!("json.corrupt-schema-{}", data.schema_version)),
            );
            data = WorkspacesFile::default();
        }
        data.schema_version = WORKSPACES_SCHEMA_VERSION;
        Ok(Self { path, data })
    }

    pub fn save(&self) -> Result<(), String> {
        write_json_atomic(&self.path, &self.data)
    }

    /// Save a named set of tabs. A name already in use (any case) is an error
    /// unless `replace`, which overwrites that workspace and keeps its id.
    pub fn save_workspace(
        &mut self,
        name: &str,
        mut tabs: Vec<WorkspaceTab>,
        active_index: Option<usize>,
        layout: Option<LayoutState>,
        replace: bool,
        now: &str,
    ) -> Result<Workspace, String> {
        let name: String = name.trim().chars().take(MAX_WORKSPACE_NAME_CHARS).collect();
        if name.is_empty() {
            return Err("Give the workspace a name.".into());
        }
        if tabs.is_empty() {
            return Err("There are no tabs to save.".into());
        }
        tabs.truncate(MAX_WORKSPACE_TABS);
        let active_index = active_index.filter(|i| *i < tabs.len());
        let folded = name.to_lowercase();
        if let Some(existing) = self
            .data
            .workspaces
            .iter_mut()
            .find(|w| w.name.to_lowercase() == folded)
        {
            if !replace {
                return Err(format!(
                    "A workspace named \"{}\" already exists.",
                    existing.name
                ));
            }
            existing.name = name;
            existing.tabs = tabs;
            existing.active_index = active_index;
            existing.layout = layout;
            existing.saved_at = now.to_string();
            return Ok(existing.clone());
        }
        if self.data.workspaces.len() >= MAX_WORKSPACES {
            return Err(format!(
                "There are already {MAX_WORKSPACES} workspaces. Delete one first."
            ));
        }
        let workspace = Workspace {
            id: self.new_id(),
            name,
            saved_at: now.to_string(),
            tabs,
            active_index,
            layout,
        };
        self.data.workspaces.push(workspace.clone());
        Ok(workspace)
    }

    pub fn delete(&mut self, id: &str) -> Result<(), String> {
        let before = self.data.workspaces.len();
        self.data.workspaces.retain(|w| w.id != id);
        if self.data.workspaces.len() == before {
            return Err("That workspace is no longer saved.".into());
        }
        Ok(())
    }

    pub fn get(&self, id: &str) -> Option<&Workspace> {
        self.data.workspaces.iter().find(|w| w.id == id)
    }

    /// Newest first.
    pub fn list(&self) -> Vec<Workspace> {
        let mut items = self.data.workspaces.clone();
        items.sort_by(|a, b| b.saved_at.cmp(&a.saved_at).then_with(|| b.id.cmp(&a.id)));
        items
    }

    fn new_id(&self) -> String {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let mut id = format!("ws_{nanos}");
        let mut n = 1;
        while self.data.workspaces.iter().any(|w| w.id == id) {
            id = format!("ws_{nanos}_{n}");
            n += 1;
        }
        id
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("dcterminal_workspaces_{nanos}"));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    pub(crate) fn tab(label: &str, role: &str, cwd: &str, kind: &str) -> WorkspaceTab {
        WorkspaceTab {
            label: label.into(),
            custom_label: false,
            role_id: role.into(),
            role_snapshot: RoleSnapshot {
                name: "Developer".into(),
                template_version: 1,
                mode: "agent".into(),
                injection: "send_on_start".into(),
            },
            cwd: cwd.into(),
            kind: kind.into(),
            terminal_launch: if kind == "terminal" {
                "shell".into()
            } else {
                String::new()
            },
            color: Some("#3fb950".into()),
            model: None,
            answers: HashMap::from([("cwd".to_string(), cwd.to_string())]),
            worktree: None,
            provider: None,
        }
    }

    const T0: &str = "2026-10-06T00:00:00Z";
    const T1: &str = "2026-10-06T01:00:00Z";

    #[test]
    fn a_saved_workspace_survives_a_restart_in_app_data() {
        let dir = dir();
        let mut store = WorkspaceStore::open(&dir).unwrap();
        assert_eq!(store.path, dir.join(WORKSPACES_FILE));
        let tabs = vec![
            tab("Planner · Koneksi", "role_planner", "/w/Koneksi", "role"),
            tab("Shell · api", "", "/w/api", "terminal"),
        ];
        let saved = store
            .save_workspace("  Koneksi day  ", tabs.clone(), Some(1), None, false, T0)
            .unwrap();
        assert_eq!(saved.name, "Koneksi day");
        store.save().unwrap();

        let reopened = WorkspaceStore::open(&dir).unwrap();
        let list = reopened.list();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, saved.id);
        assert_eq!(list[0].tabs, tabs);
        assert_eq!(list[0].active_index, Some(1));
        assert!(reopened.get(&saved.id).is_some());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn names_are_unique_unless_replacing_which_keeps_the_id() {
        let dir = dir();
        let mut store = WorkspaceStore::open(&dir).unwrap();
        let one = vec![tab("A", "role_dev", "/a", "role")];
        let two = vec![tab("B", "role_dev", "/b", "role")];
        assert!(store
            .save_workspace("  ", one.clone(), None, None, false, T0)
            .is_err());
        assert!(store
            .save_workspace("Empty", vec![], None, None, false, T0)
            .is_err());
        let first = store.save_workspace("Daily", one, None, None, false, T0).unwrap();
        let err = store
            .save_workspace("daily", two.clone(), None, None, false, T1)
            .unwrap_err();
        assert!(err.contains("already"), "{err}");
        let replaced = store
            .save_workspace("DAILY", two, Some(0), None, true, T1)
            .unwrap();
        assert_eq!(replaced.id, first.id);
        assert_eq!(replaced.name, "DAILY");
        assert_eq!(replaced.saved_at, T1);
        assert_eq!(store.list().len(), 1);
        assert_eq!(store.list()[0].tabs[0].label, "B");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn lists_newest_first_deletes_and_caps_tabs_and_bad_active_index() {
        let dir = dir();
        let mut store = WorkspaceStore::open(&dir).unwrap();
        store
            .save_workspace("Old", vec![tab("A", "r", "/a", "role")], None, None, false, T0)
            .unwrap();
        let many: Vec<_> = (0..MAX_WORKSPACE_TABS + 5)
            .map(|i| tab(&format!("T{i}"), "r", "/x", "role"))
            .collect();
        let new = store
            .save_workspace("New", many, Some(999), None, false, T1)
            .unwrap();
        assert_eq!(new.tabs.len(), MAX_WORKSPACE_TABS);
        assert_eq!(new.active_index, None);
        let names: Vec<_> = store.list().into_iter().map(|w| w.name).collect();
        assert_eq!(names, vec!["New", "Old"]);
        store.delete(&new.id).unwrap();
        assert!(store.delete(&new.id).is_err());
        assert_eq!(store.list().len(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_workspace_tab_never_carries_a_resume_id() {
        let mut record_answers = HashMap::new();
        record_answers.insert("cwd".to_string(), "/w".to_string());
        record_answers.insert("resumeSessionId".to_string(), "abc".to_string());
        let mut source = tab("CLI", "", "/w", "terminal");
        source.answers = record_answers;
        let json = serde_json::json!({
            "id": "tab_1", "label": "CLI", "roleId": "", "roleSnapshot": source.role_snapshot,
            "cwd": "/w", "answers": source.answers, "mergedPrompt": "", "mergedPromptHash": "",
            "phase": "terminal", "order": 1, "createdAt": T0, "kind": "terminal",
            "terminalLaunch": "cursor-cli", "customLabel": true
        });
        let record: TabRecord = serde_json::from_value(json).unwrap();
        let saved = WorkspaceTab::from_record(&record);
        assert!(!saved.answers.contains_key("resumeSessionId"));
        assert_eq!(saved.terminal_launch, "cursor-cli");
        assert!(saved.custom_label);
    }

    #[test]
    fn corrupt_or_newer_files_do_not_block_open() {
        let dir = dir();
        std::fs::write(dir.join(WORKSPACES_FILE), b"{nope").unwrap();
        assert!(WorkspaceStore::open(&dir).unwrap().list().is_empty());
        std::fs::write(
            dir.join(WORKSPACES_FILE),
            br#"{"schemaVersion":7,"workspaces":[]}"#,
        )
        .unwrap();
        let store = WorkspaceStore::open(&dir).unwrap();
        assert_eq!(store.data.schema_version, WORKSPACES_SCHEMA_VERSION);
        assert!(dir.join("workspaces.json.corrupt-schema-7").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn tabs_whose_role_is_gone_are_skipped_but_shells_are_kept() {
        let mut role_term = tab("Planner term", "role_gone", "/p", "terminal");
        role_term.terminal_launch = "role".into();
        let ws = Workspace {
            id: "ws".into(),
            name: "W".into(),
            saved_at: T0.into(),
            tabs: vec![
                tab("Gone chat", "role_gone", "/a", "role"),
                tab("Dev chat", "role_dev", "/b", "role"),
                role_term,
                tab("Shell", "", "/c", "terminal"),
            ],
            active_index: Some(3),
            layout: None,
        };
        let fresh = RoleSnapshot {
            name: "Developer".into(),
            template_version: 9,
            mode: "agent".into(),
            injection: "send_on_start".into(),
        };
        let (usable, skipped) =
            ws.with_current_roles(|id| (id == "role_dev").then(|| fresh.clone()));
        assert_eq!(skipped, vec!["Gone chat", "Planner term"]);
        let labels: Vec<_> = usable.tabs.iter().map(|t| t.label.as_str()).collect();
        assert_eq!(labels, vec!["Dev chat", "Shell"]);
        assert_eq!(usable.tabs[0].role_snapshot.template_version, 9);
        assert_eq!(usable.active_index, Some(1));
    }
}
