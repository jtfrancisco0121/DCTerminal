//! Localhost preview tabs: a dev server on this machine shown in an iframe.
//! The address is kept in the tab's `answers["url"]`. Only `http://localhost`
//! and `http://127.0.0.1` addresses are saved; the UI opens anything else in
//! the browser.

use super::state_store::{new_tab_id, next_tab_order};
use crate::store::state_types::{RoleSnapshot, TabRecord};
use crate::store::StateStore;
use chrono::Utc;
use std::collections::HashMap;

pub const PREVIEW_TAB_KIND: &str = "preview";
pub const DEFAULT_PREVIEW_URL: &str = "http://localhost:5173";
const URL_KEY: &str = "url";
const MAX_URL_LEN: usize = 2048;

/// The address as saved, or None when it is not a plain-http localhost
/// address. Mirrors `isLocalPreviewUrl` in `src/preview/previewUrl.ts`.
pub fn local_preview_url(input: &str) -> Option<String> {
    let url = input.trim();
    if url.len() > MAX_URL_LEN || url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return None;
    }
    let lower = url.to_ascii_lowercase();
    let rest = ["http://localhost", "http://127.0.0.1"]
        .iter()
        .find_map(|host| lower.strip_prefix(host))?;
    let rest = match rest.strip_prefix(':') {
        Some(after) => {
            let digits = after.len() - after.trim_start_matches(|c: char| c.is_ascii_digit()).len();
            let port: u32 = after[..digits].parse().ok()?;
            if digits > 5 || port == 0 || port > 65_535 {
                return None;
            }
            &after[digits..]
        }
        None => rest,
    };
    // Anything else after the host (".evil.com", "@evil.com") is another host.
    if !(rest.is_empty() || rest.starts_with(['/', '?', '#'])) {
        return None;
    }
    Some(url.to_string())
}

/// A preview tab's address (the default when none was saved).
pub fn preview_url_of(tab: &TabRecord) -> Option<String> {
    (tab.kind == PREVIEW_TAB_KIND).then(|| {
        tab.answers
            .get(URL_KEY)
            .cloned()
            .unwrap_or_else(|| DEFAULT_PREVIEW_URL.to_string())
    })
}

fn preview_label(url: &str) -> String {
    let host = url
        .split_once("://")
        .map_or(url, |(_, rest)| rest)
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default();
    format!("Preview · {host}")
}

impl StateStore {
    /// Opens a new preview tab in the window in focus and makes it active.
    pub fn create_preview_tab(&mut self, url: &str) -> Result<String, String> {
        let url = local_preview_url(url).ok_or_else(|| {
            "Preview tabs open http://localhost and http://127.0.0.1 addresses only.".to_string()
        })?;
        let tab_id = new_tab_id();
        let record = TabRecord {
            id: tab_id.clone(),
            label: preview_label(&url),
            role_id: String::new(),
            role_snapshot: RoleSnapshot {
                name: "Preview".to_string(),
                template_version: 1,
                mode: "agent".to_string(),
                injection: String::new(),
            },
            cwd: String::new(),
            answers: HashMap::from([(URL_KEY.to_string(), url)]),
            merged_prompt: String::new(),
            merged_prompt_hash: String::new(),
            phase: "draft".to_string(),
            order: next_tab_order(&self.data),
            created_at: Utc::now().to_rfc3339(),
            session: None,
            transcript: None,
            startup_prompt_sent: false,
            color: None,
            kind: PREVIEW_TAB_KIND.to_string(),
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

    /// Saves the address a preview tab shows (and its label, unless renamed).
    pub fn set_preview_url(&mut self, tab_id: &str, url: &str) -> Result<(), String> {
        let url = local_preview_url(url).ok_or_else(|| {
            "Preview tabs open http://localhost and http://127.0.0.1 addresses only.".to_string()
        })?;
        let tab = self
            .data
            .tabs
            .iter_mut()
            .find(|t| t.id == tab_id && t.kind == PREVIEW_TAB_KIND)
            .ok_or_else(|| format!("unknown preview tab: {tab_id}"))?;
        if !tab.custom_label {
            tab.label = preview_label(&url);
        }
        tab.answers.insert(URL_KEY.to_string(), url);
        self.save()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::state_types::AppStateFile;

    #[test]
    fn only_plain_http_localhost_addresses_pass() {
        for ok in [
            "http://localhost",
            "http://localhost:5173",
            "http://localhost:5173/",
            "http://127.0.0.1:8080/app?x=1#top",
            "HTTP://LOCALHOST:3000/Path",
            "  http://localhost:1  ",
        ] {
            assert!(local_preview_url(ok).is_some(), "{ok}");
        }
        for bad in [
            "https://localhost:5173",
            "http://localhost.evil.com",
            "http://localhost:80@evil.com",
            "http://localhost@evil.com",
            "http://127.0.0.10:80",
            "http://localhost:99999",
            "http://localhost:0",
            "http://localhost:",
            "http://example.com",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "http://localhost:5173/a b",
            "",
        ] {
            assert!(local_preview_url(bad).is_none(), "{bad}");
        }
        assert_eq!(
            local_preview_url(" http://localhost:3000 ").as_deref(),
            Some("http://localhost:3000")
        );
    }

    #[test]
    fn a_preview_tab_keeps_its_address() {
        let dir = crate::test_support::test_root().join(format!(
            "dcterminal_preview_{}",
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let mut store = StateStore {
            path: dir.join("state.json"),
            data: AppStateFile::default(),
            new_tab_provider: crate::provider::ProviderId::DEFAULT,
            draft_window: crate::store::MAIN_WINDOW_ID.to_string(),
        };
        assert!(store.create_preview_tab("https://example.com").is_err());
        let id = store.create_preview_tab("http://localhost:5173").unwrap();
        let tab = store.tab_by_id(&id).unwrap();
        assert_eq!(tab.kind, PREVIEW_TAB_KIND);
        assert_eq!(tab.label, "Preview · localhost:5173");
        assert_eq!(
            preview_url_of(tab).as_deref(),
            Some("http://localhost:5173")
        );
        store
            .set_preview_url(&id, "http://127.0.0.1:3000/docs")
            .unwrap();
        let tab = store.tab_by_id(&id).unwrap();
        assert_eq!(tab.label, "Preview · 127.0.0.1:3000");
        assert_eq!(
            preview_url_of(tab).as_deref(),
            Some("http://127.0.0.1:3000/docs")
        );
        assert!(store.set_preview_url(&id, "http://evil.com").is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}
