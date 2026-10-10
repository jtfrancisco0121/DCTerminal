//! `store::storage_sweep`: age and size rules, and never deleting anything
//! outside the data folder.

use crate::store::storage_sweep::{
    dir_size, permission_log_path, rotate_log_if_large, sweep_files, sweep_leftovers,
    PERMISSION_LOG_MAX_BYTES, STALE_AFTER,
};
use crate::test_support::{write_aged, TempDir, DAY};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

fn at(path: &std::path::Path, when: SystemTime) {
    let file = std::fs::OpenOptions::new().write(true).open(path).unwrap();
    file.set_modified(when).unwrap();
}

#[test]
fn age_rule_is_inclusive_at_the_limit_and_ignores_future_files() {
    let dir = TempDir::new("sweep_age");
    let base = UNIX_EPOCH + Duration::from_secs(1_800_000_000);
    let max_age = Duration::from_secs(1000);
    for name in [
        "exact.json.corrupt-1",
        "young.json.corrupt-1",
        "future.json.corrupt-1",
    ] {
        std::fs::write(dir.join(name), b"x").unwrap();
    }
    at(&dir.join("exact.json.corrupt-1"), base);
    at(
        &dir.join("young.json.corrupt-1"),
        base + Duration::from_secs(1),
    );
    at(
        &dir.join("future.json.corrupt-1"),
        base + Duration::from_secs(5000),
    );

    let freed = sweep_leftovers(dir.path(), base + max_age, max_age);
    assert_eq!(freed, 1);
    assert!(!dir.join("exact.json.corrupt-1").exists());
    assert!(dir.join("young.json.corrupt-1").exists());
    assert!(
        dir.join("future.json.corrupt-1").exists(),
        "clock skew keeps it"
    );
}

#[test]
fn only_leftovers_in_the_known_folders_are_deleted() {
    let dir = TempDir::new("sweep_scope");
    let old = STALE_AFTER + DAY;
    // Real store files are never leftovers, however old.
    for name in ["state.json", "settings.json", "scratch.json", "usage.json"] {
        write_aged(&dir.join(name), b"{}", old);
    }
    // A `.bak` that is not a `.json.bak`, and a backup whose store exists.
    write_aged(&dir.join("notes.bak"), b"x", old);
    write_aged(&dir.join("settings.json.bak"), b"{}", old);
    // Not swept: other subfolders and anything deeper than one level.
    write_aged(&dir.join("activity").join("t.json.corrupt-1"), b"x", old);
    write_aged(
        &dir.join("attachments").join("t").join("a.json.corrupt-1"),
        b"x",
        old,
    );
    write_aged(
        &dir.join("transcripts")
            .join("deep")
            .join("a.json.corrupt-1"),
        b"x",
        old,
    );
    // Swept: logs/ and transcripts/ leftovers.
    write_aged(&dir.join("logs").join("gone.json.bak"), b"12", old);
    write_aged(
        &dir.join("transcripts").join("t.json.corrupt-x"),
        b"123",
        old,
    );

    let freed = sweep_leftovers(dir.path(), SystemTime::now(), STALE_AFTER);
    assert_eq!(freed, 5);
    for name in ["state.json", "settings.json", "scratch.json", "usage.json"] {
        assert!(dir.join(name).exists(), "{name}");
    }
    assert!(dir.join("notes.bak").exists());
    assert!(dir.join("settings.json.bak").exists());
    assert!(dir.join("activity").join("t.json.corrupt-1").exists());
    assert!(dir
        .join("attachments")
        .join("t")
        .join("a.json.corrupt-1")
        .exists());
    assert!(dir
        .join("transcripts")
        .join("deep")
        .join("a.json.corrupt-1")
        .exists());
    assert!(!dir.join("logs").join("gone.json.bak").exists());
    assert!(!dir.join("transcripts").join("t.json.corrupt-x").exists());
}

#[test]
fn a_missing_data_dir_frees_nothing() {
    let dir = TempDir::new("sweep_missing");
    let missing = dir.join("nope");
    assert_eq!(sweep_files(&missing, SystemTime::now()), 0);
    assert!(!missing.exists(), "the sweep never creates folders");
}

#[test]
fn the_permission_log_rolls_exactly_at_the_cap() {
    let dir = TempDir::new("sweep_log");
    let log = permission_log_path(dir.path());
    std::fs::create_dir_all(log.parent().unwrap()).unwrap();
    std::fs::write(&log, vec![b'a'; (PERMISSION_LOG_MAX_BYTES - 1) as usize]).unwrap();
    assert_eq!(sweep_files(dir.path(), SystemTime::now()), 0);
    assert!(log.exists(), "one byte under the cap stays");

    std::fs::write(&log, vec![b'a'; PERMISSION_LOG_MAX_BYTES as usize]).unwrap();
    assert_eq!(sweep_files(dir.path(), SystemTime::now()), 0);
    assert!(!log.exists());
    let rolled = dir.join("logs").join("permission-payloads.jsonl.1");
    assert_eq!(
        std::fs::metadata(&rolled).unwrap().len(),
        PERMISSION_LOG_MAX_BYTES
    );
}

#[test]
fn rotate_ignores_a_directory_named_like_the_log() {
    let dir = TempDir::new("sweep_log_dir");
    let log = dir.join("log.jsonl");
    std::fs::create_dir_all(&log).unwrap();
    // A directory's metadata length is tiny, so it is never rolled.
    assert_eq!(rotate_log_if_large(&log, 1 << 20), 0);
    assert!(log.is_dir());
}

#[cfg(unix)]
#[test]
fn symlinked_leftovers_and_their_targets_are_left_alone() {
    let data = TempDir::new("sweep_link_data");
    let outside = TempDir::new("sweep_link_outside");
    let old = STALE_AFTER + DAY;
    let target = outside.join("precious.json.corrupt-1");
    write_aged(&target, b"keep me", old);
    std::os::unix::fs::symlink(&target, data.join("link.json.corrupt-1")).unwrap();

    assert_eq!(
        sweep_leftovers(data.path(), SystemTime::now(), STALE_AFTER),
        0
    );
    assert!(target.exists());
    assert!(data.join("link.json.corrupt-1").symlink_metadata().is_ok());
}

#[cfg(unix)]
#[test]
fn dir_size_does_not_follow_symlinks_out_of_the_data_dir() {
    let data = TempDir::new("sweep_size_data");
    let outside = TempDir::new("sweep_size_outside");
    std::fs::write(outside.join("big.bin"), vec![0u8; 4096]).unwrap();
    std::os::unix::fs::symlink(outside.path(), data.join("linked_dir")).unwrap();
    std::os::unix::fs::symlink(outside.join("big.bin"), data.join("linked_file")).unwrap();
    std::fs::write(data.join("state.json"), b"12345").unwrap();
    assert_eq!(dir_size(data.path()), 5);
}

// Regression: a symlinked transcripts/ or logs/ folder is never swept through.
#[test]
fn a_symlinked_store_folder_is_not_swept_outside_the_data_dir() {
    let data = TempDir::new("sweep_linkdir_data");
    let outside = TempDir::new("sweep_linkdir_outside");
    let victim = outside.join("someone_else.json.corrupt-1");
    write_aged(&victim, b"not ours", STALE_AFTER + DAY);
    std::os::unix::fs::symlink(outside.path(), data.join("transcripts")).unwrap();

    sweep_leftovers(data.path(), SystemTime::now(), STALE_AFTER);
    assert!(victim.exists(), "a file outside the data dir was deleted");
}
