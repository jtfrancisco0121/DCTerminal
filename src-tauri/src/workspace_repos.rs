//! W1: workspace folders. A run's start folder that is not inside a git
//! repo but holds repos as direct child folders (`~/Documents/Koneksi` with
//! `koneksi-backend`, `koneksi-engine`, …) is a workspace: each child repo
//! is a repo the run's plan can span, named after its folder, with a check
//! detected from its files. Settings › Repos becomes an override: an entry
//! whose folder is the same repo keeps its name, check and verify steps,
//! and entries outside the workspace stay as they are.
//!
//! [`workspace_repos`] is the run's repo list wherever it is built (the
//! Planner's and Triage's instructions, `repos.json`, fan-out, the lane
//! checks), so they all see the same list. A start folder inside a git
//! repo, or one with no child repos, gets Settings › Repos unchanged.
//!
//! Discovery is read-only: it lists the folder, looks for `.git` (a folder,
//! or a file in a linked worktree or submodule) in each child, and asks
//! `git rev-parse --show-toplevel` that the child is the top of its own
//! work tree. Hidden folders are skipped and at most
//! [`MAX_WORKSPACE_CHILDREN`] child folders are looked at, so a huge folder
//! never makes a launch slow. Runs `git`, so it is called with no lock held.

use crate::store::repos_settings::{valid_repo_name, MAX_REPO_NAME_CHARS};
use crate::store::RepoEntry;
use serde::Serialize;
use std::path::{Path, PathBuf};

/// The child folders a workspace scan looks at, at most (W1).
pub const MAX_WORKSPACE_CHILDREN: usize = 50;

/// A run's repos (W1): Settings › Repos, merged with the repos found in the
/// start folder when it is a workspace.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRepos {
    /// The start folder is not inside a git repo and holds at least one
    /// repo: every pull request of the run names its repo.
    pub workspace: bool,
    pub repos: Vec<RepoEntry>,
}

/// One repo found in a workspace: a direct child folder that is the top of
/// its own git work tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FoundRepo {
    /// The child folder's name, made a repo name (`koneksi-backend`).
    pub name: String,
    /// The child folder, under the start folder as you gave it.
    pub folder: PathBuf,
    /// The check detected from its files ([`detect_repo_check`]).
    pub check: Option<String>,
}

/// The run's repos for `start_folder` (W1). Not a workspace (inside a git
/// repo, missing, or with no child repos): `settings_repos` unchanged.
pub fn workspace_repos(start_folder: &Path, settings_repos: &[RepoEntry]) -> WorkspaceRepos {
    let unchanged = || WorkspaceRepos {
        workspace: false,
        repos: settings_repos.to_vec(),
    };
    if start_folder.as_os_str().is_empty() || !start_folder.is_dir() || crate::worktree::work_tree_top(start_folder).is_some() {
        return unchanged();
    }
    let found = child_repos(start_folder);
    if found.is_empty() {
        return unchanged();
    }
    // Each Settings entry's repo top, to match it to a found child.
    let settings: Vec<(RepoEntry, Option<PathBuf>)> = settings_repos
        .iter()
        .map(|entry| {
            let top = crate::worktree::work_tree_top(Path::new(entry.folder.trim())).map(|top| canonical(&top));
            (entry.clone(), top)
        })
        .collect();
    WorkspaceRepos {
        workspace: true,
        repos: merge_repos(&found, &settings),
    }
}

/// Pure (W1): the found repos with Settings › Repos laid over them, then
/// the Settings entries outside the workspace. A Settings entry whose repo
/// top (`settings[i].1`) is a found folder takes its place, keeping its
/// name, check and verify steps; with no check of its own it gets the
/// detected one. A found repo whose name a Settings entry already uses for
/// another folder is left out (Settings wins).
pub fn merge_repos(found: &[FoundRepo], settings: &[(RepoEntry, Option<PathBuf>)]) -> Vec<RepoEntry> {
    let mut used = vec![false; settings.len()];
    let mut out: Vec<RepoEntry> = Vec::new();
    for repo in found {
        let folder = canonical(&repo.folder);
        let matched = settings.iter().position(|(_, top)| top.as_deref() == Some(folder.as_path()));
        let entry = match matched {
            Some(at) if !used[at] => {
                used[at] = true;
                let mut entry = settings[at].0.clone();
                if entry.check.as_deref().is_none_or(|check| check.trim().is_empty()) {
                    entry.check = repo.check.clone();
                }
                entry
            }
            Some(_) => continue,
            None => {
                let taken = settings.iter().any(|(entry, _)| entry.name.eq_ignore_ascii_case(&repo.name));
                if taken {
                    continue;
                }
                RepoEntry {
                    name: repo.name.clone(),
                    folder: repo.folder.display().to_string(),
                    check: repo.check.clone(),
                    verify: None,
                }
            }
        };
        if !out.iter().any(|seen| seen.name.eq_ignore_ascii_case(&entry.name)) {
            out.push(entry);
        }
    }
    for (at, (entry, _)) in settings.iter().enumerate() {
        if !used[at] && !out.iter().any(|seen| seen.name.eq_ignore_ascii_case(&entry.name)) {
            out.push(entry.clone());
        }
    }
    out
}

/// The repos directly inside `folder` (W1), by folder name: hidden folders
/// skipped, at most [`MAX_WORKSPACE_CHILDREN`] child folders looked at, a
/// repo nested deeper never found.
pub fn child_repos(folder: &Path) -> Vec<FoundRepo> {
    let Ok(entries) = std::fs::read_dir(folder) else {
        return Vec::new();
    };
    let mut children: Vec<(String, PathBuf)> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_str()?.to_string();
            let path = entry.path();
            (!name.starts_with('.') && path.is_dir()).then_some((name, path))
        })
        .collect();
    children.sort();
    children.truncate(MAX_WORKSPACE_CHILDREN);
    children
        .into_iter()
        .filter(|(_, path)| is_repo_top(path))
        .filter_map(|(name, path)| {
            let name = repo_name_of(&name)?;
            let check = detect_repo_check(&path);
            Some(FoundRepo { name, folder: path, check })
        })
        .collect()
}

/// `folder` has a `.git` (a folder or a file) and is the top of its work tree.
fn is_repo_top(folder: &Path) -> bool {
    if std::fs::symlink_metadata(folder.join(".git")).is_err() {
        return false;
    }
    crate::worktree::work_tree_top(folder).is_some_and(|top| canonical(&top) == canonical(folder))
}

/// A folder name as a repo name: letters, digits, `-` and `_`, with any
/// other character made `-`, at most 40 characters. None when nothing is left.
pub fn repo_name_of(folder_name: &str) -> Option<String> {
    let name: String = folder_name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .take(MAX_REPO_NAME_CHARS)
        .collect();
    let name = name.trim_matches('-').to_string();
    valid_repo_name(&name).then_some(name)
}

/// The check of a repo found in a workspace (W1): `go test ./...` for a Go
/// module at its root, `cd server && go test ./...` for one in `server/`
/// (`koneksi-backend`), else the `auto` gate's command (`npm run check`,
/// `cargo test`, `npm test`). None: the stage's own gates run.
pub fn detect_repo_check(folder: &Path) -> Option<String> {
    if folder.join("go.mod").is_file() {
        return Some("go test ./...".to_string());
    }
    if folder.join("server").join("go.mod").is_file() {
        return Some("cd server && go test ./...".to_string());
    }
    crate::pipelines::auto_check_command(folder)
}

/// W1: why an Implementer stage may not start in `cwd`: the run's folder
/// is a workspace of repos and `cwd` is not inside any of them. None when
/// it may (not a workspace, or `cwd` is a repo or a worktree of one).
pub fn implementer_folder_problem(workspace: bool, cwd: &Path) -> Option<String> {
    if !workspace || crate::worktree::work_tree_top(cwd).is_some() {
        return None;
    }
    Some(format!(
        "{} is a workspace of repos, not a git repo, so the Implementer does not start there. \
         Each pull request gets a worktree in its own repo: fan the plan out from the chain overview (a one-task plan too).",
        cwd.display()
    ))
}

fn canonical(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

/// W1: the run's repos for the start screen and fan-out: Settings › Repos
/// (copied out of the lock), merged with the repos in `folder` when it is a
/// workspace. Runs `git`, on the blocking pool.
#[tauri::command]
pub async fn workspace_repos_for(app: tauri::AppHandle, folder: String) -> Result<WorkspaceRepos, String> {
    use tauri::Manager;
    let settings = {
        let state = app.state::<std::sync::Mutex<crate::store::SettingsStore>>();
        let settings = state.lock().map_err(|err| err.to_string())?;
        settings.repos().to_vec()
    };
    tauri::async_runtime::spawn_blocking(move || workspace_repos(Path::new(folder.trim()), &settings))
        .await
        .map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    fn is_workspace(folder: &Path) -> bool {
        workspace_repos(folder, &[]).workspace
    }

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

    fn repo_at(path: &Path) {
        std::fs::create_dir_all(path).unwrap();
        git(path, &["init", "-q"]);
        git(path, &["commit", "-q", "--allow-empty", "-m", "init"]);
    }

    /// The Koneksi folder in small: three child repos, a hidden one, a
    /// plain folder, a file, and a repo nested two levels down.
    fn workspace(tag: &str) -> TempDir {
        let dir = TempDir::new(tag);
        repo_at(&dir.join("koneksi-backend"));
        std::fs::create_dir_all(dir.join("koneksi-backend/server")).unwrap();
        std::fs::write(dir.join("koneksi-backend/server/go.mod"), "module backend\n").unwrap();
        repo_at(&dir.join("koneksi-engine"));
        std::fs::write(dir.join("koneksi-engine/go.mod"), "module engine\n").unwrap();
        repo_at(&dir.join("koneksi-web"));
        std::fs::write(dir.join("koneksi-web/package.json"), r#"{"scripts": {"check": "tsc"}}"#).unwrap();
        repo_at(&dir.join(".hidden-repo"));
        std::fs::create_dir_all(dir.join("notes")).unwrap();
        repo_at(&dir.join("notes/nested-repo"));
        std::fs::write(dir.join("README.txt"), "hi").unwrap();
        dir
    }

    fn summary(repos: &WorkspaceRepos) -> Vec<(String, String, Option<String>)> {
        repos
            .repos
            .iter()
            .map(|r| {
                let folder = Path::new(&r.folder).file_name().unwrap().to_string_lossy().to_string();
                (r.name.clone(), folder, r.check.clone())
            })
            .collect()
    }

    #[test]
    fn a_folder_of_repos_lists_its_child_repos_with_their_detected_checks() {
        let dir = workspace("w1_workspace");
        let found = workspace_repos(dir.path(), &[]);
        assert!(found.workspace);
        assert_eq!(
            summary(&found),
            [
                ("koneksi-backend".into(), "koneksi-backend".into(), Some("cd server && go test ./...".into())),
                ("koneksi-engine".into(), "koneksi-engine".into(), Some("go test ./...".into())),
                ("koneksi-web".into(), "koneksi-web".into(), Some("npm run check".into())),
            ],
            "hidden, plain and nested folders are not repos of the workspace"
        );
        assert_eq!(found.repos[0].folder, dir.join("koneksi-backend").display().to_string(), "under the folder as given");
        assert!(found.repos.iter().all(|r| r.verify.is_none()));
        assert!(is_workspace(dir.path()));
    }

    #[test]
    fn a_settings_entry_for_the_same_repo_wins_and_entries_outside_stay() {
        let dir = workspace("w1_override");
        let elsewhere = TempDir::new("w1_override_elsewhere");
        repo_at(&elsewhere.join("gateway"));
        let settings = vec![
            RepoEntry {
                name: "backend".into(),
                // Any folder inside the repo names it.
                folder: dir.join("koneksi-backend/server").display().to_string(),
                check: Some("make test".into()),
                verify: Some("Run qa128 on Windows.".into()),
            },
            RepoEntry {
                name: "engine".into(),
                folder: dir.join("koneksi-engine").display().to_string(),
                check: None,
                verify: None,
            },
            RepoEntry {
                name: "gateway".into(),
                folder: elsewhere.join("gateway").display().to_string(),
                check: None,
                verify: None,
            },
        ];
        let found = workspace_repos(dir.path(), &settings);
        assert!(found.workspace);
        let names: Vec<&str> = found.repos.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, ["backend", "engine", "koneksi-web", "gateway"]);
        assert_eq!(found.repos[0].check.as_deref(), Some("make test"), "its own check is kept");
        assert_eq!(found.repos[0].verify.as_deref(), Some("Run qa128 on Windows."));
        assert_eq!(found.repos[1].check.as_deref(), Some("go test ./..."), "no check of its own: the detected one");
        assert_eq!(found.repos[3], settings[2], "outside the workspace: unchanged");
    }

    #[test]
    fn a_repo_folder_or_a_folder_without_repos_keeps_settings_unchanged() {
        let settings = vec![RepoEntry { name: "backend".into(), folder: "/src/backend".into(), ..RepoEntry::default() }];
        // A run started in a repo (or in a folder inside one).
        let dir = workspace("w1_in_repo");
        let in_repo = workspace_repos(&dir.join("koneksi-backend/server"), &settings);
        assert_eq!(in_repo, WorkspaceRepos { workspace: false, repos: settings.clone() });
        // A plain folder: no repos inside.
        let plain = TempDir::new("w1_plain");
        std::fs::create_dir_all(plain.join("docs")).unwrap();
        assert_eq!(workspace_repos(plain.path(), &settings), WorkspaceRepos { workspace: false, repos: settings.clone() });
        assert!(!is_workspace(plain.path()));
        // Gone, or nothing given.
        assert!(!workspace_repos(&plain.join("gone"), &[]).workspace);
        assert!(!workspace_repos(Path::new(""), &[]).workspace);
    }

    #[test]
    fn a_found_repo_whose_name_settings_uses_elsewhere_is_left_out() {
        let found = vec![
            FoundRepo { name: "web".into(), folder: "/ws/web".into(), check: None },
            FoundRepo { name: "api".into(), folder: "/ws/api".into(), check: Some("go test ./...".into()) },
        ];
        let settings = vec![(RepoEntry { name: "WEB".into(), folder: "/other/web".into(), ..RepoEntry::default() }, Some(PathBuf::from("/other/web")))];
        let merged = merge_repos(&found, &settings);
        let names: Vec<&str> = merged.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, ["api", "WEB"]);
    }

    #[test]
    fn folder_names_become_repo_names_and_the_scan_is_capped() {
        assert_eq!(repo_name_of("koneksi-backend").as_deref(), Some("koneksi-backend"));
        assert_eq!(repo_name_of("my app.v2").as_deref(), Some("my-app-v2"));
        assert_eq!(repo_name_of("...").as_deref(), None);
        assert_eq!(repo_name_of(&"a".repeat(60)).map(|n| n.len()), Some(MAX_REPO_NAME_CHARS));

        let dir = TempDir::new("w1_cap");
        for n in 0..MAX_WORKSPACE_CHILDREN {
            std::fs::create_dir_all(dir.join(format!("a{n:02}"))).unwrap();
        }
        // Sorted after the 50 plain folders: past the cap.
        repo_at(&dir.join("z-repo"));
        assert!(child_repos(dir.path()).is_empty());
        assert!(!is_workspace(dir.path()));
    }

    #[test]
    fn a_linked_worktree_child_with_a_git_file_is_a_repo() {
        let dir = TempDir::new("w1_git_file");
        let main = TempDir::new("w1_git_file_main");
        repo_at(&main.join("app"));
        git(&main.join("app"), &["worktree", "add", "-q", "-b", "side", &dir.join("app-side").display().to_string()]);
        assert!(dir.join("app-side/.git").is_file());
        let found = child_repos(dir.path());
        assert_eq!(found.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), ["app-side"]);
    }

    #[test]
    fn detected_checks_prefer_go_then_server_go_then_auto() {
        let dir = TempDir::new("w1_detect");
        assert_eq!(detect_repo_check(dir.path()), None);
        std::fs::write(dir.join("Cargo.toml"), "[package]\n").unwrap();
        assert_eq!(detect_repo_check(dir.path()).as_deref(), Some("cargo test"));
        std::fs::create_dir_all(dir.join("server")).unwrap();
        std::fs::write(dir.join("server/go.mod"), "module x\n").unwrap();
        assert_eq!(detect_repo_check(dir.path()).as_deref(), Some("cd server && go test ./..."));
        std::fs::write(dir.join("go.mod"), "module x\n").unwrap();
        assert_eq!(detect_repo_check(dir.path()).as_deref(), Some("go test ./..."));
    }
}
