//! Settings › Repos (Eagle-Eye v3, L1): named git repos a plan can span.
//! A Planner task names one (`"repo": "engine"`) and fan-out makes that
//! lane's worktree in the repo's folder instead of the run's own (E13: the
//! list is yours, nothing is hard-coded).
//!
//! Kept in `settings.json` as `repos: [{ name, folder }]`. A file from
//! before L1 has no `repos` and loads with none; an entry that cannot be
//! read (a bad name, a duplicate) is dropped on load so one hand edit never
//! resets the whole file. Saving checks every entry: the name, and that the
//! folder exists and is inside a git work tree (the working-folder check and
//! `worktree::repo_info`). L2 adds per-repo checks next to `folder`.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;

/// More than a round's repos ever need; keeps the Planner's prompt short.
pub const MAX_REPOS: usize = 20;
pub const MAX_REPO_NAME_CHARS: usize = 40;
const MAX_REPO_FOLDER_CHARS: usize = 1024;

/// One named repo.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoEntry {
    /// `backend`: letters, digits, `-` and `_`.
    pub name: String,
    /// The repo's folder (its main working tree, or any folder inside it).
    pub folder: String,
}

/// A repo name is one word a task can carry: letters, digits, `-` and `_`.
pub fn valid_repo_name(name: &str) -> bool {
    !name.is_empty()
        && name.chars().count() <= MAX_REPO_NAME_CHARS
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// What is wrong with a name, in the words the settings form shows.
fn name_problem(name: &str) -> Option<String> {
    if name.is_empty() {
        return Some("Give the repo a name, such as backend.".to_string());
    }
    if name.chars().count() > MAX_REPO_NAME_CHARS {
        return Some(format!("The name {name:?} is longer than {MAX_REPO_NAME_CHARS} characters."));
    }
    (!valid_repo_name(name)).then(|| format!("The name {name:?} may use only letters, digits, - and _."))
}

/// `repos` as `settings.json` holds it: entries that do not read as a repo,
/// and later duplicates of a name, are dropped. Folders are not checked
/// here: a folder on a drive that is not mounted yet stays listed.
pub(crate) fn deserialize_repos<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Vec<RepoEntry>, D::Error> {
    let value = serde_json::Value::deserialize(deserializer)?;
    let mut out: Vec<RepoEntry> = Vec::new();
    for item in value.as_array().into_iter().flatten() {
        let Ok(entry) = serde_json::from_value::<RepoEntry>(item.clone()) else {
            continue;
        };
        let name = entry.name.trim().to_string();
        let folder = entry.folder.trim().to_string();
        let taken = out.iter().any(|seen| seen.name.eq_ignore_ascii_case(&name));
        if valid_repo_name(&name) && !folder.is_empty() && !taken && out.len() < MAX_REPOS {
            out.push(RepoEntry { name, folder });
        }
    }
    Ok(out)
}

/// The repo named `name` (any case), when it is set up.
pub fn find_repo<'a>(repos: &'a [RepoEntry], name: &str) -> Option<&'a RepoEntry> {
    repos.iter().find(|repo| repo.name.eq_ignore_ascii_case(name.trim()))
}

/// Check a whole list before it is saved: trimmed, every name valid and
/// used once (in any case), every folder an existing folder inside a git
/// work tree. `Err` names the first entry with a problem. Runs `git`, so
/// it is called with no store lock held.
pub fn check_repos(repos: Vec<RepoEntry>) -> Result<Vec<RepoEntry>, String> {
    if repos.len() > MAX_REPOS {
        return Err(format!("At most {MAX_REPOS} repos."));
    }
    let mut out: Vec<RepoEntry> = Vec::new();
    for entry in repos {
        let name = entry.name.trim().to_string();
        if let Some(problem) = name_problem(&name) {
            return Err(problem);
        }
        if out.iter().any(|seen| seen.name.eq_ignore_ascii_case(&name)) {
            return Err(format!("There is already a repo named {name}."));
        }
        let folder = check_folder(&name, &entry.folder)?;
        out.push(RepoEntry { name, folder });
    }
    Ok(out)
}

fn check_folder(name: &str, raw: &str) -> Result<String, String> {
    let folder = raw.trim();
    if folder.is_empty() {
        return Err(format!("Choose the folder of {name}."));
    }
    if folder.contains(['\n', '\r']) || folder.chars().count() > MAX_REPO_FOLDER_CHARS {
        return Err(format!("The folder of {name} is not a folder path."));
    }
    let path = crate::paths::validate_working_folder(folder).map_err(|err| format!("{name}: {}", err.message()))?;
    crate::worktree::repo_info(&path).map_err(|_| {
        format!("{name}: {} is not a git repository, so fan-out could not make worktrees there.", path.display())
    })?;
    Ok(folder.to_string())
}

impl super::SettingsStore {
    pub fn repos(&self) -> &[RepoEntry] {
        &self.data.repos
    }

    /// Save a list [`check_repos`] already checked.
    pub fn set_repos(&mut self, repos: Vec<RepoEntry>) -> Result<(), String> {
        self.data.repos = repos;
        self.save()
    }
}

/// Read Settings › Repos.
#[tauri::command]
pub fn get_repos_settings(settings: tauri::State<Mutex<super::SettingsStore>>) -> Result<Vec<RepoEntry>, String> {
    let settings = settings.lock().map_err(|err| err.to_string())?;
    Ok(settings.repos().to_vec())
}

/// Save Settings › Repos: checked first (folders run `git`, so with no lock
/// held), then written. Returns the list as saved.
#[tauri::command]
pub async fn set_repos_settings(app: tauri::AppHandle, repos: Vec<RepoEntry>) -> Result<Vec<RepoEntry>, String> {
    use tauri::Manager;
    let checked = tauri::async_runtime::spawn_blocking(move || check_repos(repos))
        .await
        .map_err(|err| err.to_string())??;
    let state = app.state::<Mutex<super::SettingsStore>>();
    let mut settings = state.lock().map_err(|err| err.to_string())?;
    settings.set_repos(checked)?;
    Ok(settings.repos().to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::SettingsStore;
    use crate::test_support::TempDir;
    use std::path::Path;

    fn git(dir: &Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "init.defaultBranch=main"])
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    fn repo(dir: &TempDir, name: &str) -> String {
        let path = dir.join(name);
        std::fs::create_dir_all(&path).unwrap();
        git(&path, &["init", "-q"]);
        git(&path, &["commit", "-q", "--allow-empty", "-m", "init"]);
        path.display().to_string()
    }

    fn entry(name: &str, folder: &str) -> RepoEntry {
        RepoEntry { name: name.into(), folder: folder.into() }
    }

    #[test]
    fn a_settings_file_from_before_repos_loads_with_none_and_bad_entries_are_dropped() {
        let dir = TempDir::new("repos_settings_old");
        std::fs::write(dir.join("settings.json"), r#"{"schemaVersion": 1, "ui": {"theme": "nord"}}"#).unwrap();
        let store = SettingsStore::open(dir.path()).unwrap();
        assert!(store.repos().is_empty());
        assert_eq!(store.ui().theme, "nord", "the rest of the file is kept");

        let dir = TempDir::new("repos_settings_hand_edited");
        std::fs::write(
            dir.join("settings.json"),
            r#"{"schemaVersion": 1, "ui": {"theme": "nord"}, "repos": [
                {"name": " backend ", "folder": "/src/backend"},
                {"name": "has space", "folder": "/src/x"},
                {"name": "Backend", "folder": "/src/dup"},
                {"name": "engine"},
                7,
                {"name": "engine", "folder": "/src/engine"}
            ]}"#,
        )
        .unwrap();
        let store = SettingsStore::open(dir.path()).unwrap();
        assert_eq!(store.repos(), [entry("backend", "/src/backend"), entry("engine", "/src/engine")]);
        assert_eq!(store.ui().theme, "nord");
    }

    #[test]
    fn saving_checks_names_duplicates_and_that_each_folder_is_a_git_repo() {
        let dir = TempDir::new("repos_settings_check");
        let backend = repo(&dir, "backend");
        let plain = dir.join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        let plain = plain.display().to_string();

        let saved = check_repos(vec![entry(" backend ", &format!(" {backend} "))]).unwrap();
        assert_eq!(saved, [entry("backend", &backend)], "trimmed");
        assert!(check_repos(vec![entry("", &backend)]).unwrap_err().contains("Give the repo a name"));
        assert!(check_repos(vec![entry("my repo", &backend)]).unwrap_err().contains("only letters, digits, - and _"));
        let long = "a".repeat(MAX_REPO_NAME_CHARS + 1);
        assert!(check_repos(vec![entry(&long, &backend)]).unwrap_err().contains("longer than"));
        let dup = check_repos(vec![entry("backend", &backend), entry("BACKEND", &backend)]).unwrap_err();
        assert!(dup.contains("already a repo named BACKEND"), "{dup}");
        assert!(check_repos(vec![entry("web", "  ")]).unwrap_err().contains("Choose the folder of web"));
        let missing = check_repos(vec![entry("web", &dir.join("gone").display().to_string())]).unwrap_err();
        assert!(missing.starts_with("web: Working folder was not found"), "{missing}");
        let not_git = check_repos(vec![entry("web", &plain)]).unwrap_err();
        assert!(not_git.contains("is not a git repository"), "{not_git}");
        let many: Vec<RepoEntry> = (0..=MAX_REPOS).map(|n| entry(&format!("r{n}"), &backend)).collect();
        assert!(check_repos(many).unwrap_err().contains("At most"));

        let mut store = SettingsStore::open(&dir.join("app")).unwrap();
        store.set_repos(saved).unwrap();
        let again = SettingsStore::open(&dir.join("app")).unwrap();
        assert_eq!(again.repos(), [entry("backend", &backend)], "kept in settings.json");
        assert_eq!(find_repo(again.repos(), "Backend").map(|r| r.name.as_str()), Some("backend"));
    }
}
