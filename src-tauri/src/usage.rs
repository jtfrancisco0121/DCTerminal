//! Last Claude rate-limit windows and per-tab context fill.
//!
//! Values come from `usage_update` (`_meta["_claude/rateLimit"]` and
//! `used`/`size`), keyed by the Claude config folder. The rate windows are
//! also saved to `usage.json` in DCTerminal's app data, so the last reading
//! is shown after a restart; nothing is written into the config folder.
//! Context fill stays in memory. Token totals and dollar amounts on the same
//! event are ignored.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub const USAGE_FILE: &str = "usage.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RateWindow {
    pub rate_limit_type: String,
    pub label: String,
    /// 0–100 when the adapter sent a utilization. Absent in the captured
    /// fixture, so the UI says the percent is not reported yet.
    pub utilization: Option<f64>,
    /// Unix seconds, when the adapter sent `resetsAt`.
    pub resets_at: Option<i64>,
    pub status: String,
    pub seen_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContextFill {
    pub used: u64,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    pub config_dir: String,
    pub windows: Vec<RateWindow>,
    pub context_by_tab: HashMap<String, ContextFill>,
}

/// What `usage.json` holds: the last rate windows per config folder.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsageFile {
    #[serde(default)]
    by_config: HashMap<String, HashMap<String, RateWindow>>,
}

#[derive(Debug, Default)]
pub struct UsageStore {
    by_config: HashMap<String, HashMap<String, RateWindow>>,
    context: HashMap<String, ContextFill>,
    tab_config: HashMap<String, String>,
    /// `usage.json` in app data. `None` keeps everything in memory (tests).
    path: Option<PathBuf>,
}

impl UsageStore {
    /// Load the last rate windows from app data. A damaged file starts empty.
    pub fn open(data_dir: &Path) -> Self {
        let path = data_dir.join(USAGE_FILE);
        let file: UsageFile = crate::store::read_json_or_recover(&path).unwrap_or_default();
        Self {
            by_config: file.by_config,
            path: Some(path),
            ..Self::default()
        }
    }

    fn save(&self) {
        let Some(path) = &self.path else {
            return;
        };
        let file = UsageFile {
            by_config: self.by_config.clone(),
        };
        if let Err(err) = crate::store::write_json_atomic(path, &file) {
            eprintln!("DCTerminal: could not save Claude usage ({err})");
        }
    }

    pub fn note(&mut self, config_dir: &str, tab_id: &str, raw_json: &str, seen_at_ms: i64) {
        let Ok(params) = serde_json::from_str::<Value>(raw_json) else {
            return;
        };
        let update = params.get("update").unwrap_or(&params);
        let kind = update
            .get("sessionUpdate")
            .or_else(|| update.get("type"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if kind != "usage_update" {
            return;
        }
        let key = config_dir.trim().to_string();
        if key.is_empty() {
            return;
        }
        self.tab_config.insert(tab_id.to_string(), key.clone());
        if let (Some(used), Some(size)) = (json_u64(update.get("used")), json_u64(update.get("size")))
        {
            if size > 0 {
                self.context.insert(
                    tab_id.to_string(),
                    ContextFill { used, size },
                );
            }
        }
        let Some(limit) = update
            .get("_meta")
            .and_then(|meta| meta.get("_claude/rateLimit"))
        else {
            return;
        };
        let rate_type = limit
            .get("rateLimitType")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        let window = RateWindow {
            label: window_label(&rate_type),
            utilization: utilization_percent(limit),
            resets_at: limit.get("resetsAt").and_then(Value::as_i64),
            status: limit
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("allowed")
                .to_string(),
            seen_at_ms,
            rate_limit_type: rate_type.clone(),
        };
        let windows = self.by_config.entry(key).or_default();
        let changed = windows.get(&rate_type).map(|old| {
            old.utilization != window.utilization
                || old.resets_at != window.resets_at
                || old.status != window.status
        });
        windows.insert(rate_type, window);
        // Every turn repeats the same reading; write only when it changes.
        if changed != Some(false) {
            self.save();
        }
    }

    pub fn snapshot(&self, config_dir: &str) -> UsageSnapshot {
        let key = config_dir.trim();
        let mut windows: Vec<RateWindow> = self
            .by_config
            .get(key)
            .map(|map| map.values().cloned().collect())
            .unwrap_or_default();
        windows.sort_by(|a, b| a.rate_limit_type.cmp(&b.rate_limit_type));
        let context_by_tab = self
            .tab_config
            .iter()
            .filter(|(_, dir)| dir.as_str() == key)
            .filter_map(|(tab, _)| self.context.get(tab).map(|fill| (tab.clone(), fill.clone())))
            .collect();
        UsageSnapshot {
            config_dir: key.to_string(),
            windows,
            context_by_tab,
        }
    }
}

fn json_u64(value: Option<&Value>) -> Option<u64> {
    value.and_then(|v| {
        v.as_u64()
            .or_else(|| v.as_i64().filter(|n| *n >= 0).map(|n| n as u64))
            .or_else(|| v.as_f64().filter(|n| n.is_finite() && *n >= 0.0).map(|n| n as u64))
    })
}

/// `utilization` may be a fraction (0–1) or a percent. Missing stays missing.
fn utilization_percent(limit: &Value) -> Option<f64> {
    let raw = limit
        .get("utilization")
        .or_else(|| limit.get("usedPercent"))
        .or_else(|| limit.get("utilizationPercent"))
        .and_then(Value::as_f64)?;
    if !raw.is_finite() || raw < 0.0 {
        return None;
    }
    let percent = if raw <= 1.0 { raw * 100.0 } else { raw };
    Some((percent * 10.0).round() / 10.0)
}

pub fn window_label(rate_type: &str) -> String {
    match rate_type {
        "five_hour" => "5h".to_string(),
        "seven_day" => "7d".to_string(),
        other => other.replace('_', " "),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixture_keeps_five_hour_window_and_ignores_cost() {
        let raw = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../fixtures/acp/claude/prompt-turn.json"
        ))
        .unwrap();
        let file: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let lines = file["messages"].as_array().cloned().unwrap_or_default();
        let mut store = UsageStore::default();
        for line in &lines {
            let params = line.get("params").cloned().unwrap_or(serde_json::Value::Null);
            store.note("/tmp/claude-account2", "tab_1", &params.to_string(), 1_700_000_000_000);
        }
        let snap = store.snapshot("/tmp/claude-account2");
        assert_eq!(snap.windows.len(), 1);
        assert_eq!(snap.windows[0].rate_limit_type, "five_hour");
        assert_eq!(snap.windows[0].label, "5h");
        assert_eq!(snap.windows[0].status, "allowed");
        assert_eq!(snap.windows[0].resets_at, Some(1791538800));
        assert_eq!(snap.windows[0].utilization, None);
        let fill = snap.context_by_tab.get("tab_1").unwrap();
        assert_eq!(fill.used, 26504);
        assert_eq!(fill.size, 1_000_000);
        // A different config folder does not see this account.
        assert!(store.snapshot("/tmp/other").windows.is_empty());
    }

    #[test]
    fn last_reading_survives_a_restart_without_context_fill() {
        let dir = std::env::temp_dir().join(format!(
            "dcterminal_usage_{}",
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let params = serde_json::json!({
            "update": {
                "sessionUpdate": "usage_update",
                "used": 10,
                "size": 100,
                "_meta": { "_claude/rateLimit": {
                    "status": "allowed", "resetsAt": 200, "rateLimitType": "five_hour", "utilization": 0.42
                } }
            }
        });
        let mut store = UsageStore::open(&dir);
        store.note("/cfg", "tab_1", &params.to_string(), 5);
        let reopened = UsageStore::open(&dir);
        let snap = reopened.snapshot("/cfg");
        assert_eq!(snap.windows.len(), 1);
        assert_eq!(snap.windows[0].utilization, Some(42.0));
        assert_eq!(snap.windows[0].seen_at_ms, 5);
        assert!(snap.context_by_tab.is_empty());
        // A damaged file starts empty instead of failing.
        std::fs::write(dir.join(USAGE_FILE), "{oops").unwrap();
        assert!(UsageStore::open(&dir).snapshot("/cfg").windows.is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn utilization_fraction_becomes_a_percent() {
        let mut store = UsageStore::default();
        let params = serde_json::json!({
            "update": {
                "sessionUpdate": "usage_update",
                "used": 10,
                "size": 100,
                "_meta": {
                    "_claude/rateLimit": {
                        "status": "allowed_warning",
                        "resetsAt": 100,
                        "rateLimitType": "seven_day",
                        "utilization": 0.82
                    }
                }
            }
        });
        store.note("/c", "t", &params.to_string(), 5);
        let snap = store.snapshot("/c");
        assert_eq!(snap.windows[0].utilization, Some(82.0));
        assert_eq!(snap.windows[0].label, "7d");
        assert_eq!(snap.windows[0].status, "allowed_warning");
    }
}
