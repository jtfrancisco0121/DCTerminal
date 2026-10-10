//! F4: what the agent changed, file by file, and a confirmed per-file undo.
//!
//! Before each prompt the tab's git repository is snapshotted into
//! DCTerminal's own app data: a copy of the repo's index goes to a scratch
//! index file, `git add -A` runs against it with `GIT_OBJECT_DIRECTORY`
//! pointing at our folder (the repo's objects are only an alternate, read
//! only), and `git write-tree` names the snapshot. The repository's refs,
//! index, objects, and working files are never written by a snapshot or a
//! diff. Clean/smudge filters, fsmonitor, and auto maintenance are switched
//! off for these commands so no filter (for example Git LFS) writes into the
//! repo either.
//!
//! The only command that touches the working tree is a revert the user
//! confirmed: `git restore --source=<snapshot> --worktree -- <paths>`, which
//! puts the snapshot's content back (and removes files the agent created).
//! It refuses a file whose content changed after the user looked at it.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

/// Unified diff text over this many bytes is cut.
pub const MAX_DIFF_BYTES: usize = 400 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Baseline {
    pub tree: String,
    pub taken_at: String,
}

/// `meta.json` in a tab's snapshot folder.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotMeta {
    pub repo_root: String,
    /// Taken at the start of the latest prompt (or "Snapshot now").
    #[serde(default)]
    pub turn: Option<Baseline>,
    /// The first snapshot for this tab: "whole tab" scope.
    #[serde(default)]
    pub tab: Option<Baseline>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    /// Relative to the repository root, `/`-separated.
    pub path: String,
    /// Relative to the tab's folder (what the file panel uses), when inside it.
    pub cwd_path: Option<String>,
    /// `added`, `modified`, `deleted`, or `typeChanged`.
    pub status: String,
    pub old_blob: String,
    pub new_blob: String,
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
    pub binary: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChangeSet {
    /// `ok`, `noRepo` (folder is not in a git repository), or `noBaseline`.
    pub state: String,
    pub scope: String,
    pub repo_root: Option<String>,
    pub base_tree: Option<String>,
    pub now_tree: Option<String>,
    pub baseline_at: Option<String>,
    pub files: Vec<ChangedFile>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub binary: bool,
    pub text: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RevertRequest {
    pub path: String,
    /// The `newBlob` the user saw. A different current blob refuses the file.
    pub new_blob: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkippedFile {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RevertOutcome {
    pub reverted: Vec<String>,
    pub skipped: Vec<SkippedFile>,
}

/// The repository that holds a tab's folder.
#[derive(Debug, Clone)]
pub struct Repo {
    pub root: PathBuf,
    index: PathBuf,
    objects: PathBuf,
    overrides: Vec<String>,
}

fn run(cmd: &mut Command, what: &str) -> Result<Vec<u8>, String> {
    let output = cmd
        .output()
        .map_err(|err| format!("could not run git: {err}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("git {what} failed")
        } else {
            stderr
        });
    }
    Ok(output.stdout)
}

fn absolute(base: &Path, path: &str) -> PathBuf {
    let path = PathBuf::from(path.trim());
    if path.is_absolute() {
        path
    } else {
        base.join(path)
    }
}

/// `-c` flags that switch every configured filter driver off, plus hooks
/// into the repo that a snapshot must not trigger.
pub fn safety_overrides(filter_config: &str) -> Vec<String> {
    let mut out: Vec<String> = [
        "core.fsmonitor=false",
        "core.untrackedCache=false",
        "core.splitIndex=false",
        "gc.auto=0",
        "maintenance.auto=false",
        "submodule.recurse=false",
    ]
    .iter()
    .flat_map(|setting| ["-c".to_string(), setting.to_string()])
    .collect();
    let mut drivers = BTreeSet::new();
    for line in filter_config.lines() {
        let key = line.split_whitespace().next().unwrap_or("");
        let Some(rest) = key.strip_prefix("filter.") else {
            continue;
        };
        if let Some((name, _)) = rest.rsplit_once('.') {
            if !name.is_empty() {
                drivers.insert(name.to_string());
            }
        }
    }
    for name in drivers {
        for setting in ["clean=", "smudge=", "process=", "required=false"] {
            out.push("-c".to_string());
            out.push(format!("filter.{name}.{setting}"));
        }
    }
    out
}

/// `Ok(None)` when the folder is not inside a git working tree.
pub fn open_repo(cwd: &Path) -> Result<Option<Repo>, String> {
    if !cwd.is_dir() {
        return Err(format!("folder not found: {}", cwd.display()));
    }
    let out = run(
        crate::worktree::git_command(cwd).args([
            "rev-parse",
            "--show-toplevel",
            "--git-path",
            "index",
            "--git-path",
            "objects",
        ]),
        "rev-parse",
    );
    let out = match out {
        Ok(out) => String::from_utf8_lossy(&out).to_string(),
        Err(_) => return Ok(None),
    };
    let lines: Vec<&str> = out.lines().collect();
    if lines.len() < 3 || lines[0].trim().is_empty() {
        return Ok(None);
    }
    let root = PathBuf::from(lines[0].trim());
    let root = root.canonicalize().unwrap_or(root);
    let index = absolute(cwd, lines[1]);
    let objects = absolute(cwd, lines[2]);
    let objects = objects.canonicalize().unwrap_or(objects);
    let filters = run(
        crate::worktree::git_command(cwd).args(["config", "--get-regexp", r"^filter\."]),
        "config",
    )
    .map(|out| String::from_utf8_lossy(&out).to_string())
    .unwrap_or_default();
    Ok(Some(Repo {
        root,
        index,
        objects,
        overrides: safety_overrides(&filters),
    }))
}

static SCRATCH: AtomicU64 = AtomicU64::new(0);

/// A scratch index under the snapshot folder, removed on drop.
struct ScratchIndex(PathBuf);

impl ScratchIndex {
    fn new(snap: &Path, tag: &str) -> Self {
        let n = SCRATCH.fetch_add(1, Ordering::Relaxed);
        Self(snap.join(format!("{tag}-{}-{n}.idx", std::process::id())))
    }
}

impl Drop for ScratchIndex {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
        let mut lock = self.0.clone().into_os_string();
        lock.push(".lock");
        let _ = std::fs::remove_file(PathBuf::from(lock));
    }
}

/// One entry for `GIT_ALTERNATE_OBJECT_DIRECTORIES`, quoted when the path
/// holds the list separator (`:` or `;` on Windows) or a quote.
pub fn alternate_env_value(path: &str) -> String {
    let separator = if cfg!(windows) { ';' } else { ':' };
    if !path.contains(separator) && !path.starts_with('"') {
        return path.to_string();
    }
    let escaped = path.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{escaped}\"")
}

fn snap_git(repo: &Repo, snap: &Path, index: &Path) -> Command {
    let mut cmd = crate::worktree::git_command(&repo.root);
    cmd.env("GIT_INDEX_FILE", index)
        .env("GIT_OBJECT_DIRECTORY", snap.join("objects"))
        .env(
            "GIT_ALTERNATE_OBJECT_DIRECTORIES",
            alternate_env_value(&repo.objects.display().to_string()),
        )
        .env("GIT_LITERAL_PATHSPECS", "1")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .args(&repo.overrides);
    cmd
}

/// Stage the whole working tree into a scratch index (seeded from the repo's
/// index so unchanged files are not re-hashed) and return the tree id.
fn capture_into(repo: &Repo, snap: &Path, index: &ScratchIndex) -> Result<String, String> {
    std::fs::create_dir_all(snap.join("objects"))
        .map_err(|err| format!("could not create the snapshot folder: {err}"))?;
    let _ = std::fs::remove_file(&index.0);
    if repo.index.is_file() {
        let _ = std::fs::copy(&repo.index, &index.0);
    }
    let added = run(snap_git(repo, snap, &index.0).args(["add", "-A"]), "add");
    if added.is_err() {
        // A split or newer-format index we cannot reuse: start empty.
        let _ = std::fs::remove_file(&index.0);
        run(snap_git(repo, snap, &index.0).args(["add", "-A"]), "add")?;
    }
    let tree = run(
        snap_git(repo, snap, &index.0).arg("write-tree"),
        "write-tree",
    )?;
    Ok(String::from_utf8_lossy(&tree).trim().to_string())
}

pub fn capture_tree(repo: &Repo, snap: &Path) -> Result<String, String> {
    let index = ScratchIndex::new(snap, "capture");
    capture_into(repo, snap, &index)
}

fn meta_path(snap: &Path) -> PathBuf {
    snap.join("meta.json")
}

pub fn read_meta(snap: &Path) -> Option<SnapshotMeta> {
    let text = std::fs::read_to_string(meta_path(snap)).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_meta(snap: &Path, meta: &SnapshotMeta) -> Result<(), String> {
    std::fs::create_dir_all(snap).map_err(|err| err.to_string())?;
    let text = serde_json::to_string_pretty(meta).map_err(|err| err.to_string())?;
    std::fs::write(meta_path(snap), text).map_err(|err| format!("could not save snapshot: {err}"))
}

/// Snapshot now as the "this turn" baseline; also the "whole tab" baseline
/// the first time (or when the tab moved to another repository).
/// `Ok(None)` when the folder is not in a git repository.
pub fn take_snapshot(cwd: &Path, snap: &Path) -> Result<Option<SnapshotMeta>, String> {
    let Some(repo) = open_repo(cwd)? else {
        return Ok(None);
    };
    let tree = capture_tree(&repo, snap)?;
    let root = repo.root.display().to_string();
    let mut meta = read_meta(snap)
        .filter(|meta| meta.repo_root == root)
        .unwrap_or(SnapshotMeta {
            repo_root: root,
            turn: None,
            tab: None,
        });
    let baseline = Baseline {
        tree,
        taken_at: chrono::Utc::now().to_rfc3339(),
    };
    if meta.tab.is_none() {
        meta.tab = Some(baseline.clone());
    }
    meta.turn = Some(baseline);
    write_meta(snap, &meta)?;
    Ok(Some(meta))
}

fn is_oid(text: &str) -> bool {
    (text.len() == 40 || text.len() == 64) && text.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Entries from `git diff --raw -z --no-abbrev`.
pub fn parse_raw(raw: &[u8]) -> Vec<(String, String, String, String)> {
    let mut out = Vec::new();
    let mut parts = raw.split(|b| *b == 0);
    while let Some(head) = parts.next() {
        let head = String::from_utf8_lossy(head);
        let Some(head) = head.strip_prefix(':') else {
            continue;
        };
        let fields: Vec<&str> = head.split(' ').collect();
        let Some(path) = parts.next() else { break };
        if fields.len() < 5 {
            continue;
        }
        let status = match fields[4].chars().next() {
            Some('A') => "added",
            Some('D') => "deleted",
            Some('T') => "typeChanged",
            _ => "modified",
        };
        out.push((
            String::from_utf8_lossy(path).to_string(),
            status.to_string(),
            fields[2].to_string(),
            fields[3].to_string(),
        ));
    }
    out
}

/// `added\tdeleted\tpath\0` from `git diff --numstat -z --no-renames`.
pub fn parse_numstat(raw: &[u8]) -> HashMap<String, (Option<u32>, Option<u32>)> {
    let mut out = HashMap::new();
    for record in raw.split(|b| *b == 0) {
        let record = String::from_utf8_lossy(record);
        let mut fields = record.splitn(3, '\t');
        let (Some(add), Some(del), Some(path)) = (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        out.insert(path.to_string(), (add.parse().ok(), del.parse().ok()));
    }
    out
}

/// Path relative to the tab folder, when the file is inside it.
pub fn cwd_relative(repo_root: &Path, tab_root: &Path, path: &str) -> Option<String> {
    let prefix = tab_root.strip_prefix(repo_root).ok()?;
    let prefix: Vec<String> = prefix
        .components()
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .collect();
    let parts: Vec<&str> = path.split('/').collect();
    if parts.len() <= prefix.len() || parts[..prefix.len()] != prefix[..] {
        return None;
    }
    let rest = &parts[prefix.len()..];
    if rest
        .iter()
        .any(|part| crate::files::HIDDEN_NAMES.contains(part))
    {
        return None;
    }
    Some(rest.join("/"))
}

fn diff_entries(
    repo: &Repo,
    snap: &Path,
    index: &ScratchIndex,
    base: &str,
    now: &str,
) -> Result<Vec<(String, String, String, String)>, String> {
    let raw = run(
        snap_git(repo, snap, &index.0).args([
            "diff",
            "--raw",
            "-z",
            "--no-abbrev",
            "--no-renames",
            "--no-ext-diff",
            base,
            now,
        ]),
        "diff",
    )?;
    Ok(parse_raw(&raw))
}

/// Files that differ between the baseline and the working tree right now.
pub fn list_changes(cwd: &Path, snap: &Path, scope: &str) -> Result<ChangeSet, String> {
    let empty = |state: &str, root: Option<String>| ChangeSet {
        state: state.to_string(),
        scope: scope.to_string(),
        repo_root: root,
        base_tree: None,
        now_tree: None,
        baseline_at: None,
        files: Vec::new(),
    };
    let Some(repo) = open_repo(cwd)? else {
        return Ok(empty("noRepo", None));
    };
    let root = repo.root.display().to_string();
    let baseline = read_meta(snap)
        .filter(|meta| meta.repo_root == root)
        .and_then(|meta| if scope == "tab" { meta.tab } else { meta.turn });
    let Some(baseline) = baseline else {
        return Ok(empty("noBaseline", Some(root)));
    };
    let index = ScratchIndex::new(snap, "list");
    let now = capture_into(&repo, snap, &index)?;
    let entries = diff_entries(&repo, snap, &index, &baseline.tree, &now)?;
    let numstat = run(
        snap_git(&repo, snap, &index.0).args([
            "diff",
            "--numstat",
            "-z",
            "--no-renames",
            "--no-ext-diff",
            "--no-textconv",
            &baseline.tree,
            &now,
        ]),
        "diff",
    )
    .map(|raw| parse_numstat(&raw))
    .unwrap_or_default();
    let tab_root = cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf());
    let files = entries
        .into_iter()
        .map(|(path, status, old_blob, new_blob)| {
            let (additions, deletions) = numstat.get(&path).cloned().unwrap_or((None, None));
            let binary = numstat.contains_key(&path) && additions.is_none() && deletions.is_none();
            ChangedFile {
                cwd_path: cwd_relative(&repo.root, &tab_root, &path),
                path,
                status,
                old_blob,
                new_blob,
                additions,
                deletions,
                binary,
            }
        })
        .collect();
    Ok(ChangeSet {
        state: "ok".to_string(),
        scope: scope.to_string(),
        repo_root: Some(root),
        base_tree: Some(baseline.tree),
        now_tree: Some(now),
        baseline_at: Some(baseline.taken_at),
        files,
    })
}

/// Unified diff of one file between two snapshot trees.
pub fn file_diff(
    cwd: &Path,
    snap: &Path,
    base: &str,
    now: &str,
    path: &str,
) -> Result<FileDiff, String> {
    if !is_oid(base) || !is_oid(now) {
        return Err("bad snapshot id".to_string());
    }
    let repo =
        open_repo(cwd)?.ok_or_else(|| "this folder is not in a git repository".to_string())?;
    let index = ScratchIndex::new(snap, "diff");
    let out = run(
        snap_git(&repo, snap, &index.0).args([
            "diff",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            "-U3",
            base,
            now,
            "--",
            path,
        ]),
        "diff",
    )?;
    let binary = out
        .split(|b| *b == b'\n')
        .any(|line| line.starts_with(b"Binary files ") || line == b"GIT binary patch");
    let truncated = out.len() > MAX_DIFF_BYTES;
    let mut text = String::from_utf8_lossy(&out[..out.len().min(MAX_DIFF_BYTES)]).to_string();
    if truncated {
        if let Some(cut) = text.rfind('\n') {
            text.truncate(cut + 1);
        }
    }
    Ok(FileDiff {
        path: path.to_string(),
        binary,
        text,
        truncated,
    })
}

/// Put the baseline's version of each file back. A file is skipped when it
/// already matches the baseline or changed since the user saw `new_blob`.
pub fn revert_files(
    cwd: &Path,
    snap: &Path,
    base: &str,
    files: &[RevertRequest],
) -> Result<RevertOutcome, String> {
    if !is_oid(base) {
        return Err("bad snapshot id".to_string());
    }
    let repo =
        open_repo(cwd)?.ok_or_else(|| "this folder is not in a git repository".to_string())?;
    let index = ScratchIndex::new(snap, "revert");
    let now = capture_into(&repo, snap, &index)?;
    let current: HashMap<String, String> = diff_entries(&repo, snap, &index, base, &now)?
        .into_iter()
        .map(|(path, _, _, new_blob)| (path, new_blob))
        .collect();
    let mut outcome = RevertOutcome::default();
    let mut paths = Vec::new();
    for file in files {
        match current.get(&file.path) {
            None => outcome.skipped.push(SkippedFile {
                path: file.path.clone(),
                reason: "already matches the snapshot".to_string(),
            }),
            Some(blob) if *blob != file.new_blob => outcome.skipped.push(SkippedFile {
                path: file.path.clone(),
                reason: "changed after you looked at it; refresh and review again".to_string(),
            }),
            Some(_) => paths.push(file.path.clone()),
        }
    }
    for chunk in paths.chunks(100) {
        let mut cmd = snap_git(&repo, snap, &index.0);
        cmd.args(["restore", "--worktree", &format!("--source={base}"), "--"]);
        cmd.args(chunk);
        run(&mut cmd, "restore")?;
        outcome.reverted.extend(chunk.iter().cloned());
    }
    Ok(outcome)
}

/// Snapshot folders for tabs that no longer exist (open or closed).
pub fn prune(root: &Path, keep: &[String]) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !keep.contains(&name) && entry.path().is_dir() {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

/// The snapshot folder for a tab. Tab ids are generated by DCTerminal.
pub fn snapshot_dir(root: &Path, tab_id: &str) -> Result<PathBuf, String> {
    if tab_id.is_empty()
        || !tab_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(format!("bad tab id: {tab_id}"));
    }
    Ok(root.join(tab_id))
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
        let dir = crate::test_support::test_root().join(format!("dct_changes_{tag}_{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
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
                // A developer gitconfig may enable fsmonitor or the untracked
                // cache. `git status` would then rewrite `.git/index`, which
                // this file's tests treat as proof the snapshot wrote the repo.
                "-c",
                "core.fsmonitor=false",
                "-c",
                "core.untrackedCache=false",
                "-c",
                "core.splitIndex=false",
            ])
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).to_string()
    }

    fn write(dir: &Path, path: &str, text: &str) {
        let file = dir.join(path);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, text).unwrap();
    }

    /// repo with a.txt, b.txt, docs/c.md committed, `ignored.log` ignored.
    fn repo(tag: &str) -> (PathBuf, PathBuf) {
        let base = temp_dir(tag);
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q"]);
        write(&repo, "a.txt", "one\ntwo\n");
        write(&repo, "b.txt", "bee\n");
        write(&repo, "docs/c.md", "# c\n");
        write(&repo, ".gitignore", "*.log\n");
        git(&repo, &["add", "-A"]);
        git(&repo, &["commit", "-q", "-m", "init"]);
        (repo, base.join("snapshots").join("tab_1"))
    }

    fn object_count(repo: &Path) -> usize {
        fn walk(dir: &Path) -> usize {
            std::fs::read_dir(dir)
                .map(|entries| {
                    entries
                        .flatten()
                        .map(|e| {
                            if e.path().is_dir() {
                                walk(&e.path())
                            } else {
                                1
                            }
                        })
                        .sum()
                })
                .unwrap_or(0)
        }
        walk(&repo.join(".git").join("objects"))
    }

    #[test]
    fn overrides_switch_off_every_filter_driver() {
        let flags = safety_overrides(
            "filter.lfs.clean git-lfs clean -- %f\nfilter.lfs.process x\nfilter.my.tool.smudge y\n",
        );
        let joined = flags.join(" ");
        assert!(joined.contains("filter.lfs.clean="));
        assert!(joined.contains("filter.lfs.process="));
        assert!(joined.contains("filter.lfs.required=false"));
        assert!(joined.contains("filter.my.tool.smudge="));
        assert!(joined.contains("core.fsmonitor=false"));
        assert!(joined.contains("gc.auto=0"));
    }

    #[test]
    fn raw_and_numstat_parse_nul_separated_output() {
        let raw = b":100644 100644 aaa bbb M\0a b.txt\0:000000 100644 000 ccc A\0new.txt\0";
        let entries = parse_raw(raw);
        assert_eq!(
            entries[0],
            (
                "a b.txt".into(),
                "modified".into(),
                "aaa".into(),
                "bbb".into()
            )
        );
        assert_eq!(entries[1].1, "added");
        let stats = parse_numstat(b"3\t1\ta b.txt\0-\t-\timg.png\0");
        assert_eq!(stats["a b.txt"], (Some(3), Some(1)));
        assert_eq!(stats["img.png"], (None, None));
    }

    #[test]
    fn paths_are_made_relative_to_the_tab_folder() {
        let root = Path::new("/r");
        assert_eq!(
            cwd_relative(root, Path::new("/r"), "src/a.ts"),
            Some("src/a.ts".into())
        );
        assert_eq!(
            cwd_relative(root, Path::new("/r/src"), "src/a.ts"),
            Some("a.ts".into())
        );
        assert_eq!(cwd_relative(root, Path::new("/r/src"), "docs/a.md"), None);
        assert_eq!(
            cwd_relative(root, Path::new("/r"), "node_modules/x/a.js"),
            None
        );
    }

    #[test]
    fn not_a_repo_and_no_baseline_are_reported() {
        if !git_available() {
            return;
        }
        let plain = temp_dir("plain");
        let snap = plain.join("snap");
        assert_eq!(list_changes(&plain, &snap, "turn").unwrap().state, "noRepo");
        assert!(take_snapshot(&plain, &snap).unwrap().is_none());
        let (repo, snap) = repo("nobase");
        assert_eq!(
            list_changes(&repo, &snap, "turn").unwrap().state,
            "noBaseline"
        );
    }

    #[test]
    fn lists_only_what_changed_after_the_snapshot_without_writing_the_repo() {
        if !git_available() {
            return;
        }
        let (repo, snap) = repo("list");
        // The user's own uncommitted work before the turn is not the agent's.
        write(&repo, "b.txt", "bee (mine)\n");
        write(&repo, "notes.txt", "draft\n");
        let index_before = std::fs::read(repo.join(".git/index")).unwrap();
        let objects_before = object_count(&repo);
        let status_before = git(&repo, &["status", "--porcelain"]);

        let meta = take_snapshot(&repo, &snap).unwrap().unwrap();
        assert_eq!(meta.turn, meta.tab);

        // The agent's turn.
        write(&repo, "a.txt", "one\ntwo\nthree\n");
        std::fs::remove_file(repo.join("docs/c.md")).unwrap();
        write(&repo, "src/new.rs", "fn main() {}\n");
        write(&repo, "build.log", "ignored\n");

        let set = list_changes(&repo.join("src"), &snap, "turn").unwrap();
        assert_eq!(set.state, "ok");
        let summary: Vec<(String, String, Option<String>)> = set
            .files
            .iter()
            .map(|f| (f.path.clone(), f.status.clone(), f.cwd_path.clone()))
            .collect();
        assert_eq!(
            summary,
            vec![
                ("a.txt".into(), "modified".into(), None),
                ("docs/c.md".into(), "deleted".into(), None),
                ("src/new.rs".into(), "added".into(), Some("new.rs".into())),
            ]
        );
        assert_eq!(set.files[0].additions, Some(1));
        assert_eq!(set.files[0].deletions, Some(0));

        let diff = file_diff(
            &repo,
            &snap,
            set.base_tree.as_deref().unwrap(),
            set.now_tree.as_deref().unwrap(),
            "a.txt",
        )
        .unwrap();
        assert!(diff.text.contains("+three"), "{}", diff.text);
        assert!(!diff.binary);

        // Nothing in the repository was written by snapshot, list, or diff.
        assert_eq!(
            std::fs::read(repo.join(".git/index")).unwrap(),
            index_before
        );
        assert_eq!(object_count(&repo), objects_before);
        let status_after = git(&repo, &["status", "--porcelain"]);
        assert_ne!(status_before, status_after); // the agent's edits, not ours
        assert!(!status_after.contains("snapshots"));
    }

    #[test]
    fn whole_tab_scope_keeps_the_first_snapshot() {
        if !git_available() {
            return;
        }
        let (repo, snap) = repo("scope");
        take_snapshot(&repo, &snap).unwrap();
        write(&repo, "a.txt", "turn one\n");
        take_snapshot(&repo, &snap).unwrap();
        write(&repo, "b.txt", "turn two\n");
        let turn: Vec<String> = list_changes(&repo, &snap, "turn")
            .unwrap()
            .files
            .into_iter()
            .map(|f| f.path)
            .collect();
        let tab: Vec<String> = list_changes(&repo, &snap, "tab")
            .unwrap()
            .files
            .into_iter()
            .map(|f| f.path)
            .collect();
        assert_eq!(turn, vec!["b.txt"]);
        assert_eq!(tab, vec!["a.txt", "b.txt"]);
    }

    #[test]
    fn revert_restores_edits_deletions_and_removes_new_files_but_skips_stale_ones() {
        if !git_available() {
            return;
        }
        let (repo, snap) = repo("revert");
        write(&repo, "b.txt", "bee (mine)\n");
        take_snapshot(&repo, &snap).unwrap();
        write(&repo, "a.txt", "agent\n");
        write(&repo, "b.txt", "agent too\n");
        std::fs::remove_file(repo.join("docs/c.md")).unwrap();
        write(&repo, "src/new.rs", "x\n");
        let set = list_changes(&repo, &snap, "turn").unwrap();
        let base = set.base_tree.clone().unwrap();
        let request = |path: &str| RevertRequest {
            path: path.into(),
            new_blob: set
                .files
                .iter()
                .find(|f| f.path == path)
                .unwrap()
                .new_blob
                .clone(),
        };
        let mut wanted = vec![
            request("a.txt"),
            request("docs/c.md"),
            request("src/new.rs"),
            request("b.txt"),
        ];
        // The agent edits b.txt again after the user looked: refuse it.
        write(&repo, "b.txt", "agent again\n");
        wanted.push(RevertRequest {
            path: "README.md".into(),
            new_blob: "0".repeat(40),
        });
        let outcome = revert_files(&repo, &snap, &base, &wanted).unwrap();
        assert_eq!(outcome.reverted, vec!["a.txt", "docs/c.md", "src/new.rs"]);
        assert_eq!(outcome.skipped.len(), 2);
        assert!(outcome.skipped[0]
            .reason
            .contains("changed after you looked"));
        assert!(outcome.skipped[1].reason.contains("already matches"));
        assert_eq!(
            std::fs::read_to_string(repo.join("a.txt")).unwrap(),
            "one\ntwo\n"
        );
        assert_eq!(
            std::fs::read_to_string(repo.join("docs/c.md")).unwrap(),
            "# c\n"
        );
        assert!(!repo.join("src/new.rs").exists());
        assert_eq!(
            std::fs::read_to_string(repo.join("b.txt")).unwrap(),
            "agent again\n"
        );
        // The user's pre-turn edit is the snapshot's version: reverting b.txt
        // brings back "bee (mine)", not HEAD.
        let set = list_changes(&repo, &snap, "turn").unwrap();
        let b = set.files.iter().find(|f| f.path == "b.txt").unwrap();
        let outcome = revert_files(
            &repo,
            &snap,
            &base,
            &[RevertRequest {
                path: "b.txt".into(),
                new_blob: b.new_blob.clone(),
            }],
        )
        .unwrap();
        assert_eq!(outcome.reverted, vec!["b.txt"]);
        assert_eq!(
            std::fs::read_to_string(repo.join("b.txt")).unwrap(),
            "bee (mine)\n"
        );
        // The repo's index and HEAD are untouched by the revert.
        assert_eq!(git(&repo, &["diff", "--cached", "--name-only"]), "");
    }

    #[test]
    fn filter_drivers_never_run_during_snapshot_or_revert() {
        if !git_available() {
            return;
        }
        let (repo, snap) = repo("filters");
        let marker = repo.join(".git").join("FILTER_RAN");
        let touch = format!("touch '{}'; cat", marker.display());
        git(&repo, &["config", "filter.mark.clean", &touch]);
        git(&repo, &["config", "filter.mark.smudge", &touch]);
        write(&repo, ".gitattributes", "*.m filter=mark\n");
        take_snapshot(&repo, &snap).unwrap();
        write(&repo, "x.m", "hello\n");
        let set = list_changes(&repo, &snap, "turn").unwrap();
        let x = set.files.iter().find(|f| f.path == "x.m").unwrap();
        revert_files(
            &repo,
            &snap,
            set.base_tree.as_deref().unwrap(),
            &[RevertRequest {
                path: "x.m".into(),
                new_blob: x.new_blob.clone(),
            }],
        )
        .unwrap();
        assert!(!repo.join("x.m").exists());
        assert!(!marker.exists(), "a filter ran inside the user's repo");
    }

    #[test]
    fn alternates_with_a_separator_are_quoted() {
        assert_eq!(alternate_env_value("/r/.git/objects"), "/r/.git/objects");
        let sep = if cfg!(windows) { ";" } else { ":" };
        let odd = format!("/a{sep}b/\"q\"/objects");
        assert_eq!(
            alternate_env_value(&odd),
            format!("\"/a{sep}b/\\\"q\\\"/objects\"")
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn a_repo_path_with_a_colon_still_snapshots() {
        if !git_available() {
            return;
        }
        let repo = temp_dir("colon").join("a:b");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q"]);
        write(&repo, "a.txt", "1\n");
        git(&repo, &["add", "-A"]);
        git(&repo, &["commit", "-q", "-m", "init"]);
        let snap = repo.parent().unwrap().join("snap");
        take_snapshot(&repo, &snap).unwrap();
        write(&repo, "a.txt", "2\n");
        let set = list_changes(&repo, &snap, "turn").unwrap();
        assert_eq!(set.files.len(), 1);
    }

    #[test]
    fn prune_keeps_only_known_tabs() {
        let root = temp_dir("prune");
        std::fs::create_dir_all(root.join("tab_a")).unwrap();
        std::fs::create_dir_all(root.join("tab_b")).unwrap();
        prune(&root, &["tab_a".to_string()]);
        assert!(root.join("tab_a").exists());
        assert!(!root.join("tab_b").exists());
        assert!(snapshot_dir(&root, "../x").is_err());
    }
}
