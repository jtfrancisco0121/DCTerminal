//! Read-only lookup of Cursor plan files.
//!
//! JT's CLI writes plans under `%USERPROFILE%\.cursor\plans`. This module
//! only reads that directory. It never creates it and never writes into
//! `~/.cursor`.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// Larger plan files are cut here; the hand-off caps plans at 8M characters.
pub const MAX_PLAN_BYTES: u64 = 8_000_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanFile {
    pub path: PathBuf,
    pub name: String,
    pub modified: SystemTime,
    pub text: String,
    pub truncated: bool,
}

pub fn cursor_plans_dir() -> PathBuf {
    // Same home as the history list, including `DCT_CURSOR_HOME` in tests.
    // A missing home stays a relative `.cursor/plans` and is not created.
    crate::cursor_history::cursor_home()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".cursor")
        .join("plans")
}

fn plan_files(dir: &Path) -> Result<Vec<(SystemTime, PathBuf)>, String> {
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let entries = fs::read_dir(dir).map_err(|err| format!("read plans dir: {err}"))?;
    let mut files = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|err| format!("read plans dir: {err}"))?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .map_err(|err| format!("plan mtime: {err}"))?;
        files.push((modified, path));
    }
    Ok(files)
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string())
}

fn read_plan(modified: SystemTime, path: PathBuf) -> Result<PlanFile, String> {
    let file = fs::File::open(&path).map_err(|err| format!("read plan file: {err}"))?;
    let mut bytes = Vec::new();
    file.take(MAX_PLAN_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|err| format!("read plan file: {err}"))?;
    let truncated = bytes.len() as u64 > MAX_PLAN_BYTES;
    if truncated {
        bytes.truncate(MAX_PLAN_BYTES as usize);
        // Drop a UTF-8 sequence cut at the limit.
        while let Err(err) = std::str::from_utf8(&bytes) {
            if err.error_len().is_some() {
                break;
            }
            bytes.truncate(err.valid_up_to());
        }
    }
    Ok(PlanFile {
        name: file_name(&path),
        path,
        modified,
        text: String::from_utf8_lossy(&bytes).into_owned(),
        truncated,
    })
}

fn newest(files: impl Iterator<Item = (SystemTime, PathBuf)>) -> Option<(SystemTime, PathBuf)> {
    files.max_by(|(a_time, a_path), (b_time, b_path)| {
        a_time.cmp(b_time).then_with(|| a_path.cmp(b_path))
    })
}

/// Newest regular file in `dir` whose mtime is strictly after `started`.
/// Subdirectories are not walked. A missing directory is an empty result.
#[cfg(test)]
pub fn newest_plan_since(dir: &Path, started: SystemTime) -> Result<Option<PlanFile>, String> {
    terminal_plan(dir, started, &[], &[])
}

/// The plan file of one terminal. A file this terminal's output names wins
/// (the one named last), whatever its mtime. Otherwise the newest file
/// written since `started` that another open terminal does not name.
pub fn terminal_plan(
    dir: &Path,
    started: SystemTime,
    mentioned: &[String],
    claimed: &[String],
) -> Result<Option<PlanFile>, String> {
    let files = plan_files(dir)?;
    let named = |list: &[String], path: &Path| {
        let name = file_name(path);
        list.iter().any(|item| item.trim() == name)
    };
    for wanted in mentioned.iter().rev() {
        if let Some((modified, path)) = files
            .iter()
            .find(|(_, path)| file_name(path) == wanted.trim())
        {
            return read_plan(*modified, path.clone()).map(Some);
        }
    }
    let found = newest(
        files
            .into_iter()
            .filter(|(modified, path)| *modified > started && !named(claimed, path)),
    );
    found
        .map(|(modified, path)| read_plan(modified, path))
        .transpose()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::OpenOptions;
    use std::time::{Duration, UNIX_EPOCH};

    #[test]
    fn newest_plan_is_the_file_modified_after_the_tab_started() {
        let nanos = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let dir = crate::test_support::test_root().join(format!("dcterminal_plans_{nanos}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let started = UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        let older = dir.join("older.md");
        let newer = dir.join("newer.md");
        let ignored = dir.join("subdir");
        fs::write(&older, "old plan").unwrap();
        fs::write(&newer, "new plan").unwrap();
        fs::create_dir_all(&ignored).unwrap();
        // A read-only handle cannot set mtime on Windows (os error 5).
        // Drop the handle before the directory is removed.
        {
            let older_file = OpenOptions::new().write(true).open(&older).unwrap();
            older_file
                .set_modified(started - Duration::from_secs(5))
                .unwrap();
            let newer_file = OpenOptions::new().write(true).open(&newer).unwrap();
            newer_file
                .set_modified(started + Duration::from_secs(5))
                .unwrap();
        }

        let found = newest_plan_since(&dir, started).unwrap().expect("plan");
        assert_eq!(found.name, "newer.md");
        assert_eq!(found.text, "new plan");
        assert!(newest_plan_since(&dir, started + Duration::from_secs(60))
            .unwrap()
            .is_none());
        assert!(newest_plan_since(&dir.join("missing"), started)
            .unwrap()
            .is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    fn plans_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let dir = crate::test_support::test_root().join(format!("dcterminal_plans_{tag}_{nanos}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn touch(path: &Path, when: SystemTime) {
        let file = OpenOptions::new().write(true).open(path).unwrap();
        file.set_modified(when).unwrap();
    }

    #[test]
    fn two_planners_each_get_the_file_their_output_names() {
        let dir = plans_dir("two");
        let started = UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        fs::write(dir.join("alpha.md"), "plan A").unwrap();
        fs::write(dir.join("beta.md"), "plan B").unwrap();
        touch(&dir.join("alpha.md"), started + Duration::from_secs(5));
        touch(&dir.join("beta.md"), started + Duration::from_secs(9));

        let a = terminal_plan(&dir, started, &["alpha.md".into()], &["beta.md".into()])
            .unwrap()
            .expect("plan");
        assert_eq!(a.text, "plan A");
        let b = terminal_plan(&dir, started, &["beta.md".into()], &["alpha.md".into()])
            .unwrap()
            .expect("plan");
        assert_eq!(b.text, "plan B");
        // No mention: the newest file another terminal does not name.
        let unnamed = terminal_plan(&dir, started, &[], &["beta.md".into()])
            .unwrap()
            .expect("plan");
        assert_eq!(unnamed.name, "alpha.md");
        assert!(terminal_plan(&dir, started, &[], &["alpha.md".into(), "beta.md".into()])
            .unwrap()
            .is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_named_plan_counts_even_when_written_before_a_restart() {
        let dir = plans_dir("named");
        let started = UNIX_EPOCH + Duration::from_secs(1_700_000_000);
        fs::write(dir.join("old.md"), "first").unwrap();
        fs::write(dir.join("other.md"), "other").unwrap();
        touch(&dir.join("old.md"), started - Duration::from_secs(60));
        touch(&dir.join("other.md"), started + Duration::from_secs(60));
        // The last mention wins; an unknown name is skipped.
        let found = terminal_plan(
            &dir,
            started,
            &["old.md".into(), "missing.md".into()],
            &[],
        )
        .unwrap()
        .expect("plan");
        assert_eq!(found.name, "old.md");
        // Edited after a hand-off: the next read returns the new text.
        fs::write(dir.join("old.md"), "second").unwrap();
        let again = terminal_plan(&dir, started, &["old.md".into()], &[])
            .unwrap()
            .expect("plan");
        assert_eq!(again.text, "second");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_very_large_plan_is_cut_on_a_char_boundary() {
        let dir = plans_dir("large");
        let path = dir.join("big.md");
        let mut body = "a".repeat(MAX_PLAN_BYTES as usize - 1);
        body.push('é');
        body.push_str("tail");
        fs::write(&path, &body).unwrap();
        let found = terminal_plan(&dir, UNIX_EPOCH, &[], &[]).unwrap().expect("plan");
        assert!(found.truncated);
        assert_eq!(found.text.len(), MAX_PLAN_BYTES as usize - 1);
        assert!(!found.text.contains('\u{fffd}'));
        fs::write(&path, "small").unwrap();
        let small = terminal_plan(&dir, UNIX_EPOCH, &[], &[]).unwrap().expect("plan");
        assert!(!small.truncated);
        let _ = fs::remove_dir_all(&dir);
    }
}
