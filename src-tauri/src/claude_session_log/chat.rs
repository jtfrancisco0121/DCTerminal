//! A Claude terminal session as ordered chat entries, built from the same
//! main-chain records the summary reads (sidechain records, i.e. a
//! sub-agent's own steps, are skipped).
//!
//! - user: a real prompt (tool-result-only records, meta reminders, compact
//!   summaries and local slash-command echoes are skipped, as in the summary).
//! - assistant: one `text` block. `thinking` blocks are left out.
//! - tool: any other `tool_use`, with a redacted one-line title; its status
//!   follows the matching `tool_result` (`is_error` → error).
//! - subAgent: a `tool_use` named `Agent` (older Claude Code: `Task`). It
//!   starts at the tool_use record and ends at its `tool_result`.
//! - plan: `ExitPlanMode` with its markdown; error means the plan was rejected.
//! - question: `AskUserQuestion` with its questions and option labels.
//!
//! Every entry has a `seq` (its position, ascending in file order) and a
//! `rev`: a process-wide counter bumped whenever the entry is added or
//! changed. A view keeps the highest `rev` it has seen and asks for entries
//! with a higher one (see `ChatLog::update_since`).

use super::{describe_tool, user_turn, ToolCallKind, UserTurn};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

/// Oldest entries are dropped past this many.
pub const MAX_CHAT_ENTRIES: usize = 2000;
/// A prompt or reply longer than this is cut (the terminal has the rest).
const TEXT_CHARS: usize = 64 * 1024;
const PLAN_CHARS: usize = 256 * 1024;
const DESCRIPTION_CHARS: usize = 200;

static REVISION: AtomicU64 = AtomicU64::new(0);

/// A fresh revision, greater than every one handed out before.
pub(crate) fn next_revision() -> u64 {
    REVISION.fetch_add(1, Ordering::Relaxed) + 1
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EntryStatus {
    /// No result yet (for a plan or question: waiting for the user).
    Running,
    Done,
    /// The result was an error, a denial or a rejection.
    Error,
    /// A later prompt started before any result came back.
    Stopped,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChatQuestion {
    pub header: String,
    pub question: String,
    pub options: Vec<String>,
    pub multi_select: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ChatItem {
    User {
        text: String,
    },
    Assistant {
        text: String,
    },
    Tool {
        tool_id: String,
        name: String,
        /// Redacted, e.g. "Bash: Run tests" or "Read: /repo/src/a.rs".
        title: String,
        tool_kind: ToolCallKind,
        status: EntryStatus,
        ended_at: Option<String>,
    },
    SubAgent {
        tool_id: String,
        /// `input.description`, else "Sub-agent".
        description: String,
        /// `input.subagent_type` ("Explore", "general-purpose", …).
        agent_type: Option<String>,
        /// `input.run_in_background`: its result only says it launched.
        background: bool,
        status: EntryStatus,
        ended_at: Option<String>,
    },
    Plan {
        tool_id: String,
        plan: String,
        status: EntryStatus,
        ended_at: Option<String>,
    },
    Question {
        tool_id: String,
        questions: Vec<ChatQuestion>,
        status: EntryStatus,
        ended_at: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChatEntry {
    pub seq: u64,
    pub rev: u64,
    /// The record's `timestamp` (ISO 8601); for a tool, when it was called.
    pub at: Option<String>,
    #[serde(flatten)]
    pub item: ChatItem,
}

impl ChatEntry {
    fn tool_state(&mut self) -> Option<(&mut EntryStatus, &mut Option<String>)> {
        match &mut self.item {
            ChatItem::Tool {
                status, ended_at, ..
            }
            | ChatItem::SubAgent {
                status, ended_at, ..
            }
            | ChatItem::Plan {
                status, ended_at, ..
            }
            | ChatItem::Question {
                status, ended_at, ..
            } => Some((status, ended_at)),
            ChatItem::User { .. } | ChatItem::Assistant { .. } => None,
        }
    }

    /// A running background sub-agent is left alone when a new prompt comes.
    fn background(&self) -> bool {
        matches!(
            self.item,
            ChatItem::SubAgent {
                background: true,
                ..
            }
        )
    }
}

/// What a view receives: from `terminal_chat_entries` and on the watch channel.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChatEntriesUpdate {
    pub session_id: String,
    /// Pass back as `since` to get only later changes.
    pub revision: u64,
    /// True: `entries` is the whole list, replace what the view holds (first
    /// read, the file was replaced or shrank, or the tab's session changed).
    /// False: `entries` holds only new or changed entries; merge by `seq`.
    pub reset: bool,
    /// Entries with a lower `seq` were dropped (past `MAX_CHAT_ENTRIES`).
    pub first_seq: u64,
    /// Ascending `seq`.
    pub entries: Vec<ChatEntry>,
}

/// The entries built so far. Fed one record at a time.
pub(crate) struct ChatLog {
    /// Revisions below this belong to an earlier parse.
    base_rev: u64,
    last_rev: u64,
    next_seq: u64,
    entries: Vec<ChatEntry>,
    /// tool_use id → entry seq.
    tools: HashMap<String, u64>,
}

impl Default for ChatLog {
    fn default() -> Self {
        let base_rev = next_revision();
        Self {
            base_rev,
            last_rev: base_rev,
            next_seq: 0,
            entries: Vec::new(),
            tools: HashMap::new(),
        }
    }
}

impl ChatLog {
    pub(crate) fn record(&mut self, value: &Value) {
        if value.get("isSidechain").and_then(Value::as_bool) == Some(true) {
            return;
        }
        let at = value
            .get("timestamp")
            .and_then(Value::as_str)
            .map(str::to_string);
        match value.get("type").and_then(Value::as_str) {
            Some("assistant") => self.assistant(value, at),
            Some("user") => self.user(value, at),
            _ => {}
        }
    }

    fn assistant(&mut self, value: &Value, at: Option<String>) {
        let Some(content) = value.get("message").and_then(|m| m.get("content")) else {
            return;
        };
        if let Some(text) = content.as_str() {
            self.push_text(text, at);
            return;
        }
        for block in content.as_array().into_iter().flatten() {
            match block.get("type").and_then(Value::as_str) {
                Some("text") => {
                    if let Some(text) = block.get("text").and_then(Value::as_str) {
                        self.push_text(text, at.clone());
                    }
                }
                Some("tool_use") => self.tool_use(block, at.clone()),
                _ => {}
            }
        }
    }

    fn push_text(&mut self, text: &str, at: Option<String>) {
        let text = text.trim();
        if !text.is_empty() {
            self.push(
                at,
                ChatItem::Assistant {
                    text: cut(text, TEXT_CHARS),
                },
            );
        }
    }

    fn tool_use(&mut self, block: &Value, at: Option<String>) {
        let id = block.get("id").and_then(Value::as_str).unwrap_or_default();
        let name = block.get("name").and_then(Value::as_str).unwrap_or("tool");
        let input = block.get("input").cloned().unwrap_or(Value::Null);
        let item = tool_item(id, name, &input, at.clone());
        if !id.is_empty() {
            // Claude Code may write a tool_use again (a resumed stream); keep its place.
            if let Some(seq) = self.tools.get(id).copied() {
                let rev = next_revision();
                self.last_rev = rev;
                if let Some(entry) = self.entry_mut(seq) {
                    let state = entry
                        .tool_state()
                        .map(|(status, ended)| (*status, ended.clone()));
                    entry.item = item;
                    if let (Some((status, ended)), Some((now, now_ended))) =
                        (state, entry.tool_state())
                    {
                        *now = status;
                        *now_ended = ended;
                    }
                    entry.rev = rev;
                }
                return;
            }
            self.tools.insert(id.to_string(), self.next_seq);
        }
        self.push(at, item);
    }

    fn user(&mut self, value: &Value, at: Option<String>) {
        let content = value.get("message").and_then(|m| m.get("content"));
        let mut results = false;
        for block in content.and_then(Value::as_array).into_iter().flatten() {
            if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                continue;
            }
            results = true;
            let failed = block.get("is_error").and_then(Value::as_bool) == Some(true);
            let Some(seq) = block
                .get("tool_use_id")
                .and_then(Value::as_str)
                .and_then(|id| self.tools.get(id).copied())
            else {
                continue;
            };
            let status = if failed {
                EntryStatus::Error
            } else {
                EntryStatus::Done
            };
            self.finish_tool(seq, status, at.clone());
        }
        if results {
            return;
        }
        if let UserTurn::Prompt(text) = user_turn(value) {
            // Whatever the previous turn left running never gets a result now.
            let open: Vec<u64> = self
                .entries
                .iter_mut()
                .filter(|entry| !entry.background())
                .filter_map(|entry| {
                    let seq = entry.seq;
                    entry
                        .tool_state()
                        .filter(|(status, _)| **status == EntryStatus::Running)
                        .map(|_| seq)
                })
                .collect();
            for seq in open {
                self.finish_tool(seq, EntryStatus::Stopped, None);
            }
            let text = text.trim();
            if !text.is_empty() {
                self.push(
                    at,
                    ChatItem::User {
                        text: cut(text, TEXT_CHARS),
                    },
                );
            }
        }
    }

    fn finish_tool(&mut self, seq: u64, status: EntryStatus, at: Option<String>) {
        let rev = next_revision();
        let Some(entry) = self.entry_mut(seq) else {
            return;
        };
        if let Some((now, ended)) = entry.tool_state() {
            *now = status;
            *ended = at;
            entry.rev = rev;
            self.last_rev = rev;
        }
    }

    fn entry_mut(&mut self, seq: u64) -> Option<&mut ChatEntry> {
        // Entries are sorted by seq with no gaps after the first.
        let first = self.entries.first()?.seq;
        let index = seq.checked_sub(first)? as usize;
        self.entries.get_mut(index)
    }

    fn push(&mut self, at: Option<String>, item: ChatItem) {
        let rev = next_revision();
        self.last_rev = rev;
        self.entries.push(ChatEntry {
            seq: self.next_seq,
            rev,
            at,
            item,
        });
        self.next_seq += 1;
        if self.entries.len() > MAX_CHAT_ENTRIES {
            let extra = self.entries.len() - MAX_CHAT_ENTRIES;
            self.entries.drain(..extra);
            let first = self.entries[0].seq;
            self.tools.retain(|_, seq| *seq >= first);
        }
    }

    #[cfg(test)]
    pub(crate) fn entries(&self) -> &[ChatEntry] {
        &self.entries
    }

    /// Entries changed after `since`, or all of them (`reset`) when `since`
    /// is missing or came from an earlier parse.
    pub(crate) fn update_since(&self, session_id: &str, since: Option<u64>) -> ChatEntriesUpdate {
        let reset = since.is_none_or(|since| since < self.base_rev);
        let entries = self
            .entries
            .iter()
            .filter(|entry| reset || since.is_some_and(|since| entry.rev > since))
            .cloned()
            .collect();
        ChatEntriesUpdate {
            session_id: session_id.to_string(),
            revision: self.last_rev,
            reset,
            first_seq: self
                .entries
                .first()
                .map_or(self.next_seq, |entry| entry.seq),
            entries,
        }
    }
}

fn tool_item(id: &str, name: &str, input: &Value, at: Option<String>) -> ChatItem {
    let tool_id = id.to_string();
    let status = EntryStatus::Running;
    match name {
        "Agent" | "Task" => ChatItem::SubAgent {
            tool_id,
            description: text_field(input, "description")
                .map(|text| cut(text, DESCRIPTION_CHARS))
                .unwrap_or_else(|| "Sub-agent".to_string()),
            agent_type: text_field(input, "subagent_type").map(str::to_string),
            background: input.get("run_in_background").and_then(Value::as_bool) == Some(true),
            status,
            ended_at: None,
        },
        "ExitPlanMode" => ChatItem::Plan {
            tool_id,
            plan: text_field(input, "plan")
                .map(|plan| cut(plan, PLAN_CHARS))
                .unwrap_or_default(),
            status,
            ended_at: None,
        },
        "AskUserQuestion" => ChatItem::Question {
            tool_id,
            questions: input
                .get("questions")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(question)
                .collect(),
            status,
            ended_at: None,
        },
        _ => {
            let call = describe_tool(tool_id.clone(), name.to_string(), input, at);
            ChatItem::Tool {
                tool_id,
                name: call.name,
                title: call.title,
                tool_kind: call.kind,
                status,
                ended_at: None,
            }
        }
    }
}

fn question(value: &Value) -> ChatQuestion {
    ChatQuestion {
        header: text_field(value, "header").unwrap_or_default().to_string(),
        question: text_field(value, "question")
            .unwrap_or_default()
            .to_string(),
        options: value
            .get("options")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|option| {
                option
                    .get("label")
                    .and_then(Value::as_str)
                    .or_else(|| option.as_str())
                    .map(str::to_string)
            })
            .collect(),
        multi_select: value.get("multiSelect").and_then(Value::as_bool) == Some(true),
    }
}

fn text_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
}

fn cut(text: &str, max_chars: usize) -> String {
    match text.char_indices().nth(max_chars) {
        Some((end, _)) => format!("{}…", &text[..end]),
        None => text.to_string(),
    }
}
