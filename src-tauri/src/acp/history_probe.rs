//! Live probe JT runs on a logged-in Windows CLI. It prints what each history
//! option actually does. Unit tests cover the verdict rules only.
//!
//! ```text
//! cd src-tauri
//! cargo test live_cli_history_probe -- --ignored --nocapture --test-threads=1
//! ```
//!
//! The probe spawns `agent`, which writes its own session files. DCTerminal's
//! app code does not.

use super::connection::{AcpConnection, LineDispatch};
use super::session_connect::{
    capabilities_from_initialize, initialize_params, load_session_params, AgentCapabilities,
};
use crate::cli_detect::resolve_agent_executable;
use crate::process_tree::{prepare_command, SharedProcess};
use crate::supervisor::AgentSupervisor;
use serde_json::{json, Value};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const CODE_WORD: &str = "ORCHID";
const PROMPT_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProbeVerdict {
    Yes,
    No,
    Inconclusive,
}

#[derive(Debug, Clone)]
pub struct BindAttemptObs {
    pub label: String,
    pub error: Option<String>,
    pub session_id: Option<String>,
    pub session_id_equals_chat: bool,
    pub acp_dir: bool,
    pub chat_dir: bool,
}

#[derive(Debug, Clone)]
pub struct CreateChatBindObs {
    pub chat_id: Option<String>,
    pub attempts: Vec<BindAttemptObs>,
}

#[derive(Debug, Clone)]
pub struct CliResumeObs {
    pub spawn_error: Option<String>,
    pub timed_out: bool,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, Clone)]
pub struct LoadObs {
    pub load_session_advertised: bool,
    pub load_error: Option<String>,
    pub replay_contains_code_word: bool,
    pub prompt_error: Option<String>,
    pub prompt_contains_code_word: bool,
}

pub fn classify_create_chat_bind(obs: &CreateChatBindObs) -> (ProbeVerdict, String) {
    if obs.chat_id.is_none() {
        return (
            ProbeVerdict::Inconclusive,
            "create-chat did not return an id".to_string(),
        );
    }
    if obs.attempts.iter().any(|attempt| {
        attempt.error.is_none()
            && (attempt.session_id_equals_chat
                || (attempt.chat_dir && attempt.session_id.is_some()))
    }) {
        return (
            ProbeVerdict::Yes,
            "a session/new attempt returned the create-chat id or wrote that id under chats/"
                .to_string(),
        );
    }
    if obs.attempts.is_empty() {
        return (
            ProbeVerdict::Inconclusive,
            "no session/new binding attempts ran".to_string(),
        );
    }
    (
        ProbeVerdict::No,
        "session/new did not return the create-chat id and did not land it under chats/"
            .to_string(),
    )
}

pub fn classify_cli_resume(obs: &CliResumeObs) -> (ProbeVerdict, String) {
    if let Some(err) = &obs.spawn_error {
        return (
            ProbeVerdict::Inconclusive,
            format!("could not spawn agent --resume: {err}"),
        );
    }
    let blob = format!("{}\n{}", obs.stdout, obs.stderr).to_lowercase();
    if looks_like_missing_session(&blob) {
        return (
            ProbeVerdict::No,
            "agent --resume reported that the ACP session id is not a CLI chat".to_string(),
        );
    }
    if obs.timed_out {
        return (
            ProbeVerdict::Inconclusive,
            "agent --resume did not exit before the timeout".to_string(),
        );
    }
    if obs.exit_code == Some(0) && blob.contains(&CODE_WORD.to_lowercase()) {
        return (
            ProbeVerdict::Yes,
            "agent --resume exited 0 and the reply contained the code word from the ACP session"
                .to_string(),
        );
    }
    if obs.exit_code == Some(0) {
        return (
            ProbeVerdict::Inconclusive,
            "agent --resume exited 0 but the reply did not contain the ACP code word".to_string(),
        );
    }
    (
        ProbeVerdict::No,
        format!("agent --resume exited {:?}", obs.exit_code),
    )
}

pub fn classify_session_load(obs: &LoadObs) -> (ProbeVerdict, String) {
    if !obs.load_session_advertised {
        return (
            ProbeVerdict::No,
            "initialize did not advertise agentCapabilities.loadSession".to_string(),
        );
    }
    if let Some(err) = &obs.load_error {
        return (ProbeVerdict::No, format!("session/load failed: {err}"));
    }
    if obs.replay_contains_code_word || obs.prompt_contains_code_word {
        return (
            ProbeVerdict::Yes,
            "session/load restored the ACP session and the code word came back".to_string(),
        );
    }
    if obs.prompt_error.is_some() {
        return (
            ProbeVerdict::Inconclusive,
            "session/load returned success but the follow-up prompt failed, and the code word was not in the replay"
                .to_string(),
        );
    }
    (
        ProbeVerdict::Inconclusive,
        "session/load returned success but the code word was not in the replay or the follow-up reply"
            .to_string(),
    )
}

fn looks_like_missing_session(blob: &str) -> bool {
    blob.contains("not found")
        || blob.contains("no conversation")
        || blob.contains("unknown session")
        || blob.contains("session not")
        || blob.contains("could not resume")
        || blob.contains("no chat")
}

pub fn parse_create_chat_id(stdout: &str) -> Option<String> {
    for token in stdout.split_whitespace() {
        let trimmed = token
            .trim_matches(|c: char| matches!(c, '"' | '\'' | ',' | '`' | '[' | ']' | '(' | ')'));
        if crate::session_id::validate_acp_session_id(trimmed).is_ok() && trimmed.contains('-') {
            return Some(trimmed.to_string());
        }
    }
    None
}

struct Captured {
    exit_code: Option<i32>,
    timed_out: bool,
    stdout: String,
    stderr: String,
    spawn_error: Option<String>,
}

fn run_agent(args: &[&str], cwd: &Path, timeout: Duration) -> Captured {
    let Some(agent) = resolve_agent_executable() else {
        return Captured {
            exit_code: None,
            timed_out: false,
            stdout: String::new(),
            stderr: String::new(),
            spawn_error: Some("agent executable not found".to_string()),
        };
    };
    let mut command = Command::new(&agent);
    command.args(args).current_dir(cwd).stdin(Stdio::null());
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    prepare_command(&mut command);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(err) => {
            return Captured {
                exit_code: None,
                timed_out: false,
                stdout: String::new(),
                stderr: String::new(),
                spawn_error: Some(err.to_string()),
            };
        }
    };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let shared = match SharedProcess::from_child(child) {
        Ok(shared) => shared,
        Err(err) => {
            return Captured {
                exit_code: None,
                timed_out: false,
                stdout: String::new(),
                stderr: String::new(),
                spawn_error: Some(err.to_string()),
            };
        }
    };
    let stdout_task = thread::spawn(move || read_capped(stdout, 64 * 1024));
    let stderr_task = thread::spawn(move || read_capped(stderr, 64 * 1024));
    if let Err(err) = shared.resume() {
        shared.kill_tree();
        return Captured {
            exit_code: None,
            timed_out: false,
            stdout: String::new(),
            stderr: String::new(),
            spawn_error: Some(err.to_string()),
        };
    }
    let started = Instant::now();
    let mut exit_code = None;
    let mut timed_out = false;
    loop {
        match shared.try_wait() {
            Ok(Some(status)) => {
                exit_code = status.code();
                break;
            }
            Ok(None) if started.elapsed() >= timeout => {
                timed_out = true;
                shared.kill_tree();
                break;
            }
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(err) => {
                shared.kill_tree();
                return Captured {
                    exit_code: None,
                    timed_out: false,
                    stdout: stdout_task.join().unwrap_or_default(),
                    stderr: stderr_task.join().unwrap_or_default(),
                    spawn_error: Some(err.to_string()),
                };
            }
        }
    }
    Captured {
        exit_code,
        timed_out,
        stdout: stdout_task.join().unwrap_or_default(),
        stderr: stderr_task.join().unwrap_or_default(),
        spawn_error: None,
    }
}

fn read_capped(pipe: Option<impl Read>, max: usize) -> String {
    let Some(mut pipe) = pipe else {
        return String::new();
    };
    let mut buf = vec![0u8; 8 * 1024];
    let mut out = Vec::new();
    loop {
        match pipe.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if out.len() >= max {
                    continue;
                }
                let room = max - out.len();
                out.extend_from_slice(&buf[..n.min(room)]);
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn with_acp<T>(
    cwd: &Path,
    body: impl FnOnce(&mut AcpConnection) -> Result<T, String>,
) -> Result<T, String> {
    let agent =
        resolve_agent_executable().ok_or_else(|| "agent executable not found".to_string())?;
    let mut conn = AgentSupervisor::spawn_acp(&agent, cwd)?;
    let result = body(&mut conn);
    conn.kill();
    result
}

fn cursor_home() -> Option<PathBuf> {
    crate::cursor_history::cursor_data_dir()
}

fn id_has_dir(root: &Path, id: &str) -> bool {
    if id.contains("..") || id.contains('/') || id.contains('\\') {
        return false;
    }
    if root.join(id).is_dir() {
        return true;
    }
    let Ok(projects) = std::fs::read_dir(root) else {
        return false;
    };
    for project in projects.flatten() {
        if project.path().join(id).is_dir() {
            return true;
        }
    }
    false
}

fn print_captured(label: &str, captured: &Captured) {
    println!("--- {label} ---");
    if let Some(err) = &captured.spawn_error {
        println!("spawn error: {err}");
    }
    println!(
        "exit={:?} timed_out={}",
        captured.exit_code, captured.timed_out
    );
    println!("stdout:\n{}", clip(&captured.stdout));
    println!("stderr:\n{}", clip(&captured.stderr));
}

fn clip(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.len() <= 2000 {
        return trimmed.to_string();
    }
    let mut end = 2000;
    while end > 0 && !trimmed.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &trimmed[..end])
}

fn summarize_keys(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let keys: Vec<_> = map.keys().cloned().collect();
            format!("object keys={keys:?}")
        }
        other => format!("{other}"),
    }
}

fn update_kind(note: &Value) -> String {
    note.pointer("/params/update/sessionUpdate")
        .or_else(|| note.pointer("/params/update/type"))
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string()
}

/// Runs the three experiments and prints a summary. Does not assert a verdict.
pub fn run_live_cli_history_probe() -> Result<String, String> {
    let agent =
        resolve_agent_executable().ok_or_else(|| "agent executable not found".to_string())?;
    let cwd = std::env::current_dir().map_err(|err| err.to_string())?;
    println!("=== DCTerminal Cursor CLI history probe ===");
    println!("This spawns real `agent` processes and spends a few model turns.");
    println!("Code word: {CODE_WORD}");
    println!("agent: {}", agent.display());
    println!("cwd: {}", cwd.display());

    let version = run_agent(&["--version"], &cwd, Duration::from_secs(20));
    print_captured("agent --version", &version);
    for (label, args) in [
        ("agent --help", &["--help"][..]),
        ("agent acp --help", &["acp", "--help"][..]),
        ("agent ls --help", &["ls", "--help"][..]),
        ("agent resume --help", &["resume", "--help"][..]),
    ] {
        let help = run_agent(args, &cwd, Duration::from_secs(20));
        print_captured(label, &help);
    }

    let created = run_agent(&["create-chat"], &cwd, Duration::from_secs(30));
    print_captured("agent create-chat", &created);
    let chat_id =
        parse_create_chat_id(&created.stdout).or_else(|| parse_create_chat_id(&created.stderr));
    println!("parsed create-chat id: {chat_id:?}");

    println!("--- baseline ACP session ---");
    let baseline = with_acp(&cwd, |conn| baseline_session(conn, &cwd))?;
    println!("baseline sessionId: {}", baseline.session_id);
    println!(
        "capabilities: loadSession={} list={} resume={} close={}",
        baseline.capabilities.load_session,
        baseline.capabilities.session_list,
        baseline.capabilities.session_resume,
        baseline.capabilities.session_close
    );
    println!(
        "initialize agentCapabilities: {}",
        baseline.capabilities_json
    );
    println!("session/list: {}", baseline.list_summary);
    println!("baseline prompt: {}", baseline.prompt_summary);

    let cursor = cursor_home();
    let acp_dir = cursor
        .as_ref()
        .is_some_and(|root| id_has_dir(&root.join("acp-sessions"), &baseline.session_id));
    let chat_dir = cursor.as_ref().is_some_and(|root| {
        id_has_dir(&root.join("chats"), &baseline.session_id)
            || chat_id
                .as_ref()
                .is_some_and(|id| id_has_dir(&root.join("chats"), id))
    });
    println!("baseline id under acp-sessions/: {acp_dir}");
    println!("baseline or create-chat id under chats/: {chat_dir}");

    let mut attempts = Vec::new();
    if let Some(chat_id) = chat_id.clone() {
        for (label, extra) in bind_extras(&chat_id) {
            println!("--- binding attempt {label} ---");
            let attempt = with_acp(&cwd, |conn| bind_attempt(conn, &cwd, &extra));
            match attempt {
                Ok(obs) => {
                    println!(
                        "sessionId={:?} equals_chat={} error={:?}",
                        obs.session_id, obs.session_id_equals_chat, obs.error
                    );
                    let mut obs = obs;
                    obs.label = label.to_string();
                    if let Some(id) = obs.session_id.clone() {
                        obs.acp_dir = cursor
                            .as_ref()
                            .is_some_and(|root| id_has_dir(&root.join("acp-sessions"), &id));
                        obs.chat_dir = cursor
                            .as_ref()
                            .is_some_and(|root| id_has_dir(&root.join("chats"), &id));
                    }
                    println!("acp_dir={} chat_dir={}", obs.acp_dir, obs.chat_dir);
                    attempts.push(obs);
                }
                Err(err) => {
                    println!("attempt failed before a result: {err}");
                    attempts.push(BindAttemptObs {
                        label: label.to_string(),
                        error: Some(err),
                        session_id: None,
                        session_id_equals_chat: false,
                        acp_dir: false,
                        chat_dir: false,
                    });
                }
            }
        }
    }

    println!("--- (b) agent --resume <acpSessionId> ---");
    let resume = run_agent(
        &[
            "--resume",
            &baseline.session_id,
            "-p",
            "What code word did I give you? Reply with that word only.",
        ],
        &cwd,
        Duration::from_secs(90),
    );
    print_captured("agent --resume <acpSessionId> -p", &resume);
    let ls = run_agent(&["ls"], &cwd, Duration::from_secs(8));
    print_captured("agent ls (8s timeout; it may be interactive)", &ls);
    let ls_blob = format!("{}\n{}", ls.stdout, ls.stderr);
    println!(
        "agent ls output contains ACP session id: {}",
        ls_blob.contains(&baseline.session_id)
    );

    println!("--- (c) session/load <acpSessionId> ---");
    let load = with_acp(&cwd, |conn| load_baseline(conn, &cwd, &baseline.session_id))?;
    println!("load error: {:?}", load.load_error);
    println!("replay kinds: {:?}", load.kinds);
    println!(
        "replay contains code word: {}",
        load.replay_contains_code_word
    );
    println!("prompt error: {:?}", load.prompt_error);
    println!(
        "prompt contains code word: {}",
        load.prompt_contains_code_word
    );
    println!("prompt reply:\n{}", clip(&load.prompt_reply));

    let (a_verdict, a_reason) = classify_create_chat_bind(&CreateChatBindObs {
        chat_id: chat_id.clone(),
        attempts,
    });
    let (b_verdict, b_reason) = classify_cli_resume(&CliResumeObs {
        spawn_error: resume.spawn_error.clone(),
        timed_out: resume.timed_out,
        exit_code: resume.exit_code,
        stdout: resume.stdout.clone(),
        stderr: resume.stderr.clone(),
    });
    let (c_verdict, c_reason) = classify_session_load(&LoadObs {
        load_session_advertised: baseline.capabilities.load_session,
        load_error: load.load_error.clone(),
        replay_contains_code_word: load.replay_contains_code_word,
        prompt_error: load.prompt_error.clone(),
        prompt_contains_code_word: load.prompt_contains_code_word,
    });

    let summary = format!(
        "=== summary ===\n(a) create-chat bind: {a_verdict:?} — {a_reason}\n(b) agent --resume <acpSessionId>: {b_verdict:?} — {b_reason}\n(c) session/load: {c_verdict:?} — {c_reason}\n"
    );
    println!("{summary}");
    Ok(summary)
}

struct Baseline {
    session_id: String,
    capabilities: AgentCapabilities,
    capabilities_json: String,
    list_summary: String,
    prompt_summary: String,
}

fn baseline_session(conn: &mut AcpConnection, cwd: &Path) -> Result<Baseline, String> {
    let timeout = super::connection::default_io_timeout();
    let init = conn.call(1, "initialize", initialize_params(), timeout)?;
    let capabilities = capabilities_from_initialize(&init);
    let capabilities_json = init
        .get("agentCapabilities")
        .cloned()
        .unwrap_or(Value::Null)
        .to_string();
    conn.call(
        2,
        "authenticate",
        json!({ "methodId": "cursor_login" }),
        timeout,
    )?;
    let list_summary = if capabilities.session_list {
        match conn.call(
            3,
            "session/list",
            json!({ "cwd": cwd.display().to_string() }),
            timeout,
        ) {
            Ok(value) => summarize_keys(&value),
            Err(err) => format!("error: {err}"),
        }
    } else {
        "not advertised, not called".to_string()
    };
    let created = conn.call(
        4,
        "session/new",
        json!({ "cwd": cwd.display().to_string(), "mcpServers": [] }),
        timeout,
    )?;
    let session_id = created
        .get("sessionId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "session/new missing sessionId".to_string())?
        .to_string();
    let mut dispatch = LineDispatch::default();
    let prompt = conn.call_with_dispatch(
        5,
        "session/prompt",
        json!({
            "sessionId": session_id,
            "prompt": [{
                "type": "text",
                "text": format!("The code word is {CODE_WORD}. Reply with only the word OK.")
            }]
        }),
        PROMPT_TIMEOUT,
        &mut dispatch,
        None,
    );
    let prompt_summary = match prompt {
        Ok(value) => format!("ok {}", summarize_keys(&value)),
        Err(err) => format!("error: {err}"),
    };
    Ok(Baseline {
        session_id,
        capabilities,
        capabilities_json,
        list_summary,
        prompt_summary,
    })
}

fn bind_extras(chat_id: &str) -> Vec<(&'static str, Value)> {
    vec![
        ("sessionId", json!({ "sessionId": chat_id })),
        ("chatId", json!({ "chatId": chat_id })),
        ("_meta.chatId", json!({ "_meta": { "chatId": chat_id } })),
    ]
}

fn bind_attempt(
    conn: &mut AcpConnection,
    cwd: &Path,
    extra: &Value,
) -> Result<BindAttemptObs, String> {
    let timeout = super::connection::default_io_timeout();
    conn.call(1, "initialize", initialize_params(), timeout)?;
    conn.call(
        2,
        "authenticate",
        json!({ "methodId": "cursor_login" }),
        timeout,
    )?;
    let mut params = json!({
        "cwd": cwd.display().to_string(),
        "mcpServers": []
    });
    if let (Some(obj), Some(extra_obj)) = (params.as_object_mut(), extra.as_object()) {
        for (key, value) in extra_obj {
            obj.insert(key.clone(), value.clone());
        }
    }
    match conn.call(3, "session/new", params, timeout) {
        Ok(value) => {
            let session_id = value
                .get("sessionId")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let chat_id = extra
                .get("sessionId")
                .or_else(|| extra.get("chatId"))
                .or_else(|| extra.pointer("/_meta/chatId"))
                .and_then(|v| v.as_str());
            Ok(BindAttemptObs {
                label: String::new(),
                error: None,
                session_id_equals_chat: session_id.as_deref() == chat_id && chat_id.is_some(),
                session_id,
                acp_dir: false,
                chat_dir: false,
            })
        }
        Err(err) => Ok(BindAttemptObs {
            label: String::new(),
            error: Some(err),
            session_id: None,
            session_id_equals_chat: false,
            acp_dir: false,
            chat_dir: false,
        }),
    }
}

struct LoadResult {
    load_error: Option<String>,
    kinds: Vec<String>,
    replay_contains_code_word: bool,
    prompt_error: Option<String>,
    prompt_contains_code_word: bool,
    prompt_reply: String,
}

fn load_baseline(
    conn: &mut AcpConnection,
    cwd: &Path,
    session_id: &str,
) -> Result<LoadResult, String> {
    let timeout = super::connection::default_io_timeout();
    let init = conn.call(1, "initialize", initialize_params(), timeout)?;
    let caps = capabilities_from_initialize(&init);
    if !caps.load_session {
        return Ok(LoadResult {
            load_error: Some("loadSession not advertised".to_string()),
            kinds: Vec::new(),
            replay_contains_code_word: false,
            prompt_error: Some("not called".to_string()),
            prompt_contains_code_word: false,
            prompt_reply: String::new(),
        });
    }
    conn.call(
        2,
        "authenticate",
        json!({ "methodId": "cursor_login" }),
        timeout,
    )?;
    let mut dispatch = LineDispatch::default();
    let loaded = conn.call_with_dispatch(
        3,
        "session/load",
        load_session_params(session_id, &cwd.display().to_string()),
        super::session_connect::LOAD_TIMEOUT,
        &mut dispatch,
        None,
    );
    if let Err(err) = loaded {
        return Ok(LoadResult {
            load_error: Some(err),
            kinds: Vec::new(),
            replay_contains_code_word: false,
            prompt_error: Some("not called".to_string()),
            prompt_contains_code_word: false,
            prompt_reply: String::new(),
        });
    }
    let replay_text = dispatch
        .notifications
        .iter()
        .map(|note| note.to_string())
        .collect::<Vec<_>>()
        .join("\n");
    let kinds: Vec<String> = dispatch.notifications.iter().map(update_kind).collect();
    let prompt = conn.call_with_dispatch(
        4,
        "session/prompt",
        json!({
            "sessionId": session_id,
            "prompt": [{
                "type": "text",
                "text": "What code word did I give you? Reply with that word only."
            }]
        }),
        PROMPT_TIMEOUT,
        &mut dispatch,
        None,
    );
    let (prompt_error, prompt_reply) = match prompt {
        Ok(value) => (None, value.to_string()),
        Err(err) => (Some(err), String::new()),
    };
    let prompt_blob = format!(
        "{prompt_reply}\n{}",
        dispatch
            .notifications
            .iter()
            .map(|note| note.to_string())
            .collect::<Vec<_>>()
            .join("\n")
    );
    Ok(LoadResult {
        load_error: None,
        kinds,
        replay_contains_code_word: replay_text.contains(CODE_WORD),
        prompt_error,
        prompt_contains_code_word: prompt_blob.contains(CODE_WORD),
        prompt_reply,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_uuid_from_create_chat_stdout() {
        let id = parse_create_chat_id("  11111111-2222-3333-4444-555555555555\n").unwrap();
        assert_eq!(id, "11111111-2222-3333-4444-555555555555");
    }

    #[test]
    fn create_chat_bind_is_no_when_ids_differ_and_nothing_lands_in_chats() {
        let (verdict, _) = classify_create_chat_bind(&CreateChatBindObs {
            chat_id: Some("11111111-2222-3333-4444-555555555555".into()),
            attempts: vec![BindAttemptObs {
                label: "sessionId".into(),
                error: None,
                session_id: Some("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee".into()),
                session_id_equals_chat: false,
                acp_dir: true,
                chat_dir: false,
            }],
        });
        assert_eq!(verdict, ProbeVerdict::No);
    }

    #[test]
    fn create_chat_bind_is_yes_when_the_returned_id_matches() {
        let (verdict, _) = classify_create_chat_bind(&CreateChatBindObs {
            chat_id: Some("11111111-2222-3333-4444-555555555555".into()),
            attempts: vec![BindAttemptObs {
                label: "_meta.chatId".into(),
                error: None,
                session_id: Some("11111111-2222-3333-4444-555555555555".into()),
                session_id_equals_chat: true,
                acp_dir: false,
                chat_dir: true,
            }],
        });
        assert_eq!(verdict, ProbeVerdict::Yes);
    }

    #[test]
    fn cli_resume_without_the_code_word_is_not_a_yes() {
        let (verdict, _) = classify_cli_resume(&CliResumeObs {
            spawn_error: None,
            timed_out: false,
            exit_code: Some(0),
            stdout: "pong".into(),
            stderr: String::new(),
        });
        assert_eq!(verdict, ProbeVerdict::Inconclusive);
        let (missing, _) = classify_cli_resume(&CliResumeObs {
            spawn_error: None,
            timed_out: false,
            exit_code: Some(1),
            stdout: String::new(),
            stderr: "Error: session not found".into(),
        });
        assert_eq!(missing, ProbeVerdict::No);
    }

    #[test]
    fn session_load_yes_requires_the_code_word() {
        let (verdict, _) = classify_session_load(&LoadObs {
            load_session_advertised: true,
            load_error: None,
            replay_contains_code_word: true,
            prompt_error: None,
            prompt_contains_code_word: false,
        });
        assert_eq!(verdict, ProbeVerdict::Yes);
        let (missing, _) = classify_session_load(&LoadObs {
            load_session_advertised: true,
            load_error: Some("Session not found".into()),
            replay_contains_code_word: false,
            prompt_error: None,
            prompt_contains_code_word: false,
        });
        assert_eq!(missing, ProbeVerdict::No);
    }

    #[test]
    #[ignore = "requires a logged-in Cursor CLI; spends a few model turns"]
    fn live_cli_history_probe() {
        let summary = run_live_cli_history_probe().expect("probe failed to start");
        println!("{summary}");
        assert!(summary.contains("=== summary ==="));
    }
}
