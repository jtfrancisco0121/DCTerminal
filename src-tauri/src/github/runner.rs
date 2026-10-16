//! Runs the user's `gh` with an argument vector (never a shell) and a
//! deadline, and reads GitHub's reply from `gh api -i`.
//!
//! The reply is judged by its HTTP status line, never by gh's exit code: gh
//! exits 1 on a 304 and on every 4xx.

use crate::cli_detect::find_on_path;
use crate::process_tree::{prepare_command, SharedProcess};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// One `gh` call may take this long before its process tree is killed.
pub const GH_TIMEOUT: Duration = Duration::from_secs(25);

/// What the cycle needs from GitHub. The real one runs `gh`; tests use a fake.
pub trait GhApi: Sync {
    /// GET `endpoint` (a path such as `repos/o/r/events`), sending
    /// `If-None-Match: <etag>` when one is given. `Err` means no HTTP reply
    /// came back (gh missing, signed out, offline, timed out).
    fn get(&self, endpoint: &str, etag: Option<&str>) -> Result<GhResponse, String>;
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct GhResponse {
    pub status: u16,
    pub etag: Option<String>,
    pub poll_interval: Option<u64>,
    /// `X-OAuth-Scopes`; None when the header is absent (fine-grained tokens).
    pub scopes: Option<Vec<String>>,
    pub rate_remaining: Option<u32>,
    pub rate_reset: Option<i64>,
    /// `X-RateLimit-Resource`: "core", "search", ... Each has its own limit.
    pub rate_resource: Option<String>,
    pub body: String,
}

impl GhResponse {
    pub fn status_line(&self) -> String {
        format!("HTTP {}", self.status)
    }
}

pub fn find_gh() -> Option<PathBuf> {
    find_on_path("gh").or_else(|| {
        ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"]
            .iter()
            .map(PathBuf::from)
            .find(|path| path.is_file())
    })
}

pub struct GhCli {
    path: PathBuf,
    timeout: Duration,
}

impl GhCli {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            timeout: GH_TIMEOUT,
        }
    }

    #[cfg(test)]
    pub fn with_timeout(path: PathBuf, timeout: Duration) -> Self {
        Self { path, timeout }
    }
}

impl GhApi for GhCli {
    fn get(&self, endpoint: &str, etag: Option<&str>) -> Result<GhResponse, String> {
        if endpoint.is_empty()
            || endpoint.starts_with('-')
            || endpoint.chars().any(char::is_control)
        {
            return Err("invalid GitHub endpoint".to_string());
        }
        let mut args: Vec<String> = vec!["api".into(), "-i".into()];
        if let Some(etag) = etag.filter(|e| !e.chars().any(char::is_control)) {
            args.push("-H".into());
            args.push(format!("If-None-Match: {etag}"));
        }
        args.push(endpoint.to_string());
        let (stdout, stderr) = run_gh(&self.path, &args, self.timeout)?;
        parse_response(&stdout).ok_or_else(|| short_error(&stderr))
    }
}

/// Runs `gh <args>` with no shell, stdin closed, no prompts and a deadline.
/// The whole process tree is killed at the deadline. Returns stdout, stderr.
pub fn run_gh(gh: &Path, args: &[String], timeout: Duration) -> Result<(String, String), String> {
    let mut command = Command::new(gh);
    command
        .args(args)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("NO_COLOR", "1")
        .env("GH_PAGER", "cat")
        .env_remove("GH_HOST")
        .env_remove("GH_REPO")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    prepare_command(&mut command);
    let mut child = command
        .spawn()
        .map_err(|err| format!("could not run gh: {err}"))?;
    let mut stdout = child.stdout.take().ok_or("no stdout")?;
    let mut stderr = child.stderr.take().ok_or("no stderr")?;
    let process = SharedProcess::from_child(child).map_err(|err| format!("gh: {err}"))?;
    if let Err(err) = process.resume() {
        process.kill_tree();
        return Err(format!("gh: {err}"));
    }
    let out_thread = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.read_to_end(&mut bytes);
        String::from_utf8_lossy(&bytes).into_owned()
    });
    let err_thread = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stderr.read_to_end(&mut bytes);
        String::from_utf8_lossy(&bytes).into_owned()
    });
    let deadline = Instant::now() + timeout;
    loop {
        match process.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() >= deadline => {
                process.kill_tree();
                let _ = out_thread.join();
                let _ = err_thread.join();
                return Err("gh timed out".to_string());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(err) => {
                process.kill_tree();
                return Err(format!("gh: {err}"));
            }
        }
    }
    Ok((
        out_thread.join().unwrap_or_default(),
        err_thread.join().unwrap_or_default(),
    ))
}

/// The first line of gh's own message, shortened. Never raw output.
fn short_error(stderr: &str) -> String {
    let line = stderr
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("gh returned no response");
    line.chars().take(200).collect()
}

/// True when gh's message says it has no login (so the fix is `gh auth login`).
pub fn is_signed_out_message(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("gh auth login")
        || lower.contains("not logged in")
        || lower.contains("authentication token")
        || lower.contains("bad credentials")
}

/// Reads the output of `gh api -i`: status line, headers, blank line, body.
/// A redirect chain prints several heads; the last one counts.
pub fn parse_response(raw: &str) -> Option<GhResponse> {
    let mut rest = raw.trim_start_matches(['\r', '\n']);
    loop {
        if !rest.starts_with("HTTP/") {
            return None;
        }
        let (head, body) = split_head(rest);
        if body.starts_with("HTTP/") {
            rest = body;
            continue;
        }
        let mut lines = head.lines();
        let status: u16 = lines.next()?.split_whitespace().nth(1)?.parse().ok()?;
        let mut response = GhResponse {
            status,
            body: body.to_string(),
            ..GhResponse::default()
        };
        for line in lines {
            let Some((name, value)) = line.split_once(':') else {
                continue;
            };
            let value = value.trim();
            match name.trim().to_ascii_lowercase().as_str() {
                "etag" => response.etag = Some(value.to_string()),
                "x-poll-interval" => response.poll_interval = value.parse().ok(),
                "x-oauth-scopes" => {
                    response.scopes = Some(
                        value
                            .split(',')
                            .map(|scope| scope.trim().to_string())
                            .filter(|scope| !scope.is_empty())
                            .collect(),
                    )
                }
                "x-ratelimit-remaining" => response.rate_remaining = value.parse().ok(),
                "x-ratelimit-reset" => response.rate_reset = value.parse().ok(),
                "x-ratelimit-resource" => response.rate_resource = Some(value.to_ascii_lowercase()),
                _ => {}
            }
        }
        return Some(response);
    }
}

fn split_head(text: &str) -> (&str, &str) {
    let crlf = text.find("\r\n\r\n").map(|at| (at, 4));
    let lf = text.find("\n\n").map(|at| (at, 2));
    let split = match (crlf, lf) {
        (Some(a), Some(b)) => Some(if a.0 <= b.0 { a } else { b }),
        (a, b) => a.or(b),
    };
    match split {
        Some((at, len)) => (&text[..at], &text[at + len..]),
        None => (text, ""),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const OK: &str = "HTTP/2.0 200 OK\r\nEtag: W/\"abc\"\r\nX-Poll-Interval: 60\r\nX-Oauth-Scopes: gist, read:org, repo, workflow\r\nX-Ratelimit-Remaining: 4959\r\nX-Ratelimit-Reset: 1790000000\r\nX-Ratelimit-Resource: core\r\n\r\n[{\"id\":\"1\"}]";

    #[test]
    fn reads_status_headers_and_body() {
        let response = parse_response(OK).unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.etag.as_deref(), Some("W/\"abc\""));
        assert_eq!(response.poll_interval, Some(60));
        assert_eq!(
            response.scopes,
            Some(vec![
                "gist".into(),
                "read:org".into(),
                "repo".into(),
                "workflow".into()
            ])
        );
        assert_eq!(response.rate_remaining, Some(4959));
        assert_eq!(response.rate_reset, Some(1_790_000_000));
        assert_eq!(response.rate_resource.as_deref(), Some("core"));
        assert_eq!(response.body, "[{\"id\":\"1\"}]");
    }

    #[test]
    fn a_304_is_read_from_the_status_line() {
        let response = parse_response("HTTP/2.0 304 Not Modified\r\nEtag: x\r\n\r\n").unwrap();
        assert_eq!(response.status, 304);
        assert!(response.body.is_empty());
    }

    #[test]
    fn a_missing_scope_header_is_none_not_empty() {
        let response = parse_response("HTTP/2.0 200 OK\r\n\r\n[]").unwrap();
        assert_eq!(response.scopes, None);
    }

    #[test]
    fn follows_the_last_head_of_a_redirect_chain() {
        let raw = "HTTP/2.0 301 Moved\r\nLocation: x\r\n\r\nHTTP/2.0 200 OK\r\nEtag: e\r\n\r\n[]";
        let response = parse_response(raw).unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.etag.as_deref(), Some("e"));
    }

    #[test]
    fn output_without_a_status_line_is_not_a_response() {
        assert!(parse_response("").is_none());
        assert!(parse_response("gh: command not found").is_none());
    }

    #[test]
    fn a_404_keeps_its_status_and_error_body() {
        let response =
            parse_response("HTTP/2.0 404 Not Found\n\n{\"message\":\"Not Found\"}").unwrap();
        assert_eq!(response.status, 404);
    }

    #[test]
    fn sign_out_messages_are_recognised() {
        assert!(is_signed_out_message(
            "To get started with GitHub CLI, please run:  gh auth login"
        ));
        assert!(!is_signed_out_message("dial tcp: no such host"));
    }

    #[test]
    fn errors_carry_one_short_line() {
        let long = format!("\n  {}\nsecond", "x".repeat(500));
        assert_eq!(short_error(&long).len(), 200);
        assert_eq!(short_error(""), "gh returned no response");
    }

    #[cfg(unix)]
    fn script(body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let dir = crate::test_support::temp_path("gh_script");
        let path = dir.join("gh");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[cfg(unix)]
    #[test]
    fn a_304_with_exit_code_1_is_still_a_304() {
        let gh = script("printf 'HTTP/2.0 304 Not Modified\\r\\nEtag: e\\r\\n\\r\\n'\nexit 1");
        let api = GhCli::new(gh);
        let response = api.get("repos/o/r/events", Some("e")).unwrap();
        assert_eq!(response.status, 304);
    }

    #[cfg(unix)]
    #[test]
    fn sends_the_etag_as_one_header_argument_and_never_uses_a_shell() {
        // The script echoes its arguments, one per line, as the body.
        let gh = script(
            "printf 'HTTP/2.0 200 OK\\r\\n\\r\\n'\nfor a in \"$@\"; do printf '%s\\n' \"$a\"; done",
        );
        let api = GhCli::new(gh);
        let response = api
            .get("repos/o/r/events?per_page=100", Some("W/\"x y\""))
            .unwrap();
        assert_eq!(
            response.body,
            "api\n-i\n-H\nIf-None-Match: W/\"x y\"\nrepos/o/r/events?per_page=100\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_environment_is_set_for_gh() {
        let gh = script(
            "printf 'HTTP/2.0 200 OK\\r\\n\\r\\n%s|%s|%s|%s' \"$GH_PROMPT_DISABLED\" \"$NO_COLOR\" \"$GH_PAGER\" \"${GH_HOST:-unset}\"",
        );
        std::env::set_var("GH_HOST", "example.invalid");
        let response = GhCli::new(gh).get("user", None).unwrap();
        std::env::remove_var("GH_HOST");
        assert_eq!(response.body, "1|1|cat|unset");
    }

    #[cfg(unix)]
    #[test]
    fn a_slow_gh_is_killed_at_the_deadline() {
        let gh = script("sleep 30");
        let api = GhCli::with_timeout(gh, Duration::from_millis(300));
        let started = Instant::now();
        let err = api.get("user", None).unwrap_err();
        assert_eq!(err, "gh timed out");
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[test]
    fn rejects_endpoints_that_could_be_flags() {
        let api = GhCli::new(PathBuf::from("/nonexistent/gh"));
        assert_eq!(
            api.get("--hostname", None).unwrap_err(),
            "invalid GitHub endpoint"
        );
    }
}
