//! Incremental reads of one session log. The first read parses the last
//! `MAX_TAIL_BYTES` (as `read_session_log` does); each later read parses only
//! the bytes appended since. A file that shrank or was replaced (another
//! inode) is parsed again from its tail, and the chat entries report a reset.
//!
//! A trailing line without its newline is held back until it is complete. It
//! is taken early only when it already parses as a JSON object, so a read
//! that lands between Claude Code's write and its newline still matches a
//! full parse.
//!
//! `SessionLogReaders` (managed state) keeps one reader per tab. Its lock is
//! only held to look a reader up; the file is read under the reader's own
//! lock, never under a store lock.

use super::chat::{ChatEntriesUpdate, ChatLog};
use super::watch::WatchHandle;
use super::{find_session_log, read_tail_at, Parser, TerminalSessionLog, MAX_TAIL_BYTES};
use crate::claude_history::parse_jsonl_line;
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// Tells a replaced file from one that only grew.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileKey {
    #[cfg(unix)]
    dev: u64,
    #[cfg(unix)]
    ino: u64,
}

fn file_key(meta: &std::fs::Metadata) -> FileKey {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        FileKey {
            dev: meta.dev(),
            ino: meta.ino(),
        }
    }
    #[cfg(not(unix))]
    {
        let _ = meta;
        FileKey {}
    }
}

pub struct SessionLogReader {
    path: PathBuf,
    session_id: String,
    key: Option<FileKey>,
    /// File offset of the first byte not yet parsed (the start of `partial`).
    offset: u64,
    /// An unfinished last line.
    partial: Vec<u8>,
    parser: Parser,
    chat: ChatLog,
}

impl SessionLogReader {
    /// Parse the file's tail. `None` when it cannot be read.
    pub fn open(path: &Path, session_id: &str) -> Option<Self> {
        let key = std::fs::metadata(path).ok().map(|meta| file_key(&meta));
        let (start, bytes) = read_tail_at(path, MAX_TAIL_BYTES)?;
        let mut reader = Self {
            path: path.to_path_buf(),
            session_id: session_id.to_string(),
            key,
            offset: start,
            partial: Vec::new(),
            parser: Parser::default(),
            chat: ChatLog::default(),
        };
        reader.feed(bytes);
        Some(reader)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Parse what was appended since the last read. Returns false when the
    /// file is gone or unreadable (the state is kept).
    pub fn refresh(&mut self) -> bool {
        let Ok(meta) = std::fs::metadata(&self.path) else {
            return false;
        };
        let read_to = self.offset + self.partial.len() as u64;
        let key = file_key(&meta);
        if meta.len() < read_to || self.key.is_some_and(|known| known != key) {
            return match Self::open(&self.path, &self.session_id) {
                Some(fresh) => {
                    *self = fresh;
                    true
                }
                None => false,
            };
        }
        if meta.len() == read_to {
            return true;
        }
        let Ok(mut file) = std::fs::File::open(&self.path) else {
            return false;
        };
        if file.seek(SeekFrom::Start(read_to)).is_err() {
            return false;
        }
        let mut bytes = Vec::with_capacity((meta.len() - read_to) as usize);
        if file.read_to_end(&mut bytes).is_err() {
            return false;
        }
        self.key = Some(key);
        let mut pending = std::mem::take(&mut self.partial);
        pending.extend_from_slice(&bytes);
        self.feed(pending);
        true
    }

    /// Parse whole lines from `bytes` (which start at `self.offset`) and keep
    /// the unfinished rest.
    fn feed(&mut self, mut bytes: Vec<u8>) {
        let whole = bytes.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
        let rest = bytes.split_off(whole);
        for line in bytes.split(|b| *b == b'\n') {
            self.line(line);
        }
        self.offset += whole as u64;
        match parse_jsonl_line(&rest).filter(|value| value.is_object()) {
            Some(value) => {
                self.record(&value);
                self.offset += rest.len() as u64;
            }
            None => self.partial = rest,
        }
    }

    fn line(&mut self, line: &[u8]) {
        if let Some(value) = parse_jsonl_line(line) {
            self.record(&value);
        }
    }

    fn record(&mut self, value: &serde_json::Value) {
        self.parser.record(value);
        self.chat.record(value);
    }

    pub fn summary(&self) -> TerminalSessionLog {
        self.parser.summary(&self.session_id, &self.path)
    }

    pub fn chat_since(&self, since: Option<u64>) -> ChatEntriesUpdate {
        self.chat.update_since(&self.session_id, since)
    }

    #[cfg(test)]
    pub(crate) fn chat(&self) -> &ChatLog {
        &self.chat
    }
}

#[derive(Default)]
struct ReadersInner {
    readers: HashMap<String, Arc<Mutex<SessionLogReader>>>,
    watches: HashMap<String, WatchHandle>,
}

/// One reader, and at most one live watch, per tab. Managed state; clones
/// share the same map (a watch thread keeps one).
#[derive(Clone, Default)]
pub struct SessionLogReaders {
    inner: Arc<Mutex<ReadersInner>>,
}

impl SessionLogReaders {
    pub fn new() -> Self {
        Self::default()
    }

    /// The tab closed: stop its watch and drop its reader.
    pub fn forget(&self, tab_id: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            if let Some(watch) = inner.watches.remove(tab_id) {
                watch.stop();
            }
            inner.readers.remove(tab_id);
        }
    }

    /// Stop the tab's watch, if any. The reader is kept.
    pub fn stop_watch(&self, tab_id: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            if let Some(watch) = inner.watches.remove(tab_id) {
                watch.stop();
            }
        }
    }

    /// Keep `watch` as the tab's one watch, stopping the one it replaces.
    pub(crate) fn set_watch(&self, tab_id: &str, watch: WatchHandle) {
        if let Ok(mut inner) = self.inner.lock() {
            if let Some(old) = inner.watches.insert(tab_id.to_string(), watch) {
                old.stop();
            }
        }
    }

    /// The tab's reader for `session_id` under `config_dir`, refreshed. A
    /// different session or a moved file starts a new reader. `None` until
    /// the log exists. The map is locked only for the lookup and the insert.
    pub fn tab_reader(
        &self,
        tab_id: &str,
        config_dir: &Path,
        session_id: &str,
    ) -> Option<Arc<Mutex<SessionLogReader>>> {
        let known = self
            .inner
            .lock()
            .ok()
            .and_then(|inner| inner.readers.get(tab_id).cloned());
        if let Some(reader) = known {
            let fresh = reader.lock().ok().is_some_and(|mut guard| {
                guard.session_id == session_id.trim() && guard.path.is_file() && guard.refresh()
            });
            if fresh {
                return Some(reader);
            }
        }
        let path = find_session_log(config_dir, session_id)?;
        let reader = Arc::new(Mutex::new(SessionLogReader::open(
            &path,
            session_id.trim(),
        )?));
        if let Ok(mut inner) = self.inner.lock() {
            inner.readers.insert(tab_id.to_string(), reader.clone());
        }
        Some(reader)
    }

    #[cfg(test)]
    pub(crate) fn reader_count(&self) -> usize {
        self.inner.lock().map_or(0, |inner| inner.readers.len())
    }

    #[cfg(test)]
    pub(crate) fn watch_count(&self) -> usize {
        self.inner.lock().map_or(0, |inner| inner.watches.len())
    }
}

#[cfg(test)]
mod tests {
    use super::super::chat::{ChatEntry, ChatItem, EntryStatus};
    use super::super::read_session_log;
    use super::*;
    use crate::test_support::TempDir;
    use serde_json::{json, Value};
    use std::io::Write;

    const SID: &str = "0b6c1d2e-aaaa-4bbb-8ccc-1234567890ab";

    fn base(kind: &str, at: &str) -> Value {
        json!({
            "parentUuid": null, "isSidechain": false, "type": kind,
            "uuid": format!("u-{at}"), "timestamp": at, "cwd": "/tmp/project",
            "sessionId": SID, "version": "2.1.0",
        })
    }

    fn prompt(text: &str, at: &str) -> Value {
        let mut v = base("user", at);
        v["message"] = json!({ "role": "user", "content": text });
        v
    }

    fn assistant(block: Value, stop: Option<&str>, at: &str) -> Value {
        let mut v = base("assistant", at);
        v["message"] = json!({
            "id": "msg_1", "type": "message", "role": "assistant", "model": "test",
            "content": [block], "stop_reason": stop, "stop_sequence": null,
        });
        v
    }

    fn text(t: &str, stop: Option<&str>, at: &str) -> Value {
        assistant(json!({ "type": "text", "text": t }), stop, at)
    }

    fn tool(id: &str, name: &str, input: Value, at: &str) -> Value {
        assistant(
            json!({ "type": "tool_use", "id": id, "name": name, "input": input }),
            Some("tool_use"),
            at,
        )
    }

    fn result(id: &str, is_error: bool, at: &str) -> Value {
        let mut v = base("user", at);
        v["message"] = json!({ "role": "user", "content": [
            { "tool_use_id": id, "type": "tool_result", "content": "ok", "is_error": is_error }
        ]});
        v
    }

    fn jsonl(records: &[Value]) -> String {
        records
            .iter()
            .map(|r| serde_json::to_string(r).unwrap() + "\n")
            .collect()
    }

    fn log_path(dir: &TempDir) -> PathBuf {
        let folder = dir.join("projects").join("-tmp-project");
        std::fs::create_dir_all(&folder).unwrap();
        folder.join(format!("{SID}.jsonl"))
    }

    fn append(path: &Path, bytes: &[u8]) {
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap();
        file.write_all(bytes).unwrap();
    }

    /// Entries without their revisions, which differ between two parses.
    fn items(entries: &[ChatEntry]) -> Vec<(u64, Option<String>, ChatItem)> {
        entries
            .iter()
            .map(|e| (e.seq, e.at.clone(), e.item.clone()))
            .collect()
    }

    /// A session with every kind of record: prompts, thinking, text, tools,
    /// a sub-agent with sidechain steps, a plan, a question, an interrupt,
    /// local commands and a meta reminder.
    fn session() -> Vec<Value> {
        let mut side = text("sub-agent step", Some("end_turn"), "t6");
        side["isSidechain"] = json!(true);
        let mut meta = prompt("<system-reminder>x</system-reminder>", "t12");
        meta["isMeta"] = json!(true);
        let mut mode = prompt("Plan the fix", "t1");
        mode["permissionMode"] = json!("plan");
        let mut duration = base("system", "t11");
        duration["subtype"] = json!("turn_duration");
        vec![
            mode,
            assistant(
                json!({ "type": "thinking", "thinking": "hmm", "signature": "s" }),
                None,
                "t2",
            ),
            text("Looking around.", Some("tool_use"), "t3"),
            tool("r1", "Read", json!({ "file_path": "/repo/a.rs" }), "t4"),
            result("r1", false, "t5"),
            tool(
                "ag1",
                "Agent",
                json!({ "description": "Explore auth", "subagent_type": "Explore", "prompt": "p" }),
                "t5",
            ),
            side,
            result("ag1", false, "t7"),
            tool(
                "q1",
                "AskUserQuestion",
                json!({ "questions": [
                    { "question": "Which DB?", "header": "DB", "multiSelect": false,
                      "options": [{ "label": "Postgres", "description": "d" }, { "label": "SQLite" }] }
                ]}),
                "t8",
            ),
            result("q1", false, "t9"),
            tool(
                "p1",
                "ExitPlanMode",
                json!({ "plan": "# Plan\n- step" }),
                "t10",
            ),
            result("p1", true, "t10b"),
            duration,
            meta,
            prompt("<command-name>/model</command-name>", "t12b"),
            prompt("Do it", "t13"),
            tool(
                "b1",
                "Bash",
                json!({ "command": "npm test", "description": "Run tests" }),
                "t14",
            ),
            prompt("[Request interrupted by user]", "t15"),
            prompt("Again", "t16"),
            tool("t1", "Task", json!({ "description": "Old style" }), "t17"),
            text("Working on it", None, "t18"),
        ]
    }

    #[test]
    fn entries_follow_the_session_in_order() {
        let dir = TempDir::new("reader_entries");
        let path = log_path(&dir);
        std::fs::write(&path, jsonl(&session())).unwrap();
        let reader = SessionLogReader::open(&path, SID).unwrap();
        let kinds: Vec<String> = reader
            .chat()
            .entries()
            .iter()
            .map(|e| {
                serde_json::to_value(e).unwrap()["kind"]
                    .as_str()
                    .unwrap()
                    .to_string()
            })
            .collect();
        assert_eq!(
            kinds,
            vec![
                "user",
                "assistant",
                "tool",
                "subAgent",
                "question",
                "plan",
                "user",
                "tool",
                "user",
                "subAgent",
                "assistant"
            ]
        );
        let entries = reader.chat().entries();
        assert_eq!(
            entries[0].item,
            ChatItem::User {
                text: "Plan the fix".into()
            }
        );
        assert_eq!(entries[0].at.as_deref(), Some("t1"));
        match &entries[3].item {
            ChatItem::SubAgent {
                description,
                agent_type,
                status,
                ended_at,
                background,
                ..
            } => {
                assert_eq!(description, "Explore auth");
                assert_eq!(agent_type.as_deref(), Some("Explore"));
                assert_eq!(*status, EntryStatus::Done);
                assert_eq!(ended_at.as_deref(), Some("t7"));
                assert!(!background);
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(entries[3].at.as_deref(), Some("t5"));
        match &entries[4].item {
            ChatItem::Question {
                questions, status, ..
            } => {
                assert_eq!(questions[0].question, "Which DB?");
                assert_eq!(questions[0].options, vec!["Postgres", "SQLite"]);
                assert_eq!(*status, EntryStatus::Done);
            }
            other => panic!("{other:?}"),
        }
        match &entries[5].item {
            ChatItem::Plan { plan, status, .. } => {
                assert_eq!(plan, "# Plan\n- step");
                assert_eq!(*status, EntryStatus::Error);
            }
            other => panic!("{other:?}"),
        }
        match &entries[7].item {
            ChatItem::Tool { title, status, .. } => {
                assert_eq!(title, "Bash: Run tests");
                // The interrupted call never got a result; the next prompt closed it.
                assert_eq!(*status, EntryStatus::Stopped);
            }
            other => panic!("{other:?}"),
        }
        match &entries[9].item {
            ChatItem::SubAgent {
                description,
                status,
                ended_at,
                ..
            } => {
                assert_eq!(description, "Old style");
                assert_eq!(*status, EntryStatus::Running);
                assert_eq!(*ended_at, None);
            }
            other => panic!("{other:?}"),
        }
        let json = serde_json::to_value(&entries[3]).unwrap();
        assert_eq!(json["kind"], json!("subAgent"));
        assert_eq!(json["agentType"], json!("Explore"));
        assert_eq!(json["endedAt"], json!("t7"));
        assert_eq!(json["toolId"], json!("ag1"));
        assert_eq!(json["status"], json!("done"));
        assert!(json.get("seq").is_some() && json.get("rev").is_some());
    }

    #[test]
    fn incremental_reads_match_a_full_parse_at_every_split() {
        let body = jsonl(&session());
        let full_dir = TempDir::new("reader_full");
        let full_path = log_path(&full_dir);
        std::fs::write(&full_path, &body).unwrap();
        let full = SessionLogReader::open(&full_path, SID).unwrap();
        assert_eq!(full.summary(), read_session_log(&full_path, SID).unwrap());

        // Cut the file at many byte positions, mid-line included, and read after each cut.
        for step in [1usize, 7, 64, 333, 4096] {
            let dir = TempDir::new("reader_inc");
            let path = log_path(&dir);
            std::fs::write(&path, b"").unwrap();
            let mut reader = SessionLogReader::open(&path, SID).unwrap();
            for chunk in body.as_bytes().chunks(step) {
                append(&path, chunk);
                assert!(reader.refresh());
                let mut summary = reader.summary();
                let mut expected = read_session_log(&path, SID).unwrap();
                summary.path = String::new();
                expected.path = String::new();
                assert_eq!(summary, expected, "step {step}");
            }
            let mut summary = reader.summary();
            summary.path = full.summary().path;
            assert_eq!(summary, full.summary(), "step {step}");
            assert_eq!(
                items(reader.chat().entries()),
                items(full.chat().entries()),
                "step {step}"
            );
        }
    }

    #[test]
    fn a_partial_line_waits_for_the_rest() {
        let dir = TempDir::new("reader_partial");
        let path = log_path(&dir);
        let first = jsonl(&[prompt("go", "t1")]);
        let line = jsonl(&[text("Hello there", Some("end_turn"), "t2")]);
        let (head, tail) = line.split_at(20);
        std::fs::write(&path, format!("{first}{head}")).unwrap();
        let mut reader = SessionLogReader::open(&path, SID).unwrap();
        assert_eq!(reader.chat().entries().len(), 1);
        assert!(!reader.summary().turn_done);
        let before = reader.chat_since(None).revision;
        append(&path, tail.as_bytes());
        reader.refresh();
        assert!(reader.summary().turn_done);
        assert_eq!(reader.summary().last_reply, "Hello there");
        let update = reader.chat_since(Some(before));
        assert!(!update.reset);
        assert_eq!(update.entries.len(), 1);
        assert_eq!(
            update.entries[0].item,
            ChatItem::Assistant {
                text: "Hello there".into()
            }
        );
        // A complete object without its newline is taken; the newline that follows is harmless.
        let no_newline = serde_json::to_string(&prompt("next", "t3")).unwrap();
        append(&path, no_newline.as_bytes());
        reader.refresh();
        assert_eq!(reader.summary().last_prompt_at.as_deref(), Some("t3"));
        append(&path, b"\n");
        reader.refresh();
        assert_eq!(reader.chat().entries().len(), 3);
        assert_eq!(reader.summary(), read_session_log(&path, SID).unwrap());
    }

    #[test]
    fn updates_carry_only_changes_and_a_replaced_file_resets() {
        let dir = TempDir::new("reader_updates");
        let path = log_path(&dir);
        std::fs::write(
            &path,
            jsonl(&[
                prompt("go", "t1"),
                tool("ag1", "Agent", json!({ "description": "Scan" }), "t2"),
            ]),
        )
        .unwrap();
        let mut reader = SessionLogReader::open(&path, SID).unwrap();
        let first = reader.chat_since(None);
        assert!(first.reset);
        assert_eq!(first.entries.len(), 2);
        assert_eq!(first.first_seq, 0);
        let same = reader.chat_since(Some(first.revision));
        assert!(!same.reset && same.entries.is_empty());
        assert_eq!(same.revision, first.revision);

        append(&path, jsonl(&[result("ag1", false, "t3")]).as_bytes());
        reader.refresh();
        let ended = reader.chat_since(Some(first.revision));
        assert!(!ended.reset);
        assert_eq!(ended.entries.len(), 1);
        assert_eq!(ended.entries[0].seq, 1);
        assert!(matches!(
            ended.entries[0].item,
            ChatItem::SubAgent {
                status: EntryStatus::Done,
                ..
            }
        ));
        assert!(ended.revision > first.revision);

        // Truncated: parsed again, and the view is told to start over.
        std::fs::write(&path, jsonl(&[prompt("fresh", "t9")])).unwrap();
        reader.refresh();
        let reset = reader.chat_since(Some(ended.revision));
        assert!(reset.reset);
        assert_eq!(
            items(&reset.entries),
            vec![(
                0,
                Some("t9".into()),
                ChatItem::User {
                    text: "fresh".into()
                }
            )]
        );
        assert_eq!(reader.summary().last_prompt_at.as_deref(), Some("t9"));

        // Replaced by a longer file (a new inode): also parsed again.
        let replacement = path.with_extension("tmp");
        std::fs::write(
            &replacement,
            jsonl(&[
                prompt("other", "u1"),
                text("A much longer reply here", None, "u2"),
            ]),
        )
        .unwrap();
        std::fs::rename(&replacement, &path).unwrap();
        reader.refresh();
        let replaced = reader.chat_since(Some(reset.revision));
        if cfg!(unix) {
            assert!(replaced.reset);
            assert_eq!(replaced.entries.len(), 2);
        }
        assert_eq!(reader.summary(), read_session_log(&path, SID).unwrap());
    }

    #[test]
    fn tab_reader_reuses_its_reader_and_follows_a_session_change() {
        let dir = TempDir::new("reader_tabs");
        let path = log_path(&dir);
        std::fs::write(&path, jsonl(&[prompt("go", "t1")])).unwrap();
        let readers = SessionLogReaders::new();
        assert!(readers
            .tab_reader("tab1", dir.path(), "not-a-session/..")
            .is_none());
        let a = readers.tab_reader("tab1", dir.path(), SID).unwrap();
        append(
            &path,
            jsonl(&[text("Hi", Some("end_turn"), "t2")]).as_bytes(),
        );
        let b = readers.tab_reader("tab1", dir.path(), SID).unwrap();
        assert!(Arc::ptr_eq(&a, &b));
        assert!(b.lock().unwrap().summary().turn_done);

        let other = "0b6c1d2e-aaaa-4bbb-8ccc-0000000000ff";
        let other_path = path.with_file_name(format!("{other}.jsonl"));
        std::fs::write(&other_path, jsonl(&[prompt("new", "t5")])).unwrap();
        let c = readers.tab_reader("tab1", dir.path(), other).unwrap();
        assert!(!Arc::ptr_eq(&a, &c));
        let since = a.lock().unwrap().chat_since(None).revision;
        // A cursor from the old session's reader resets.
        assert!(c.lock().unwrap().chat_since(Some(since)).reset);
        readers.forget("tab1");
        assert_eq!(readers.reader_count(), 0);
    }

    #[test]
    fn a_large_file_starts_from_its_tail_like_a_full_parse() {
        let dir = TempDir::new("reader_big");
        let path = log_path(&dir);
        let filler = jsonl(&[text(&"x".repeat(4096), Some("end_turn"), "t0")]);
        let mut body = jsonl(&[prompt("ancient", "t-old")]);
        body.push_str(&filler.repeat(MAX_TAIL_BYTES as usize / filler.len() + 50));
        body.push_str(&jsonl(&[prompt("latest", "t1")]));
        std::fs::write(&path, &body).unwrap();
        let mut reader = SessionLogReader::open(&path, SID).unwrap();
        assert_eq!(reader.summary(), read_session_log(&path, SID).unwrap());
        assert!(!reader.chat().entries().iter().any(|e| e.item
            == ChatItem::User {
                text: "ancient".into()
            }));
        append(
            &path,
            jsonl(&[text("Tail reply", Some("end_turn"), "t2")]).as_bytes(),
        );
        assert!(reader.refresh());
        assert_eq!(reader.summary(), read_session_log(&path, SID).unwrap());
    }

    #[test]
    fn a_long_session_keeps_its_newest_tool_calls_and_their_results() {
        let dir = TempDir::new("reader_tools");
        let path = log_path(&dir);
        std::fs::write(&path, jsonl(&[prompt("go", "t1")])).unwrap();
        let mut reader = SessionLogReader::open(&path, SID).unwrap();
        for i in 0..1200 {
            let id = format!("r{i}");
            append(
                &path,
                jsonl(&[
                    tool(&id, "Read", json!({ "file_path": "/a" }), "t2"),
                    result(&id, i % 2 == 1, "t3"),
                ])
                .as_bytes(),
            );
            if i % 97 == 0 {
                reader.refresh();
            }
        }
        reader.refresh();
        let summary = reader.summary();
        assert_eq!(summary, read_session_log(&path, SID).unwrap());
        assert_eq!(summary.tool_calls.len(), 500);
        assert_eq!(summary.tool_calls[499].id, "r1199");
        assert_eq!(
            summary.tool_calls[499].status,
            super::super::ToolCallStatus::Failed
        );
        assert!(!summary.turn_done && summary.pending_tools.is_empty());
    }

    #[test]
    fn entries_keep_the_newest_and_report_the_first_seq() {
        let dir = TempDir::new("reader_cap");
        let path = log_path(&dir);
        let records: Vec<Value> = (0..super::super::chat::MAX_CHAT_ENTRIES + 10)
            .map(|i| prompt(&format!("p{i}"), "t"))
            .collect();
        std::fs::write(&path, jsonl(&records)).unwrap();
        let reader = SessionLogReader::open(&path, SID).unwrap();
        let update = reader.chat_since(None);
        assert_eq!(update.entries.len(), super::super::chat::MAX_CHAT_ENTRIES);
        assert_eq!(update.first_seq, 10);
        assert_eq!(update.entries[0].seq, 10);
    }
}
