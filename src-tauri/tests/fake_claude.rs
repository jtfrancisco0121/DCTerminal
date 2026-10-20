//! Scenario tests for the `fake_claude` bin (`src/bin/fake_claude.rs`, which
//! documents the scenario format). Each test runs the bin in a real
//! `PtySession` with `CLAUDE_CONFIG_DIR` pinned to a temp folder, and reads
//! its session log through the app's `SessionLogReader`.
//!
//! These are integration tests, not unit tests next to `claude_session_log`
//! and `pty`, because Cargo sets `CARGO_BIN_EXE_<name>` only for integration
//! tests and benches. `mod session_log` covers what the reader sees; `mod pty`
//! covers what the bin draws, how it takes input and how it stops.
#![cfg(unix)]

use dcterminal_lib::testing::{
    find_session_log, PtyOutput, PtySession, SessionLogReader, SpawnSpec, TerminalSessionLog,
    ToolCallStatus,
};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::Receiver;
use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const FAKE_CLAUDE: &str = env!("CARGO_BIN_EXE_fake_claude");
const WAIT: Duration = Duration::from_secs(15);

fn now_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}

/// This process's folder, `temp_dir()/dcterminal-tests/run-<pid>-<nanos>`,
/// the layout `test_support` uses, so its sweep removes what a crashed run
/// leaves behind.
fn test_root() -> &'static Path {
    static ROOT: OnceLock<PathBuf> = OnceLock::new();
    ROOT.get_or_init(|| {
        let root = std::env::temp_dir().join("dcterminal-tests").join(format!(
            "run-{}-{}",
            std::process::id(),
            now_nanos()
        ));
        std::fs::create_dir_all(&root).expect("create test run dir");
        root
    })
}

/// A fresh folder under the run folder, removed on drop.
struct TempDir {
    path: PathBuf,
}

impl TempDir {
    fn new(tag: &str) -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let path = test_root().join(format!(
            "{tag}_{}_{}",
            NEXT.fetch_add(1, Ordering::SeqCst),
            now_nanos()
        ));
        std::fs::create_dir_all(&path).expect("create temp dir");
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn join(&self, part: impl AsRef<Path>) -> PathBuf {
        self.path.join(part)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// A config folder and a working folder for one or more runs (a resume
/// reuses both).
struct FakeHome {
    config: TempDir,
    cwd: TempDir,
}

impl FakeHome {
    fn new(tag: &str) -> Self {
        let home = Self {
            config: TempDir::new(&format!("{tag}_config")),
            cwd: TempDir::new(&format!("{tag}_cwd")),
        };
        // An empty config dir would resolve to the real ~/.claude; never let
        // a test run without the pin.
        assert!(
            home.config.path().starts_with(test_root()),
            "config dir must be a test temp dir: {}",
            home.config.path().display()
        );
        home
    }

    /// Spawn `fake_claude <args>` with this scenario.
    fn run(&self, scenario: &Value, args: &[&str]) -> FakeClaude {
        self.run_in(self.cwd.path(), scenario, args)
    }

    /// `run`, with `cwd` (a folder under this home's cwd) as the working folder.
    fn run_in(&self, cwd: &Path, scenario: &Value, args: &[&str]) -> FakeClaude {
        let file = self.cwd.join(format!("scenario-{}.json", now_nanos()));
        std::fs::write(&file, serde_json::to_vec(scenario).unwrap()).expect("write scenario");
        let mut session = PtySession::spawn(SpawnSpec {
            program: FAKE_CLAUDE.into(),
            args: args.iter().map(|arg| arg.to_string()).collect(),
            env: vec![
                (
                    "CLAUDE_CONFIG_DIR".into(),
                    self.config.path().display().to_string(),
                ),
                (
                    "DCT_FAKE_CLAUDE_SCENARIO".into(),
                    file.display().to_string(),
                ),
            ],
            cwd: cwd.to_path_buf(),
            cols: 120,
            rows: 40,
        })
        .expect("spawn fake_claude");
        let output = session.take_output().expect("pty output");
        FakeClaude {
            session,
            output,
            config: self.config.path().to_path_buf(),
            screen: Vec::new(),
            exit: None,
        }
    }
}

struct FakeClaude {
    session: PtySession,
    output: Receiver<PtyOutput>,
    config: PathBuf,
    screen: Vec<u8>,
    exit: Option<Option<i32>>,
}

impl FakeClaude {
    fn pump(&mut self, slice: Duration) {
        match self.output.recv_timeout(slice) {
            Ok(PtyOutput::Data(bytes)) => self.screen.extend_from_slice(&bytes),
            Ok(PtyOutput::Exit { code }) => self.exit = Some(code),
            Err(_) => {}
        }
    }

    /// Everything drawn so far, as plain lines (see `plain_screen`).
    fn screen(&self) -> String {
        plain_screen(&self.screen)
    }

    /// Wait until the plain screen contains `marker`.
    fn wait_screen(&mut self, marker: &str) -> bool {
        let deadline = Instant::now() + WAIT;
        while Instant::now() < deadline {
            if self.screen().contains(marker) {
                return true;
            }
            if self.exit.is_some() {
                break;
            }
            self.pump(Duration::from_millis(50));
        }
        self.screen().contains(marker)
    }

    /// Wait for the process to exit; its code.
    fn wait_exit(&mut self) -> Option<i32> {
        let deadline = Instant::now() + WAIT;
        while self.exit.is_none() && Instant::now() < deadline {
            self.pump(Duration::from_millis(50));
        }
        self.exit.expect("fake_claude did not exit")
    }

    fn write(&self, bytes: &[u8]) {
        self.session.write(bytes).expect("write to fake_claude");
    }

    /// The log for `session_id`, under the pinned config dir only.
    fn log_path(&self, session_id: &str) -> Option<PathBuf> {
        let path = find_session_log(&self.config, session_id)?;
        assert!(path.starts_with(&self.config), "{}", path.display());
        Some(path)
    }

    /// Read the log through the app's reader until `done` holds.
    fn wait_log(
        &mut self,
        session_id: &str,
        done: impl Fn(&TerminalSessionLog) -> bool,
    ) -> TerminalSessionLog {
        let deadline = Instant::now() + WAIT;
        let mut reader: Option<SessionLogReader> = None;
        loop {
            if reader.is_none() {
                reader = self
                    .log_path(session_id)
                    .and_then(|path| SessionLogReader::open(&path, session_id));
            } else if let Some(reader) = reader.as_mut() {
                reader.refresh();
            }
            if let Some(summary) = reader.as_ref().map(SessionLogReader::summary) {
                if done(&summary) || Instant::now() >= deadline {
                    return summary;
                }
            } else {
                assert!(
                    Instant::now() < deadline,
                    "no session log for {session_id}; screen:\n{}",
                    self.screen()
                );
            }
            self.pump(Duration::from_millis(30));
        }
    }
}

/// The log's records, one JSON value per line. Panics on a line that is not
/// complete JSON, except a trailing partial line when `allow_partial`.
fn log_records(path: &Path, allow_partial: bool) -> Vec<Value> {
    let body = std::fs::read(path).expect("read log");
    let complete = body.last() == Some(&b'\n');
    let mut lines: Vec<&[u8]> = body.split(|b| *b == b'\n').collect();
    let tail = lines.pop().unwrap_or_default();
    if !complete && !allow_partial {
        panic!(
            "the last log line is not complete: {:?}",
            String::from_utf8_lossy(tail)
        );
    }
    lines
        .into_iter()
        .map(|line| {
            serde_json::from_slice(line)
                .unwrap_or_else(|err| panic!("{err}: {:?}", String::from_utf8_lossy(line)))
        })
        .collect()
}

/// Raw PTY bytes to rough plain lines, the way `src/terminal/permissionDialog.ts`
/// `normalizeTerminalText` does: CHA is a space, cursor-forward is spaces,
/// vertical moves and CR are line breaks, other escapes vanish.
fn plain_screen(raw: &[u8]) -> String {
    let text = String::from_utf8_lossy(raw);
    let mut out = String::new();
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '\u{1b}' {
            match ch {
                '\r' | '\n' => out.push('\n'),
                '\t' => out.push(' '),
                c if (c as u32) < 0x20 => {}
                c => out.push(c),
            }
            continue;
        }
        match chars.peek() {
            Some('[') => {
                chars.next();
                let mut params = String::new();
                let mut fin = None;
                for next in chars.by_ref() {
                    if ('@'..='~').contains(&next) {
                        fin = Some(next);
                        break;
                    }
                    params.push(next);
                }
                let private = params.starts_with(['<', '=', '>', '?']);
                let n: usize = params.parse().unwrap_or(1).max(1);
                match fin {
                    _ if private => {}
                    Some('C') => out.push_str(&" ".repeat(n.min(256))),
                    Some('G' | '`') => out.push(' '),
                    Some('A' | 'B' | 'E' | 'F' | 'd' | 'H' | 'f') => out.push('\n'),
                    _ => {}
                }
            }
            Some(']') => {
                chars.next();
                while let Some(next) = chars.next() {
                    if next == '\u{7}' {
                        break;
                    }
                    if next == '\u{1b}' && chars.peek() == Some(&'\\') {
                        chars.next();
                        break;
                    }
                }
            }
            Some(_) => {
                chars.next();
            }
            None => {}
        }
    }
    out.lines()
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// What the app's session-log reader sees.
mod session_log {
    use super::*;
    use serde_json::json;

    const SID: &str = "5f0c2a9e-1b2c-4d3e-8f40-0123456789ab";

    fn kinds(records: &[Value]) -> Vec<String> {
        records
            .iter()
            .map(|r| {
                let kind = r["type"].as_str().unwrap_or("?");
                match r["subtype"].as_str() {
                    Some(sub) => format!("{kind}/{sub}"),
                    None => kind.to_string(),
                }
            })
            .collect()
    }

    #[test]
    fn a_reply_and_turn_duration_read_as_turn_done() {
        let home = FakeHome::new("fc_done");
        let scenario = json!({ "turns": [
            // No end_turn: only the turn_duration record ends this turn.
            { "steps": [ { "thinking": "Let me think." }, { "text": "All done." } ] }
        ]});
        let mut fake = home.run(
            &scenario,
            &[
                "--session-id",
                SID,
                "--model",
                "claude-sonnet-4-5",
                "--permission-mode",
                "auto",
                "Fix it",
            ],
        );
        let log = fake.wait_log(SID, |log| log.turn_done);
        assert!(log.turn_done, "screen:\n{}", fake.screen());
        assert!(!log.interrupted);
        assert_eq!(log.last_reply, "All done.");
        assert_eq!(log.permission_mode.as_deref(), Some("auto"));
        assert!(log.open_tool.is_none());

        let path = fake.log_path(SID).unwrap();
        let folder = path
            .parent()
            .unwrap()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_string();
        assert!(!folder.contains('/') && folder.starts_with('-'), "{folder}");
        let records = log_records(&path, false);
        let kinds = kinds(&records);
        assert_eq!(
            kinds
                .iter()
                .filter(|k| k.as_str() != "file-history-snapshot" && k.as_str() != "ai-title")
                .collect::<Vec<_>>(),
            vec!["user", "assistant", "assistant", "system/turn_duration"]
        );
        let prompt = records.iter().find(|r| r["type"] == "user").unwrap();
        assert_eq!(prompt["message"]["content"], json!("Fix it"));
        assert_eq!(prompt["sessionId"], json!(SID));
        assert_eq!(prompt["isSidechain"], json!(false));
        let cwd = std::fs::canonicalize(home.cwd.path()).unwrap();
        assert_eq!(
            std::fs::canonicalize(prompt["cwd"].as_str().unwrap()).unwrap(),
            cwd
        );
        let reply = records.iter().rfind(|r| r["type"] == "assistant").unwrap();
        assert_eq!(reply["message"]["stop_reason"], Value::Null);
        assert_eq!(reply["message"]["model"], json!("claude-sonnet-4-5"));
        let thinking = records.iter().find(|r| r["type"] == "assistant").unwrap();
        assert_eq!(reply["parentUuid"], thinking["uuid"]);
    }

    /// Claude Code encodes per UTF-16 unit (JS `replace(/[^a-zA-Z0-9]/g, "-")`),
    /// so an emoji (two units) becomes two dashes.
    #[test]
    fn the_project_folder_has_a_dash_per_utf16_unit() {
        let home = FakeHome::new("fc_encode");
        let cwd = home.cwd.join("x\u{1F600}y");
        std::fs::create_dir_all(&cwd).expect("create emoji cwd");
        let scenario = json!({ "turns": [ { "steps": [ { "reply": "Done." } ] }, { "exit": 0 } ] });
        let mut fake = home.run_in(&cwd, &scenario, &["--session-id", SID, "go"]);
        assert_eq!(fake.wait_exit(), Some(0), "screen:\n{}", fake.screen());
        let path = fake.log_path(SID).unwrap();
        let folder = path
            .parent()
            .unwrap()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_string();
        assert!(folder.ends_with("-x--y"), "{folder}");
    }

    #[test]
    fn esc_and_a_scripted_interrupt_end_the_turn_as_interrupted() {
        let home = FakeHome::new("fc_interrupt");
        let scenario = json!({ "turns": [
            { "steps": [ { "text": "Starting" }, { "delay_ms": 20000 }, { "reply": "never" } ] },
            { "steps": [ { "text": "Partial" }, { "interrupt": true }, { "reply": "never" } ] },
            { "steps": [ { "reply": "Third." } ] }
        ]});
        let mut fake = home.run(&scenario, &["--session-id", SID, "go"]);
        assert!(fake.wait_screen("Starting"), "screen:\n{}", fake.screen());
        fake.write(b"\x1b");
        let log = fake.wait_log(SID, |log| log.turn_done);
        assert!(log.turn_done && log.interrupted, "{log:?}");
        assert_eq!(log.last_reply, "Starting");

        fake.write(b"second\r");
        let log = fake.wait_log(SID, |log| log.last_reply == "Partial" && log.turn_done);
        assert!(log.interrupted, "{log:?}");

        fake.write(b"third\r");
        let log = fake.wait_log(SID, |log| log.last_reply == "Third." && log.turn_done);
        assert!(!log.interrupted, "{log:?}");
        let records = log_records(&fake.log_path(SID).unwrap(), false);
        let interrupts = records
            .iter()
            .filter(|r| {
                r["message"]["content"][0]["text"] == json!("[Request interrupted by user]")
            })
            .count();
        assert_eq!(interrupts, 2);
        assert!(!records.iter().any(|r| r.to_string().contains("never")));
    }

    #[test]
    fn a_rate_limit_error_ends_the_turn_and_the_reader_names_it() {
        let home = FakeHome::new("fc_rate_limit");
        let limit = "You've hit your limit · resets 3pm (Europe/London)";
        let scenario = json!({ "turns": [
            { "steps": [ { "text": "Starting" }, { "rate_limit": limit }, { "reply": "never" } ] },
            { "steps": [ { "reply": "Back again." } ] }
        ]});
        let mut fake = home.run(&scenario, &["--session-id", SID, "go"]);
        let log = fake.wait_log(SID, |log| log.turn_done);
        assert!(log.turn_done && !log.interrupted, "{log:?}");
        assert_eq!(log.rate_limit.as_deref(), Some(limit), "screen:\n{}", fake.screen());
        assert!(fake.screen().contains("hit your limit"), "screen:\n{}", fake.screen());

        // The next turn is a fresh one: no limit any more.
        fake.write(b"again\r");
        let log = fake.wait_log(SID, |log| log.last_reply == "Back again." && log.turn_done);
        assert_eq!(log.rate_limit, None, "{log:?}");
        let records = log_records(&fake.log_path(SID).unwrap(), false);
        assert!(!records.iter().any(|r| r.to_string().contains("never")), "the refused turn ended");
    }

    #[test]
    fn exit_plan_mode_is_the_open_tool_and_keep_planning_rejects_it() {
        let home = FakeHome::new("fc_plan");
        let scenario = json!({ "turns": [
            { "steps": [
                { "tool": "ExitPlanMode", "input": { "plan": "# Plan\n1. Do it" }, "permission": true },
                { "reply": "never" }
            ] },
            { "steps": [
                { "text": "Planning again." },
                { "tool": "ExitPlanMode", "input": { "plan": "# Plan\n1. Do it" }, "permission": true },
                { "reply": "Approved." }
            ] },
            { "steps": [ { "reply": "Next." } ] }
        ]});
        let mut fake = home.run(
            &scenario,
            &["--session-id", SID, "--permission-mode", "plan", "Plan it"],
        );
        let log = fake.wait_log(SID, |log| log.open_tool.is_some());
        let open = log.open_tool.as_ref().expect("open tool");
        assert_eq!(open.name, "ExitPlanMode");
        assert_eq!(log.plan.as_deref(), Some("# Plan\n1. Do it"));
        assert_eq!(log.permission_mode.as_deref(), Some("plan"));
        assert!(!log.turn_done);
        assert!(
            fake.wait_screen("No, keep planning"),
            "screen:\n{}",
            fake.screen()
        );

        fake.write(b"3");
        let log = fake.wait_log(SID, |log| log.turn_done);
        assert!(log.turn_done && log.interrupted, "{log:?}");
        assert!(log.open_tool.is_none());
        assert_eq!(log.tool_calls[0].status, ToolCallStatus::Failed);
        assert_eq!(log.plan.as_deref(), Some("# Plan\n1. Do it"));

        // Kept planning: still plan mode. Approving leaves it.
        fake.write(b"again\r");
        assert!(
            fake.wait_screen("Planning again."),
            "screen:\n{}",
            fake.screen()
        );
        let log = fake.wait_log(SID, |log| log.open_tool.is_some());
        assert_eq!(log.permission_mode.as_deref(), Some("plan"));
        fake.write(b"1");
        fake.wait_log(SID, |log| {
            log.last_reply.ends_with("Approved.") && log.turn_done
        });
        fake.write(b"next\r");
        let log = fake.wait_log(SID, |log| log.last_reply == "Next." && log.turn_done);
        assert_eq!(log.permission_mode.as_deref(), Some("acceptEdits"));
        let records = log_records(&fake.log_path(SID).unwrap(), false);
        let modes: Vec<&Value> = records
            .iter()
            .filter(|r| r["type"] == "user" && r["message"]["content"].is_string())
            .map(|r| &r["permissionMode"])
            .collect();
        assert_eq!(
            modes,
            vec![&json!("plan"), &json!("plan"), &json!("acceptEdits")]
        );
    }

    #[test]
    fn approving_a_plan_with_manual_edits_switches_to_default_mode() {
        let home = FakeHome::new("fc_plan_manual");
        let scenario = json!({ "turns": [
            { "steps": [
                { "tool": "ExitPlanMode", "input": { "plan": "# Plan\n1. Do it" }, "permission": true },
                { "reply": "Approved." }
            ] },
            { "steps": [ { "reply": "Next." } ] }
        ]});
        let mut fake = home.run(
            &scenario,
            &["--session-id", SID, "--permission-mode", "plan", "Plan it"],
        );
        let log = fake.wait_log(SID, |log| log.open_tool.is_some());
        assert_eq!(log.permission_mode.as_deref(), Some("plan"));
        assert!(
            fake.wait_screen("Yes, and manually approve edits"),
            "screen:\n{}",
            fake.screen()
        );

        // Option 2: leave plan mode, but ask before each edit.
        fake.write(b"2");
        fake.wait_log(SID, |log| {
            log.last_reply.ends_with("Approved.") && log.turn_done
        });
        fake.write(b"next\r");
        let log = fake.wait_log(SID, |log| log.last_reply == "Next." && log.turn_done);
        assert_eq!(log.permission_mode.as_deref(), Some("default"));
        let records = log_records(&fake.log_path(SID).unwrap(), false);
        let modes: Vec<&Value> = records
            .iter()
            .filter(|r| r["type"] == "user" && r["message"]["content"].is_string())
            .map(|r| &r["permissionMode"])
            .collect();
        assert_eq!(modes, vec![&json!("plan"), &json!("default")]);
        assert!(
            fake.wait_screen("? for shortcuts"),
            "screen:\n{}",
            fake.screen()
        );
        let screen = fake.screen();
        let after = &screen[screen.rfind("Approved.").expect("approved on screen")..];
        assert!(!after.contains("plan mode on"), "screen:\n{screen}");
    }

    #[test]
    fn sub_agent_records_stay_off_the_main_chain() {
        let home = FakeHome::new("fc_subagent");
        let scenario = json!({ "turns": [
            { "steps": [
                { "subagent": {
                    "description": "Explore code",
                    "prompt": "Find main",
                    "steps": [
                        { "tool": "Grep", "input": { "pattern": "fn main" } },
                        { "reply": "Found it in main.rs" }
                    ]
                } },
                { "reply": "Main says done." }
            ] }
        ]});
        let mut fake = home.run(&scenario, &["--session-id", SID, "Look around"]);
        let log = fake.wait_log(SID, |log| log.turn_done);
        assert!(log.turn_done, "{log:?}");
        assert_eq!(log.last_reply, "Main says done.");
        let names: Vec<&str> = log.tool_calls.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, vec!["Task"]);
        assert_eq!(log.tool_calls[0].status, ToolCallStatus::Completed);
        assert_eq!(log.tool_calls[0].title, "Task: Explore code");
        let records = log_records(&fake.log_path(SID).unwrap(), false);
        let side: Vec<&Value> = records
            .iter()
            .filter(|r| r["isSidechain"] == json!(true))
            .collect();
        assert_eq!(side.len(), 4, "prompt, Grep, its result, reply");
        assert!(side.iter().all(|r| r["sessionId"] == json!(SID)));
    }

    #[test]
    fn a_crash_mid_turn_leaves_an_unfinished_turn_and_a_held_back_line() {
        let home = FakeHome::new("fc_crash");
        let scenario = json!({ "turns": [
            { "steps": [
                { "tool": "Bash", "input": { "command": "ls" } },
                { "text": "Looking" },
                { "crash": true }
            ] }
        ]});
        let mut fake = home.run(&scenario, &["--session-id", SID, "go"]);
        let code = fake.wait_exit();
        assert_ne!(code, Some(0));
        let path = fake.log_path(SID).unwrap();
        let records = log_records(&path, true);
        assert_eq!(
            records.last().unwrap()["message"]["content"][0]["text"],
            json!("Looking")
        );
        assert_ne!(
            std::fs::read(&path).unwrap().last(),
            Some(&b'\n'),
            "a partial line"
        );
        let log = fake.wait_log(SID, |_| true);
        assert!(!log.turn_done, "{log:?}");
        assert_eq!(log.last_reply, "Looking");
        assert_eq!(log.tool_calls[0].status, ToolCallStatus::Completed);
    }

    #[test]
    fn resume_appends_to_the_same_log() {
        let home = FakeHome::new("fc_resume");
        let first = json!({ "turns": [ { "steps": [ { "reply": "First." } ] }, { "exit": 0 } ] });
        let mut fake = home.run(&first, &["--session-id", SID, "one"]);
        assert_eq!(fake.wait_exit(), Some(0));
        let path = fake.log_path(SID).unwrap();

        // An id already in use is refused, like Claude Code does.
        let mut again = home.run(&first, &["--session-id", SID, "one"]);
        assert_ne!(again.wait_exit(), Some(0));

        let second = json!({ "turns": [ { "steps": [ { "reply": "Second." } ] }, { "exit": 0 } ] });
        let mut resumed = home.run(
            &second,
            &["--resume", SID, "--permission-mode", "plan", "two"],
        );
        assert_eq!(resumed.wait_exit(), Some(0));
        assert_eq!(resumed.log_path(SID).unwrap(), path);
        let log = resumed.wait_log(SID, |log| log.turn_done);
        assert_eq!(log.last_reply, "Second.");
        assert_eq!(log.permission_mode.as_deref(), Some("plan"));
        let records = log_records(&path, false);
        let prompts: Vec<&Value> = records
            .iter()
            .filter(|r| r["type"] == "user")
            .map(|r| &r["message"]["content"])
            .collect();
        assert_eq!(prompts, vec![&json!("one"), &json!("two")]);
        assert!(records
            .iter()
            .all(|r| r.get("sessionId").is_none() || r["sessionId"] == json!(SID)));

        let unknown = "00000000-0000-4000-8000-000000000000";
        let mut missing = home.run(&second, &["--resume", unknown, "x"]);
        assert_ne!(missing.wait_exit(), Some(0));
        assert!(missing.log_path(unknown).is_none());
    }
}

/// What the bin draws in the PTY, how it takes input and how it stops.
mod pty {
    use super::*;
    use serde_json::json;

    const SID: &str = "7a1d3c5e-2f4b-4c6d-9e8f-abcdef012345";

    #[test]
    fn a_tool_awaiting_permission_is_the_open_tool_and_draws_the_dialog() {
        let home = FakeHome::new("fc_permission");
        let scenario = json!({ "turns": [
            { "steps": [
                { "tool": "Bash", "input": { "command": "npm test", "description": "Run tests" }, "permission": true },
                { "reply": "Tests pass." }
            ] }
        ]});
        let mut fake = home.run(&scenario, &["--session-id", SID, "Run the tests"]);
        let log = fake.wait_log(SID, |log| log.open_tool.is_some());
        let open = log.open_tool.as_ref().expect("open tool");
        assert_eq!(
            (open.name.as_str(), open.title.as_str(), open.hint.as_str()),
            ("Bash", "Bash: Run tests", "npm test")
        );
        assert!(!log.turn_done);
        // The lines `src/terminal/permissionDialog.ts` looks for, in order.
        assert!(fake.wait_screen("3. No"), "screen:\n{}", fake.screen());
        let screen = fake.screen();
        let lines: Vec<&str> = screen.lines().collect();
        let question = lines
            .iter()
            .rposition(|line| *line == "Do you want to proceed?")
            .unwrap_or_else(|| panic!("no question:\n{screen}"));
        assert!(
            lines[..question].contains(&"npm test"),
            "{screen}"
        );
        assert_eq!(lines[question + 1], "❯ 1. Yes", "{screen}");
        assert!(lines[question + 2].starts_with("2. Yes, and"), "{screen}");
        assert_eq!(lines[question + 3], "3. No", "{screen}");

        fake.write(b"1");
        let log = fake.wait_log(SID, |log| log.turn_done);
        assert!(log.turn_done && !log.interrupted, "{log:?}");
        assert_eq!(log.tool_calls[0].status, ToolCallStatus::Completed);
        assert_eq!(log.last_reply, "Tests pass.");
    }

    #[test]
    fn a_file_write_asks_to_create_the_file() {
        let home = FakeHome::new("fc_write");
        let scenario = json!({ "turns": [
            { "steps": [
                { "tool": "Write", "input": { "file_path": "/repo/note.txt", "content": "hi" }, "permission": true },
                { "reply": "Wrote it." }
            ] }
        ]});
        let mut fake = home.run(&scenario, &["--session-id", SID, "Write a note"]);
        assert!(fake.wait_screen("3. No"), "screen:\n{}", fake.screen());
        assert!(
            fake.screen().contains("Do you want to create note.txt?"),
            "{}",
            fake.screen()
        );
        let log = fake.wait_log(SID, |log| log.open_tool.is_some());
        assert_eq!(log.open_tool.as_ref().unwrap().hint, "note.txt");
        // Esc rejects it: the tool fails and the turn ends interrupted.
        fake.write(b"\x1b");
        let log = fake.wait_log(SID, |log| log.turn_done);
        assert!(log.interrupted, "{log:?}");
        assert_eq!(log.tool_calls[0].status, ToolCallStatus::Failed);
    }

    #[test]
    fn the_prompt_line_takes_typed_prompts_and_other_flags_are_ignored() {
        let home = FakeHome::new("fc_prompt");
        let scenario = json!({ "turns": [
            { "steps": [ { "reply": "One." } ] },
            { "steps": [ { "reply": "Two." } ] }
        ]});
        let mut fake = home.run(
            &scenario,
            &[
                "--settings",
                "{\"hooks\":{}}",
                "--allowedTools",
                "mcp__dcterminal__submit_result",
                "--verbose",
                "--session-id",
                SID,
            ],
        );
        assert!(fake.wait_screen("❯"), "screen:\n{}", fake.screen());
        fake.write(b"first prompt\r");
        fake.wait_log(SID, |log| log.last_reply == "One." && log.turn_done);
        fake.write(b"second prompt\r");
        let log = fake.wait_log(SID, |log| log.last_reply == "Two." && log.turn_done);
        assert!(log.turn_done);
        fake.write(b"/exit\r");
        assert_eq!(fake.wait_exit(), Some(0));
        let records = log_records(&fake.log_path(SID).unwrap(), false);
        let prompts: Vec<_> = records
            .iter()
            .filter(|r| r["type"] == "user")
            .map(|r| r["message"]["content"].clone())
            .collect();
        assert_eq!(prompts, vec![json!("first prompt"), json!("second prompt")]);
    }

    /// The run actor pastes a round sent back as one bracketed paste and
    /// Enter: its newlines stay in the one prompt, even split across reads.
    #[test]
    fn a_bracketed_paste_with_newlines_is_one_prompt() {
        let home = FakeHome::new("fc_paste");
        let scenario = json!({ "turns": [
            { "steps": [ { "reply": "One." } ] },
            { "steps": [ { "reply": "Two." } ] }
        ]});
        let mut fake = home.run(&scenario, &["--session-id", SID]);
        assert!(fake.wait_screen("❯"), "screen:\n{}", fake.screen());
        fake.write(b"\x1b[200~Review findings:\n\n1. [HIGH] It retries forever.\x1b[201~\r");
        fake.wait_log(SID, |log| log.last_reply == "One." && log.turn_done);
        // A marker cut in two by the PTY still counts.
        fake.write(b"\x1b[20");
        std::thread::sleep(Duration::from_millis(100));
        fake.write(b"0~line one\nline two\x1b[201~\r");
        fake.wait_log(SID, |log| log.last_reply == "Two." && log.turn_done);
        fake.write(b"/exit\r");
        assert_eq!(fake.wait_exit(), Some(0));
        let prompts: Vec<_> = log_records(&fake.log_path(SID).unwrap(), false)
            .iter()
            .filter(|r| r["type"] == "user")
            .map(|r| r["message"]["content"].clone())
            .collect();
        assert_eq!(
            prompts,
            vec![json!("Review findings:\n\n1. [HIGH] It retries forever."), json!("line one\nline two")]
        );
    }

    /// The S1 graceful stop: SIGTERM, then up to `STOP_GRACE` before SIGKILL.
    /// A record half written when SIGTERM lands is finished first.
    #[test]
    fn sigterm_mid_turn_still_leaves_a_complete_last_line() {
        let home = FakeHome::new("fc_sigterm");
        let long = format!("LONGREPLY {}", "word ".repeat(600));
        let scenario = json!({
            "write_chunk_ms": 10,
            "turns": [ { "steps": [ { "text": "Working" }, { "reply": long }, { "delay_ms": 20000 } ] } ]
        });
        let mut fake = home.run(&scenario, &["--session-id", SID, "go"]);
        // Wait until the long record is partly on disk.
        let deadline = Instant::now() + Duration::from_secs(15);
        let path = loop {
            assert!(Instant::now() < deadline, "the long reply never started");
            if let Some(path) = fake.log_path(SID) {
                let body = std::fs::read(&path).unwrap_or_default();
                let tail = body.rsplit(|b| *b == b'\n').next().unwrap_or_default();
                if String::from_utf8_lossy(tail).contains("LONGREPLY") {
                    break path;
                }
            }
            std::thread::sleep(Duration::from_millis(5));
        };
        fake.session.kill();
        let code = fake.wait_exit();
        let records = log_records(&path, false);
        let last = records.last().unwrap();
        assert_eq!(last["message"]["content"][0]["text"], json!(long));
        assert_eq!(last["message"]["stop_reason"], json!("end_turn"));
        assert_eq!(code, Some(143), "it exited on SIGTERM, not SIGKILL");
    }

    #[test]
    fn it_refuses_to_run_without_a_pinned_config_dir() {
        let home = FakeHome::new("fc_noconfig");
        let scenario = home.cwd.join("scenario.json");
        std::fs::write(&scenario, b"{\"turns\":[]}").unwrap();
        for config in [None, Some(""), Some("/nonexistent/.claude-account9")] {
            let mut command = std::process::Command::new(FAKE_CLAUDE);
            command
                .args(["--session-id", SID, "hi"])
                .current_dir(home.cwd.path())
                .env("DCT_FAKE_CLAUDE_SCENARIO", &scenario)
                .env_remove("CLAUDE_CONFIG_DIR")
                .stdin(std::process::Stdio::null());
            if let Some(dir) = config {
                command.env("CLAUDE_CONFIG_DIR", dir);
            }
            let out = command.output().expect("run fake_claude");
            assert_eq!(out.status.code(), Some(2), "{config:?}");
            let err = String::from_utf8_lossy(&out.stderr);
            assert!(err.contains("CLAUDE_CONFIG_DIR"), "{config:?}: {err}");
        }
        assert!(!std::path::Path::new("/nonexistent").exists());
    }
}

/// Track H3 over a real fake_claude: what the startup reconcile and the
/// stall watchdog (`pipelines::recovery`) make of quitting mid-turn,
/// quitting after the turn, and a tool that never returns. The logs are read
/// back through the app's reader, as the app does after a restart.
mod recovery {
    use super::*;
    use dcterminal_lib::testing::{
        current_stage_tabs, find_pipeline, reconcile_run, stop_stalled, turn_key, working,
        PipelineRun, Reconciled, RunStatus, StageKind, StallObservation, StallWatch, StopReason,
    };
    use serde_json::json;
    use std::collections::HashMap;

    const SID: &str = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";
    const TAB: &str = "tab_impl";

    /// An Eagle-Eye 1 run at the Implementer (tab `TAB`) with autopilot on,
    /// as `state.json` holds it.
    fn running_run() -> PipelineRun {
        serde_json::from_value(json!({
            "id": "ee_h3", "kind": "full", "cwd": "/tmp", "stage": "implementer",
            "tabIds": { "role_implementer": TAB }, "createdAt": "2026-10-19T00:00:00Z",
            "chainId": "ee_h3", "autopilot": { "enabled": true }, "status": "running"
        }))
        .unwrap()
    }

    /// The app quits: the terminal's program is stopped as app exit stops it.
    fn quit(fake: &mut FakeClaude) {
        fake.session.kill();
        fake.wait_exit();
    }

    /// After the restart: the log as a fresh reader sees it.
    fn reread(fake: &mut FakeClaude) -> HashMap<String, TerminalSessionLog> {
        let path = fake.log_path(SID).expect("log");
        let log = SessionLogReader::open(&path, SID).expect("reader").summary();
        HashMap::from([(TAB.to_string(), log)])
    }

    #[test]
    fn quit_mid_turn_is_noted_and_the_run_keeps_running_without_acting() {
        let home = FakeHome::new("h3_mid_turn");
        let scenario = json!({ "turns": [
            { "steps": [ { "text": "Working on it" }, { "delay_ms": 20000 }, { "reply": "Done." } ] }
        ]});
        let mut fake = home.run(&scenario, &["--session-id", SID, "Implement the plan"]);
        fake.wait_log(SID, |log| log.last_reply == "Working on it");
        quit(&mut fake);
        let logs = reread(&mut fake);
        assert!(!logs[TAB].turn_done, "{:?}", logs[TAB]);

        let def = find_pipeline("full").unwrap();
        let mut run = running_run();
        assert_eq!(reconcile_run(&def, &mut run, &logs), Some(Reconciled::CutOff));
        assert_eq!((run.status, run.stop_reason), (RunStatus::Running, None));
        assert!(run.events.last().unwrap().summary.contains("cut off when the app closed"));
        // Nothing was decided or handed on.
        assert!(run.claims.is_empty());
        assert!(run.autopilot.as_ref().unwrap().decided.is_empty());
    }

    #[test]
    fn quit_after_the_turn_waits_with_app_restarted_unless_it_was_decided() {
        let home = FakeHome::new("h3_after_turn");
        let scenario = json!({ "turns": [ { "steps": [ { "reply": "Implemented. Draft PR opened." } ] } ]});
        let mut fake = home.run(&scenario, &["--session-id", SID, "Implement the plan"]);
        fake.wait_log(SID, |log| log.turn_done);
        quit(&mut fake);
        let logs = reread(&mut fake);
        let def = find_pipeline("full").unwrap();

        let mut run = running_run();
        let found = reconcile_run(&def, &mut run, &logs);
        let Some(Reconciled::Waiting { tab_id, why }) = found else {
            panic!("not waiting: {found:?}");
        };
        assert_eq!(tab_id, TAB);
        assert!(why.contains("Press Continue"), "{why}");
        assert_eq!((run.status, run.stop_reason), (RunStatus::Waiting, Some(StopReason::AppRestarted)));
        assert!(run.claims.is_empty(), "never acts by itself");
        assert!(run.autopilot.as_ref().unwrap().decided.is_empty());

        // Decided before the quit: nothing to recover.
        let mut decided = running_run();
        decided.autopilot.as_mut().unwrap().decided.push(turn_key(TAB, &logs[TAB]));
        assert_eq!(reconcile_run(&def, &mut decided, &logs), None);
        assert_eq!(decided.status, RunStatus::Running);
    }

    /// Watch `fake` the way the watchdog does, every 50 ms, until it reports
    /// a stall or `within` passes.
    fn watch_for_stall(fake: &mut FakeClaude, limit: Duration, within: Duration) -> Option<(Duration, StallObservation)> {
        let mut watch = StallWatch::new();
        let mut reader: Option<SessionLogReader> = None;
        let deadline = Instant::now() + within;
        while Instant::now() < deadline {
            fake.pump(Duration::from_millis(50));
            if reader.is_none() {
                reader = fake.log_path(SID).and_then(|path| SessionLogReader::open(&path, SID));
            }
            let Some(reader) = reader.as_mut() else { continue };
            reader.refresh();
            let log = reader.summary();
            let seen = StallObservation {
                working: working(StageKind::Implementer, &log),
                log_len: std::fs::metadata(reader.path()).ok().map(|m| m.len()),
                pty_quiet: Some(fake.session.quiet_for()),
            };
            if let Some(quiet) = watch.observe("ee_h3|tab_impl", Instant::now(), seen, limit) {
                return Some((quiet, seen));
            }
        }
        None
    }

    #[test]
    fn a_hung_tool_stalls_the_run_and_a_finished_turn_does_not() {
        let limit = Duration::from_millis(800);
        let home = FakeHome::new("h3_hung_tool");
        let hung = json!({ "turns": [
            { "steps": [
                { "text": "Running the tests" },
                { "tool": "Bash", "input": { "command": "npm test" }, "pending": true },
                { "delay_ms": 30000 }
            ] }
        ]});
        let mut fake = home.run(&hung, &["--session-id", SID, "Implement the plan"]);
        let (quiet, seen) = watch_for_stall(&mut fake, limit, WAIT).expect("the hung tool never stalled");
        assert!(quiet >= limit && seen.working, "{quiet:?} {seen:?}");
        assert!(seen.pty_quiet.unwrap() >= limit, "the terminal was quiet too: {seen:?}");

        let def = find_pipeline("full").unwrap();
        let mut run = running_run();
        let tab = current_stage_tabs(&def, &run).remove(0);
        let why = stop_stalled(&mut run, &tab, quiet).unwrap();
        assert_eq!((run.status, run.stop_reason), (RunStatus::Waiting, Some(StopReason::Stalled)));
        assert!(why.starts_with("Implementer has been quiet for"), "{why}");
        quit(&mut fake);

        let other = FakeHome::new("h3_done_turn");
        let done = json!({ "turns": [ { "steps": [ { "reply": "Done." } ] } ]});
        let mut fake = other.run(&done, &["--session-id", SID, "Implement the plan"]);
        assert_eq!(watch_for_stall(&mut fake, limit, limit * 3), None, "a finished turn is not Working");
        quit(&mut fake);
    }
}

/// Pipeline v2 (V2a): a reviewer stage launched with the bridge's flags, as
/// `role_terminal_start` launches it, against the real `dcterminal bridge`
/// (hooks and the stdio MCP server). `fake_claude` runs the hooks and calls
/// the tool the way Claude Code does.
mod bridge {
    use super::*;
    use dcterminal_lib::testing::{
        bridged_command, claude_terminal_args, drain_inbox, launch_flags, prepare_stage, read_stage_turn, runs_root,
        BridgePlan, BridgeTag, BridgeTurn, InboxEvent, ProgramArgs, ResultKind, RunMode, TerminalKind, TerminalLaunch,
        TurnOutcome,
    };
    use serde_json::json;

    const DCTERMINAL: &str = env!("CARGO_BIN_EXE_dcterminal");
    const RUN: &str = "ee_1760000000000";
    const TAB: &str = "tab_pr_reviewer";
    const SID: &str = "6a1d3b0f-2c3d-4e5f-9a51-0123456789cd";

    struct Stage {
        home: FakeHome,
        runs: PathBuf,
        run_dir: PathBuf,
        _data: TempDir,
    }

    impl Stage {
        fn new(tag: &str, autopilot: bool) -> Self {
            let data = TempDir::new(&format!("{tag}_data"));
            let runs = runs_root(data.path());
            let plan = BridgePlan {
                run_id: RUN.into(),
                stage_id: "pr_reviewer".into(),
                role_id: "role_pr_reviewer".into(),
                lane: None,
                stage_key: "pr_reviewer".into(),
                kind: ResultKind::Reviewer,
                autopilot,
            };
            let run_dir = prepare_stage(&runs, &plan, TAB).expect("prepare stage");
            Self { home: FakeHome::new(tag), runs, run_dir, _data: data }
        }

        fn launch(&self, scenario: &Value) -> FakeClaude {
            // As role_terminal_start builds it: one --settings with the hooks
            // merged into the status line, the prompt last.
            let request = TerminalLaunch {
                kind: TerminalKind::Role {
                    role_id: "role_pr_reviewer".into(),
                    run_mode: RunMode::Default,
                    prompt: Some("Review PR1 and report your result.".into()),
                    stage_kind: None,
                },
                model: None,
                session_id: Some(SID.into()),
                settings: Some(json!({ "statusLine": { "type": "command", "command": "true" } })),
            };
            let flags = launch_flags(ResultKind::Reviewer, Path::new(DCTERMINAL), &self.run_dir, RUN, "pr_reviewer", TAB);
            let args = bridged_command(request, Some(flags), |req| {
                Ok(ProgramArgs::new("claude", claude_terminal_args(req)?))
            })
            .expect("bridged launch")
            .args;
            let args: Vec<&str> = args.iter().map(String::as_str).collect();
            self.home.run(scenario, &args)
        }

        /// Wait for the stage's turn to end; the turn as Continue reads it.
        fn wait_turn(&self, fake: &mut FakeClaude) -> BridgeTurn {
            let tag = BridgeTag { run_id: RUN.into(), stage: "pr_reviewer".into() };
            let deadline = Instant::now() + WAIT;
            loop {
                if let Some(turn) = read_stage_turn(&self.runs, &tag, TAB) {
                    return turn;
                }
                assert!(
                    Instant::now() < deadline,
                    "the turn never ended; screen:\n{}\nbridge.log: {}",
                    fake.screen(),
                    std::fs::read_to_string(self.run_dir.join("bridge.log")).unwrap_or_default()
                );
                fake.pump(Duration::from_millis(30));
            }
        }

        fn inbox(&self) -> Vec<BridgeTurn> {
            let mut events = Vec::new();
            drain_inbox(&self.runs, &mut |event| {
                if let InboxEvent::Turn(turn) = event {
                    events.push(turn);
                }
            });
            events
        }
    }

    fn submit(arguments: Value) -> Value {
        json!({ "mcp": "submit_result", "arguments": arguments })
    }

    #[test]
    fn a_reviewer_that_forgets_the_tool_is_blocked_once_then_submits() {
        let stage = Stage::new("bridge_forgets", true);
        let scenario = json!({ "turns": [
            {
                "steps": [{ "reply": "## HANDOFF: Verdict\nREQUEST CHANGES" }],
                "on_block": [[
                    // A wrong verdict word first: the tool names the problem.
                    submit(json!({ "verdict": "REQUEST CHANGES", "findings": [] })),
                    submit(json!({ "verdict": "CHANGES_REQUIRED", "findings": [
                        { "severity": "HIGH", "file": "src/auth.ts:42", "summary": "An expired token returns 500." }
                    ] })),
                    { "reply": "Submitted the result." }
                ]]
            },
            { "exit": 0 }
        ] });
        let mut fake = stage.launch(&scenario);
        let turn = stage.wait_turn(&mut fake);
        assert_eq!(turn.outcome, TurnOutcome::Result, "screen:\n{}", fake.screen());
        assert!(turn.blocked, "the first stop was blocked");
        assert_eq!(turn.last_assistant_message, "Submitted the result.");
        let result = turn.result.clone().expect("result");
        assert_eq!(result["verdict"], "CHANGES_REQUIRED");
        assert_eq!(result["findings"][0]["file"], "src/auth.ts:42");
        assert_eq!(fake.wait_exit(), Some(0));
        // The screen shows the block, and the tool's answers came back.
        let screen = fake.screen();
        assert!(screen.contains("Stop hook error"), "{screen}");
        assert!(screen.contains("mcp__dcterminal__submit_result"), "{screen}");
        // The watcher's view: exactly one finished turn.
        let events = stage.inbox();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].turn, turn.turn);
        assert_eq!(events[0].tab_id, TAB);
        // The session log has both tool calls; the first was refused with the problem named.
        let path = fake.log_path(SID).expect("log");
        let results: Vec<Value> = log_records(&path, false)
            .into_iter()
            .filter(|r| r["message"]["content"][0]["type"] == "tool_result")
            .map(|r| r["message"]["content"][0].clone())
            .collect();
        assert_eq!(results.len(), 2, "{results:?}");
        assert_eq!(results[0]["is_error"], true);
        assert!(results[0]["content"].as_str().unwrap().contains("`verdict` \"REQUEST CHANGES\" is not one of"));
        assert_eq!(results[1]["is_error"], false);
    }

    #[test]
    fn a_reviewer_that_never_submits_ends_with_no_result_after_one_block() {
        let stage = Stage::new("bridge_never", true);
        let scenario = json!({ "turns": [
            {
                "steps": [{ "reply": "Looks fine." }],
                "on_block": [[{ "reply": "Which verdict should I submit?" }], [{ "reply": "never reached" }]],
                // Only turn.json's blocked flag, read by the next hook process, ends the turn.
                "stop_hook_active_after_block": false
            },
            { "exit": 0 }
        ] });
        let mut fake = stage.launch(&scenario);
        let turn = stage.wait_turn(&mut fake);
        assert_eq!(turn.outcome, TurnOutcome::NoResult);
        assert!(turn.blocked);
        assert!(turn.result.is_none());
        assert_eq!(turn.last_assistant_message, "Which verdict should I submit?");
        assert_eq!(fake.wait_exit(), Some(0));
        assert!(!fake.screen().contains("never reached"), "blocked once, not twice");
        assert_eq!(fake.screen().matches("Stop hook error").count(), 1, "{}", fake.screen());
        assert_eq!(stage.inbox().len(), 1);
    }

    #[test]
    fn a_manual_run_is_never_blocked_but_keeps_the_result() {
        let stage = Stage::new("bridge_manual", false);
        let scenario = json!({ "turns": [
            {
                "steps": [
                    submit(json!({ "verdict": "APPROVED", "findings": [] })),
                    { "reply": "Approved." }
                ],
                "on_block": [[{ "reply": "never reached" }]]
            },
            { "steps": [{ "reply": "A question answered." }], "prompt": "One more thing?" },
            { "exit": 0 }
        ] });
        let mut fake = stage.launch(&scenario);
        assert_eq!(fake.wait_exit(), Some(0));
        let events = stage.inbox();
        assert_eq!(events.len(), 2, "{events:?}");
        assert_eq!(events[0].outcome, TurnOutcome::Result);
        assert_eq!(events[0].result.as_ref().unwrap()["verdict"], "APPROVED");
        assert!(!events[0].blocked);
        // A turn without the tool on a manual run just ends.
        assert_eq!(events[1].outcome, TurnOutcome::NoResult);
        assert_ne!(events[0].turn, events[1].turn, "each turn has its own prompt_id");
        assert!(!fake.screen().contains("never reached"));
    }
}

/// Pipeline v2 (V2b): a whole Eagle-Eye 1 on the bridge. Each stage runs as
/// `fake_claude` launched with its stage's bridge flags (the Planner in plan
/// mode with ExitPlanMode capture, the reviewers and the Implementer with
/// `submit_result`), against the real `dcterminal bridge`. Every turn end,
/// verdict, task list and pull request comes from the bridge's inbox and run
/// folder, and the Rust decision moves the run on from them; nothing parses
/// a reply.
mod eagle_eye_1 {
    use super::*;
    use dcterminal_lib::testing::{
        bridged_command, claude_terminal_args, decide, drain_inbox, find_pipeline, launch_flags, prepare_stage,
        read_run_tasks, runs_root, BridgeNeeds, BridgePlan, BridgeTurn, FindingReport, InboxEvent, NeedsSource,
        PipelineRun, ProgramArgs, ResultKind, RunMode, TerminalKind, TerminalLaunch, TurnOutcome, TurnReport,
    };
    use serde_json::json;

    const DCTERMINAL: &str = env!("CARGO_BIN_EXE_dcterminal");
    const RUN: &str = "ee_1760000000001";
    /// Planner, Plan Reviewer, Implementer, PR Reviewer.
    const SIDS: [&str; 4] = [
        "7b2e4c10-1a2b-4c3d-8e4f-000000000001",
        "7b2e4c10-1a2b-4c3d-8e4f-000000000002",
        "7b2e4c10-1a2b-4c3d-8e4f-000000000003",
        "7b2e4c10-1a2b-4c3d-8e4f-000000000004",
    ];

    /// One run folder and the events its inbox has had.
    struct Run {
        home: FakeHome,
        runs: PathBuf,
        run_dir: PathBuf,
        turns: Vec<BridgeTurn>,
        needs: Vec<BridgeNeeds>,
        _data: TempDir,
    }

    impl Run {
        fn new() -> Self {
            let data = TempDir::new("ee1_data");
            let runs = runs_root(data.path());
            let run_dir = runs.join(RUN);
            Self { home: FakeHome::new("ee1"), runs, run_dir, turns: Vec::new(), needs: Vec::new(), _data: data }
        }

        /// Launch `stage_id`'s claude in `tab`, bridged as `kind`, with session `sid`.
        fn launch(&self, stage_id: &str, role_id: &str, kind: ResultKind, tab: &str, sid: &str, scenario: &Value) -> FakeClaude {
            let plan = BridgePlan {
                run_id: RUN.into(),
                stage_id: stage_id.into(),
                role_id: role_id.into(),
                lane: None,
                stage_key: stage_id.into(),
                kind,
                autopilot: true,
            };
            let run_dir = prepare_stage(&self.runs, &plan, tab).expect("prepare stage");
            // As role_terminal_start builds it: one --settings (the hooks
            // merged into the status line), the role's permission mode, the
            // prompt last.
            let request = TerminalLaunch {
                kind: TerminalKind::Role {
                    role_id: role_id.into(),
                    run_mode: RunMode::Default,
                    prompt: Some(format!("Run the {stage_id} stage.")),
                    stage_kind: None,
                },
                model: None,
                session_id: Some(sid.into()),
                settings: Some(json!({ "statusLine": { "type": "command", "command": "true" } })),
            };
            let flags = launch_flags(kind, Path::new(DCTERMINAL), &run_dir, RUN, stage_id, tab);
            let args = bridged_command(request, Some(flags), |req| Ok(ProgramArgs::new("claude", claude_terminal_args(req)?)))
                .expect("bridged launch")
                .args;
            let args: Vec<&str> = args.iter().map(String::as_str).collect();
            self.home.run(scenario, &args)
        }

        fn drain(&mut self) {
            let (turns, needs) = (&mut self.turns, &mut self.needs);
            drain_inbox(&self.runs, &mut |event| match event {
                InboxEvent::Turn(turn) => turns.push(turn),
                InboxEvent::Needs(n) => needs.push(n),
            });
        }

        /// Pump until the inbox has a Needs you (the dialog is up), then return it.
        fn wait_needs(&mut self, fake: &mut FakeClaude) -> BridgeNeeds {
            let deadline = Instant::now() + WAIT;
            loop {
                self.drain();
                if let Some(needs) = self.needs.pop() {
                    return needs;
                }
                assert!(Instant::now() < deadline, "no Needs you; screen:\n{}", fake.screen());
                fake.pump(Duration::from_millis(30));
            }
        }

        /// Run `fake` to its exit, then the one turn it ended.
        fn finish(&mut self, fake: &mut FakeClaude, stage_id: &str) -> BridgeTurn {
            let code = fake.wait_exit();
            assert_eq!(
                code,
                Some(0),
                "{stage_id} did not exit; screen:\n{}\nbridge.log: {}",
                fake.screen(),
                std::fs::read_to_string(self.run_dir.join("bridge.log")).unwrap_or_default()
            );
            self.drain();
            let turn = self.turns.pop().unwrap_or_else(|| panic!("{stage_id}: no turn end; screen:\n{}", fake.screen()));
            assert_eq!(turn.stage_key, stage_id);
            assert!(self.turns.is_empty(), "{stage_id} ended one turn");
            turn
        }
    }

    /// The report the run actor builds from a bridge turn (`turn_report` in `src/run_actor/actor.rs`).
    fn report(turn: &BridgeTurn) -> TurnReport {
        let result = turn.result.clone().unwrap_or(Value::Null);
        TurnReport {
            stage_id: turn.stage_id.clone(),
            verdict: result["verdict"].as_str().map(str::to_string),
            findings: result["findings"]
                .as_array()
                .map(|items| {
                    items
                        .iter()
                        .map(|f| FindingReport {
                            severity: f["severity"].as_str().unwrap_or_default().to_string(),
                            summary: f["summary"].as_str().unwrap_or_default().to_string(),
                        })
                        .collect()
                })
                .unwrap_or_default(),
            findings_known: turn.outcome == TurnOutcome::Result,
            no_result: turn.outcome != TurnOutcome::Result,
            turn: Some(format!("{}|bridge|{}", turn.tab_id, turn.turn)),
            ..TurnReport::default()
        }
    }

    /// The tool results in a stage's session log, oldest first.
    fn tool_results(fake: &FakeClaude, sid: &str) -> Vec<Value> {
        let path = fake.log_path(sid).expect("log");
        log_records(&path, false)
            .into_iter()
            .filter(|r| r["message"]["content"][0]["type"] == "tool_result")
            .map(|r| r["message"]["content"][0].clone())
            .collect()
    }

    fn plan(tasks: &Value) -> String {
        format!(
            "# Plan: token refresh\n\n## HANDOFF: Plan\n1. Refresh tokens in src/auth.ts.\n\n## HANDOFF: Pull requests\n\
             * `PR1 — Refresh`: Depends on: none\n* `PR2 — Session UI`: Depends on: PR1\n\n```json\n{tasks}\n```\n\n\
             ## HANDOFF: Open questions\nNone.\n"
        )
    }

    #[test]
    fn turn_ends_verdicts_and_tasks_all_come_from_the_bridge() {
        let mut run = Run::new();
        let def = find_pipeline("eagle1").expect("Eagle-Eye 1");
        let mut state: PipelineRun = serde_json::from_value(json!({
            "id": RUN, "kind": "full", "cwd": "/repo", "stage": "planner", "tabIds": {},
            "createdAt": "2026-10-19T00:00:00Z", "status": "running",
            "autopilot": { "enabled": true, "passedCheckpoints": ["implementer"] }
        }))
        .unwrap();

        // 1. Planner (plan mode): a broken tasks block is sent back, the fixed
        //    plan is taken, and no approval dialog ever shows.
        let good = json!({ "tasks": [
            { "id": "pr1", "title": "Refresh", "dependsOn": [], "manual": false, "summary": "Refresh expired tokens." },
            { "id": "pr2", "title": "Session UI", "dependsOn": ["pr1"], "manual": false, "summary": "Show the session state." }
        ] });
        let broken = json!({ "tasks": [{ "id": "pr1", "title": "Refresh", "dependsOn": ["pr7"], "summary": "x" }] });
        let mut planner = run.launch(
            "planner",
            "role_planner",
            ResultKind::Planner,
            "tab_planner",
            SIDS[0],
            &json!({ "turns": [
                { "steps": [
                    { "tool": "ExitPlanMode", "input": { "plan": plan(&broken) }, "permission": true },
                    { "tool": "ExitPlanMode", "input": { "plan": plan(&good) }, "permission": true },
                    { "reply": "The plan is written and DCTerminal received it." }
                ] },
                { "exit": 0 }
            ] }),
        );
        let turn = run.finish(&mut planner, "planner");
        let screen = planner.screen();
        assert!(!screen.contains("Would you like to proceed"), "no plan dialog:\n{screen}");
        assert!(screen.contains("PreToolUse:ExitPlanMode hook error: Plan received"), "{screen}");
        let results = tool_results(&planner, SIDS[0]);
        assert_eq!(results.len(), 2, "{results:?}");
        assert_eq!(results[0]["is_error"], true);
        assert!(results[0]["content"].as_str().unwrap().contains("pr1 depends on \"pr7\", which is not a task"));
        assert!(results[1]["content"].as_str().unwrap().starts_with("Plan received by DCTerminal"));
        assert_eq!(turn.outcome, TurnOutcome::Result);
        assert!(!turn.blocked);
        assert_eq!(turn.last_assistant_message, "The plan is written and DCTerminal received it.");
        let tasks = read_run_tasks(&run.runs, RUN).expect("tasks.json");
        let ids: Vec<&str> = tasks.tasks.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, ["pr1", "pr2"]);
        assert_eq!(tasks.tasks[1].depends_on, ["pr1"]);
        assert_eq!(turn.result.as_ref().unwrap()["tasks"][1]["id"], "pr2");
        assert!(std::fs::read_to_string(run.run_dir.join("plan.md")).unwrap().contains("Refresh tokens in src/auth.ts"));
        let decision = decide(&def, &mut state, &report(&turn));
        assert_eq!((decision.action.as_str(), decision.stage_id.as_deref()), ("advance", Some("plan_reviewer")));

        // 2. Plan Reviewer: its verdict through submit_result.
        let mut reviewer = run.launch(
            "plan_reviewer",
            "role_plan_reviewer",
            ResultKind::Reviewer,
            "tab_plan_reviewer",
            SIDS[1],
            &json!({ "turns": [
                { "steps": [
                    { "mcp": "submit_result", "arguments": { "verdict": "APPROVED", "findings": [] } },
                    { "reply": "Approved." }
                ] },
                { "exit": 0 }
            ] }),
        );
        let turn = run.finish(&mut reviewer, "plan_reviewer");
        assert_eq!(turn.result.as_ref().unwrap()["verdict"], "APPROVED");
        let decision = decide(&def, &mut state, &report(&turn));
        assert_eq!((decision.action.as_str(), decision.stage_id.as_deref()), ("advance", Some("implementer")));

        // 3. Implementer: a permission dialog is Needs you at once (the
        //    Notification backup is not posted again), then its pull requests.
        let mut implementer = run.launch(
            "implementer",
            "role_implementer",
            ResultKind::Implementer,
            "tab_implementer",
            SIDS[2],
            &json!({ "turns": [
                { "steps": [
                    { "tool": "Bash", "input": { "command": "git push -u origin HEAD" }, "permission": true },
                    { "mcp": "submit_result", "arguments": {
                        "prs": [{ "url": "https://github.com/acme/app/pull/12", "branch": "feat/refresh", "title": "Refresh tokens" }],
                        "summary": "Expired tokens are refreshed once.",
                        "checks": [{ "command": "npm test", "passed": true }]
                    } },
                    { "reply": "Opened https://github.com/acme/app/pull/12" }
                ] },
                { "exit": 0 }
            ] }),
        );
        let needs = run.wait_needs(&mut implementer);
        assert_eq!(needs.source, NeedsSource::PermissionRequest);
        assert_eq!(needs.tool.as_deref(), Some("Bash"));
        assert_eq!(needs.tab_id, "tab_implementer");
        assert!(implementer.wait_screen("Do you want to proceed?"), "the dialog is still up for you");
        implementer.write(b"1");
        let turn = run.finish(&mut implementer, "implementer");
        assert!(run.needs.is_empty(), "one Needs you per prompt: {:?}", run.needs);
        assert_eq!(turn.outcome, TurnOutcome::Result);
        assert_eq!(turn.result.as_ref().unwrap()["prs"][0]["url"], "https://github.com/acme/app/pull/12");
        let prs: Value = serde_json::from_str(&std::fs::read_to_string(run.run_dir.join("prs.json")).unwrap()).unwrap();
        assert_eq!(prs["result"]["checks"][0]["command"], "npm test");
        let decision = decide(&def, &mut state, &report(&turn));
        assert_eq!((decision.action.as_str(), decision.stage_id.as_deref()), ("advance", Some("pr_reviewer")));

        // 4. PR Reviewer: changes required, so the round goes back to the Implementer.
        let mut reviewer = run.launch(
            "pr_reviewer",
            "role_pr_reviewer",
            ResultKind::Reviewer,
            "tab_pr_reviewer",
            SIDS[3],
            &json!({ "turns": [
                { "steps": [
                    { "mcp": "submit_result", "arguments": { "verdict": "CHANGES_REQUIRED", "findings": [
                        { "severity": "HIGH", "file": "src/auth.ts:42", "summary": "An expired token returns 500." }
                    ] } },
                    { "reply": "Changes required." }
                ] },
                { "exit": 0 }
            ] }),
        );
        let turn = run.finish(&mut reviewer, "pr_reviewer");
        assert_eq!(turn.result.as_ref().unwrap()["verdict"], "CHANGES_REQUIRED");
        let decision = decide(&def, &mut state, &report(&turn));
        assert_eq!((decision.action.as_str(), decision.stage_id.as_deref()), ("loopBack", Some("implementer")));
    }
}

/// Pipeline v2 (V3): a whole Eagle-Eye 1 run driven by the Rust run actor,
/// with no UI. Every stage after the Planner is opened by the actor as a
/// `fake_claude` terminal launched with its stage's bridge flags; the
/// actor hears each finished turn from the run's inbox, runs the gates,
/// decides and carries the decision out: it sends a plan review round back
/// into the running Planner, stops at the Implementer's checkpoint until
/// your Send (an actor message too), pastes a failed check's output back
/// into the Implementer, sends a PR review round back into the same
/// Implementer session, and completes the run when the PR Reviewer approves.
mod run_actor {
    use super::*;
    use dcterminal_lib::testing::{
        bridged_command, bundled_seed, claude_terminal_args, drain_inbox, launch_flags, prepare_stage, runs_root,
        ActorMsg, AppStateFile, BridgePlan, BridgeTag, ChainRef, GateDef, GateResult, Host, InboxEvent, PipelineRun,
        ProgramArgs, ResultKind, Role, RunActors, RunMode, RunStatus, StageLaunch, StateStore, StopReason,
        TerminalKind, TerminalLaunch, UserAction, MAIN_WINDOW_ID,
    };
    use serde_json::json;
    use std::collections::{HashMap, VecDeque};
    use std::sync::atomic::AtomicBool;
    use std::sync::{Arc, Mutex};

    const DCTERMINAL: &str = env!("CARGO_BIN_EXE_dcterminal");
    const RUN: &str = "ee_1760000000200";
    const PLANNER_SID: &str = "8c3f5d21-2b3c-4d4e-9f50-000000000001";
    /// The command gate: fails the first time it runs in a folder, then passes.
    const FLAKY_CHECK: &str = "if [ -f .check-failed-once ]; then echo 'all 12 tests passed'; \
        else touch .check-failed-once; echo 'FAIL src/auth.test.ts: expected 200, got 500'; exit 1; fi";

    struct Terminal {
        session: PtySession,
        screen: Arc<Mutex<Vec<u8>>>,
        exited: Arc<AtomicBool>,
    }

    /// The run actor's host: real `fake_claude` terminals in PTYs, a scenario
    /// per terminal it opens (by role, in order), and the command gate run
    /// for real with `sh` (the pull-request gate needs `gh`, so it passes).
    struct FakeHost {
        store: Mutex<StateStore>,
        runs: PathBuf,
        roles: Vec<Role>,
        home: FakeHome,
        scenarios: Mutex<HashMap<String, VecDeque<Value>>>,
        terminals: Mutex<HashMap<String, Terminal>>,
        launches: Mutex<Vec<StageLaunch>>,
        stops: Mutex<Vec<String>>,
        notices: Mutex<Vec<String>>,
        /// The pull requests each pull-request gate was given.
        pr_gate_urls: Mutex<Vec<Vec<String>>>,
        _data: TempDir,
    }

    impl FakeHost {
        fn start(&self, launch: &StageLaunch, scenario: &Value) {
            let file = self.home.cwd.join(format!("scenario-{}.json", now_nanos()));
            std::fs::write(&file, serde_json::to_vec(scenario).unwrap()).expect("write scenario");
            // As `start_actor_stage` builds it: one --settings with the
            // bridge's hooks merged into the status line, the prompt last.
            let request = TerminalLaunch {
                kind: TerminalKind::Role {
                    role_id: launch.role_id.clone(),
                    run_mode: RunMode::Default,
                    prompt: Some(launch.prompt.clone()),
                    stage_kind: None,
                },
                model: None,
                session_id: Some(launch.session_id.clone()),
                settings: Some(json!({ "statusLine": { "type": "command", "command": "true" } })),
            };
            let args = bridged_command(request, launch.bridge.clone(), |req| {
                Ok(ProgramArgs::new("claude", claude_terminal_args(req)?))
            })
            .expect("bridged launch")
            .args;
            let mut session = PtySession::spawn(SpawnSpec {
                program: FAKE_CLAUDE.into(),
                args,
                env: vec![
                    ("CLAUDE_CONFIG_DIR".into(), self.home.config.path().display().to_string()),
                    ("DCT_FAKE_CLAUDE_SCENARIO".into(), file.display().to_string()),
                ],
                cwd: launch.cwd.clone(),
                cols: 120,
                rows: 40,
            })
            .expect("spawn fake_claude");
            let output = session.take_output().expect("pty output");
            let screen = Arc::new(Mutex::new(Vec::new()));
            let exited = Arc::new(AtomicBool::new(false));
            let (into, done) = (screen.clone(), exited.clone());
            // Keep reading, or a full PTY buffer would stall the stage.
            std::thread::spawn(move || {
                while let Ok(event) = output.recv() {
                    match event {
                        PtyOutput::Data(bytes) => into.lock().unwrap().extend_from_slice(&bytes),
                        PtyOutput::Exit { .. } => {
                            done.store(true, Ordering::SeqCst);
                            return;
                        }
                    }
                }
            });
            self.terminals.lock().unwrap().insert(launch.tab_id.clone(), Terminal { session, screen, exited });
        }

        fn screens(&self) -> String {
            let terminals = self.terminals.lock().unwrap();
            terminals
                .iter()
                .map(|(tab, t)| format!("--- {tab} ---\n{}", plain_screen(&t.screen.lock().unwrap())))
                .collect::<Vec<_>>()
                .join("\n")
        }
    }

    impl Host for FakeHost {
        fn store(&self) -> &Mutex<StateStore> {
            &self.store
        }
        fn runs_root(&self) -> PathBuf {
            self.runs.clone()
        }
        fn bridge_program(&self) -> Option<PathBuf> {
            Some(PathBuf::from(DCTERMINAL))
        }
        fn role(&self, role_id: &str) -> Option<Role> {
            self.roles.iter().find(|r| r.id == role_id).cloned()
        }
        fn spawn_stage(&self, launch: &StageLaunch) -> Result<(), String> {
            let scenario = self
                .scenarios
                .lock()
                .unwrap()
                .get_mut(&launch.role_id)
                .and_then(VecDeque::pop_front)
                .ok_or_else(|| format!("no scenario left for {}", launch.role_id))?;
            self.start(launch, &scenario);
            self.launches.lock().unwrap().push(launch.clone());
            Ok(())
        }
        fn paste(&self, tab_id: &str, text: &str) -> Result<(), String> {
            let terminals = self.terminals.lock().unwrap();
            let terminal = terminals.get(tab_id).ok_or_else(|| format!("no terminal {tab_id}"))?;
            let mut bytes = b"\x1b[200~".to_vec();
            bytes.extend_from_slice(text.as_bytes());
            bytes.extend_from_slice(b"\x1b[201~\r");
            terminal.session.write(&bytes).map_err(|err| err.to_string())
        }
        fn terminal_live(&self, tab_id: &str) -> bool {
            self.terminals.lock().unwrap().get(tab_id).is_some_and(|t| !t.exited.load(Ordering::SeqCst))
        }
        fn run_gate(&self, gate: &GateDef, folder: &Path, pr_urls: &[String]) -> GateResult {
            let GateDef::Command { .. } = gate else {
                self.pr_gate_urls.lock().unwrap().push(pr_urls.to_vec());
                return GateResult {
                    kind: "pullRequest".into(),
                    label: "pull requests".into(),
                    status: "passed".into(),
                    summary: "Every pull request exists.".into(),
                    output: String::new(),
                    duration_ms: 0,
                    optional: false,
                };
            };
            let ran = std::process::Command::new("/bin/sh")
                .args(["-c", FLAKY_CHECK])
                .current_dir(folder)
                .output()
                .expect("run the check");
            let passed = ran.status.success();
            GateResult {
                kind: "command".into(),
                label: "npm run check".into(),
                status: if passed { "passed" } else { "failed" }.into(),
                summary: if passed { "Passed." } else { "Exited with code 1." }.into(),
                output: String::from_utf8_lossy(&ran.stdout).trim().to_string(),
                duration_ms: 1,
                optional: false,
            }
        }
        fn usage_percent(&self, _run_id: &str) -> Option<u8> {
            None
        }
        fn rate_limit(&self, _tab_id: &str) -> Option<String> {
            None
        }
        fn bridge_gate(&self, _run_id: &str, _stage_key: &str, _cwd: &Path) -> Result<bool, String> {
            Ok(true)
        }
        fn run_changed(&self, _run_id: &str) {}
        fn tab_opened(&self, _run_id: &str, _tab_id: &str) {}
        fn stopped(&self, _run_id: &str, _tab_id: Option<&str>, reason: StopReason, summary: &str) {
            self.stops.lock().unwrap().push(format!("{reason:?}: {summary}"));
        }
        fn notice(&self, _run_id: &str, title: &str, body: &str) {
            self.notices.lock().unwrap().push(format!("{title}: {body}"));
        }
    }

    impl Drop for FakeHost {
        fn drop(&mut self) {
            for terminal in self.terminals.lock().unwrap().values() {
                terminal.session.kill();
            }
        }
    }

    fn submit(arguments: Value) -> Value {
        json!({ "mcp": "submit_result", "arguments": arguments })
    }

    fn plan(version: &str) -> String {
        let tasks = json!({ "tasks": [
            { "id": "pr1", "title": "Refresh", "dependsOn": [], "manual": false, "summary": "Refresh expired tokens once." }
        ] });
        format!(
            "# Plan: token refresh ({version})\n\n## HANDOFF: Plan\n1. Refresh tokens in src/auth.ts.\n\n```json\n{tasks}\n```\n\n\
             ## HANDOFF: Open questions\nNone.\n"
        )
    }

    fn implemented(reply: &str) -> Value {
        json!({ "steps": [
            submit(json!({
                "prs": [{ "url": "https://github.com/acme/app/pull/12", "branch": "fix/refresh", "title": "Refresh tokens" }],
                "summary": "Expired tokens are refreshed once.",
                "checks": [{ "command": "npm test", "passed": true }]
            })),
            { "reply": reply }
        ] })
    }

    fn reviewed(verdict: &str, findings: Value) -> Value {
        json!({ "turns": [{ "steps": [submit(json!({ "verdict": verdict, "findings": findings })), { "reply": verdict }] }] })
    }

    /// Every scenario, by role, in the order the actor opens terminals.
    fn scenarios() -> HashMap<String, VecDeque<Value>> {
        HashMap::from([
            (
                "role_plan_reviewer".to_string(),
                VecDeque::from([
                    reviewed("CHANGES_REQUIRED", json!([{ "severity": "HIGH", "file": "src/auth.ts:42", "summary": "It retries forever." }])),
                    reviewed("APPROVED", json!([])),
                ]),
            ),
            (
                "role_implementer".to_string(),
                VecDeque::from([json!({ "turns": [
                    implemented("Opened https://github.com/acme/app/pull/12"),
                    implemented("Fixed the failing test."),
                    implemented("Addressed the review."),
                ] })]),
            ),
            (
                "role_pr_reviewer".to_string(),
                VecDeque::from([
                    reviewed("CHANGES_REQUIRED", json!([{ "severity": "MEDIUM", "file": "src/auth.ts:57", "summary": "No test for a second expiry." }])),
                    reviewed("APPROVED", json!([])),
                ]),
            ),
        ])
    }

    /// The user's own start of the Planner (the app's `role_terminal_start`):
    /// its tab on a new engine-2 chain, its run folder, its terminal.
    fn start_planner(host: &FakeHost) {
        let cwd = host.home.cwd.path().display().to_string();
        let planner = {
            let mut store = host.store.lock().unwrap();
            let role = host.roles.iter().find(|r| r.id == "role_planner").unwrap();
            let tab = store.create_draft_tab(role, &cwd, true, None).unwrap();
            let answers = HashMap::from([
                ("cwd".to_string(), cwd.clone()),
                ("taskType".to_string(), "Bug".to_string()),
                ("title".to_string(), "Expired tokens".to_string()),
                ("request".to_string(), "Refresh expired tokens instead of failing.".to_string()),
                ("expectedBehavior".to_string(), "One retry with a fresh token.".to_string()),
                ("currentBehavior".to_string(), "It returns 500.".to_string()),
            ]);
            store.data.tabs.iter_mut().find(|t| t.id == tab).unwrap().answers = answers;
            let chain = ChainRef { chain_id: RUN.into(), kind: "eagle1".into(), step: 1, total: 4, round: 1, lane: None };
            store.set_tab_chain(&tab, Some(chain), None).unwrap();
            let run = store.pipeline_run_by_id_mut(RUN).expect("the run");
            assert_eq!(run.engine, 2, "Eagle-Eye 1 runs on engine 2");
            run.set_autopilot_enabled(true);
            store.set_tab_bridge(&tab, Some(BridgeTag { run_id: RUN.into(), stage: "planner".into() })).unwrap();
            store.save().unwrap();
            tab
        };
        let bridge = BridgePlan {
            run_id: RUN.into(),
            stage_id: "planner".into(),
            role_id: "role_planner".into(),
            lane: None,
            stage_key: "planner".into(),
            kind: ResultKind::Planner,
            autopilot: true,
        };
        let run_dir = prepare_stage(&host.runs, &bridge, &planner).expect("prepare the Planner");
        let launch = StageLaunch {
            run_id: RUN.into(),
            tab_id: planner.clone(),
            role_id: "role_planner".into(),
            cwd: host.home.cwd.path().to_path_buf(),
            prompt: "Plan the token refresh.".into(),
            session_id: PLANNER_SID.into(),
            bridge: Some(launch_flags(ResultKind::Planner, Path::new(DCTERMINAL), &run_dir, RUN, "planner", &planner)),
        };
        host.start(
            &launch,
            &json!({ "turns": [
                { "steps": [
                    { "tool": "ExitPlanMode", "input": { "plan": plan("v1") }, "permission": true },
                    { "reply": "The plan is written." }
                ] },
                { "steps": [
                    { "tool": "ExitPlanMode", "input": { "plan": plan("v2") }, "permission": true },
                    { "reply": "The plan is revised." }
                ] }
            ] }),
        );
    }

    fn snapshot(host: &FakeHost) -> PipelineRun {
        host.store.lock().unwrap().pipeline_run_by_id(RUN).cloned().expect("the run")
    }

    fn ledger(run: &PipelineRun) -> String {
        run.events
            .iter()
            .map(|e| format!("{} [{}] {}", e.kind, e.outcome.clone().unwrap_or_default(), e.summary))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// The user prompts in a stage's session log, oldest first.
    fn prompts(host: &FakeHost, session_id: &str) -> Vec<String> {
        let path = find_session_log(host.home.config.path(), session_id).expect("session log");
        log_records(&path, false)
            .into_iter()
            .filter(|r| r["type"] == "user" && r["message"]["content"].is_string())
            .map(|r| r["message"]["content"].as_str().unwrap_or_default().to_string())
            .collect()
    }

    #[test]
    fn a_whole_eagle_eye_1_runs_on_the_actor_with_a_loop_back_and_a_failed_gate() {
        let data = TempDir::new("actor_ee1_data");
        let home = FakeHome::new("actor_ee1");
        let state = StateStore {
            path: data.join("state.json"),
            data: AppStateFile::default(),
            new_tab_provider: dcterminal_lib::provider::ProviderId::DEFAULT,
            draft_window: MAIN_WINDOW_ID.to_string(),
        };
        let host = Arc::new(FakeHost {
            store: Mutex::new(state),
            runs: runs_root(data.path()),
            roles: bundled_seed().expect("roles").roles,
            home,
            scenarios: Mutex::new(scenarios()),
            terminals: Mutex::new(HashMap::new()),
            launches: Mutex::new(Vec::new()),
            stops: Mutex::new(Vec::new()),
            notices: Mutex::new(Vec::new()),
            pr_gate_urls: Mutex::new(Vec::new()),
            _data: data,
        });
        let actors = RunActors::new(host.clone());
        start_planner(&host);

        // The app's inbox watcher, and you at the checkpoint.
        let deadline = Instant::now() + Duration::from_secs(90);
        let mut sent = false;
        loop {
            drain_inbox(&host.runs, &mut |event| {
                if let InboxEvent::Turn(turn) = event {
                    let run_id = turn.run_id.clone();
                    actors.send(&run_id, ActorMsg::Turn(turn));
                }
            });
            let run = snapshot(&host);
            match (run.status, run.stop_reason) {
                (RunStatus::Complete, _) => break,
                (RunStatus::Waiting, Some(StopReason::Checkpoint)) if !sent => {
                    sent = true;
                    let reviewer = run.tab_ids["role_plan_reviewer"].clone();
                    let outcome = actors
                        .ask(
                            RUN,
                            UserAction::Send {
                                source_tab_id: reviewer,
                                target_role_id: "role_implementer".into(),
                                values: None,
                                handoff_plan: None,
                                handoff_text: None,
                                force: false,
                            },
                            Duration::from_secs(30),
                        )
                        .expect("your Send");
                    assert!(outcome.tab_id.is_some() && outcome.warning.is_none(), "{outcome:?}");
                }
                (RunStatus::Running, _) => {}
                (status, reason) if !(status == RunStatus::Waiting && reason == Some(StopReason::Checkpoint)) => panic!(
                    "the run stopped: {status:?} {reason:?}\nledger:\n{}\nstops: {:?}\n{}",
                    ledger(&run),
                    host.stops.lock().unwrap(),
                    host.screens()
                ),
                _ => {}
            }
            assert!(
                Instant::now() < deadline,
                "the run never completed\nledger:\n{}\n{}\nbridge.log: {}",
                ledger(&run),
                host.screens(),
                std::fs::read_to_string(host.runs.join(RUN).join("bridge.log")).unwrap_or_default()
            );
            std::thread::sleep(Duration::from_millis(30));
        }

        let run = snapshot(&host);
        let all = ledger(&run);
        // Every stage the actor opened, in order: the review rounds each got
        // a new reviewer, the rounds sent back went into the running stages.
        let roles: Vec<String> = host.launches.lock().unwrap().iter().map(|l| l.role_id.clone()).collect();
        assert_eq!(
            roles,
            ["role_plan_reviewer", "role_plan_reviewer", "role_implementer", "role_pr_reviewer", "role_pr_reviewer"],
            "{all}"
        );
        // The loop-backs: the plan review round, then the PR review round.
        let sent_back: Vec<&str> =
            run.events.iter().filter(|e| e.kind == "loopBack").map(|e| e.summary.as_str()).collect();
        assert_eq!(sent_back, ["Round 1 sent back (REQUIRES REVISION)", "Round 2 sent back (REQUEST CHANGES)"], "{all}");
        // The failed gate, its retry, then passes.
        let gates: Vec<&str> = run
            .events
            .iter()
            .filter(|e| e.kind == "gate" && e.summary.starts_with("npm run check"))
            .map(|e| e.outcome.as_deref().unwrap_or_default())
            .collect();
        assert_eq!(gates, ["failed", "passed", "passed"], "{all}");
        assert!(run.events.iter().any(|e| e.outcome.as_deref() == Some("retry")), "{all}");
        assert_eq!(run.events.last().map(|e| e.kind.as_str()), Some("complete"), "{all}");
        assert!(host.notices.lock().unwrap().iter().any(|n| n.starts_with("Run complete")));
        assert!(host.stops.lock().unwrap().iter().all(|s| s.starts_with("Checkpoint")), "{:?}", host.stops.lock().unwrap());

        // The Planner was asked once to revise, in its own session.
        let planner = prompts(&host, PLANNER_SID);
        assert_eq!(planner.len(), 2, "{planner:?}");
        assert!(planner[1].starts_with("Review findings from the Plan Reviewer (round 1):"), "{}", planner[1]);
        assert!(planner[1].contains("1. [HIGH] src/auth.ts:42: It retries forever."), "{}", planner[1]);
        // One Implementer session: its prompt from plan.md, the check's output, the review round.
        let implementer = host.launches.lock().unwrap()[2].clone();
        assert!(implementer.prompt.contains("(v2)"), "the revised plan from plan.md");
        assert!(implementer.prompt.contains("Bug Fix"));
        let turns = prompts(&host, &implementer.session_id);
        assert_eq!(turns.len(), 3, "{turns:?}");
        assert!(turns[1].contains("FAIL src/auth.test.ts: expected 200, got 500"), "{}", turns[1]);
        assert!(turns[2].starts_with("Review findings from the PR Reviewer (round 1):"), "{}", turns[2]);
        assert!(turns[2].contains("src/auth.ts:57: No test for a second expiry."), "{}", turns[2]);
        // The PR Reviewer read the pull request from prs.json.
        let reviewer = host.launches.lock().unwrap()[3].clone();
        assert!(
            reviewer.prompt.contains("Pull request: https://github.com/acme/app/pull/12 (branch `fix/refresh`)"),
            "{}",
            reviewer.prompt
        );
        // Each second review is told what its own first round sent back.
        let launches = host.launches.lock().unwrap().clone();
        assert!(launches[1].prompt.contains("It retries forever."), "{}", launches[1].prompt);
        assert!(launches[4].prompt.contains("No test for a second expiry."), "{}", launches[4].prompt);
        assert!(!launches[4].prompt.contains("It retries forever."), "not the plan review's findings");
        assert_eq!(run.verdicts.len(), 2);
        assert_eq!((run.round, run.status), (3, RunStatus::Complete));
        // Each Implementer turn's pull-request gate checked the pull request
        // it reported through submit_result.
        let pr_gates = host.pr_gate_urls.lock().unwrap().clone();
        assert!(!pr_gates.is_empty());
        for urls in &pr_gates {
            assert_eq!(urls, &vec!["https://github.com/acme/app/pull/12".to_string()], "{pr_gates:?}");
        }
    }
}
