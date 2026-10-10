//! Read-only lookup of Cursor plan files.
//!
//! JT's CLI writes plans under `%USERPROFILE%\.cursor\plans`. This module
//! only reads that directory. It never creates it and never writes into
//! `~/.cursor`.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanFile {
    pub path: PathBuf,
    pub name: String,
    pub modified: SystemTime,
    pub text: String,
}

pub fn cursor_plans_dir() -> PathBuf {
    // Same home as the history list, including `DCT_CURSOR_HOME` in tests.
    // A missing home stays a relative `.cursor/plans` and is not created.
    crate::cursor_history::cursor_home()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".cursor")
        .join("plans")
}

/// Newest regular file in `dir` whose mtime is strictly after `started`.
/// Subdirectories are not walked. A missing directory is an empty result.
pub fn newest_plan_since(dir: &Path, started: SystemTime) -> Result<Option<PlanFile>, String> {
    if !dir.is_dir() {
        return Ok(None);
    }
    let entries = fs::read_dir(dir).map_err(|err| format!("read plans dir: {err}"))?;
    let mut best: Option<(SystemTime, PathBuf)> = None;
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
        if modified <= started {
            continue;
        }
        let replace = match &best {
            None => true,
            Some((when, previous)) => modified > *when || (modified == *when && path > *previous),
        };
        if replace {
            best = Some((modified, path));
        }
    }
    let Some((modified, path)) = best else {
        return Ok(None);
    };
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string());
    let text = fs::read_to_string(&path).map_err(|err| format!("read plan file: {err}"))?;
    Ok(Some(PlanFile {
        path,
        name,
        modified,
        text,
    }))
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
}
