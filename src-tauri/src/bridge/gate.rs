//! Whether an engine-2 run may launch its stages bridged (plan D24, the
//! `disableAllHooks` risk row; ADR-015 §6), checked at every bridged start
//! and every relaunch (Restart, resume) of a bridged tab, on the launch's
//! blocking thread, with no store lock held while reading the CLI and the
//! settings. The version is cached; the settings are read each time:
//!
//! - The bridge relies on what V0 verified on Claude Code 2.1.287 (command
//!   hooks with an `args` array, `prompt_id` in the payloads, the MCP
//!   handshake). An older CLI, or one whose version cannot be read, runs the
//!   run as engine 1 with a notice. A newer one is allowed: the bridge logs
//!   payload fields it has not seen (`hook::note_unknown_fields`) and the
//!   overview says "Claude Code version not yet verified".
//! - `disableAllHooks: true` in a settings file Claude Code would read
//!   (the run's config folder, the project's `.claude/settings*.json`, the
//!   managed settings), or a managed `allowManagedHooksOnly: true` (which
//!   drops `--settings` hooks too), turns the bridge's hooks off, so the run
//!   uses engine 1.
//!
//! The version comes from `claude --version` (`claude_detect::read_claude_version`),
//! read once per executable and cached (`ClaudeProvider::cli_version`).

use serde_json::Value;
use std::path::{Path, PathBuf};

/// The Claude Code version V0 verified the bridge against.
pub const VERIFIED_CLAUDE_VERSION: [u32; 3] = [2, 1, 287];

fn verified_text() -> String {
    let [a, b, c] = VERIFIED_CLAUDE_VERSION;
    format!("{a}.{b}.{c}")
}

/// `2.1.287` from `claude --version` output such as `2.1.287 (Claude Code)`.
pub fn parse_version(text: &str) -> Option<[u32; 3]> {
    let first = text.split_whitespace().next()?;
    let first = first.strip_prefix('v').unwrap_or(first);
    let mut parts = first.split('.');
    let mut out = [0u32; 3];
    for slot in &mut out {
        let digits: String = parts.next()?.chars().take_while(char::is_ascii_digit).collect();
        *slot = digits.parse().ok()?;
    }
    Some(out)
}

/// What the gate decided for a run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Gate {
    /// Launch bridged. `unverified`: the overview note for a newer CLI.
    Bridge { unverified: Option<String> },
    /// The run uses engine 1; the notice says why.
    EngineOne(String),
}

/// D24 over the CLI's version text (`None`: it could not be read), then
/// `hooks_off` (the settings file that turns hooks off, if any).
pub fn decide(version: Option<&str>, hooks_off: Option<&HooksOff>) -> Gate {
    let verified = verified_text();
    if let Some(off) = hooks_off {
        return Gate::EngineOne(format!(
            "Claude Code hooks are turned off ({} in {}), so this run uses engine 1, which is manual only: hand each stage on yourself.",
            off.setting,
            off.file.display()
        ));
    }
    let text = version.map(str::trim).filter(|text| !text.is_empty());
    let Some(found) = text.and_then(parse_version) else {
        return Gate::EngineOne(format!(
            "DCTerminal could not read the Claude Code version (pipeline v2 needs {verified} or newer), so this run uses engine 1, which is manual only: hand each stage on yourself."
        ));
    };
    let shown = text.and_then(|t| t.split_whitespace().next()).unwrap_or_default();
    if found < VERIFIED_CLAUDE_VERSION {
        return Gate::EngineOne(format!(
            "Claude Code {shown} is older than {verified}, which pipeline v2 needs, so this run uses engine 1, which is manual only: hand each stage on yourself. Update Claude Code for the next run."
        ));
    }
    Gate::Bridge {
        unverified: (found > VERIFIED_CLAUDE_VERSION).then(|| {
            format!("Claude Code version not yet verified: {shown} is newer than {verified}, the version pipeline v2 was checked against.")
        }),
    }
}

/// Record `gate` on an engine-2 `run` at a bridged launch of `stage_id`.
/// Returns (launch bridged, run changed). Engine 1: the run switches for
/// good, with its notice on the overview (`engine_note`) and the Timeline.
pub fn apply(run: &mut crate::store::PipelineRun, gate: &Gate, stage_id: &str) -> (bool, bool) {
    apply_with(run, gate, stage_id, true)
}

/// [`apply`]; `timeline: false` leaves the engine-1 notice off the Timeline
/// (a relaunch's switch logs its own "manual from now on" line instead).
pub fn apply_with(run: &mut crate::store::PipelineRun, gate: &Gate, stage_id: &str, timeline: bool) -> (bool, bool) {
    match gate {
        Gate::EngineOne(notice) => {
            run.engine = 1;
            run.engine_note = Some(notice.clone());
            if timeline {
                run.log("note", Some(stage_id), None, notice.clone(), None);
            }
            (false, true)
        }
        Gate::Bridge { unverified } => {
            let changed = unverified.is_some() && run.engine_note != *unverified;
            if changed {
                run.engine_note = unverified.clone();
            }
            (true, changed)
        }
    }
}

/// A run that was running bridged was just switched to engine 1 at a
/// relaunch: autopilot goes off for good (status `stopped`, no stop reason:
/// the engine note and the Timeline say why), and cannot be turned back on
/// (`manual_only`).
pub fn make_manual(run: &mut crate::store::PipelineRun, stage_id: &str, decided_key: Option<&str>) {
    run.manual_only = true;
    // Belt and braces for restart recovery and Continue: the relaunched
    // tab's current turn (decided by the bridge) under its v1 key too.
    if let Some(key) = decided_key.map(str::trim).filter(|key| !key.is_empty()) {
        let decided = &mut run.autopilot.get_or_insert_with(Default::default).decided;
        if !decided.iter().any(|seen| seen == key) {
            decided.push(key.to_string());
            if decided.len() > crate::store::MAX_DECIDED_TURNS {
                let drop = decided.len() - crate::store::MAX_DECIDED_TURNS;
                decided.drain(..drop);
            }
        }
    }
    run.set_autopilot_enabled(false);
    run.stop_reason = None;
    let why = run
        .engine_note
        .take()
        .and_then(|note| note.split(", so this run uses engine 1").next().map(str::to_string))
        .filter(|why| !why.is_empty());
    let line = "This run was running with the pipeline bridge, so it is manual from now on: autopilot is off. Hand each stage on yourself.";
    let note = match why {
        Some(why) => format!("{why}. {line}"),
        None => line.to_string(),
    };
    run.log("note", Some(stage_id), None, note.clone(), None);
    run.engine_note = Some(note);
}

/// The managed settings file Claude Code reads on this OS.
pub fn managed_settings_path() -> Option<PathBuf> {
    if cfg!(target_os = "macos") {
        Some(PathBuf::from("/Library/Application Support/ClaudeCode/managed-settings.json"))
    } else if cfg!(windows) {
        Some(PathBuf::from(r"C:\Program Files\ClaudeCode\managed-settings.json"))
    } else {
        Some(PathBuf::from("/etc/claude-code/managed-settings.json"))
    }
}

/// The settings files Claude Code would read for a stage in `cwd` under the
/// config folder `config_dir`, then `managed`.
fn settings_files(config_dir: Option<&Path>, cwd: &Path, managed: Option<PathBuf>) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = config_dir.map(|dir| dir.join("settings.json")).into_iter().collect();
    files.push(cwd.join(".claude").join("settings.json"));
    files.push(cwd.join(".claude").join("settings.local.json"));
    files.extend(managed);
    files
}

/// Where and how Claude Code's hooks are turned off for a stage.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HooksOff {
    pub file: PathBuf,
    /// `disableAllHooks`, or `allowManagedHooksOnly` (managed settings only;
    /// it drops hooks given with `--settings` too).
    pub setting: &'static str,
}

fn read_settings(path: &Path) -> Option<Value> {
    std::fs::read(path).ok().and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
}

fn is_true(settings: &Value, key: &str) -> bool {
    settings.get(key).and_then(Value::as_bool) == Some(true)
}

/// Whether a settings file Claude Code would read turns the bridge's hooks
/// off: `disableAllHooks: true` in any of them (`settings_files`), or a
/// managed `allowManagedHooksOnly: true`. A missing or unreadable file sets
/// nothing. Read-only.
pub fn hooks_off(config_dir: Option<&Path>, cwd: &Path, managed: Option<PathBuf>) -> Option<HooksOff> {
    let files = settings_files(config_dir, cwd, managed.clone());
    if let Some(file) = files.into_iter().find(|path| read_settings(path).is_some_and(|s| is_true(&s, "disableAllHooks"))) {
        return Some(HooksOff { file, setting: "disableAllHooks" });
    }
    let managed = managed?;
    read_settings(&managed)
        .is_some_and(|s| is_true(&s, "allowManagedHooksOnly"))
        .then_some(HooksOff { file: managed, setting: "allowManagedHooksOnly" })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    #[test]
    fn versions_parse_from_the_cli_output() {
        assert_eq!(parse_version("2.1.287 (Claude Code)"), Some([2, 1, 287]));
        assert_eq!(parse_version("v2.10.3"), Some([2, 10, 3]));
        assert_eq!(parse_version("2.2.0-beta.1 (Claude Code)"), Some([2, 2, 0]));
        assert_eq!(parse_version("boom: bad install"), None);
        assert_eq!(parse_version(""), None);
        assert_eq!(parse_version("2.1"), None);
    }

    #[test]
    fn the_verified_version_or_newer_bridges_and_older_or_unknown_is_engine_1() {
        assert_eq!(decide(Some("2.1.287 (Claude Code)"), None), Gate::Bridge { unverified: None });
        match decide(Some("2.1.300 (Claude Code)"), None) {
            Gate::Bridge { unverified: Some(note) } => {
                assert!(note.starts_with("Claude Code version not yet verified"), "{note}");
                assert!(note.contains("2.1.300") && note.contains("2.1.287"), "{note}");
            }
            other => panic!("a newer CLI is allowed with a note: {other:?}"),
        }
        match decide(Some("2.1.200 (Claude Code)"), None) {
            Gate::EngineOne(notice) => assert!(notice.contains("2.1.200") && notice.contains("engine 1"), "{notice}"),
            other => panic!("an older CLI is engine 1: {other:?}"),
        }
        for unknown in [None, Some(""), Some("boom: bad install")] {
            match decide(unknown, None) {
                Gate::EngineOne(notice) => assert!(notice.contains("could not read"), "{notice}"),
                other => panic!("an unknown version is engine 1: {other:?}"),
            }
        }
    }

    #[test]
    fn every_engine_1_notice_says_the_run_is_manual_only() {
        let off = HooksOff { file: PathBuf::from("/x/settings.json"), setting: "disableAllHooks" };
        for (version, hooks) in [(Some("2.1.200 (Claude Code)"), None), (None, None), (Some("2.1.287 (Claude Code)"), Some(&off))] {
            match decide(version, hooks) {
                Gate::EngineOne(notice) => {
                    assert!(notice.contains(", so this run uses engine 1"), "make_manual cuts here: {notice}");
                    assert!(notice.contains("manual only"), "{notice}");
                    assert!(!notice.contains("autopilot reads"), "engine 1 has no autopilot since V6: {notice}");
                }
                other => panic!("engine 1: {other:?}"),
            }
        }
    }

    fn engine2_run() -> crate::store::PipelineRun {
        let mut run: crate::store::PipelineRun = serde_json::from_value(serde_json::json!({
            "id": "ee_1700000000000", "kind": "full", "cwd": "/repo", "stage": "plan_reviewer",
            "tabIds": {}, "createdAt": "2026-10-19T00:00:00Z", "status": "running"
        }))
        .unwrap();
        run.engine = super::super::launch::ENGINE_V2;
        run
    }

    #[test]
    fn engine_1_is_recorded_on_the_run_with_its_notice_and_a_newer_cli_leaves_a_note() {
        let mut run = engine2_run();
        let gate = decide(Some("2.1.200 (Claude Code)"), None);
        assert_eq!(apply(&mut run, &gate, "plan_reviewer"), (false, true));
        assert_eq!(run.engine, 1, "the run now uses engine 1");
        let note = run.engine_note.clone().expect("the overview's notice");
        assert!(note.contains("2.1.200"), "{note}");
        let event = run.events.last().expect("a Timeline notice");
        assert_eq!(event.kind, "note");
        assert_eq!(event.summary, note);

        let mut run = engine2_run();
        let gate = decide(Some("2.1.300 (Claude Code)"), None);
        assert_eq!(apply(&mut run, &gate, "plan_reviewer"), (true, true));
        assert_eq!(run.engine, super::super::launch::ENGINE_V2);
        assert!(run.engine_note.as_deref().unwrap().starts_with("Claude Code version not yet verified"));
        // The same note again changes nothing.
        assert_eq!(apply(&mut run, &gate, "pr_reviewer"), (true, false));

        let mut run = engine2_run();
        assert_eq!(apply(&mut run, &decide(Some("2.1.287 (Claude Code)"), None), "plan_reviewer"), (true, false));
        assert_eq!(run.engine_note, None);
        assert!(run.events.is_empty());
    }

    #[test]
    fn managed_hooks_only_turns_the_bridge_hooks_off_but_only_in_managed_settings() {
        let dir = TempDir::new("gate_managed_only");
        let config = dir.join("config");
        let cwd = dir.join("repo");
        let managed = dir.join("managed-settings.json");
        std::fs::create_dir_all(&config).unwrap();
        std::fs::create_dir_all(cwd.join(".claude")).unwrap();
        // In your own settings it does nothing (only a managed policy counts).
        std::fs::write(config.join("settings.json"), r#"{"allowManagedHooksOnly": true}"#).unwrap();
        assert_eq!(hooks_off(Some(&config), &cwd, Some(managed.clone())), None);
        std::fs::write(&managed, r#"{"allowManagedHooksOnly": true}"#).unwrap();
        let off = hooks_off(Some(&config), &cwd, Some(managed.clone())).expect("managed hooks only");
        assert_eq!((off.file.as_path(), off.setting), (managed.as_path(), "allowManagedHooksOnly"));
        match decide(Some("2.1.287 (Claude Code)"), Some(&off)) {
            Gate::EngineOne(notice) => assert!(notice.contains("allowManagedHooksOnly"), "{notice}"),
            other => panic!("managed hooks only is engine 1: {other:?}"),
        }
    }

    #[test]
    fn hooks_turned_off_anywhere_claude_reads_settings_is_engine_1() {
        let dir = TempDir::new("gate_hooks_off");
        let config = dir.join("config");
        let cwd = dir.join("repo");
        let managed = dir.join("managed").join("managed-settings.json");
        std::fs::create_dir_all(cwd.join(".claude")).unwrap();
        std::fs::create_dir_all(&config).unwrap();
        std::fs::create_dir_all(managed.parent().unwrap()).unwrap();
        let off = || hooks_off(Some(&config), &cwd, Some(managed.clone()));
        assert_eq!(off(), None, "no files: hooks on");

        // Off, false, or unreadable: hooks stay on.
        std::fs::write(config.join("settings.json"), r#"{"disableAllHooks": false, "statusLine": null}"#).unwrap();
        std::fs::write(cwd.join(".claude").join("settings.json"), "{ not json").unwrap();
        assert_eq!(off(), None);

        for file in [
            config.join("settings.json"),
            cwd.join(".claude").join("settings.json"),
            cwd.join(".claude").join("settings.local.json"),
            managed.clone(),
        ] {
            assert!(file.starts_with(dir.path()), "pinned to the temp dir");
            std::fs::write(&file, r#"{"disableAllHooks": true}"#).unwrap();
            let found = off().expect("hooks off");
            assert_eq!((found.file.as_path(), found.setting), (file.as_path(), "disableAllHooks"));
            match decide(Some("2.1.287 (Claude Code)"), Some(&found)) {
                Gate::EngineOne(notice) => assert!(notice.contains("disableAllHooks"), "{notice}"),
                other => panic!("hooks off is engine 1: {other:?}"),
            }
            std::fs::remove_file(&file).unwrap();
        }
    }
}
