//! Live chat entries for one tab: a thread that re-reads the tab's session
//! log when it changes and sends what is new on a channel.
//!
//! Wake-ups come from a `notify` watcher on the log's folder (FSEvents on
//! macOS), filtered to the log's file name, with a short debounce so a burst
//! of appended lines is one read. A read is cheap (a stat, then only the
//! appended bytes), so the thread also reads every `SAFETY_POLL` in case an
//! event was missed or coalesced away, and every `FIND_POLL` while the log
//! does not exist yet (Claude Code creates it on the first prompt). Nothing
//! is sent when nothing changed.
//!
//! A watch ends when it is replaced or stopped (`unwatch`, the tab closes,
//! its PTY is killed) or when the view's channel is gone.

use super::chat::ChatEntriesUpdate;
use super::reader::SessionLogReaders;
use notify::{EventKind, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

const SAFETY_POLL: Duration = Duration::from_millis(2000);
const FIND_POLL: Duration = Duration::from_millis(1000);
const DEBOUNCE: Duration = Duration::from_millis(40);

pub(crate) enum Wake {
    Changed,
    Stop,
}

/// A running watch; dropping it does not stop the thread, `stop` does.
pub(crate) struct WatchHandle {
    wake: Sender<Wake>,
    /// Set by `stop`. The thread checks it under the readers' map lock before
    /// it keeps a reader, so a read already under way when the tab is
    /// forgotten does not put the reader back.
    stopped: Arc<AtomicBool>,
}

impl WatchHandle {
    pub(crate) fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        let _ = self.wake.send(Wake::Stop);
    }
}

/// Start a watch thread for `tab_id`. `target` names the tab's config dir and
/// session id on each read (it can change when the PTY restarts); `send`
/// returns false once the view is gone. `since` is the view's last revision.
pub(crate) fn spawn_watch<T, S>(
    readers: SessionLogReaders,
    tab_id: String,
    since: Option<u64>,
    target: T,
    send: S,
) -> WatchHandle
where
    T: Fn() -> Option<(PathBuf, String)> + Send + 'static,
    S: Fn(ChatEntriesUpdate) -> bool + Send + 'static,
{
    let (wake, wakes) = channel::<Wake>();
    let events = wake.clone();
    let stopped = Arc::new(AtomicBool::new(false));
    let thread_stopped = stopped.clone();
    thread::spawn(move || {
        let stopped = thread_stopped;
        let mut since = since;
        let mut watched: Option<(PathBuf, notify::RecommendedWatcher)> = None;
        loop {
            if stopped.load(Ordering::SeqCst) {
                break;
            }
            let reader =
                target().and_then(|(dir, id)| readers.watch_reader(&tab_id, &dir, &id, &stopped));
            if let Some(reader) = reader {
                let (update, path) = match reader.lock() {
                    Ok(guard) => (guard.chat_since(since), guard.path().to_path_buf()),
                    Err(_) => break,
                };
                since = Some(update.revision);
                if (update.reset || !update.entries.is_empty()) && !send(update) {
                    break;
                }
                if watched.as_ref().map(|(file, _)| file) != Some(&path) {
                    watched = watch_file(&path, events.clone()).map(|w| (path, w));
                }
            }
            let wait = if watched.is_some() {
                SAFETY_POLL
            } else {
                FIND_POLL
            };
            match wakes.recv_timeout(wait) {
                Ok(Wake::Stop) | Err(RecvTimeoutError::Disconnected) => break,
                Ok(Wake::Changed) | Err(RecvTimeoutError::Timeout) => {}
            }
            // Let a burst of writes settle into one read.
            loop {
                match wakes.recv_timeout(DEBOUNCE) {
                    Ok(Wake::Changed) => continue,
                    Ok(Wake::Stop) => return,
                    Err(_) => break,
                }
            }
        }
    });
    WatchHandle { wake, stopped }
}

/// Watch `path`'s folder and wake on events that name `path`. `None` when the
/// watcher cannot start; the safety poll still reads.
fn watch_file(path: &Path, wake: Sender<Wake>) -> Option<notify::RecommendedWatcher> {
    let name = path.file_name()?.to_os_string();
    let folder = path.parent()?;
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        let Ok(event) = event else {
            return;
        };
        if matches!(event.kind, EventKind::Access(_)) {
            return;
        }
        // FSEvents may report /private/var for /var: compare names only.
        if event
            .paths
            .iter()
            .any(|p| p.file_name() == Some(name.as_os_str()))
        {
            let _ = wake.send(Wake::Changed);
        }
    })
    .ok()?;
    watcher.watch(folder, RecursiveMode::NonRecursive).ok()?;
    Some(watcher)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;
    use std::io::Write;
    use std::sync::mpsc::Receiver;

    const SID: &str = "0b6c1d2e-aaaa-4bbb-8ccc-1234567890ab";

    fn line(kind: &str, text: &str, at: &str) -> String {
        let body = if kind == "user" {
            serde_json::json!({ "role": "user", "content": text })
        } else {
            serde_json::json!({ "role": "assistant", "content": [{ "type": "text", "text": text }],
                "stop_reason": "end_turn" })
        };
        serde_json::json!({ "type": kind, "isSidechain": false, "timestamp": at, "message": body })
            .to_string()
            + "\n"
    }

    fn next(rx: &Receiver<ChatEntriesUpdate>) -> ChatEntriesUpdate {
        rx.recv_timeout(Duration::from_secs(10)).expect("an update")
    }

    #[test]
    fn a_watch_sends_the_log_once_it_exists_then_only_appends_and_stops() {
        let dir = TempDir::new("watch_live");
        let folder = dir.join("projects").join("-tmp-project");
        let path = folder.join(format!("{SID}.jsonl"));
        let config = dir.path().to_path_buf();
        let (tx, rx) = channel();
        let readers = SessionLogReaders::new();
        let handle = spawn_watch(
            readers.clone(),
            "watch-tab".into(),
            None,
            move || Some((config.clone(), SID.to_string())),
            move |update| tx.send(update).is_ok(),
        );
        // Not there yet: nothing is sent until Claude Code writes the file.
        assert!(rx.recv_timeout(Duration::from_millis(300)).is_err());
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(&path, line("user", "hello", "t1")).unwrap();
        let first = next(&rx);
        assert!(first.reset);
        assert_eq!(first.entries.len(), 1);

        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        file.write_all(line("assistant", "Hi!", "t2").as_bytes())
            .unwrap();
        drop(file);
        let second = next(&rx);
        assert!(!second.reset);
        assert_eq!(second.entries.len(), 1);
        assert_eq!(second.entries[0].seq, 1);

        readers.set_watch("watch-tab", handle);
        assert_eq!(readers.watch_count(), 1);
        readers.stop_watch("watch-tab");
        assert_eq!(readers.watch_count(), 0);
        thread::sleep(Duration::from_millis(200));
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        file.write_all(line("user", "more", "t3").as_bytes())
            .unwrap();
        assert!(rx.recv_timeout(Duration::from_millis(2500)).is_err());
        readers.forget("watch-tab");
        assert_eq!(readers.reader_count(), 0);
    }

    #[test]
    fn a_read_under_way_when_the_tab_is_forgotten_does_not_keep_its_reader() {
        let dir = TempDir::new("watch_forget");
        let folder = dir.join("projects").join("-tmp-project");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(
            folder.join(format!("{SID}.jsonl")),
            line("user", "hello", "t1"),
        )
        .unwrap();
        let readers = SessionLogReaders::new();
        // A watch whose thread never finds a log of its own.
        let handle = spawn_watch(readers.clone(), "gone-tab".into(), None, || None, |_| true);
        let stopped = handle.stopped.clone();
        readers.set_watch("gone-tab", handle);
        readers.forget("gone-tab");
        assert!(stopped.load(Ordering::SeqCst));
        // The thread was mid-iteration: its read finishes after the forget.
        assert!(readers
            .watch_reader("gone-tab", dir.path(), SID, &stopped)
            .is_none());
        assert_eq!(readers.reader_count(), 0);
        // A live watch still keeps its reader.
        let live = AtomicBool::new(false);
        assert!(readers
            .watch_reader("gone-tab", dir.path(), SID, &live)
            .is_some());
        assert_eq!(readers.reader_count(), 1);
    }
}
