use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::Path;

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
    if !path.exists() {
        // No file, but an intact copy beside it: a save interrupted between
        // removing the old file and renaming the new one in (Windows), or a
        // recovery from `.bak` that was never saved before the app quit.
        return Ok(intact_copy(path).unwrap_or_default());
    }
    match read_json::<T>(path) {
        Ok(value) => Ok(value),
        Err(_) => {
            let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%S%3f");
            let corrupt = path.with_extension(format!("json.corrupt-{stamp}"));
            let _ = fs::rename(path, &corrupt);
            let bak = path.with_extension("json.bak");
            if bak.exists() {
                if let Ok(value) = read_json::<T>(&bak) {
                    return Ok(value);
                }
            }
            Ok(T::default())
        }
    }
}

/// `.json.tmp` (a finished write that was not renamed in), then `.json.bak`.
fn intact_copy<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    [path.with_extension("json.tmp"), path.with_extension("json.bak")]
        .iter()
        .filter(|candidate| candidate.exists())
        .find_map(|candidate| read_json::<T>(candidate).ok())
}
