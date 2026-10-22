//! Gates: checks the app runs itself after a stage's turn (ADR-014). A
//! command gate runs a shell command in the stage's folder; a pull-request
//! gate asks `gh` that every pull request the stage reported exists. Both
//! run through the user's login shell, so a GUI launch finds `npm`, `cargo`
//! and `gh` on the same PATH as a terminal.

use crate::process_tree::{prepare_command, SharedProcess};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// A command gate's limit when the pipeline sets none.
pub const DEFAULT_GATE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const PR_GATE_TIMEOUT: Duration = Duration::from_secs(60);
const OUTPUT_LINES: usize = 120;
const OUTPUT_CHARS: usize = 12_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GateResult {
    /// `command`, `pullRequest` or `contract`.
    pub kind: String,
    /// What ran, e.g. `npm run check`.
    pub label: String,
    /// `passed`, `failed` or `skipped`.
    pub status: String,
    pub summary: String,
    /// Last lines of the output (failures only carry what is useful).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub output: String,
    pub duration_ms: u64,
    /// The gate is marked `optional`: an `auto` check with nothing to run
    /// is skipped instead of stopping the run.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub optional: bool,
}

impl GateResult {
    pub fn passed(&self) -> bool {
        self.status == "passed"
    }

    pub fn failed(&self) -> bool {
        self.status == "failed"
    }

    /// An `auto` command check that found nothing to run, on a gate not
    /// marked optional: the run stops with `no_check_found` (D31).
    pub fn no_check_found(&self) -> bool {
        self.kind == "command" && self.status == "skipped" && !self.optional
    }

    pub fn skipped(kind: &str, label: &str, summary: &str) -> Self {
        Self {
            kind: kind.into(),
            label: label.into(),
            status: "skipped".into(),
            summary: summary.into(),
            output: String::new(),
            duration_ms: 0,
            optional: false,
        }
    }
}

/// The folder's own check command for `"run": "auto"`: `npm run check`,
/// then `cargo test`, then a real `npm test`. None when the folder has none.
pub fn auto_check_command(cwd: &Path) -> Option<String> {
    let scripts = std::fs::read_to_string(cwd.join("package.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|json| json.get("scripts").cloned());
    let script = |name: &str| {
        scripts
            .as_ref()
            .and_then(|s| s.get(name))
            .and_then(|v| v.as_str())
            .map(str::to_string)
    };
    if script("check").is_some() {
        return Some("npm run check".into());
    }
    if cwd.join("Cargo.toml").is_file() {
        return Some("cargo test".into());
    }
    // `npm init` writes a test script that only fails.
    match script("test") {
        Some(test) if !test.contains("no test specified") => Some("npm test".into()),
        _ => None,
    }
}

struct Ran {
    code: Option<i32>,
    timed_out: bool,
    output: String,
    duration: Duration,
}

fn shell_command(script: &str) -> Command {
    #[cfg(windows)]
    {
        let mut cmd = Command::new("cmd");
        cmd.args(["/D", "/S", "/C", &format!("{script} 2>&1")]);
        cmd
    }
    #[cfg(not(windows))]
    {
        let shell = std::env::var("SHELL")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "/bin/sh".into());
        let mut cmd = Command::new(shell);
        // A login shell reads the profile that puts Homebrew, nvm and cargo on PATH.
        cmd.args(["-l", "-c", &format!("exec 2>&1; {script}")]);
        cmd
    }
}

fn tail_text(lines: &VecDeque<String>) -> String {
    let joined = lines.iter().cloned().collect::<Vec<_>>().join("\n");
    let chars = joined.chars().count();
    if chars <= OUTPUT_CHARS {
        joined
    } else {
        joined.chars().skip(chars - OUTPUT_CHARS).collect()
    }
}

fn run_in_shell(cwd: &Path, script: &str, timeout: Duration) -> Result<Ran, String> {
    let started = Instant::now();
    let mut cmd = shell_command(script);
    cmd.current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    prepare_command(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("could not start the shell: {e}"))?;
    let stdout = child.stdout.take();
    let process = SharedProcess::from_child(child).map_err(|e| e.to_string())?;
    process.resume().map_err(|e| e.to_string())?;
    let lines = Arc::new(Mutex::new(VecDeque::new()));
    let reader = stdout.map(|out| {
        let lines = Arc::clone(&lines);
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                if let Ok(mut buf) = lines.lock() {
                    if buf.len() == OUTPUT_LINES {
                        buf.pop_front();
                    }
                    buf.push_back(strip_ansi(&line));
                }
            }
        })
    });
    let deadline = started + timeout;
    let (code, timed_out) = loop {
        match process.try_wait() {
            Ok(Some(status)) => break (status.code(), false),
            Ok(None) if Instant::now() >= deadline => {
                process.kill_tree();
                break (None, true);
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => {
                process.kill_tree();
                return Err(e.to_string());
            }
        }
    };
    if let Some(reader) = reader {
        // The group is gone, so the pipe closes; a grandchild that kept it
        // open is not waited on forever.
        let wait_until = Instant::now() + Duration::from_secs(2);
        while !reader.is_finished() && Instant::now() < wait_until {
            std::thread::sleep(Duration::from_millis(20));
        }
    }
    let output = lines.lock().map(|buf| tail_text(&buf)).unwrap_or_default();
    Ok(Ran {
        code,
        timed_out,
        output,
        duration: started.elapsed(),
    })
}

fn strip_ansi(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();
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
        if c != '\r' {
            out.push(c);
        }
    }
    out
}

/// Run `run` in `cwd` (`auto` picks the folder's check command).
pub fn run_command_gate(cwd: &Path, run: &str, timeout: Option<Duration>) -> GateResult {
    let command = if run.trim() == "auto" {
        match auto_check_command(cwd) {
            Some(command) => command,
            None => {
                return GateResult::skipped(
                    "command",
                    "auto",
                    "No check command found (no npm `check` or `test` script, no Cargo.toml).",
                )
            }
        }
    } else {
        run.trim().to_string()
    };
    if !cwd.is_dir() {
        return GateResult {
            kind: "command".into(),
            label: command,
            status: "failed".into(),
            summary: format!("The folder {} does not exist.", cwd.display()),
            output: String::new(),
            duration_ms: 0,
            optional: false,
        };
    }
    let timeout = timeout.unwrap_or(DEFAULT_GATE_TIMEOUT);
    match run_in_shell(cwd, &command, timeout) {
        Ok(ran) => {
            let passed = !ran.timed_out && ran.code == Some(0);
            let summary = if ran.timed_out {
                format!("Stopped after {} minutes.", timeout.as_secs() / 60)
            } else if passed {
                "Passed.".to_string()
            } else {
                match ran.code {
                    Some(code) => format!("Failed (exit code {code})."),
                    None => "Failed (stopped by a signal).".to_string(),
                }
            };
            GateResult {
                kind: "command".into(),
                label: command,
                status: if passed { "passed" } else { "failed" }.into(),
                summary,
                output: if passed { String::new() } else { ran.output },
                duration_ms: ran.duration.as_millis() as u64,
                optional: false,
            }
        }
        Err(err) => GateResult {
            kind: "command".into(),
            label: command,
            status: "failed".into(),
            summary: err,
            output: String::new(),
            duration_ms: 0,
            optional: false,
        },
    }
}

/// `https://github.com/<owner>/<repo>/pull/<n>`; nothing else reaches the shell.
pub fn is_github_pr_url(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://github.com/") else {
        return false;
    };
    let parts: Vec<&str> = rest.split('/').collect();
    let token = |s: &str| {
        !s.is_empty()
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    };
    parts.len() == 4
        && token(parts[0])
        && token(parts[1])
        && parts[2] == "pull"
        && !parts[3].is_empty()
        && parts[3].chars().all(|c| c.is_ascii_digit())
}

/// Every URL is an open or merged pull request (`gh pr view`).
pub fn run_pull_request_gate(cwd: &Path, urls: &[String]) -> GateResult {
    let label = "gh pr view".to_string();
    let urls: Vec<&String> = urls.iter().filter(|url| is_github_pr_url(url)).collect();
    if urls.is_empty() {
        return GateResult {
            kind: "pullRequest".into(),
            label,
            status: "failed".into(),
            summary: "The stage reported no GitHub pull request URL.".into(),
            output: String::new(),
            duration_ms: 0,
            optional: false,
        };
    }
    let started = Instant::now();
    let mut problems = Vec::new();
    let mut output = Vec::new();
    for url in &urls {
        let script = format!("gh pr view {url} --json url,state,isDraft");
        match run_in_shell(cwd, &script, PR_GATE_TIMEOUT) {
            Ok(ran) if ran.code == Some(0) => {
                let state = serde_json::from_str::<serde_json::Value>(ran.output.trim())
                    .ok()
                    .and_then(|v| v.get("state").and_then(|s| s.as_str()).map(str::to_string))
                    .unwrap_or_default();
                if state == "CLOSED" {
                    problems.push(format!("{url} is closed."));
                }
                output.push(format!(
                    "{url}: {}",
                    if state.is_empty() { "found" } else { &state }
                ));
            }
            Ok(ran) => {
                problems.push(format!("{url} was not found."));
                output.push(format!("{url}: {}", ran.output.trim()));
            }
            Err(err) => {
                problems.push(format!("{url}: {err}"));
            }
        }
    }
    let passed = problems.is_empty();
    GateResult {
        kind: "pullRequest".into(),
        label,
        status: if passed { "passed" } else { "failed" }.into(),
        summary: if passed {
            format!("{} pull request(s) found.", urls.len())
        } else {
            problems.join(" ")
        },
        output: output.join("\n"),
        duration_ms: started.elapsed().as_millis() as u64,
        optional: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    #[test]
    fn auto_picks_npm_check_then_cargo_then_a_real_npm_test() {
        let dir = TempDir::new("gate_auto");
        assert_eq!(auto_check_command(dir.path()), None);
        std::fs::write(
            dir.path().join("package.json"),
            r#"{"scripts":{"test":"echo \"Error: no test specified\" && exit 1"}}"#,
        )
        .unwrap();
        assert_eq!(auto_check_command(dir.path()), None);
        std::fs::write(dir.path().join("Cargo.toml"), "[package]\n").unwrap();
        assert_eq!(
            auto_check_command(dir.path()).as_deref(),
            Some("cargo test")
        );
        std::fs::write(
            dir.path().join("package.json"),
            r#"{"scripts":{"check":"node check.mjs","test":"vitest"}}"#,
        )
        .unwrap();
        assert_eq!(
            auto_check_command(dir.path()).as_deref(),
            Some("npm run check")
        );
    }

    #[test]
    fn only_plain_github_pull_request_urls_reach_the_shell() {
        assert!(is_github_pr_url("https://github.com/jt/DCTerminal/pull/45"));
        assert!(!is_github_pr_url(
            "https://github.com/jt/DCTerminal/pull/45; rm -rf ~"
        ));
        assert!(!is_github_pr_url("https://github.com/jt/DCTerminal/pull/x"));
        assert!(!is_github_pr_url("https://gitlab.com/jt/repo/pull/1"));
        assert!(!is_github_pr_url("https://github.com/jt/repo/pull/1/files"));
        assert!(!is_github_pr_url("https://github.com/j$t/repo/pull/1"));
    }

    #[test]
    fn a_pull_request_gate_with_no_urls_fails_without_running_gh() {
        let dir = TempDir::new("gate_pr_none");
        let result = run_pull_request_gate(dir.path(), &["not a url".to_string()]);
        assert!(result.failed());
        assert_eq!(result.duration_ms, 0);
    }

    #[cfg(unix)]
    #[test]
    fn a_command_gate_passes_fails_and_keeps_the_failing_output() {
        let dir = TempDir::new("gate_cmd");
        let ok = run_command_gate(dir.path(), "echo fine", None);
        assert!(ok.passed(), "{ok:?}");
        assert!(ok.output.is_empty());
        let bad = run_command_gate(dir.path(), "echo boom; echo oops >&2; exit 3", None);
        assert!(bad.failed());
        assert_eq!(bad.summary, "Failed (exit code 3).");
        assert!(bad.output.contains("boom"), "{bad:?}");
        assert!(bad.output.contains("oops"), "stderr is kept: {bad:?}");
    }

    #[cfg(unix)]
    #[test]
    fn a_command_gate_that_runs_too_long_is_stopped() {
        let dir = TempDir::new("gate_timeout");
        let started = Instant::now();
        let slow = run_command_gate(dir.path(), "sleep 30", Some(Duration::from_millis(300)));
        assert!(slow.failed());
        assert!(slow.summary.starts_with("Stopped after"));
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn auto_with_nothing_to_run_is_skipped_not_failed() {
        let dir = TempDir::new("gate_skip");
        let result = run_command_gate(dir.path(), "auto", None);
        assert_eq!(result.status, "skipped");
    }

    #[test]
    fn escape_codes_and_carriage_returns_are_stripped() {
        assert_eq!(strip_ansi("\u{1b}[31mred\u{1b}[0m\r"), "red");
    }
}
