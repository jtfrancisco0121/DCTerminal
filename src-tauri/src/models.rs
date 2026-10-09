//! Model list and model choice.
//!
//! The list comes from `agent --list-models`: a header line, then one
//! `<id> - <label>` line per model. The CLI pads some lines with U+200B and
//! double spaces, and marks one entry `(current)` or `(default)`. The parsed
//! list is cached in app data. A static list is used when the CLI is missing
//! and nothing is cached. Nothing here reads or writes `~/.cursor`.

use crate::cli_detect::{agent_missing_message, resolve_agent_executable};
use crate::store::{read_json, write_json_atomic, ModelSettings, SettingsStore, StateStore};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, State};

/// The app default. Not `composer-2.5-fast`.
pub const DEFAULT_MODEL_ID: &str = "composer-2.5";
const LIST_TIMEOUT: Duration = Duration::from_secs(20);
const CACHE_TTL_MS: i64 = 24 * 60 * 60 * 1000;
const MAX_MODELS: usize = 400;
const MAX_ID_CHARS: usize = 100;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelEntry {
    pub id: String,
    pub label: String,
    /// A speed-tuned variant (`-fast` id, or `Fast` in the label).
    pub fast: bool,
    /// Extra note, e.g. Fable's "may use usage credits".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub badge: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCache {
    pub fetched_at_ms: i64,
    pub models: Vec<ModelEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelList {
    pub models: Vec<ModelEntry>,
    /// `cli`, `cache`, or `fallback`.
    pub source: String,
    pub fetched_at_ms: Option<i64>,
    pub error: Option<String>,
}

/// A model id is passed as one argv element after `--model`, so it must not
/// look like a flag and must not carry whitespace or shell metacharacters.
pub fn valid_model_id(id: &str) -> bool {
    !id.is_empty()
        && id.chars().count() <= MAX_ID_CHARS
        && !id.starts_with('-')
        && id.chars().all(|ch| {
            ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-' | ':' | '/' | '[' | ']')
        })
}

/// Claude model aliases `claude --model` and the adapter accept.
const CLAUDE_ALIASES: &[&str] = &[
    "default", "opus", "sonnet", "haiku", "fable", "opusplan", "best",
];
const CLAUDE_FAMILIES: &[&str] = &["opus", "sonnet", "haiku", "fable"];

/// A Claude model id: an alias (`default`, `opus`, `sonnet`, `haiku`, …) or a
/// full name `claude-<family>-<version…>`, each optionally with the `[1m]`
/// context suffix the adapter reports (e.g. `opus[1m]`). Cursor ids such as
/// `composer-2.5`, `gpt-5`, `auto` or `claude-4.5-sonnet` are not Claude ids.
pub fn is_claude_model_id(id: &str) -> bool {
    let id = id.trim();
    let base = id.strip_suffix("[1m]").unwrap_or(id);
    if base.is_empty() || base.len() > MAX_ID_CHARS {
        return false;
    }
    if CLAUDE_ALIASES.contains(&base) {
        return true;
    }
    let Some(rest) = base.strip_prefix("claude-") else {
        return false;
    };
    let Some((family, version)) = rest.split_once('-') else {
        return false;
    };
    CLAUDE_FAMILIES.contains(&family)
        && version.chars().next().is_some_and(|ch| ch.is_ascii_digit())
        && version
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '.' | '-'))
}

/// Model for a Claude process: the id when it is a Claude id, else `default`
/// (the account's default model; no `--model` flag is passed for it).
pub fn claude_model_or_default(raw: Option<&str>) -> String {
    match raw.map(str::trim).filter(|id| is_claude_model_id(id)) {
        Some(id) => id.to_string(),
        None => "default".to_string(),
    }
}

pub fn effective_model(settings: &ModelSettings, role_id: &str, tab_model: Option<&str>) -> String {
    if let Some(model) = tab_model.map(str::trim).filter(|m| valid_model_id(m)) {
        return model.to_string();
    }
    if let Some(model) = settings
        .role_models
        .get(role_id)
        .map(|m| m.trim())
        .filter(|m| valid_model_id(m))
    {
        return model.to_string();
    }
    let global = settings.default_model.trim();
    if valid_model_id(global) {
        global.to_string()
    } else {
        DEFAULT_MODEL_ID.to_string()
    }
}

fn strip_ansi(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' {
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
        out.push(ch);
    }
    out
}

/// Remove zero-width characters and collapse runs of whitespace.
fn clean_line(raw: &str) -> String {
    let no_ansi = strip_ansi(raw);
    let visible: String = no_ansi
        .chars()
        .filter(|ch| !matches!(ch, '\u{200B}' | '\u{200C}' | '\u{200D}' | '\u{FEFF}'))
        .collect();
    visible.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn strip_markers(label: &str) -> String {
    let mut text = label.trim().to_string();
    loop {
        let lower = text.to_ascii_lowercase();
        let mut changed = false;
        for marker in ["(current)", "(default)"] {
            if lower.ends_with(marker) {
                text.truncate(text.len() - marker.len());
                text = text.trim_end().to_string();
                changed = true;
                break;
            }
        }
        if !changed {
            break;
        }
    }
    text
}

fn is_fast(id: &str, label: &str) -> bool {
    let id = id.to_ascii_lowercase();
    id.ends_with("-fast")
        || id.contains("-fast-")
        || label
            .split(|ch: char| !ch.is_ascii_alphanumeric())
            .any(|word| word.eq_ignore_ascii_case("fast"))
}

/// Parse `agent --list-models` output. Lines that are not `<id> - <label>`
/// (the header, blank lines, tips) are skipped. Duplicate ids keep the first.
pub fn parse_list_models(stdout: &str) -> Vec<ModelEntry> {
    let mut models: Vec<ModelEntry> = Vec::new();
    for raw in stdout.lines() {
        let line = clean_line(raw);
        let Some((id, label)) = line.split_once(" - ") else {
            continue;
        };
        let id = strip_markers(id.trim().trim_start_matches(['*', '•', '>']).trim());
        if !valid_model_id(&id) {
            continue;
        }
        let mut label = strip_markers(label);
        if label.is_empty() {
            label = id.clone();
        }
        if models.iter().any(|m| m.id == id) {
            continue;
        }
        let fast = is_fast(&id, &label);
        models.push(ModelEntry {
            id,
            label,
            fast,
            badge: None,
        });
        if models.len() >= MAX_MODELS {
            break;
        }
    }
    models
}

/// Used when the CLI cannot be run and nothing is cached.
pub fn static_fallback() -> Vec<ModelEntry> {
    [
        ("composer-2.5", "Composer 2.5"),
        ("composer-2.5-fast", "Composer 2.5 Fast"),
        ("auto", "Auto"),
        ("sonnet-4.5", "Claude Sonnet 4.5"),
        ("sonnet-4.5-thinking", "Claude Sonnet 4.5 Thinking"),
        ("opus-4.5", "Claude Opus 4.5"),
        ("gpt-5", "GPT-5"),
        ("gpt-5-codex", "GPT-5 Codex"),
        ("gemini-3-pro", "Gemini 3 Pro"),
        ("grok", "Grok"),
    ]
    .into_iter()
    .map(|(id, label)| ModelEntry {
        id: id.to_string(),
        label: label.to_string(),
        fast: is_fast(id, label),
        badge: None,
    })
    .collect()
}

/// Used when no Claude chat has reported a model list in the last 24 h.
/// Extras (`fable`, `opusplan`, `sonnet[1m]`, `opus[1m]`) stay off this list;
/// they appear only when the adapter's `session/new` options include them.
pub fn claude_static_fallback() -> Vec<ModelEntry> {
    [
        ("default", "Default (account default)", false),
        ("opus", "Opus", false),
        ("sonnet", "Sonnet", false),
        ("haiku", "Haiku", true),
    ]
    .into_iter()
    .map(|(id, label, fast)| ModelEntry {
        id: id.to_string(),
        label: label.to_string(),
        fast,
        badge: None,
    })
    .collect()
}

/// One adapter model option, when the id is a Claude model id.
pub fn claude_model_entry(id: &str, label: &str) -> Option<ModelEntry> {
    let id = id.trim();
    if !is_claude_model_id(id) {
        return None;
    }
    let label = label.trim();
    let label = if label.is_empty() { id } else { label };
    let badge = if id.to_ascii_lowercase().contains("fable") {
        Some("may use usage credits".to_string())
    } else {
        None
    };
    Some(ModelEntry {
        id: id.to_string(),
        label: label.to_string(),
        fast: id.contains("haiku") || is_fast(id, label),
        badge,
    })
}

/// Adapter model options, in the order the adapter sent them. Ids that are
/// not Claude models are dropped. Duplicate ids keep the first.
pub fn claude_models_from_options(options: &[(String, String)]) -> Vec<ModelEntry> {
    let mut models: Vec<ModelEntry> = Vec::new();
    for (id, label) in options {
        let Some(entry) = claude_model_entry(id, label) else {
            continue;
        };
        if models.iter().any(|model| model.id == entry.id) {
            continue;
        }
        models.push(entry);
        if models.len() >= MAX_MODELS {
            break;
        }
    }
    models
}

fn cache_path(dir: &Path) -> PathBuf {
    dir.join("models-cache.json")
}

/// `models-cache.json` holds one list per provider. A file written before
/// that (a single `{ fetchedAtMs, models }` object) is the Cursor list.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderModelCaches {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cursor: Option<ModelCache>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    claude: Option<ModelCache>,
    /// Legacy flat cache. Read as Cursor; not written back.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    models: Vec<ModelEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    fetched_at_ms: Option<i64>,
}

fn load_caches(dir: &Path) -> ProviderModelCaches {
    let path = cache_path(dir);
    if !path.is_file() {
        return ProviderModelCaches::default();
    }
    let Ok(mut file) = read_json::<ProviderModelCaches>(&path) else {
        return ProviderModelCaches::default();
    };
    if file.cursor.as_ref().is_none_or(|cache| cache.models.is_empty()) && !file.models.is_empty()
    {
        file.cursor = Some(ModelCache {
            fetched_at_ms: file.fetched_at_ms.unwrap_or(0),
            models: std::mem::take(&mut file.models),
        });
    }
    file
}

pub fn read_provider_cache(dir: &Path, provider: &str) -> Option<ModelCache> {
    let file = load_caches(dir);
    let cache = if provider == "claude" {
        file.claude
    } else {
        file.cursor
    };
    cache.filter(|cache| !cache.models.is_empty())
}

pub fn write_provider_cache(dir: &Path, provider: &str, cache: &ModelCache) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|err| format!("model cache dir: {err}"))?;
    let mut file = load_caches(dir);
    file.models.clear();
    file.fetched_at_ms = None;
    if provider == "claude" {
        file.claude = Some(cache.clone());
    } else {
        file.cursor = Some(cache.clone());
    }
    write_json_atomic(&cache_path(dir), &file)
}

/// Cursor list. A legacy flat cache is read as Cursor.
pub fn read_cache(dir: &Path) -> Option<ModelCache> {
    read_provider_cache(dir, "cursor")
}

pub fn write_cache(dir: &Path, cache: &ModelCache) -> Result<(), String> {
    write_provider_cache(dir, "cursor", cache)
}

/// Remember the model options from a Claude `session/new` / `session/load`.
/// Nothing is written when the list is empty.
pub fn remember_claude_models(dir: &Path, models: &[ModelEntry]) -> Result<(), String> {
    if models.is_empty() {
        return Ok(());
    }
    let cache = ModelCache {
        fetched_at_ms: chrono::Utc::now().timestamp_millis(),
        models: models.to_vec(),
    };
    write_provider_cache(dir, "claude", &cache)
}

/// Claude picker list: a fresh cache from the last `session/new`, else the
/// static aliases. There is no CLI refresh — spawning a session just to list
/// models would talk to Claude's account.
pub fn claude_model_list(dir: &Path, now_ms: i64) -> ModelList {
    if let Some(cache) = read_provider_cache(dir, "claude") {
        if now_ms - cache.fetched_at_ms < CACHE_TTL_MS {
            return ModelList {
                models: cache.models,
                source: "cache".to_string(),
                fetched_at_ms: Some(cache.fetched_at_ms),
                error: None,
            };
        }
    }
    ModelList {
        models: claude_static_fallback(),
        source: "fallback".to_string(),
        fetched_at_ms: None,
        error: None,
    }
}

/// Pick what to show. A fresh cache wins unless `refresh` is set. A failed
/// CLI run falls back to any cache, then to the static list.
pub fn choose_list(
    refresh: bool,
    now_ms: i64,
    cache: Option<ModelCache>,
    run_cli: impl FnOnce() -> Result<Vec<ModelEntry>, String>,
) -> (ModelList, Option<ModelCache>) {
    if !refresh {
        if let Some(cache) = cache.as_ref() {
            if now_ms - cache.fetched_at_ms < CACHE_TTL_MS {
                return (
                    ModelList {
                        models: cache.models.clone(),
                        source: "cache".to_string(),
                        fetched_at_ms: Some(cache.fetched_at_ms),
                        error: None,
                    },
                    None,
                );
            }
        }
    }
    match run_cli() {
        Ok(models) if !models.is_empty() => {
            let fresh = ModelCache {
                fetched_at_ms: now_ms,
                models: models.clone(),
            };
            (
                ModelList {
                    models,
                    source: "cli".to_string(),
                    fetched_at_ms: Some(now_ms),
                    error: None,
                },
                Some(fresh),
            )
        }
        outcome => {
            let error = match outcome {
                Err(err) => err,
                Ok(_) => "agent --list-models printed no models".to_string(),
            };
            if let Some(cache) = cache {
                return (
                    ModelList {
                        models: cache.models,
                        source: "cache".to_string(),
                        fetched_at_ms: Some(cache.fetched_at_ms),
                        error: Some(error),
                    },
                    None,
                );
            }
            (
                ModelList {
                    models: static_fallback(),
                    source: "fallback".to_string(),
                    fetched_at_ms: None,
                    error: Some(error),
                },
                None,
            )
        }
    }
}

fn run_list_models() -> Result<Vec<ModelEntry>, String> {
    let agent = resolve_agent_executable().ok_or_else(agent_missing_message)?;
    let mut command = Command::new(&agent);
    command
        .arg("--list-models")
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
        .map_err(|err| format!("could not run agent --list-models: {err}"))?;
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
    let deadline = Instant::now() + LIST_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("agent --list-models timed out".to_string());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(err) => return Err(err.to_string()),
        }
    };
    let text = out_thread.join().unwrap_or_default();
    let err_text = err_thread.join().unwrap_or_default();
    if !status.success() {
        let detail: String = err_text.trim().chars().take(300).collect();
        return Err(format!(
            "agent --list-models exited with {status}{}",
            if detail.is_empty() {
                String::new()
            } else {
                format!(": {detail}")
            }
        ));
    }
    Ok(parse_list_models(&text))
}

#[tauri::command]
pub async fn list_models(
    app: AppHandle,
    provider: Option<String>,
    refresh: Option<bool>,
) -> Result<ModelList, String> {
    let dir = crate::data_dir::app_data_dir(&app).path;
    let refresh = refresh.unwrap_or(false);
    let provider = provider.unwrap_or_else(|| "cursor".to_string());
    tauri::async_runtime::spawn_blocking(move || {
        let now = chrono::Utc::now().timestamp_millis();
        if provider == "claude" {
            return claude_model_list(&dir, now);
        }
        let (list, fresh) = choose_list(refresh, now, read_cache(&dir), run_list_models);
        if let Some(cache) = fresh {
            if let Err(err) = write_cache(&dir, &cache) {
                return ModelList {
                    error: Some(format!("could not cache the model list: {err}")),
                    ..list
                };
            }
        }
        list
    })
    .await
    .map_err(|err| err.to_string())
}

#[tauri::command]
pub fn get_model_settings(
    settings: State<Mutex<SettingsStore>>,
) -> Result<crate::store::ProviderModels, String> {
    let settings = settings.lock().map_err(|err| err.to_string())?;
    Ok(settings.data.models.clone())
}

#[tauri::command]
pub fn set_model_settings(
    models: ModelSettings,
    provider: Option<String>,
    settings: State<Mutex<SettingsStore>>,
) -> Result<ModelSettings, String> {
    let id = provider
        .as_deref()
        .and_then(crate::provider::ProviderId::parse)
        .unwrap_or(crate::provider::ProviderId::Cursor);
    let mut settings = settings.lock().map_err(|err| err.to_string())?;
    settings.set_models_for(id, models)?;
    Ok(settings.models_for(id).clone())
}

/// Per-tab override. `None` (or blank) clears it so the role default applies.
#[tauri::command]
pub fn set_tab_model(
    tab_id: String,
    model: Option<String>,
    store: State<Mutex<StateStore>>,
    settings: State<Mutex<SettingsStore>>,
) -> Result<String, String> {
    let model = model
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty());
    if let Some(id) = &model {
        if !valid_model_id(id) {
            return Err(format!("not a model id: {id}"));
        }
    }
    let role_id = {
        let mut store = store.lock().map_err(|err| err.to_string())?;
        store.set_tab_model(&tab_id, model.clone())?;
        store
            .tab_by_id(&tab_id)
            .map(|tab| tab.role_id.clone())
            .unwrap_or_default()
    };
    let settings = settings.lock().map_err(|err| err.to_string())?;
    Ok(settings.effective_model(&role_id, model.as_deref()))
}

/// Model for an `agent` launched for this tab. `None` for an unknown tab id
/// falls back to the role default, then the global default.
pub fn model_for_tab(
    store: &Mutex<StateStore>,
    settings: &Mutex<SettingsStore>,
    tab_id: Option<&str>,
    role_id: &str,
) -> Result<String, String> {
    let (role, tab_model) = {
        let store = store.lock().map_err(|err| err.to_string())?;
        let tab = tab_id.and_then(|id| store.tab_by_id(id));
        let role = tab
            .map(|t| t.role_id.clone())
            .filter(|r| !r.is_empty() && role_id.is_empty())
            .unwrap_or_else(|| role_id.to_string());
        (role, tab.and_then(|t| t.model.clone()))
    };
    let settings = settings.lock().map_err(|err| err.to_string())?;
    Ok(settings.effective_model(&role, tab_model.as_deref()))
}

/// Like [`model_for_tab`], but from the provider's own model settings
/// (Claude: `models.claude`, default `default`).
pub fn model_for_tab_provider(
    store: &Mutex<StateStore>,
    settings: &Mutex<SettingsStore>,
    tab_id: Option<&str>,
    role_id: &str,
    provider: crate::provider::ProviderId,
) -> Result<String, String> {
    if provider == crate::provider::ProviderId::Cursor {
        return model_for_tab(store, settings, tab_id, role_id);
    }
    let (role, tab_model) = {
        let store = store.lock().map_err(|err| err.to_string())?;
        let tab = tab_id.and_then(|id| store.tab_by_id(id));
        let role = tab
            .map(|t| t.role_id.clone())
            .filter(|r| !r.is_empty() && role_id.is_empty())
            .unwrap_or_else(|| role_id.to_string());
        (role, tab.and_then(|t| t.model.clone()))
    };
    let settings = settings.lock().map_err(|err| err.to_string())?;
    // Never let a Cursor id (old tab override, role default) reach Claude.
    let tab_model = tab_model.filter(|id| is_claude_model_id(id));
    let picked = effective_model(settings.models_for(provider), &role, tab_model.as_deref());
    Ok(claude_model_or_default(Some(&picked)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_ids_are_told_apart_from_cursor_ids() {
        for id in [
            "default",
            "opus",
            "sonnet",
            "haiku",
            "fable",
            "opus[1m]",
            "claude-fable-5[1m]",
            "claude-opus-4-8",
            "claude-sonnet-4-5-20250929",
        ] {
            assert!(is_claude_model_id(id), "{id}");
        }
        for id in [
            "composer-2.5",
            "composer-2.5-fast",
            "gpt-5",
            "auto",
            "sonnet-4.5-thinking",
            "claude-4.5-sonnet",
            "claude-",
            "claude-opus",
            "--settings",
            "opus [1m]",
            "",
        ] {
            assert!(!is_claude_model_id(id), "{id}");
        }
    }

    #[test]
    fn non_claude_models_fall_back_to_default() {
        assert_eq!(claude_model_or_default(Some("composer-2.5")), "default");
        assert_eq!(claude_model_or_default(Some("gpt-5")), "default");
        assert_eq!(claude_model_or_default(None), "default");
        assert_eq!(claude_model_or_default(Some(" opus ")), "opus");
        assert_eq!(claude_model_or_default(Some("opus[1m]")), "opus[1m]");
    }
    use std::collections::HashMap;

    const SAMPLE: &str = "Available models\n\
\u{200B}composer-2.5 - Composer 2.5  (current)\n\
composer-2.5-fast - Composer 2.5 Fast (default)\n\
auto  -  Auto\n\
sonnet-4.5-thinking - Claude  Sonnet 4.5 Thinking\n\
\n\
Tip: use --model <id> to pick one\n";

    #[test]
    fn parses_header_then_id_label_lines() {
        let models = parse_list_models(SAMPLE);
        let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(
            ids,
            vec![
                "composer-2.5",
                "composer-2.5-fast",
                "auto",
                "sonnet-4.5-thinking"
            ]
        );
        assert_eq!(models[0].label, "Composer 2.5");
        assert_eq!(models[1].label, "Composer 2.5 Fast");
        assert_eq!(models[3].label, "Claude Sonnet 4.5 Thinking");
    }

    #[test]
    fn flags_fast_variants() {
        let models = parse_list_models(SAMPLE);
        assert!(!models[0].fast);
        assert!(models[1].fast);
        assert!(!models[2].fast);
    }

    #[test]
    fn strips_ansi_zero_width_and_duplicate_ids() {
        let text = "Models\n\u{1b}[1mgpt-5\u{1b}[0m - GPT-5 (current) (default)\ngpt-5 - again\n";
        let models = parse_list_models(text);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].label, "GPT-5");
    }

    #[test]
    fn sixty_entries_parse() {
        let mut text = String::from("Available models\n");
        for n in 0..60 {
            text.push_str(&format!("model-{n} - Model {n}\n"));
        }
        assert_eq!(parse_list_models(&text).len(), 60);
    }

    #[test]
    fn model_ids_cannot_be_flags_or_carry_spaces() {
        assert!(valid_model_id("composer-2.5"));
        assert!(valid_model_id("vendor/model:latest"));
        assert!(valid_model_id("opus[1m]"));
        assert!(valid_model_id("sonnet[1m]"));
        assert!(!valid_model_id("--yolo"));
        assert!(!valid_model_id("a b"));
        assert!(!valid_model_id("x;rm"));
        assert!(!valid_model_id(""));
    }

    #[test]
    fn default_is_composer_not_fast() {
        assert_eq!(DEFAULT_MODEL_ID, "composer-2.5");
        let settings = ModelSettings::default();
        assert_eq!(
            effective_model(&settings, "role_implementer", None),
            "composer-2.5"
        );
    }

    #[test]
    fn tab_beats_role_beats_global() {
        let settings = ModelSettings {
            default_model: "auto".to_string(),
            role_models: HashMap::from([("role_planner".to_string(), "gpt-5".to_string())]),
        };
        assert_eq!(effective_model(&settings, "role_general", None), "auto");
        assert_eq!(effective_model(&settings, "role_planner", None), "gpt-5");
        assert_eq!(
            effective_model(&settings, "role_planner", Some("sonnet-4.5")),
            "sonnet-4.5"
        );
        assert_eq!(
            effective_model(&settings, "role_planner", Some("  ")),
            "gpt-5"
        );
    }

    #[test]
    fn fresh_cache_is_used_without_running_the_cli() {
        let cache = ModelCache {
            fetched_at_ms: 1_000,
            models: static_fallback(),
        };
        let (list, fresh) = choose_list(false, 2_000, Some(cache), || {
            panic!("the CLI must not run while the cache is fresh")
        });
        assert_eq!(list.source, "cache");
        assert!(fresh.is_none());
    }

    #[test]
    fn failed_cli_uses_stale_cache_then_static_list() {
        let cache = ModelCache {
            fetched_at_ms: 0,
            models: vec![ModelEntry {
                id: "x".to_string(),
                label: "X".to_string(),
                fast: false,
                badge: None,
            }],
        };
        let (list, _) = choose_list(true, CACHE_TTL_MS * 2, Some(cache), || {
            Err("missing".to_string())
        });
        assert_eq!(list.source, "cache");
        assert_eq!(list.models[0].id, "x");
        assert_eq!(list.error.as_deref(), Some("missing"));
        let (list, _) = choose_list(true, 0, None, || Err("missing".to_string()));
        assert_eq!(list.source, "fallback");
        assert!(list.models.iter().any(|m| m.id == DEFAULT_MODEL_ID));
    }

    #[test]
    fn cli_result_is_returned_and_cached() {
        let (list, fresh) = choose_list(true, 5, None, || Ok(parse_list_models(SAMPLE)));
        assert_eq!(list.source, "cli");
        assert_eq!(fresh.map(|c| c.fetched_at_ms), Some(5));
    }

    #[test]
    fn cache_round_trips() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("dcterminal_model_cache_{nanos}"));
        assert!(read_cache(&dir).is_none());
        let cache = ModelCache {
            fetched_at_ms: 42,
            models: static_fallback(),
        };
        write_cache(&dir, &cache).unwrap();
        let back = read_cache(&dir).unwrap();
        assert_eq!(back.fetched_at_ms, 42);
        assert_eq!(back.models, cache.models);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn claude_fallback_is_the_four_aliases_and_cache_is_per_provider() {
        let fallback = claude_static_fallback();
        assert_eq!(
            fallback.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["default", "opus", "sonnet", "haiku"]
        );
        assert!(fallback.iter().all(|m| m.badge.is_none()));
        let listed = claude_models_from_options(&[
            ("default".into(), "Default".into()),
            ("opus[1m]".into(), "Opus".into()),
            ("claude-fable-5[1m]".into(), "Fable".into()),
            ("composer-2.5".into(), "Composer".into()),
        ]);
        assert_eq!(listed[1].id, "opus[1m]");
        assert_eq!(
            listed[2].badge.as_deref(),
            Some("may use usage credits")
        );
        assert!(listed.iter().all(|m| m.id != "composer-2.5"));

        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("dcterminal_claude_models_{nanos}"));
        let stale = claude_model_list(&dir, 1_000);
        assert_eq!(stale.source, "fallback");
        remember_claude_models(&dir, &listed).unwrap();
        let fresh = claude_model_list(&dir, chrono::Utc::now().timestamp_millis());
        assert_eq!(fresh.source, "cache");
        assert_eq!(fresh.models[2].id, "claude-fable-5[1m]");
        // Cursor cache is a different slot.
        assert!(read_cache(&dir).is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn legacy_flat_cache_is_the_cursor_list() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("dcterminal_legacy_models_{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        let body = serde_json::json!({
            "fetchedAtMs": 10,
            "models": [{ "id": "composer-2.5", "label": "Composer 2.5", "fast": false }]
        });
        std::fs::write(dir.join("models-cache.json"), body.to_string()).unwrap();
        let cursor = read_provider_cache(&dir, "cursor").unwrap();
        assert_eq!(cursor.models[0].id, "composer-2.5");
        assert!(read_provider_cache(&dir, "claude").is_none());
        let _ = std::fs::remove_dir_all(dir);
    }
}
