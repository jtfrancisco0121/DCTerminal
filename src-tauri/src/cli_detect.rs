use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliDetectResult {
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub error: Option<String>,
}

/// Resolve the `agent` executable (FR-001). Settings override is T1.4 / settings.json.
pub fn resolve_agent_executable() -> Option<PathBuf> {
    if let Ok(override_path) = std::env::var("DCT_AGENT_PATH") {
        let path = PathBuf::from(override_path);
        if path.is_file() {
            return Some(path);
        }
    }

    if let Some(path) = find_on_path("agent") {
        return Some(path);
    }

    known_install_candidates()
        .into_iter()
        .find(|candidate| candidate.is_file())
}

pub fn agent_missing_message() -> String {
    "Cursor CLI (agent) was not found. Install it from https://cursor.com/docs/cli/installation, \
     add it to PATH (on Windows the shim is often %LOCALAPPDATA%\\cursor-agent\\agent.cmd), \
     or set DCT_AGENT_PATH to the executable. Then run `agent login` in a terminal."
        .to_string()
}

pub fn detect_agent() -> CliDetectResult {
    match resolve_agent_executable() {
        Some(path) => {
            let version = read_agent_version(&path);
            CliDetectResult {
                found: true,
                path: Some(path.display().to_string()),
                version,
                error: None,
            }
        }
        None => CliDetectResult {
            found: false,
            path: None,
            version: None,
            error: Some(agent_missing_message()),
        },
    }
}

#[tauri::command]
pub fn detect_cli() -> CliDetectResult {
    detect_agent()
}

fn read_agent_version(agent: &Path) -> Option<String> {
    let output = Command::new(agent).arg("--version").output();
    match output {
        Ok(out) if out.status.success() => {
            let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if text.is_empty() {
                None
            } else {
                Some(text)
            }
        }
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            if stderr.is_empty() {
                None
            } else {
                Some(stderr)
            }
        }
        Err(_) => None,
    }
}

fn find_on_path(binary: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        for candidate in candidate_names(binary) {
            let full = dir.join(&candidate);
            if full.is_file() {
                return Some(full);
            }
        }
    }
    None
}

fn candidate_names(binary: &str) -> Vec<String> {
    #[cfg(windows)]
    {
        let mut names = Vec::new();
        if let Ok(pathext) = std::env::var("PATHEXT") {
            for ext in pathext.split(';') {
                let ext = ext.trim();
                if ext.is_empty() {
                    continue;
                }
                let ext = if ext.starts_with('.') {
                    ext.to_string()
                } else {
                    format!(".{}", ext)
                };
                names.push(format!("{}{}", binary, ext));
            }
        }
        names.push(format!("{}.exe", binary));
        names.push(format!("{}.cmd", binary));
        names.push(binary.to_string());
        names
    }
    #[cfg(not(windows))]
    {
        vec![binary.to_string()]
    }
}

pub fn known_install_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    #[cfg(windows)]
    {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            candidates.push(PathBuf::from(local).join("cursor-agent").join("agent.cmd"));
        }
    }
    #[cfg(not(windows))]
    {
        if let Ok(home) = std::env::var("HOME") {
            candidates.push(PathBuf::from(home).join(".local").join("bin").join("agent"));
        }
    }
    candidates
}

/// F8: whether the Cursor CLI is signed in, from `agent status`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LoginStatus {
    /// `loggedIn`, `loggedOut`, `unknown`, or `noCli`.
    pub state: String,
    pub account: Option<String>,
    /// Short text to show when the state is not clear.
    pub detail: Option<String>,
    /// `CURSOR_API_KEY` is set (its value is never read back).
    pub api_key_env: bool,
}

/// Read `agent status` output (JSON or text). Never touches credential files.
pub fn parse_login_status(stdout: &str, stderr: &str, _success: bool) -> LoginStatus {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(stdout.trim()) {
        if let Some(status) = login_from_json(&value) {
            return status;
        }
    }
    let text = strip_ansi(&format!("{stdout}\n{stderr}"));
    // ASCII lowering keeps byte offsets, so `find` positions index `text` safely.
    let lower = text.to_ascii_lowercase();
    const SIGNED_OUT: [&str; 6] = [
        "not logged in",
        "not authenticated",
        "logged out",
        "not signed in",
        "unauthenticated",
        "please log in",
    ];
    if SIGNED_OUT.iter().any(|needle| lower.contains(needle)) {
        return with_state("loggedOut", None);
    }
    for marker in ["logged in as", "authenticated as", "signed in as"] {
        if let Some(at) = lower.find(marker) {
            let rest = &text[at + marker.len()..];
            let account = rest
                .lines()
                .next()
                .unwrap_or("")
                .trim()
                .trim_end_matches('.')
                .to_string();
            return with_state("loggedIn", (!account.is_empty()).then_some(account));
        }
    }
    if lower.contains("logged in") || lower.contains("login successful") {
        return with_state("loggedIn", None);
    }
    let detail: String = text.trim().chars().take(200).collect();
    unknown_status((!detail.is_empty()).then_some(detail))
}

fn with_state(state: &str, account: Option<String>) -> LoginStatus {
    LoginStatus {
        state: state.into(),
        account,
        detail: None,
        api_key_env: false,
    }
}

fn login_from_json(value: &serde_json::Value) -> Option<LoginStatus> {
    let obj = value.as_object()?;
    let find_bool = |keys: &[&str]| {
        obj.iter()
            .find(|(k, _)| keys.iter().any(|key| k.eq_ignore_ascii_case(key)))
            .and_then(|(_, v)| v.as_bool())
    };
    let account = ["email", "userEmail", "account", "username"]
        .iter()
        .find_map(|key| obj.get(*key).and_then(|v| v.as_str()))
        .or_else(|| {
            obj.get("user")
                .and_then(|u| u.get("email").or_else(|| u.get("name")))
                .and_then(|v| v.as_str())
        })
        .map(str::to_string);
    let signed_in = find_bool(&["isAuthenticated", "authenticated", "loggedIn", "isLoggedIn"])
        .or_else(|| {
            let status = obj
                .get("status")?
                .as_str()?
                .to_lowercase()
                .replace(['_', '-'], " ");
            if status.contains("not") || status.contains("out") || status.contains("unauth") {
                Some(false)
            } else if status.contains("logged in") || status.contains("authenticated") {
                Some(true)
            } else {
                None
            }
        })?;
    Some(if signed_in {
        with_state("loggedIn", account)
    } else {
        with_state("loggedOut", None)
    })
}

fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for next in chars.by_ref() {
                    if next.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

const STATUS_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// Run `agent <args>` without a window, with a timeout. Returns stdout, stderr, success.
fn run_agent(agent: &Path, args: &[&str]) -> Result<(String, String, bool), String> {
    use std::io::Read;
    use std::process::Stdio;
    let mut command = Command::new(agent);
    command
        .args(args)
        .env("NO_COLOR", "1")
        .env("NO_OPEN_BROWSER", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command
        .spawn()
        .map_err(|err| format!("could not run agent {}: {err}", args.join(" ")))?;
    let mut stdout = child.stdout.take().ok_or("no stdout")?;
    let mut stderr = child.stderr.take().ok_or("no stderr")?;
    let out_thread = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stdout.read_to_string(&mut text);
        text
    });
    let err_thread = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stderr.read_to_string(&mut text);
        text
    });
    let deadline = std::time::Instant::now() + STATUS_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if std::time::Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("agent {} timed out", args.join(" ")));
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(50)),
            Err(err) => return Err(err.to_string()),
        }
    };
    Ok((
        out_thread.join().unwrap_or_default(),
        err_thread.join().unwrap_or_default(),
        status.success(),
    ))
}

/// F8: ask the CLI itself (`agent status`) whether it is signed in. Read-only:
/// DCTerminal never opens the CLI's credential store.
pub fn agent_login_status() -> LoginStatus {
    let api_key_env = std::env::var_os("CURSOR_API_KEY").is_some_and(|v| !v.is_empty());
    let Some(agent) = resolve_agent_executable() else {
        return LoginStatus {
            state: "noCli".into(),
            account: None,
            detail: Some(agent_missing_message()),
            api_key_env,
        };
    };
    let mut status = match run_agent(&agent, &["status", "--format", "json"]) {
        Ok((out, err, ok)) => parse_login_status(&out, &err, ok),
        Err(err) => unknown_status(Some(err)),
    };
    if status.state == "unknown" {
        // Older CLIs may not know `--format`; read the plain text instead.
        status = match run_agent(&agent, &["status"]) {
            Ok((out, err, ok)) => parse_login_status(&out, &err, ok),
            Err(err) => unknown_status(Some(err)),
        };
    }
    status.api_key_env = api_key_env;
    status
}

#[tauri::command]
pub async fn cli_login_status() -> Result<LoginStatus, String> {
    tauri::async_runtime::spawn_blocking(agent_login_status)
        .await
        .map_err(|err| err.to_string())
}

fn unknown_status(detail: Option<String>) -> LoginStatus {
    LoginStatus {
        state: "unknown".into(),
        account: None,
        detail,
        api_key_env: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_signed_in_text_status() {
        let status = parse_login_status(
            "\u{1b}[32m ✓ Logged in as jt@example.com\u{1b}[0m\n",
            "",
            true,
        );
        assert_eq!(status.state, "loggedIn");
        assert_eq!(status.account.as_deref(), Some("jt@example.com"));
    }

    #[test]
    fn reads_signed_out_text_before_the_words_logged_in() {
        for text in [
            "Not logged in. Run `agent login`.",
            "✗ Not authenticated",
            "You are logged out",
        ] {
            let status = parse_login_status(text, "", true);
            assert_eq!(status.state, "loggedOut", "{text}");
            assert_eq!(status.account, None);
        }
        let status = parse_login_status("", "Error: not logged in", false);
        assert_eq!(status.state, "loggedOut");
    }

    #[test]
    fn reads_json_status_shapes() {
        let status = parse_login_status(
            r#"{"isAuthenticated":true,"email":"jt@example.com","endpoint":"https://api2.cursor.sh"}"#,
            "",
            true,
        );
        assert_eq!(status.state, "loggedIn");
        assert_eq!(status.account.as_deref(), Some("jt@example.com"));
        let status = parse_login_status(r#"{"authenticated":false}"#, "", true);
        assert_eq!(status.state, "loggedOut");
        let status = parse_login_status(
            r#"{"status":"logged_in","user":{"email":"a@b.c"}}"#,
            "",
            true,
        );
        assert_eq!(status.state, "loggedIn");
        assert_eq!(status.account.as_deref(), Some("a@b.c"));
        let status = parse_login_status(r#"{"status":"not_logged_in"}"#, "", true);
        assert_eq!(status.state, "loggedOut");
    }

    #[test]
    fn unclear_output_is_unknown_with_a_short_detail() {
        let noise = "x".repeat(500);
        let status = parse_login_status(&noise, "", false);
        assert_eq!(status.state, "unknown");
        assert!(status.detail.unwrap().chars().count() <= 200);
        assert_eq!(parse_login_status("", "", true).state, "unknown");
    }

    #[test]
    fn known_windows_candidate_points_at_cursor_agent_shim() {
        #[cfg(windows)]
        {
            let candidates = known_install_candidates();
            assert!(
                candidates
                    .iter()
                    .any(|p| p.to_string_lossy().contains("cursor-agent")),
                "expected cursor-agent install candidate"
            );
        }
    }

    #[test]
    fn resolves_agent_when_on_path() {
        let result = detect_agent();
        // Developer machines with Cursor CLI should find it; CI may not.
        if result.found {
            assert!(result.path.is_some());
            assert!(result.version.is_some());
        }
    }
}
