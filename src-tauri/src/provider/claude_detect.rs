//! Find Claude Code (`claude`) and the Claude Code ACP adapter
//! (`claude-agent-acp`), and ask `claude` whether it is signed in.
//!
//! Read-only: DCTerminal runs `claude --version` and `claude auth status
//! --json`, both with `CLAUDE_CONFIG_DIR=<configDir>` (via `claude_env`), and
//! never reads Claude's credential store or runs a login flow.
//!
//! `claude auth status` writes `.claude.json` into the config folder (Claude's
//! own bookkeeping) and would create a missing folder, so it only runs when the
//! resolved folder exists. `claude --version` does not touch the folder.

use super::claude_config::{claude_env, ConfigDirInfo};
use crate::cli_detect::{find_on_path, run_cli, strip_ansi, LoginStatus};
use serde_json::Value;
use std::path::{Path, PathBuf};

/// Env override for the `claude` executable.
pub const CLAUDE_PATH_ENV: &str = "DCT_CLAUDE_PATH";
/// Env override for the `claude-agent-acp` executable.
pub const CLAUDE_ACP_PATH_ENV: &str = "DCT_CLAUDE_ACP_PATH";
/// Pinned adapter version for the install hint.
pub const ADAPTER_PACKAGE: &str = "@agentclientprotocol/claude-agent-acp@0.88.0";

pub fn adapter_install_command() -> String {
    format!("npm install -g --omit=optional {ADAPTER_PACKAGE}")
}

fn home_dir() -> Option<PathBuf> {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn exe(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

/// Places a GUI app should look when `PATH` (which macOS GUI apps do not
/// inherit from the shell) has no `claude`.
pub fn known_claude_locations(home: Option<&Path>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    #[cfg(not(windows))]
    {
        out.push(PathBuf::from("/opt/homebrew/bin/claude"));
        out.push(PathBuf::from("/usr/local/bin/claude"));
    }
    if let Some(home) = home {
        out.push(home.join(".local").join("bin").join(exe("claude")));
        // Older Claude Code "local" installs.
        out.push(home.join(".claude").join("local").join(exe("claude")));
    }
    out
}

fn adapter_names() -> Vec<String> {
    if cfg!(windows) {
        vec![
            "claude-agent-acp.cmd".to_string(),
            "claude-agent-acp.exe".to_string(),
            "claude-agent-acp".to_string(),
        ]
    } else {
        vec!["claude-agent-acp".to_string()]
    }
}

fn first_file(candidates: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    candidates.into_iter().find(|path| path.is_file())
}

fn from_override(value: Option<&str>) -> Option<PathBuf> {
    value
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_file())
}

/// Inputs to the lookup, passed in so tests can use fake folders.
#[derive(Debug, Clone, Default)]
pub struct Lookup {
    pub env_override: Option<String>,
    pub setting: Option<String>,
    /// Folders to search like `PATH`.
    pub path_dirs: Vec<PathBuf>,
    pub known: Vec<PathBuf>,
}

/// `DCT_CLAUDE_PATH`, settings `claudePath`, `PATH`, then known locations.
pub fn resolve_claude_with(lookup: &Lookup) -> Option<PathBuf> {
    from_override(lookup.env_override.as_deref())
        .or_else(|| from_override(lookup.setting.as_deref()))
        .or_else(|| first_file(lookup.path_dirs.iter().map(|dir| dir.join(exe("claude")))))
        .or_else(|| first_file(lookup.known.iter().cloned()))
}

/// `DCT_CLAUDE_ACP_PATH`, settings `adapterPath`, `PATH`, npm global bin,
/// Homebrew.
pub fn resolve_adapter_with(lookup: &Lookup) -> Option<PathBuf> {
    from_override(lookup.env_override.as_deref())
        .or_else(|| from_override(lookup.setting.as_deref()))
        .or_else(|| {
            first_file(
                lookup
                    .path_dirs
                    .iter()
                    .chain(lookup.known.iter())
                    .flat_map(|dir| adapter_names().into_iter().map(move |n| dir.join(n))),
            )
        })
}

fn path_dirs() -> Vec<PathBuf> {
    std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect())
        .unwrap_or_default()
}

pub fn resolve_claude(setting: Option<&str>) -> Option<PathBuf> {
    resolve_claude_with(&Lookup {
        env_override: std::env::var(CLAUDE_PATH_ENV).ok(),
        setting: setting.map(str::to_string),
        path_dirs: path_dirs(),
        known: known_claude_locations(home_dir().as_deref()),
    })
}

/// `npm prefix -g` → its bin folder. `npm` itself may only be in Homebrew
/// for a GUI app.
fn npm_global_bin() -> Option<PathBuf> {
    let npm = find_on_path(if cfg!(windows) { "npm.cmd" } else { "npm" })
        .or_else(|| first_file([PathBuf::from("/opt/homebrew/bin/npm")]))?;
    let (out, _err, ok) = run_cli(&npm, &["prefix", "-g"], &[]).ok()?;
    let prefix = out.trim();
    if !ok || prefix.is_empty() {
        return None;
    }
    let prefix = PathBuf::from(prefix);
    Some(if cfg!(windows) {
        prefix
    } else {
        prefix.join("bin")
    })
}

pub fn resolve_adapter(setting: Option<&str>) -> Option<PathBuf> {
    let env_override = std::env::var(CLAUDE_ACP_PATH_ENV).ok();
    let mut lookup = Lookup {
        env_override,
        setting: setting.map(str::to_string),
        path_dirs: path_dirs(),
        known: Vec::new(),
    };
    if let Some(found) = resolve_adapter_with(&lookup) {
        return Some(found);
    }
    lookup.env_override = None;
    lookup.setting = None;
    lookup.path_dirs = Vec::new();
    lookup.known = npm_global_bin().into_iter().collect();
    #[cfg(not(windows))]
    {
        lookup.known.push(PathBuf::from("/opt/homebrew/bin"));
        lookup.known.push(PathBuf::from("/usr/local/bin"));
    }
    resolve_adapter_with(&lookup)
}

/// Arguments of the auth-status call (env comes from [`auth_status_env`]).
pub const AUTH_STATUS_ARGS: [&str; 3] = ["auth", "status", "--json"];

/// Env for `claude auth status` / `claude --version`: `CLAUDE_CONFIG_DIR`
/// from the resolver, plus no colour.
pub fn auth_status_env(config: &ConfigDirInfo) -> Vec<(String, String)> {
    let mut env = claude_env(config);
    env.push(("NO_COLOR".to_string(), "1".to_string()));
    env
}

/// `claude --version` → `2.1.236 (Claude Code)`.
pub fn read_claude_version(claude: &Path, config: &ConfigDirInfo) -> Option<String> {
    let (out, err, ok) = run_cli(claude, &["--version"], &auth_status_env(config)).ok()?;
    let text = if ok { out } else { err };
    let text = strip_ansi(text.trim());
    (!text.is_empty()).then(|| text.lines().next().unwrap_or("").trim().to_string())
}

/// Parse `claude auth status --json` (CLI 2.1.236 shape, see
/// `fixtures/claude/`). Falls back to the `--text` wording.
pub fn parse_claude_auth_status(stdout: &str, stderr: &str) -> LoginStatus {
    if let Ok(value) = serde_json::from_str::<Value>(stdout.trim()) {
        if let Some(logged_in) = value.get("loggedIn").and_then(Value::as_bool) {
            let text = |key: &str| {
                value
                    .get(key)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|v| !v.is_empty() && *v != "none")
                    .map(str::to_string)
            };
            if !logged_in {
                return LoginStatus {
                    state: "loggedOut".into(),
                    ..Default::default()
                };
            }
            let method = match (text("authMethod"), text("subscriptionType")) {
                (Some(method), Some(plan)) => Some(format!("{method} · {plan}")),
                (Some(method), None) => Some(method),
                (None, Some(plan)) => Some(plan),
                (None, None) => None,
            };
            let organization = text("orgName");
            let account = text("email").or_else(|| organization.clone());
            return LoginStatus {
                state: "loggedIn".into(),
                account,
                method,
                organization,
                ..Default::default()
            };
        }
    }
    let text = strip_ansi(&format!("{stdout}\n{stderr}"));
    let lower = text.to_ascii_lowercase();
    if lower.contains("not logged in") || lower.contains("not authenticated") {
        return LoginStatus {
            state: "loggedOut".into(),
            ..Default::default()
        };
    }
    let detail: String = text.trim().chars().take(200).collect();
    LoginStatus {
        state: "unknown".into(),
        detail: (!detail.is_empty()).then_some(detail),
        ..Default::default()
    }
}

/// Signed-in state for the account in `config`. Never runs when the folder
/// is missing (Claude would create it).
pub fn claude_login_status(claude: Option<&Path>, config: &ConfigDirInfo) -> LoginStatus {
    let api_key_env = std::env::var_os("ANTHROPIC_API_KEY").is_some_and(|v| !v.is_empty());
    let mut status = match claude {
        None => LoginStatus {
            state: "noCli".into(),
            ..Default::default()
        },
        Some(_) if !config.exists => LoginStatus {
            state: "noConfigDir".into(),
            detail: config.missing_message(),
            ..Default::default()
        },
        Some(claude) => match run_cli(claude, &AUTH_STATUS_ARGS, &auth_status_env(config)) {
            // Exit 1 when signed out; the JSON is still on stdout.
            Ok((out, err, _ok)) => parse_claude_auth_status(&out, &err),
            Err(err) => LoginStatus {
                state: "unknown".into(),
                detail: Some(err.chars().take(200).collect()),
                ..Default::default()
            },
        },
    };
    status.api_key_env = api_key_env;
    status
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::claude_config::{resolve_with, CLAUDE_CONFIG_DIR};
    use std::time::{SystemTime, UNIX_EPOCH};

    const LOGGED_IN: &str = include_str!("../../../fixtures/claude/auth-status-logged-in.json");
    const LOGGED_OUT: &str = include_str!("../../../fixtures/claude/auth-status-logged-out.json");

    fn temp(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("dct_claude_detect_{tag}_{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn touch(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "#!/bin/sh\n").unwrap();
    }

    #[test]
    fn claude_lookup_order_is_env_setting_path_known() {
        let root = temp("order");
        let env_bin = root.join("env").join("claude");
        let setting_bin = root.join("setting").join("claude");
        let path_dir = root.join("path");
        let known_bin = root.join("known").join(exe("claude"));
        touch(&env_bin);
        touch(&setting_bin);
        touch(&path_dir.join(exe("claude")));
        touch(&known_bin);
        let mut lookup = Lookup {
            env_override: Some(env_bin.display().to_string()),
            setting: Some(setting_bin.display().to_string()),
            path_dirs: vec![root.join("empty"), path_dir.clone()],
            known: vec![root.join("nope").join("claude"), known_bin.clone()],
        };
        assert_eq!(resolve_claude_with(&lookup), Some(env_bin.clone()));
        lookup.env_override = Some(root.join("missing").display().to_string());
        assert_eq!(resolve_claude_with(&lookup), Some(setting_bin));
        lookup.setting = None;
        assert_eq!(
            resolve_claude_with(&lookup),
            Some(path_dir.join(exe("claude")))
        );
        lookup.path_dirs.clear();
        assert_eq!(resolve_claude_with(&lookup), Some(known_bin));
        lookup.known.clear();
        assert_eq!(resolve_claude_with(&lookup), None);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn known_locations_include_homebrew_and_local_bin() {
        let known = known_claude_locations(Some(Path::new("/Users/jt")));
        #[cfg(not(windows))]
        assert_eq!(known[0], PathBuf::from("/opt/homebrew/bin/claude"));
        assert!(known.contains(&PathBuf::from("/Users/jt/.local/bin").join(exe("claude"))));
    }

    #[test]
    fn adapter_lookup_searches_path_then_known_folders() {
        let root = temp("adapter");
        let npm_bin = root.join("npm-global").join("bin");
        touch(&npm_bin.join(&adapter_names()[0]));
        let lookup = Lookup {
            env_override: None,
            setting: None,
            path_dirs: vec![root.join("empty")],
            known: vec![npm_bin.clone()],
        };
        assert_eq!(
            resolve_adapter_with(&lookup),
            Some(npm_bin.join(&adapter_names()[0]))
        );
        let none = Lookup::default();
        assert_eq!(resolve_adapter_with(&none), None);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn parses_logged_in_fixture() {
        let status = parse_claude_auth_status(LOGGED_IN, "");
        assert_eq!(status.state, "loggedIn");
        assert_eq!(status.account.as_deref(), Some("jt@example.com"));
        assert_eq!(status.organization.as_deref(), Some("Example Org"));
        assert_eq!(status.method.as_deref(), Some("claude.ai · team"));
    }

    #[test]
    fn parses_logged_out_fixture_and_text() {
        let status = parse_claude_auth_status(LOGGED_OUT, "");
        assert_eq!(status.state, "loggedOut");
        assert_eq!(status.account, None);
        assert_eq!(status.method, None);
        let text =
            parse_claude_auth_status("Not logged in. Run claude auth login to authenticate.", "");
        assert_eq!(text.state, "loggedOut");
        assert_eq!(parse_claude_auth_status("", "").state, "unknown");
    }

    #[test]
    fn auth_status_env_carries_the_resolved_config_dir() {
        let config = resolve_with(None, Some("/Users/jt/.claude-account2"), None);
        let env = auth_status_env(&config);
        assert!(env.contains(&(
            CLAUDE_CONFIG_DIR.to_string(),
            "/Users/jt/.claude-account2".to_string()
        )));
        assert_eq!(AUTH_STATUS_ARGS, ["auth", "status", "--json"]);
    }

    #[test]
    fn missing_config_dir_skips_the_auth_call() {
        let config = resolve_with(None, Some("/definitely/not/here/.claude-x"), None);
        // A program that would fail loudly if it were run.
        let status = claude_login_status(Some(Path::new("/definitely/not/a/claude")), &config);
        assert_eq!(status.state, "noConfigDir");
        assert!(status
            .detail
            .unwrap()
            .contains("Claude config folder not found"));
        assert!(!Path::new("/definitely/not/here/.claude-x").exists());
        assert_eq!(claude_login_status(None, &config).state, "noCli");
    }

    #[cfg(unix)]
    #[test]
    fn auth_status_runs_with_claude_config_dir_from_the_resolver() {
        use std::os::unix::fs::PermissionsExt;
        let root = temp("fake");
        let config_dir = root.join("account2");
        std::fs::create_dir_all(&config_dir).unwrap();
        // Fake `claude`: echo the env it got as JSON.
        let fake = root.join("claude");
        std::fs::write(
            &fake,
            "#!/bin/sh\nprintf '{\"loggedIn\":true,\"authMethod\":\"claude.ai\",\"email\":\"%s\"}' \"$CLAUDE_CONFIG_DIR\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let config = resolve_with(None, Some(&config_dir.display().to_string()), None);
        let status = claude_login_status(Some(&fake), &config);
        assert_eq!(status.state, "loggedIn");
        assert_eq!(status.account.as_deref(), Some(config.path.as_str()));
        let _ = std::fs::remove_dir_all(root);
    }
}
