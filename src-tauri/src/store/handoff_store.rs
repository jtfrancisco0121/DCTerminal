//! Planner hand-offs live in app data (`handoffs.json`), never in the
//! user's repo or `~/.cursor`. A plan that is too large for the JSON file
//! is attached beside it as `handoff-plans/<id>.txt`.

use crate::store::json_io::{read_json_or_recover, write_json_atomic};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const HANDOFF_SCHEMA_VERSION: u32 = 1;
/// Full text kept inside `handoffs.json`. Larger plans become a sidecar file.
pub const JSON_PLAN_CHARS: usize = 1_000_000;
/// Hard cap for a sidecar. The UI warns when this truncates.
pub const FILE_PLAN_CHARS: usize = 8_000_000;
pub const MAX_HANDOFFS: usize = 100;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HandoffRecord {
    pub id: String,
    pub created_at: String,
    pub source_tab_id: String,
    pub source_role_id: String,
    pub source_label: String,
    pub target_role_id: String,
    #[serde(default)]
    pub target_tab_id: Option<String>,
    pub title: String,
    pub cwd: String,
    pub scope: String,
    pub plan_text: String,
    pub truncated: bool,
    #[serde(default)]
    pub warning: Option<String>,
    #[serde(default)]
    pub plan_file: Option<String>,
    #[serde(default)]
    pub plan_field: Option<String>,
    /// Eagle-Eye position carried by this hand-off, if it stays on the chain.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chain: Option<crate::store::ChainRef>,
}

#[derive(Debug, Clone)]
pub struct NewHandoff {
    pub source_tab_id: String,
    pub source_role_id: String,
    pub source_label: String,
    pub target_role_id: String,
    pub title: String,
    pub cwd: String,
    pub scope: String,
    pub plan_text: String,
    pub truncated: bool,
    pub warning: Option<String>,
    pub plan_field: Option<String>,
    pub chain: Option<crate::store::ChainRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HandoffFile {
    pub schema_version: u32,
    #[serde(default)]
    pub handoffs: Vec<HandoffRecord>,
}

fn safe_plan_file_name(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".txt") else {
        return false;
    };
    !stem.is_empty()
        && stem.len() < 80
        && stem.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

impl Default for HandoffFile {
    fn default() -> Self {
        Self {
            schema_version: HANDOFF_SCHEMA_VERSION,
            handoffs: Vec::new(),
        }
    }
}

pub struct HandoffStore {
    pub path: PathBuf,
    pub plans_dir: PathBuf,
    pub data: HandoffFile,
}

impl HandoffStore {
    pub fn open(dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(dir).map_err(|e| format!("handoff dir: {e}"))?;
        let plans_dir = dir.join("handoff-plans");
        std::fs::create_dir_all(&plans_dir).map_err(|e| format!("handoff plans dir: {e}"))?;
        let path = dir.join("handoffs.json");
        let mut data = read_json_or_recover::<HandoffFile>(&path)?;
        if data.schema_version > HANDOFF_SCHEMA_VERSION {
            let _ = std::fs::rename(
                &path,
                path.with_extension(format!("json.corrupt-schema-{}", data.schema_version)),
            );
            data = HandoffFile::default();
        }
        data.schema_version = HANDOFF_SCHEMA_VERSION;
        Ok(Self {
            path,
            plans_dir,
            data,
        })
    }

    pub fn save(&self) -> Result<(), String> {
        write_json_atomic(&self.path, &self.data)
    }

    pub fn insert(&mut self, draft: NewHandoff) -> Result<HandoffRecord, String> {
        let id = new_handoff_id();
        let original_chars = char_len(&draft.plan_text);
        let mut truncated = draft.truncated;
        let mut warning = draft.warning;
        let mut plan_file = None;
        let plan_text = if original_chars > JSON_PLAN_CHARS {
            let file_body = take_chars(&draft.plan_text, FILE_PLAN_CHARS);
            let file_name = format!("{id}.txt");
            let file_path = self.plans_dir.join(&file_name);
            std::fs::write(&file_path, &file_body)
                .map_err(|e| format!("handoff plan file: {e}"))?;
            truncated = true;
            let note = if original_chars > FILE_PLAN_CHARS {
                format!(
                    "Full plan attached as {file_name} in app data and truncated to {FILE_PLAN_CHARS} characters."
                )
            } else {
                format!("Full plan attached as {file_name} in app data.")
            };
            warning = Some(join_warning(warning, &note));
            plan_file = Some(file_name);
            take_chars(&file_body, 8_000)
        } else {
            draft.plan_text
        };
        let record = HandoffRecord {
            id,
            created_at: Utc::now().to_rfc3339(),
            source_tab_id: draft.source_tab_id,
            source_role_id: draft.source_role_id,
            source_label: draft.source_label,
            target_role_id: draft.target_role_id,
            target_tab_id: None,
            title: draft.title,
            cwd: draft.cwd,
            scope: draft.scope,
            plan_text,
            truncated,
            warning,
            plan_file,
            plan_field: draft.plan_field,
            chain: draft.chain,
        };
        self.data.handoffs.push(record.clone());
        self.drop_oldest();
        self.save()?;
        Ok(record)
    }

    pub fn bind_target(&mut self, id: &str, tab_id: &str) -> Result<HandoffRecord, String> {
        let record = self
            .data
            .handoffs
            .iter_mut()
            .find(|item| item.id == id)
            .ok_or_else(|| format!("unknown hand-off: {id}"))?;
        record.target_tab_id = Some(tab_id.to_string());
        let stored = record.clone();
        self.save()?;
        Ok(stored)
    }

    pub fn list(&self) -> Vec<HandoffRecord> {
        let mut items = self.data.handoffs.clone();
        items.reverse();
        items
    }

    /// Returns the record with sidecar text folded back into `plan_text`.
    pub fn get(&self, id: &str) -> Result<Option<HandoffRecord>, String> {
        let Some(record) = self.data.handoffs.iter().find(|item| item.id == id) else {
            return Ok(None);
        };
        let mut hydrated = record.clone();
        if let Some(file_name) = &record.plan_file {
            if !safe_plan_file_name(file_name) {
                return Err(format!("refusing hand-off plan name: {file_name}"));
            }
            let path = self.plans_dir.join(file_name);
            if path.exists() {
                hydrated.plan_text = std::fs::read_to_string(&path)
                    .map_err(|e| format!("handoff plan file: {e}"))?;
            }
        }
        Ok(Some(hydrated))
    }

    pub fn for_target_tab(&self, tab_id: &str) -> Option<HandoffRecord> {
        self.data
            .handoffs
            .iter()
            .rev()
            .find(|item| item.target_tab_id.as_deref() == Some(tab_id))
            .cloned()
    }

    fn drop_oldest(&mut self) {
        while self.data.handoffs.len() > MAX_HANDOFFS {
            let old = self.data.handoffs.remove(0);
            if let Some(file_name) = old.plan_file {
                if safe_plan_file_name(&file_name) {
                    let _ = std::fs::remove_file(self.plans_dir.join(file_name));
                }
            }
        }
    }
}

fn join_warning(existing: Option<String>, note: &str) -> String {
    match existing {
        Some(text) if !text.trim().is_empty() => format!("{text} {note}"),
        _ => note.to_string(),
    }
}

fn char_len(text: &str) -> usize {
    text.chars().count()
}

fn take_chars(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

fn new_handoff_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("handoff_{nanos}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let path = crate::test_support::test_root().join(format!("dcterminal_handoff_{nanos}"));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    fn draft(plan: &str) -> NewHandoff {
        NewHandoff {
            source_tab_id: "tab_planner".into(),
            source_role_id: "role_planner".into(),
            source_label: "Planner · Login".into(),
            target_role_id: "role_implementer".into(),
            title: "Login 500".into(),
            cwd: r"C:\Repos\Demo".into(),
            scope: "plan_and_todos".into(),
            plan_text: plan.into(),
            truncated: false,
            warning: None,
            plan_field: Some("approvedPlan".into()),
            chain: None,
        }
    }

    #[test]
    fn handoff_survives_reopen_and_remembers_its_target_tab() {
        let path = dir();
        let id = {
            let mut store = HandoffStore::open(&path).unwrap();
            let saved = store.insert(draft("Check the token path.")).unwrap();
            let bound = store.bind_target(&saved.id, "tab_impl").unwrap();
            assert_eq!(bound.target_tab_id.as_deref(), Some("tab_impl"));
            assert!(!saved.created_at.is_empty());
            saved.id
        };
        let store = HandoffStore::open(&path).unwrap();
        let loaded = store.get(&id).unwrap().expect("saved hand-off");
        assert_eq!(loaded.plan_text, "Check the token path.");
        assert_eq!(loaded.source_tab_id, "tab_planner");
        assert_eq!(loaded.cwd, r"C:\Repos\Demo");
        assert_eq!(loaded.target_tab_id.as_deref(), Some("tab_impl"));
        assert_eq!(loaded.title, "Login 500");
        assert!(store.for_target_tab("tab_impl").is_some());
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn long_plan_is_attached_as_a_file_and_reloaded_in_full() {
        let path = dir();
        let plan = "p".repeat(JSON_PLAN_CHARS + 25);
        let mut store = HandoffStore::open(&path).unwrap();
        let saved = store.insert(draft(&plan)).unwrap();
        assert!(saved.truncated);
        assert!(saved.warning.unwrap_or_default().contains("app data"));
        assert!(saved.plan_text.chars().count() <= 8_000);
        let file_name = saved.plan_file.clone().expect("sidecar");
        assert!(store.plans_dir.join(&file_name).is_file());
        let hydrated = store.get(&saved.id).unwrap().unwrap();
        assert_eq!(hydrated.plan_text, plan);
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn file_cap_truncates_with_a_warning() {
        let path = dir();
        let plan = "q".repeat(FILE_PLAN_CHARS + 10);
        let mut store = HandoffStore::open(&path).unwrap();
        let saved = store.insert(draft(&plan)).unwrap();
        let hydrated = store.get(&saved.id).unwrap().unwrap();
        assert_eq!(hydrated.plan_text.chars().count(), FILE_PLAN_CHARS);
        assert!(hydrated.warning.unwrap_or_default().contains("truncated"));
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn keeps_the_newest_handoffs_and_drops_old_sidecars() {
        let path = dir();
        let mut store = HandoffStore::open(&path).unwrap();
        let mut first_file = None;
        for index in 0..(MAX_HANDOFFS + 1) {
            let mut item = draft("short");
            if index == 0 {
                item.plan_text = "z".repeat(JSON_PLAN_CHARS + 1);
            }
            item.title = format!("Plan {index}");
            let saved = store.insert(item).unwrap();
            if index == 0 {
                first_file = saved.plan_file.clone();
            }
        }
        assert_eq!(store.data.handoffs.len(), MAX_HANDOFFS);
        assert_eq!(store.list()[0].title, format!("Plan {}", MAX_HANDOFFS));
        let file_name = first_file.expect("first sidecar");
        assert!(!store.plans_dir.join(file_name).exists());
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn corrupt_file_does_not_block_open() {
        let path = dir();
        std::fs::write(path.join("handoffs.json"), b"{not json").unwrap();
        let store = HandoffStore::open(&path).unwrap();
        assert!(store.data.handoffs.is_empty());
        assert!(store.get("missing").unwrap().is_none());
        let _ = std::fs::remove_dir_all(path);
    }
}
