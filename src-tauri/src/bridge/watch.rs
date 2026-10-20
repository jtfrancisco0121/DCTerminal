//! The inbox watcher: a thread that reads the finished turns the Stop hook
//! drops in `runs/*/inbox/`, deletes each file and emits it to the frontend
//! as `pipeline-bridge-turn`, where today's executor decides on it (V2a;
//! the run actor takes this over in V3). A Needs you the PermissionRequest
//! hook (or its Notification backup) drops there goes out as
//! `pipeline-bridge-needs` (V2b).
//!
//! Wake-ups come from a `notify` watcher on `runs/` (recursive), with a
//! short debounce and a safety poll in case an event was missed, like the
//! session-log watch. At startup the inbox is emptied without emitting: a
//! turn that ended while the app was closed is never acted on by itself
//! (D29); Continue reads it back from `turn.json`.

use super::folder::{BridgeNeeds, BridgeTurn, INBOX_DIR};
use notify::{EventKind, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, RecvTimeoutError};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Runtime};

pub const BRIDGE_TURN_EVENT: &str = "pipeline-bridge-turn";
pub const BRIDGE_NEEDS_EVENT: &str = "pipeline-bridge-needs";

/// One event from an inbox.
#[derive(Debug, Clone, PartialEq)]
pub enum InboxEvent {
    /// A finished turn (`<stamp>-stop-<turn>.json`).
    Turn(BridgeTurn),
    /// A stage waiting on a permission dialog (`<stamp>-needs-<turn>.json`).
    Needs(BridgeNeeds),
}

/// `<stamp>-<kind>-<turn>.json`: the stamp has no `-`, a turn id may.
fn parse_event(name: &str, text: &str) -> Option<InboxEvent> {
    if name.split_once('-').is_some_and(|(_, rest)| rest.starts_with("needs-")) {
        serde_json::from_str(text).ok().map(InboxEvent::Needs)
    } else {
        serde_json::from_str(text).ok().map(InboxEvent::Turn)
    }
}

const SAFETY_POLL: Duration = Duration::from_millis(2000);
const DEBOUNCE: Duration = Duration::from_millis(30);

/// Event files waiting in every run's inbox, oldest name first.
fn inbox_files(runs_root: &Path) -> Vec<PathBuf> {
    let Ok(runs) = std::fs::read_dir(runs_root) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = runs
        .flatten()
        .filter_map(|run| std::fs::read_dir(run.path().join(INBOX_DIR)).ok())
        .flat_map(|entries| entries.flatten().map(|entry| entry.path()))
        .filter(|path| {
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default();
            !name.starts_with('.') && name.ends_with(".json")
        })
        .collect();
    files.sort_by(|a, b| a.file_name().cmp(&b.file_name()));
    files
}

/// Read, delete and hand on every waiting event. A file that does not parse
/// is deleted too, so it is not read again. Returns how many were handed on.
pub fn drain_inbox(runs_root: &Path, emit: &mut dyn FnMut(InboxEvent)) -> usize {
    let mut count = 0;
    for path in inbox_files(runs_root) {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string();
        let event = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| parse_event(&name, &text));
        if std::fs::remove_file(&path).is_err() {
            // Not ours to delete (or gone): never emit the same file twice.
            continue;
        }
        if let Some(event) = event {
            emit(event);
            count += 1;
        }
    }
    count
}

/// Empty every inbox without handing anything on (startup).
pub fn clear_inbox(runs_root: &Path) -> usize {
    drain_inbox(runs_root, &mut |_| {})
}

/// Start the watcher thread. Never returns an error: without `notify` the
/// safety poll still reads.
pub fn spawn<R: Runtime>(app: AppHandle<R>, runs_root: PathBuf) {
    std::thread::spawn(move || {
        if let Err(err) = std::fs::create_dir_all(&runs_root) {
            eprintln!("DCTerminal: run folder {} unavailable: {err}", runs_root.display());
        }
        let stale = clear_inbox(&runs_root);
        if stale > 0 {
            eprintln!("DCTerminal: left {stale} turn(s) that ended while the app was closed for Continue");
        }
        let (wake, wakes) = channel::<()>();
        let _watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
            let Ok(event) = event else {
                return;
            };
            if matches!(event.kind, EventKind::Access(_)) {
                return;
            }
            let in_inbox = event
                .paths
                .iter()
                .any(|p| p.parent().and_then(Path::file_name).is_some_and(|n| n == INBOX_DIR));
            if in_inbox {
                let _ = wake.send(());
            }
        })
        .ok()
        .and_then(|mut watcher| watcher.watch(&runs_root, RecursiveMode::Recursive).ok().map(|_| watcher));
        loop {
            drain_inbox(&runs_root, &mut |event| {
                let _ = match event {
                    InboxEvent::Turn(turn) => app.emit(BRIDGE_TURN_EVENT, turn),
                    InboxEvent::Needs(needs) => app.emit(BRIDGE_NEEDS_EVENT, needs),
                };
            });
            match wakes.recv_timeout(SAFETY_POLL) {
                Ok(()) | Err(RecvTimeoutError::Timeout) => {}
                // No watcher (it failed to start): poll.
                Err(RecvTimeoutError::Disconnected) => std::thread::sleep(SAFETY_POLL),
            }
            while wakes.recv_timeout(DEBOUNCE).is_ok() {}
        }
    });
}
