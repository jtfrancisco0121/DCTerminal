//! F3: one git worktree per tab, only when the user asks for it.
//!
//! Nothing here runs on its own. `git worktree add` runs from the
//! "New tab in worktree…" dialog; `git worktree remove` runs after the user
//! confirms and only when the worktree has no uncommitted or untracked
//! changes (never `--force`). Worktrees go in a sibling folder,
//! `<parent>/<repo>-worktrees/<branch>`, so the repo itself gets no new files
//! beyond git's own worktree bookkeeping under `.git/worktrees`.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRef {
    /// Main working tree of the repository the worktree belongs to.
    pub repo_root: String,
    /// The worktree folder (the tab's working folder).
    pub path: String,
    /// Branch checked out when the worktree was created.
    pub branch: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    pub main_root: String,
    pub current_branch: Option<String>,
    /// Local branches, current first.
    pub branches: Vec<String>,
    /// Branches already checked out in some worktree (cannot be added again).
    pub checked_out: Vec<String>,
    /// Folder new worktrees go into.
    pub worktrees_dir: String,
}

pub(crate) fn git_command(dir: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.arg("-C")
        .arg(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        // Read-only commands must not take the index lock or refresh it.
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let output = git_command(dir)
        .args(args)
        .output()
        .map_err(|err| format!("could not run git: {err}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("git {} failed", args.first().unwrap_or(&""))
        } else {
            stderr
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListedWorktree {
    pub path: PathBuf,
    pub branch: Option<String>,
}

/// Parse `git worktree list --porcelain`. The first entry is the main tree.
pub fn parse_worktree_list(text: &str) -> Vec<ListedWorktree> {
    let mut out = Vec::new();
    let mut current: Option<ListedWorktree> = None;
    for line in text.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            if let Some(done) = current.take() {
                out.push(done);
            }
            current = Some(ListedWorktree {
                path: PathBuf::from(path),
                branch: None,
            });
        } else if let Some(reference) = line.strip_prefix("branch ") {
            if let Some(entry) = current.as_mut() {
                entry.branch = Some(
                    reference
                        .strip_prefix("refs/heads/")
                        .unwrap_or(reference)
                        .to_string(),
                );
            }
        }
    }
    if let Some(done) = current {
        out.push(done);
    }
    out
}

fn list_worktrees(dir: &Path) -> Result<Vec<ListedWorktree>, String> {
    Ok(parse_worktree_list(&git(
        dir,
        &["worktree", "list", "--porcelain"],
    )?))
}

/// A branch name made safe as one folder name: `feat/login` -> `feat-login`.
pub fn worktree_folder_name(branch: &str) -> String {
    let mut name: String = branch
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    while name.contains("--") {
        name = name.replace("--", "-");
    }
    let name = name.trim_matches(|c| c == '-' || c == '.').to_string();
    if name.is_empty() {
        "worktree".to_string()
    } else {
        name
    }
}

/// `<parent of repo>/<repo name>-worktrees`.
pub fn worktrees_dir(main_root: &Path) -> Result<PathBuf, String> {
    let name = main_root
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "repository folder has no name".to_string())?;
    let parent = main_root
        .parent()
        .ok_or_else(|| "repository has no parent folder".to_string())?;
    Ok(parent.join(format!("{name}-worktrees")))
}

pub fn worktree_destination(main_root: &Path, branch: &str) -> Result<PathBuf, String> {
    Ok(worktrees_dir(main_root)?.join(worktree_folder_name(branch)))
}

/// Reject names git would treat as an option, then ask git.
pub fn validate_branch_name(dir: &Path, name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("branch name is empty".to_string());
    }
    if name.starts_with('-') {
        return Err("branch name cannot start with '-'".to_string());
    }
    git(dir, &["check-ref-format", "--branch", name])
        .map(|_| ())
        .map_err(|_| format!("'{name}' is not a valid branch name"))
}

fn main_root(dir: &Path) -> Result<PathBuf, String> {
    list_worktrees(dir)?
        .into_iter()
        .next()
        .map(|entry| entry.path)
        .ok_or_else(|| "not a git repository".to_string())
}

/// Read-only look at the repository that contains `path`.
pub fn repo_info(path: &Path) -> Result<RepoInfo, String> {
    if !path.is_dir() {
        return Err(format!("folder not found: {}", path.display()));
    }
    git(path, &["rev-parse", "--is-inside-work-tree"])
        .map_err(|_| "this folder is not inside a git repository".to_string())?;
    let worktrees = list_worktrees(path)?;
    let main = worktrees
        .first()
        .map(|entry| entry.path.clone())
        .ok_or_else(|| "not a git repository".to_string())?;
    let current = git(path, &["branch", "--show-current"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let mut branches: Vec<String> = git(
        path,
        &["for-each-ref", "--format=%(refname:short)", "refs/heads"],
    )?
    .lines()
    .map(|line| line.trim().to_string())
    .filter(|line| !line.is_empty())
    .collect();
    if let Some(current) = &current {
        if let Some(pos) = branches.iter().position(|b| b == current) {
            let head = branches.remove(pos);
            branches.insert(0, head);
        }
    }
    Ok(RepoInfo {
        main_root: main.display().to_string(),
        current_branch: current,
        branches,
        checked_out: worktrees.iter().filter_map(|w| w.branch.clone()).collect(),
        worktrees_dir: worktrees_dir(&main)?.display().to_string(),
    })
}

/// `git worktree add` into the sibling folder. `create` makes a new branch
/// from `base` (or HEAD); otherwise `branch` must already exist.
pub fn add_worktree(
    repo: &Path,
    branch: &str,
    create: bool,
    base: Option<&str>,
) -> Result<WorktreeRef, String> {
    let branch = branch.trim();
    validate_branch_name(repo, branch)?;
    let main = main_root(repo)?;
    let dest = worktree_destination(&main, branch)?;
    if dest.exists() {
        return Err(format!("{} already exists", dest.display()));
    }
    let dest_text = dest.display().to_string();
    let mut args: Vec<&str> = vec!["worktree", "add"];
    if create {
        args.extend(["-b", branch, "--", &dest_text]);
        if let Some(base) = base.map(str::trim).filter(|b| !b.is_empty()) {
            if base.starts_with('-') {
                return Err("base cannot start with '-'".to_string());
            }
            args.push(base);
        }
    } else {
        git(
            &main,
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("refs/heads/{branch}"),
            ],
        )
        .map_err(|_| format!("branch '{branch}' does not exist"))?;
        args.extend(["--", &dest_text, branch]);
    }
    git(&main, &args)?;
    Ok(WorktreeRef {
        repo_root: main.display().to_string(),
        path: dest_text,
        branch: branch.to_string(),
    })
}

/// `git status --porcelain` lines (untracked included). Empty means clean.
pub fn dirty_files(path: &Path) -> Result<Vec<String>, String> {
    Ok(
        git(path, &["status", "--porcelain", "--untracked-files=normal"])?
            .lines()
            .map(|line| line.to_string())
            .filter(|line| !line.trim().is_empty())
            .collect(),
    )
}

fn same_path(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

/// Remove a linked worktree after the user confirmed. Refuses the main
/// tree, anything git does not list for this repo, and any dirty tree.
pub fn remove_worktree(worktree: &WorktreeRef) -> Result<(), String> {
    let main = PathBuf::from(&worktree.repo_root);
    let path = PathBuf::from(&worktree.path);
    if same_path(&main, &path) {
        return Err("refusing to remove the main working tree".to_string());
    }
    let listed = list_worktrees(&main)?;
    if !listed.iter().skip(1).any(|w| same_path(&w.path, &path)) {
        return Err(format!(
            "{} is not a worktree of {}",
            path.display(),
            main.display()
        ));
    }
    let dirty = dirty_files(&path)?;
    if !dirty.is_empty() {
        return Err(dirty_message(&path, &dirty));
    }
    let path_text = path.display().to_string();
    git(&main, &["worktree", "remove", "--", &path_text])?;
    Ok(())
}

pub fn dirty_message(path: &Path, dirty: &[String]) -> String {
    let preview: Vec<&str> = dirty.iter().take(5).map(|s| s.as_str()).collect();
    format!(
        "{} has {} uncommitted or untracked change{} — commit, stash, or discard them first:\n{}{}",
        path.display(),
        dirty.len(),
        if dirty.len() == 1 { "" } else { "s" },
        preview.join("\n"),
        if dirty.len() > 5 { "\n…" } else { "" }
    )
}

/// Branch checked out in `path`, read from git's HEAD file (no git
/// process). `None` when the folder is not a git checkout. Detached HEAD
/// gives the short commit id.
pub fn head_branch(path: &Path) -> Option<String> {
    let dot_git = path.join(".git");
    let git_dir = if dot_git.is_dir() {
        dot_git
    } else {
        let text = std::fs::read_to_string(&dot_git).ok()?;
        let target = text.trim().strip_prefix("gitdir:")?.trim();
        let target = PathBuf::from(target);
        if target.is_absolute() {
            target
        } else {
            path.join(target)
        }
    };
    let head = std::fs::read_to_string(git_dir.join("HEAD")).ok()?;
    let head = head.trim();
    if let Some(reference) = head.strip_prefix("ref:") {
        let reference = reference.trim();
        return Some(
            reference
                .strip_prefix("refs/heads/")
                .unwrap_or(reference)
                .to_string(),
        );
    }
    if head.len() >= 7 {
        return Some(head[..7].to_string());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git_available() -> bool {
        Command::new("git").arg("--version").output().is_ok()
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let dir = crate::test_support::test_root().join(format!("dct_wt_{tag}_{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn run(dir: &Path, args: &[&str]) {
        let status = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args([
                "-c",
                "user.name=DCT Test",
                "-c",
                "user.email=dct@example.com",
                "-c",
                "commit.gpgsign=false",
                "-c",
                "init.defaultBranch=main",
            ])
            .args(args)
            .output()
            .unwrap();
        assert!(
            status.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&status.stderr)
        );
    }

    /// `<tmp>/app` with one commit on `main`, plus branch `feat/old`.
    fn repo(tag: &str) -> (PathBuf, PathBuf) {
        let base = temp_dir(tag);
        let repo = base.join("app");
        std::fs::create_dir_all(&repo).unwrap();
        run(&repo, &["init", "-q"]);
        std::fs::write(repo.join("README.md"), "hi\n").unwrap();
        run(&repo, &["add", "README.md"]);
        run(&repo, &["commit", "-q", "-m", "init"]);
        run(&repo, &["branch", "feat/old"]);
        (base, repo)
    }

    #[test]
    fn folder_names_are_one_safe_segment() {
        assert_eq!(worktree_folder_name("feat/login"), "feat-login");
        assert_eq!(worktree_folder_name("fix//a b"), "fix-a-b");
        assert_eq!(worktree_folder_name("../../etc"), "etc");
        assert_eq!(worktree_folder_name("///"), "worktree");
        assert_eq!(worktree_folder_name("v1.2_rc-1"), "v1.2_rc-1");
    }

    #[test]
    fn destination_is_a_sibling_of_the_repo() {
        let main = Path::new("/Users/jt/Projects/Koneksi");
        assert_eq!(
            worktree_destination(main, "feat/login").unwrap(),
            Path::new("/Users/jt/Projects/Koneksi-worktrees/feat-login")
        );
    }

    #[test]
    fn parses_porcelain_worktree_list() {
        let text = "worktree /r/app\nHEAD abc\nbranch refs/heads/main\n\nworktree /r/app-worktrees/x\nHEAD def\ndetached\n\nworktree /r/app-worktrees/y\nHEAD 123\nbranch refs/heads/feat/y\n";
        let list = parse_worktree_list(text);
        assert_eq!(list.len(), 3);
        assert_eq!(list[0].path, PathBuf::from("/r/app"));
        assert_eq!(list[0].branch.as_deref(), Some("main"));
        assert_eq!(list[1].branch, None);
        assert_eq!(list[2].branch.as_deref(), Some("feat/y"));
    }

    #[test]
    fn add_new_branch_worktree_in_sibling_folder_and_read_its_branch() {
        if !git_available() {
            return;
        }
        let (base, repo) = repo("add");
        let info = repo_info(&repo).unwrap();
        assert_eq!(info.current_branch.as_deref(), Some("main"));
        assert_eq!(info.branches[0], "main");
        assert!(info.branches.contains(&"feat/old".to_string()));
        assert!(info.worktrees_dir.ends_with("app-worktrees"));

        let created = add_worktree(&repo, "feat/login", true, None).unwrap();
        let expected = base.join("app-worktrees").join("feat-login");
        assert!(same_path(Path::new(&created.path), &expected));
        assert_eq!(created.branch, "feat/login");
        assert!(expected.join("README.md").exists());
        assert_eq!(head_branch(&expected).as_deref(), Some("feat/login"));
        assert_eq!(head_branch(&repo).as_deref(), Some("main"));
        // The main checkout is untouched.
        assert!(dirty_files(&repo).unwrap().is_empty());
        // From inside the worktree, the main root is still the repo.
        let from_wt = repo_info(&expected).unwrap();
        assert!(same_path(Path::new(&from_wt.main_root), &repo));
        assert!(from_wt.checked_out.contains(&"feat/login".to_string()));

        // Same branch again: the folder already exists.
        assert!(add_worktree(&repo, "feat/login", false, None).is_err());
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn add_existing_branch_and_reject_bad_names() {
        if !git_available() {
            return;
        }
        let (base, repo) = repo("existing");
        let created = add_worktree(&repo, "feat/old", false, None).unwrap();
        assert_eq!(
            head_branch(Path::new(&created.path)).as_deref(),
            Some("feat/old")
        );
        assert!(add_worktree(&repo, "nope", false, None)
            .unwrap_err()
            .contains("does not exist"));
        assert!(add_worktree(&repo, "-rf", true, None).is_err());
        assert!(add_worktree(&repo, "bad..name", true, None).is_err());
        assert!(add_worktree(&repo, "   ", true, None).is_err());
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn remove_refuses_dirty_trees_and_the_main_tree() {
        if !git_available() {
            return;
        }
        let (base, repo) = repo("remove");
        let created = add_worktree(&repo, "feat/x", true, None).unwrap();
        let path = PathBuf::from(&created.path);

        std::fs::write(path.join("new.txt"), "untracked").unwrap();
        let err = remove_worktree(&created).unwrap_err();
        assert!(err.contains("uncommitted"), "{err}");
        assert!(path.exists());
        std::fs::remove_file(path.join("new.txt")).unwrap();

        std::fs::write(path.join("README.md"), "changed\n").unwrap();
        assert!(remove_worktree(&created).is_err());
        run(&path, &["checkout", "--", "README.md"]);

        let main_ref = WorktreeRef {
            repo_root: created.repo_root.clone(),
            path: created.repo_root.clone(),
            branch: "main".to_string(),
        };
        assert!(remove_worktree(&main_ref).unwrap_err().contains("main"));
        let stranger = WorktreeRef {
            path: base.display().to_string(),
            ..created.clone()
        };
        assert!(remove_worktree(&stranger).is_err());

        remove_worktree(&created).unwrap();
        assert!(!path.exists());
        // The branch is kept.
        assert!(repo_info(&repo)
            .unwrap()
            .branches
            .contains(&"feat/x".to_string()));
        let _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn repo_info_rejects_plain_folders() {
        if !git_available() {
            return;
        }
        let dir = temp_dir("plain");
        assert!(repo_info(&dir).is_err());
        assert_eq!(head_branch(&dir), None);
        let _ = std::fs::remove_dir_all(dir);
    }
}
