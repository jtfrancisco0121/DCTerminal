use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

/// Data files moved aside since startup, as one line each for the user.
/// Process-wide so every store can add to it without an AppHandle.
static RECOVERY_NOTES: Mutex<Vec<String>> = Mutex::new(Vec::new());

pub fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "path has no parent".to_string())?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;

    if path.exists() {
        let backup = path.with_extension("json.bak");
        let _ = fs::copy(path, backup);
    }

    let tmp = path.with_extension("json.tmp");
    let mut data = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    if !data.ends_with(b"\n") {
        data.push(b'\n');
    }
    {
        let mut file = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        file.write_all(&data).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
    }

    // Unix rename replaces the file atomically, so a crash never leaves no
    // file at all. Windows keeps the old remove-then-rename.
    #[cfg(windows)]
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, path).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, String> {
    let data = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&data).map_err(|e| e.to_string())
}

/// Load JSON, or move a damaged file aside and fall back to `.bak` then `Default`.
/// A corrupt transcript or scratch file must not stop the app from opening.
pub fn read_json_or_recover<T>(path: &Path) -> Result<T, String>
where
    T: serde::de::DeserializeOwned + Default,
{
    read_json_or_recover_with(path, T::default)
}

/// [`read_json_or_recover`] with `fallback()` in place of `T::default()`.
pub fn read_json_or_recover_with<T: serde::de::DeserializeOwned>(
    path: &Path,
    fallback: impl FnOnce() -> T,
) -> Result<T, String> {
    if !path.exists() {
        // No file, but an intact copy beside it: a save interrupted between
        // removing the old file and renaming the new one in (Windows), or a
        // recovery from `.bak` that was never saved before the app quit.
        return Ok(intact_copy(path).unwrap_or_else(fallback));
    }
    match read_json::<T>(path) {
        Ok(value) => Ok(value),
        Err(_) => {
            let corrupt = path.with_extension(format!("json.corrupt-{}", stamp()));
            let moved = fs::rename(path, &corrupt).is_ok();
            if moved {
                touch(&corrupt);
            }
            let bak = path.with_extension("json.bak");
            let restored = if bak.exists() { read_json::<T>(&bak).ok() } else { None };
            if moved {
                note_recovery(format!(
                    "{} was damaged; kept as {}. {}",
                    file_name(path),
                    file_name(&corrupt),
                    if restored.is_some() {
                        "Restored from the backup."
                    } else {
                        "Defaults are in use."
                    }
                ));
            }
            Ok(restored.unwrap_or_else(fallback))
        }
    }
}

/// Move a file written by a different DCTerminal version to
/// `<name>.json.from-v{found}-<stamp>`, so no later save or sweep removes it.
/// When `path` is gone (already moved aside as damaged), its `.bak` is
/// copied instead. Never deletes anything. Returns the kept file.
pub fn set_aside_other_version(path: &Path, found: u32) -> Option<PathBuf> {
    let base = path.with_extension(format!("json.from-v{found}-{}", stamp()));
    // Two set-asides in the same millisecond must not replace each other.
    let target = (0..)
        .map(|n| {
            if n == 0 {
                base.clone()
            } else {
                PathBuf::from(format!("{}-{n}", base.display()))
            }
        })
        .find(|candidate| !candidate.exists())?;
    let kept = if path.exists() {
        fs::rename(path, &target).is_ok() || fs::copy(path, &target).is_ok()
    } else {
        let bak = path.with_extension("json.bak");
        bak.exists() && fs::copy(&bak, &target).is_ok()
    };
    if !kept {
        return None;
    }
    touch(&target);
    note_recovery(format!(
        "{} was written by a different DCTerminal version (v{found}); kept as {}. Defaults are in use.",
        file_name(path),
        file_name(&target)
    ));
    Some(target)
}

pub fn note_recovery(msg: String) {
    eprintln!("DCTerminal: {msg}");
    if let Ok(mut notes) = RECOVERY_NOTES.lock() {
        notes.push(msg);
    }
}

/// The notes recorded so far; each is returned once.
pub fn take_recovery_notes() -> Vec<String> {
    RECOVERY_NOTES
        .lock()
        .map(|mut notes| std::mem::take(&mut *notes))
        .unwrap_or_default()
}

fn stamp() -> String {
    chrono::Utc::now().format("%Y%m%dT%H%M%S%3f").to_string()
}

/// `fs::rename` keeps the old mtime, and the startup sweep deletes leftovers
/// by age: date a moved file from the move, so it gets its full 30 days.
fn touch(path: &Path) {
    if let Ok(file) = fs::OpenOptions::new().write(true).open(path) {
        let _ = file.set_modified(SystemTime::now());
    }
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string())
}

/// `.json.tmp` (a finished write that was not renamed in), then `.json.bak`.
fn intact_copy<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    [path.with_extension("json.tmp"), path.with_extension("json.bak")]
        .iter()
        .filter(|candidate| candidate.exists())
        .find_map(|candidate| read_json::<T>(candidate).ok())
}
