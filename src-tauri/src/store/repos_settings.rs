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
//! `worktree::repo_info`).
//!
//! L2 adds two optional texts per repo. `check` is the command that checks a
//! lane made in that repo (`cd server && go test ./...`): it replaces the
//! stage's command gates there (`pipelines::lane_gates`). `verify` is steps
//! you carry out yourself (a Playwright run on another machine): after the
//! check passes, the run waits for you to mark them verified or failed.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;

/// More than a round's repos ever need; keeps the Planner's prompt short.
pub const MAX_REPOS: usize = 20;
pub const MAX_REPO_NAME_CHARS: usize = 40;
const MAX_REPO_FOLDER_CHARS: usize = 1024;
/// As a pipeline's command gate (L2).
pub const MAX_REPO_CHECK_CHARS: usize = 2_000;
/// As a pipeline's `verify` gate steps (L2).
pub const MAX_REPO_VERIFY_CHARS: usize = 2_000;

/// One named repo.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoEntry {
    /// `backend`: letters, digits, `-` and `_`.
    pub name: String,
    /// The repo's folder (its main working tree, or any folder inside it).
    pub folder: String,
    /// The command that checks a lane in this repo (L2): it replaces the
    /// stage's command gates there. One line, at most 2000 characters.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub check: Option<String>,
    /// Steps you verify yourself for a lane in this repo, after its check
    /// passes (L2): the run waits until you mark them verified or failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verify: Option<String>,
}

/// What is wrong with a repo's `check` (L2), as for a pipeline's command
/// gate: one line, at most 2000 characters. Blank is no check.
pub fn check_problem(name: &str, check: &str) -> Option<String> {
    let check = check.trim();
    if check.contains(['\n', '\r']) {
        return Some(format!("The check of {name} is one line: no line breaks."));
    }
    (check.chars().count() > MAX_REPO_CHECK_CHARS)
        .then(|| format!("The check of {name} is longer than {MAX_REPO_CHECK_CHARS} characters."))
}

/// What is wrong with a repo's `verify` steps (L2): at most 2000
/// characters. Blank is nothing to verify.
pub fn verify_problem(name: &str, verify: &str) -> Option<String> {
    (verify.trim().chars().count() > MAX_REPO_VERIFY_CHARS)
        .then(|| format!("The verify steps of {name} are longer than {MAX_REPO_VERIFY_CHARS} characters."))
}

/// A trimmed optional text; blank is none.
fn some_text(text: Option<&str>) -> Option<String> {
    text.map(str::trim).filter(|text| !text.is_empty()).map(str::to_string)
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
            // L2: a hand-edited check or verify text that would not save is
            // dropped on its own; the repo stays.
            let check = some_text(entry.check.as_deref()).filter(|check| check_problem(&name, check).is_none());
            let verify = some_text(entry.verify.as_deref()).filter(|verify| verify_problem(&name, verify).is_none());
            out.push(RepoEntry { name, folder, check, verify });
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
        let check = some_text(entry.check.as_deref());
        if let Some(problem) = check.as_deref().and_then(|check| check_problem(&name, check)) {
            return Err(problem);
        }
        let verify = some_text(entry.verify.as_deref());
        if let Some(problem) = verify.as_deref().and_then(|verify| verify_problem(&name, verify)) {
            return Err(problem);
        }
        out.push(RepoEntry { name, folder, check, verify });
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
        RepoEntry { name: name.into(), folder: folder.into(), ..RepoEntry::default() }
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

    /// L2: a repo's check and verify texts are trimmed, blank is none, and
    /// they are checked as a pipeline's command gate is (one line, at most
    /// 2000 characters). A bad text in a hand-edited file drops that text,
    /// never the repo.
    #[test]
    fn a_repos_check_and_verify_are_one_checked_line_and_free_steps() {
        let dir = TempDir::new("repos_settings_l2");
        let backend = repo(&dir, "backend");
        let with = |check: &str, verify: &str| RepoEntry {
            check: Some(check.into()),
            verify: Some(verify.into()),
            ..entry("backend", &backend)
        };
        let saved = check_repos(vec![with("  cd server && go test ./...  ", " Run qa128-ml on the\nWindows staging build. ")]).unwrap();
        assert_eq!(saved[0].check.as_deref(), Some("cd server && go test ./..."));
        assert_eq!(saved[0].verify.as_deref(), Some("Run qa128-ml on the\nWindows staging build."), "steps may span lines");
        let blank = check_repos(vec![with("  ", "\n")]).unwrap();
        assert_eq!((blank[0].check.clone(), blank[0].verify.clone()), (None, None), "blank is none");
        let two_lines = check_repos(vec![with("go vet ./...\ngo test ./...", "")]).unwrap_err();
        assert!(two_lines.contains("The check of backend is one line"), "{two_lines}");
        let long = "x".repeat(MAX_REPO_CHECK_CHARS + 1);
        assert!(check_repos(vec![with(&long, "")]).unwrap_err().contains("longer than 2000 characters"));
        assert!(check_repos(vec![with(&"x".repeat(MAX_REPO_CHECK_CHARS), "")]).is_ok(), "2000 is allowed");
        let steps = check_repos(vec![with("", &long)]).unwrap_err();
        assert!(steps.contains("The verify steps of backend are longer than 2000"), "{steps}");

        // Kept in settings.json, and a file from L1 (no check) loads as before.
        let mut store = SettingsStore::open(&dir.join("app")).unwrap();
        store.set_repos(saved.clone()).unwrap();
        assert_eq!(SettingsStore::open(&dir.join("app")).unwrap().repos(), saved.as_slice());
        let text = std::fs::read_to_string(dir.join("app").join("settings.json")).unwrap();
        assert!(text.contains("\"check\": \"cd server && go test ./...\""), "{text}");

        let hand = TempDir::new("repos_settings_l2_hand");
        std::fs::write(
            hand.join("settings.json"),
            r#"{"schemaVersion": 1, "repos": [
                {"name": "backend", "folder": "/src/backend", "check": "a\nb", "verify": " Steps. "},
                {"name": "engine", "folder": "/src/engine", "check": " go test ./... "}
            ]}"#,
        )
        .unwrap();
        let store = SettingsStore::open(hand.path()).unwrap();
        let repos = store.repos();
        assert_eq!(repos.len(), 2, "both repos stay");
        assert_eq!((repos[0].check.as_deref(), repos[0].verify.as_deref()), (None, Some("Steps.")));
        assert_eq!(repos[1].check.as_deref(), Some("go test ./..."));
    }
}
