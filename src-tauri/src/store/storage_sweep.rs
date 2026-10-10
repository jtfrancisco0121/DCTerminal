//! Housekeeping for DCTerminal's own app data folder. Runs at startup and
//! from Settings > Data > "Clean up now". Only ever touches files inside the
//! app data dir: never a project folder or a provider config dir.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// The permission-payload log rolls to `.1` past this size.
pub const PERMISSION_LOG_MAX_BYTES: u64 = 5 * 1024 * 1024;
/// `.corrupt-*` files and orphaned `.bak` files older than this are deleted.
pub const STALE_AFTER: Duration = Duration::from_secs(30 * 24 * 60 * 60);
/// Subfolders that hold store files (and so their corrupt/backup leftovers).
/// `changes/` is left alone: it holds copies of repo files and prunes itself.
const SWEPT_SUBDIRS: [&str; 2] = ["transcripts", "logs"];

pub fn permission_log_path(data_dir: &Path) -> PathBuf {
    data_dir.join("logs").join("permission-payloads.jsonl")
}

/// Rename `path` to `path.1` (replacing an older `.1`) once it reaches
/// `max_bytes`. Returns the bytes freed by dropping the previous `.1`.
pub fn rotate_log_if_large(path: &Path, max_bytes: u64) -> u64 {
    let Ok(meta) = std::fs::metadata(path) else {
        return 0;
    };
    if meta.len() < max_bytes {
        return 0;
    }
    let mut rolled = path.as_os_str().to_owned();
    rolled.push(".1");
    let rolled = PathBuf::from(rolled);
    let freed = std::fs::metadata(&rolled).map(|m| m.len()).unwrap_or(0);
    let _ = std::fs::remove_file(&rolled);
    if std::fs::rename(path, &rolled).is_err() {
        return 0;
    }
    freed
}

/// True for a leftover the sweep may delete once it is old enough: a file
/// moved aside as corrupt, or a `.json.bak` whose `.json` no longer exists.
fn is_leftover(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    if name.contains(".corrupt-") {
        return true;
    }
    if let Some(base) = name.strip_suffix(".json.bak") {
        return !path.with_file_name(format!("{base}.json")).exists();
    }
    false
}

/// Delete stale leftovers in the data dir and its store subfolders (not
/// recursive). Returns the bytes freed.
pub fn sweep_leftovers(data_dir: &Path, now: SystemTime, max_age: Duration) -> u64 {
    let mut dirs = vec![data_dir.to_path_buf()];
    // A symlinked subfolder points outside the data dir; never sweep through it.
    dirs.extend(
        SWEPT_SUBDIRS
            .iter()
            .map(|sub| data_dir.join(sub))
            .filter(|dir| !std::fs::symlink_metadata(dir).is_ok_and(|meta| meta.is_symlink())),
    );
    let mut freed = 0;
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = std::fs::symlink_metadata(&path) else {
                continue;
            };
            if !meta.is_file() || !is_leftover(&path) {
                continue;
            }
            let modified = meta.modified().unwrap_or(now);
            let old_enough = now
                .duration_since(modified)
                .map(|age| age >= max_age)
                .unwrap_or(false);
            if old_enough && std::fs::remove_file(&path).is_ok() {
                freed += meta.len();
            }
        }
    }
    freed
}

/// Total size of every regular file under `dir`. Symlinks are not followed.
pub fn dir_size(dir: &Path) -> u64 {
    let mut total = 0;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(next) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&next) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
                continue;
            };
            if meta.is_dir() {
                stack.push(entry.path());
            } else if meta.is_file() {
                total += meta.len();
            }
        }
    }
    total
}

/// The file-level part of the sweep: stale leftovers plus log rotation.
pub fn sweep_files(data_dir: &Path, now: SystemTime) -> u64 {
    let freed = sweep_leftovers(data_dir, now, STALE_AFTER);
    freed + rotate_log_if_large(&permission_log_path(data_dir), PERMISSION_LOG_MAX_BYTES)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::UNIX_EPOCH;

    fn dir() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let path = crate::test_support::test_root().join(format!("dcterminal_sweep_{nanos}"));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    fn write_aged(path: &Path, body: &[u8], age: Duration) {
        std::fs::write(path, body).unwrap();
        let file = std::fs::OpenOptions::new().write(true).open(path).unwrap();
        file.set_modified(SystemTime::now() - age).unwrap();
    }

    #[test]
    fn rotates_the_log_at_the_cap_and_keeps_one_previous_file() {
        let dir = dir();
        let log = dir.join("log.jsonl");
        std::fs::write(&log, vec![b'a'; 10]).unwrap();
        assert_eq!(rotate_log_if_large(&log, 20), 0);
        assert!(log.exists(), "under the cap stays put");

        std::fs::write(&log, vec![b'b'; 20]).unwrap();
        assert_eq!(rotate_log_if_large(&log, 20), 0);
        assert!(!log.exists());
        let rolled = dir.join("log.jsonl.1");
        assert_eq!(std::fs::read(&rolled).unwrap().len(), 20);

        std::fs::write(&log, vec![b'c'; 30]).unwrap();
        assert_eq!(rotate_log_if_large(&log, 20), 20, "old .1 is dropped");
        assert_eq!(std::fs::read(&rolled).unwrap(), vec![b'c'; 30]);
        assert_eq!(rotate_log_if_large(&dir.join("missing"), 20), 0);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn deletes_month_old_corrupt_and_orphan_backup_files_only() {
        let dir = dir();
        let transcripts = dir.join("transcripts");
        std::fs::create_dir_all(&transcripts).unwrap();
        let month = Duration::from_secs(31 * 24 * 60 * 60);
        let hour = Duration::from_secs(60 * 60);
        write_aged(&dir.join("scratch.json.corrupt-20200101"), b"xx", month);
        write_aged(&dir.join("prompts.json.corrupt-schema-9"), b"x", hour);
        write_aged(&transcripts.join("tab_1.json.corrupt-1"), b"xxx", month);
        write_aged(&transcripts.join("tab_gone.json.bak"), b"xxxx", month);
        write_aged(&transcripts.join("tab_2.json"), b"{}", month);
        write_aged(&transcripts.join("tab_2.json.bak"), b"{}", month);
        write_aged(&dir.join("state.json"), b"{}", month);

        let freed = sweep_leftovers(&dir, SystemTime::now(), STALE_AFTER);
        assert_eq!(freed, 2 + 3 + 4);
        assert!(!dir.join("scratch.json.corrupt-20200101").exists());
        assert!(dir.join("prompts.json.corrupt-schema-9").exists(), "too new");
        assert!(!transcripts.join("tab_1.json.corrupt-1").exists());
        assert!(!transcripts.join("tab_gone.json.bak").exists());
        assert!(transcripts.join("tab_2.json.bak").exists(), "live backup");
        assert!(transcripts.join("tab_2.json").exists());
        assert!(dir.join("state.json").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn leaves_snapshot_folders_alone_and_measures_the_whole_tree() {
        let dir = dir();
        let snap = dir.join("changes").join("tab_1");
        std::fs::create_dir_all(&snap).unwrap();
        let month = Duration::from_secs(31 * 24 * 60 * 60);
        write_aged(&snap.join("data.json.corrupt-1"), b"12345", month);
        std::fs::write(dir.join("state.json"), b"123").unwrap();

        assert_eq!(sweep_files(&dir, SystemTime::now()), 0);
        assert!(snap.join("data.json.corrupt-1").exists());
        assert_eq!(dir_size(&dir), 8);
        assert_eq!(dir_size(&dir.join("missing")), 0);
        let _ = std::fs::remove_dir_all(dir);
    }
}
