//! F6 prompt library (`prompts.json` in DCTerminal's app data): named
//! prompts and the most recent sends. Never written to a repo or `~/.cursor`.

use crate::store::json_io::{read_json_or_recover, write_json_atomic};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const PROMPTS_SCHEMA_VERSION: u32 = 1;
pub const PROMPTS_FILE: &str = "prompts.json";
pub const MAX_PROMPTS: usize = 500;
pub const MAX_RECENT: usize = 50;
pub const MAX_PROMPT_CHARS: usize = 200_000;
pub const MAX_NAME_CHARS: usize = 120;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SavedPrompt {
    pub id: String,
    pub name: String,
    pub body: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub last_used_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecentSend {
    pub text: String,
    pub sent_at: String,
    /// "chat" or "terminal".
    #[serde(default)]
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PromptsFile {
    pub schema_version: u32,
    #[serde(default)]
    pub prompts: Vec<SavedPrompt>,
    #[serde(default)]
    pub recent: Vec<RecentSend>,
}

impl Default for PromptsFile {
    fn default() -> Self {
        Self {
            schema_version: PROMPTS_SCHEMA_VERSION,
            prompts: Vec::new(),
            recent: Vec::new(),
        }
    }
}

pub struct PromptStore {
    pub path: PathBuf,
    pub data: PromptsFile,
}

impl PromptStore {
    pub fn open(dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(dir).map_err(|e| format!("prompt library dir: {e}"))?;
        let path = dir.join(PROMPTS_FILE);
        let mut data = read_json_or_recover::<PromptsFile>(&path)?;
        if data.schema_version > PROMPTS_SCHEMA_VERSION {
            let _ = std::fs::rename(
                &path,
                path.with_extension(format!("json.corrupt-schema-{}", data.schema_version)),
            );
            data = PromptsFile::default();
        }
        data.schema_version = PROMPTS_SCHEMA_VERSION;
        Ok(Self { path, data })
    }

    pub fn save(&self) -> Result<(), String> {
        write_json_atomic(&self.path, &self.data)
    }

    /// Create a prompt (`id` None) or edit one. Names are trimmed and unique
    /// (case-insensitive), so a save never silently replaces another prompt.
    pub fn save_prompt(
        &mut self,
        id: Option<&str>,
        name: &str,
        body: &str,
        now: &str,
    ) -> Result<SavedPrompt, String> {
        let name = take_chars(name.trim(), MAX_NAME_CHARS);
        if name.is_empty() {
            return Err("Give the prompt a name.".into());
        }
        if body.trim().is_empty() {
            return Err("The prompt is empty.".into());
        }
        let body = take_chars(body, MAX_PROMPT_CHARS);
        let folded = name.to_lowercase();
        if let Some(clash) = self
            .data
            .prompts
            .iter()
            .find(|p| p.name.to_lowercase() == folded && Some(p.id.as_str()) != id)
        {
            return Err(format!("A prompt named \"{}\" already exists.", clash.name));
        }
        if let Some(id) = id {
            let prompt = self
                .data
                .prompts
                .iter_mut()
                .find(|p| p.id == id)
                .ok_or_else(|| "That prompt is no longer in the library.".to_string())?;
            prompt.name = name;
            prompt.body = body;
            prompt.updated_at = now.to_string();
            return Ok(prompt.clone());
        }
        if self.data.prompts.len() >= MAX_PROMPTS {
            return Err(format!(
                "The library is full ({MAX_PROMPTS} prompts). Delete one first."
            ));
        }
        let prompt = SavedPrompt {
            id: self.new_id(),
            name,
            body,
            created_at: now.to_string(),
            updated_at: now.to_string(),
            last_used_at: None,
        };
        self.data.prompts.push(prompt.clone());
        Ok(prompt)
    }

    pub fn delete_prompt(&mut self, id: &str) -> Result<(), String> {
        let before = self.data.prompts.len();
        self.data.prompts.retain(|p| p.id != id);
        if self.data.prompts.len() == before {
            return Err("That prompt is no longer in the library.".into());
        }
        Ok(())
    }

    pub fn mark_used(&mut self, id: &str, now: &str) -> Result<(), String> {
        let prompt = self
            .data
            .prompts
            .iter_mut()
            .find(|p| p.id == id)
            .ok_or_else(|| "That prompt is no longer in the library.".to_string())?;
        prompt.last_used_at = Some(now.to_string());
        Ok(())
    }

    /// Remember a sent prompt. The same text moves to the front instead of
    /// repeating. Returns false for blank text (nothing stored).
    pub fn record_send(&mut self, text: &str, source: &str, now: &str) -> bool {
        let text = take_chars(text.trim(), MAX_PROMPT_CHARS);
        if text.is_empty() {
            return false;
        }
        self.data.recent.retain(|r| r.text != text);
        self.data.recent.insert(
            0,
            RecentSend {
                text,
                sent_at: now.to_string(),
                source: source.to_string(),
            },
        );
        self.data.recent.truncate(MAX_RECENT);
        true
    }

    pub fn clear_recent(&mut self) {
        self.data.recent.clear();
    }

    /// Saved prompts sorted by name, recent sends newest first.
    pub fn snapshot(&self) -> (Vec<SavedPrompt>, Vec<RecentSend>) {
        let mut prompts = self.data.prompts.clone();
        prompts.sort_by(|a, b| {
            a.name
                .to_lowercase()
                .cmp(&b.name.to_lowercase())
                .then_with(|| a.id.cmp(&b.id))
        });
        (prompts, self.data.recent.clone())
    }

    fn new_id(&self) -> String {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let mut id = format!("prompt_{nanos}");
        let mut n = 1;
        while self.data.prompts.iter().any(|p| p.id == id) {
            id = format!("prompt_{nanos}_{n}");
            n += 1;
        }
        id
    }
}

fn take_chars(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let path = crate::test_support::test_root().join(format!("dcterminal_prompts_{nanos}"));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    const T0: &str = "2026-10-06T00:00:00Z";
    const T1: &str = "2026-10-06T01:00:00Z";

    #[test]
    fn saved_prompts_and_recent_sends_survive_a_restart_in_app_data() {
        let dir = dir();
        let mut store = PromptStore::open(&dir).unwrap();
        assert_eq!(store.path, dir.join(PROMPTS_FILE));
        let saved = store
            .save_prompt(None, "  Review diff  ", "Review the diff.\nList risks.", T0)
            .unwrap();
        assert_eq!(saved.name, "Review diff");
        assert!(store.record_send("  fix the login bug ", "chat", T0));
        store.save().unwrap();

        let reopened = PromptStore::open(&dir).unwrap();
        let (prompts, recent) = reopened.snapshot();
        assert_eq!(prompts.len(), 1);
        assert_eq!(prompts[0].id, saved.id);
        assert_eq!(prompts[0].body, "Review the diff.\nList risks.");
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].text, "fix the login bug");
        assert_eq!(recent[0].source, "chat");
        let names: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert!(names.contains(&PROMPTS_FILE.to_string()));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn names_are_required_unique_and_editing_keeps_the_id() {
        let dir = dir();
        let mut store = PromptStore::open(&dir).unwrap();
        assert!(store.save_prompt(None, "   ", "body", T0).is_err());
        assert!(store.save_prompt(None, "Name", "  \n ", T0).is_err());
        let first = store.save_prompt(None, "Plan", "one", T0).unwrap();
        let err = store.save_prompt(None, "plan", "two", T1).unwrap_err();
        assert!(err.contains("already"), "{err}");
        let edited = store
            .save_prompt(Some(&first.id), "Plan v2", "two", T1)
            .unwrap();
        assert_eq!(edited.id, first.id);
        assert_eq!(edited.created_at, T0);
        assert_eq!(edited.updated_at, T1);
        // Renaming to its own name (different case) is fine.
        store
            .save_prompt(Some(&first.id), "PLAN V2", "two", T1)
            .unwrap();
        assert!(store
            .save_prompt(Some("prompt_missing"), "X", "y", T1)
            .is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn prompts_sort_by_name_and_can_be_deleted_and_marked_used() {
        let dir = dir();
        let mut store = PromptStore::open(&dir).unwrap();
        let b = store.save_prompt(None, "beta", "b", T0).unwrap();
        store.save_prompt(None, "Alpha", "a", T0).unwrap();
        store.mark_used(&b.id, T1).unwrap();
        let (prompts, _) = store.snapshot();
        let names: Vec<_> = prompts.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, vec!["Alpha", "beta"]);
        assert_eq!(prompts[1].last_used_at.as_deref(), Some(T1));
        store.delete_prompt(&b.id).unwrap();
        assert_eq!(store.snapshot().0.len(), 1);
        assert!(store.delete_prompt(&b.id).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn recent_sends_dedupe_to_the_front_cap_and_clear() {
        let dir = dir();
        let mut store = PromptStore::open(&dir).unwrap();
        assert!(!store.record_send("   ", "chat", T0));
        for i in 0..(MAX_RECENT + 5) {
            store.record_send(&format!("send {i}"), "terminal", T0);
        }
        store.record_send("send 3", "chat", T1);
        let (_, recent) = store.snapshot();
        assert_eq!(recent.len(), MAX_RECENT);
        assert_eq!(recent[0].text, "send 3");
        assert_eq!(recent[0].sent_at, T1);
        assert_eq!(recent.iter().filter(|r| r.text == "send 3").count(), 1);
        store.clear_recent();
        assert!(store.snapshot().1.is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn huge_bodies_are_capped_and_a_corrupt_file_does_not_block_open() {
        let dir = dir();
        let mut store = PromptStore::open(&dir).unwrap();
        let huge = "é".repeat(MAX_PROMPT_CHARS + 3);
        let long_name = "n".repeat(MAX_NAME_CHARS + 3);
        let saved = store.save_prompt(None, &long_name, &huge, T0).unwrap();
        assert_eq!(saved.body.chars().count(), MAX_PROMPT_CHARS);
        assert_eq!(saved.name.chars().count(), MAX_NAME_CHARS);
        store.record_send(&huge, "chat", T0);
        assert_eq!(store.snapshot().1[0].text.chars().count(), MAX_PROMPT_CHARS);

        std::fs::write(dir.join(PROMPTS_FILE), b"{oops").unwrap();
        let recovered = PromptStore::open(&dir).unwrap();
        assert!(recovered.snapshot().0.is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_newer_schema_is_set_aside_not_overwritten() {
        let dir = dir();
        let path = dir.join(PROMPTS_FILE);
        std::fs::write(&path, br#"{"schemaVersion":99,"prompts":[],"recent":[]}"#).unwrap();
        let store = PromptStore::open(&dir).unwrap();
        assert_eq!(store.data.schema_version, PROMPTS_SCHEMA_VERSION);
        assert!(dir.join("prompts.json.corrupt-schema-99").exists());
        let _ = std::fs::remove_dir_all(dir);
    }
}
