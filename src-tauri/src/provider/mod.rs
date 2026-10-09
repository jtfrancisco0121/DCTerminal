//! Agent providers (Claude-first plan, Phase 2).
//!
//! A provider is the CLI behind a tab: Claude Code (`claude`, and
//! `claude-agent-acp` for chat) or the Cursor CLI (`agent`). This module holds
//! the provider id that tabs, workspaces, and settings store. Tabs saved before
//! providers existed have no id; they resolve to Cursor until the one-time
//! migration (plan Task 6.3) moves them to Claude.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderId {
    Claude,
    Cursor,
}

impl ProviderId {
    /// Provider for a tab or workspace saved without one.
    pub const LEGACY: ProviderId = ProviderId::Cursor;
    /// Settings default for new and existing profiles (Decision 3).
    pub const DEFAULT: ProviderId = ProviderId::Claude;

    /// `None` is a legacy record: Cursor, until Task 6.3 migrates it.
    pub fn resolve(saved: Option<ProviderId>) -> ProviderId {
        saved.unwrap_or(Self::LEGACY)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            ProviderId::Claude => "claude",
            ProviderId::Cursor => "cursor",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            ProviderId::Claude => "Claude",
            ProviderId::Cursor => "Cursor",
        }
    }

    pub fn parse(value: &str) -> Option<ProviderId> {
        match value.trim().to_ascii_lowercase().as_str() {
            "claude" => Some(ProviderId::Claude),
            "cursor" => Some(ProviderId::Cursor),
            _ => None,
        }
    }
}

/// Session ids per provider. A Cursor id can never resume under Claude, so a
/// tab keeps one id per provider. `claude_config_dir` is the Claude config
/// folder that was in effect when `claude` was saved (plan: Claude account /
/// config dir); a different folder later means a fresh Claude session.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSessions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude_config_dir: Option<String>,
}

impl ProviderSessions {
    pub fn is_empty(&self) -> bool {
        self.cursor.is_none() && self.claude.is_none() && self.claude_config_dir.is_none()
    }

    pub fn get(&self, provider: ProviderId) -> Option<&str> {
        match provider {
            ProviderId::Cursor => self.cursor.as_deref(),
            ProviderId::Claude => self.claude.as_deref(),
        }
    }

    pub fn set(&mut self, provider: ProviderId, id: Option<String>) {
        match provider {
            ProviderId::Cursor => self.cursor = id,
            ProviderId::Claude => self.claude = id,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_ids_are_lowercase_strings() {
        assert_eq!(
            serde_json::to_value(ProviderId::Claude).unwrap(),
            serde_json::json!("claude")
        );
        let parsed: ProviderId = serde_json::from_str("\"cursor\"").unwrap();
        assert_eq!(parsed, ProviderId::Cursor);
        assert!(serde_json::from_str::<ProviderId>("\"Claude\"").is_err());
        assert_eq!(ProviderId::parse(" Claude "), Some(ProviderId::Claude));
        assert_eq!(ProviderId::parse("gpt"), None);
    }

    #[test]
    fn missing_provider_is_cursor_until_migration() {
        assert_eq!(ProviderId::resolve(None), ProviderId::Cursor);
        assert_eq!(
            ProviderId::resolve(Some(ProviderId::Claude)),
            ProviderId::Claude
        );
        assert_eq!(ProviderId::DEFAULT, ProviderId::Claude);
    }

    #[test]
    fn sessions_keep_one_id_per_provider() {
        let mut sessions = ProviderSessions::default();
        assert!(sessions.is_empty());
        sessions.set(ProviderId::Cursor, Some("c-1".into()));
        assert_eq!(sessions.get(ProviderId::Cursor), Some("c-1"));
        assert_eq!(sessions.get(ProviderId::Claude), None);
        let json = serde_json::to_value(&sessions).unwrap();
        assert_eq!(json, serde_json::json!({ "cursor": "c-1" }));
    }
}
