//! Test-only helpers shared by the coverage tests. Nothing here touches the
//! real home folder, `~/.claude*`, `~/.cursor` or DCTerminal's app data.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, SystemTime};

static NEXT: AtomicUsize = AtomicUsize::new(0);

/// A fresh folder under the system temp dir, removed on drop.
pub struct TempDir {
    path: PathBuf,
}

impl TempDir {
    pub fn new(tag: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "dct_cov_{tag}_{}_{}_{nanos}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).expect("create temp dir");
        Self { path }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn join(&self, part: impl AsRef<Path>) -> PathBuf {
        self.path.join(part)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// Write `body` to `path` and set its mtime `age` in the past.
pub fn write_aged(path: &Path, body: &[u8], age: Duration) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(path, body).unwrap();
    let file = std::fs::OpenOptions::new().write(true).open(path).unwrap();
    file.set_modified(SystemTime::now() - age).unwrap();
}

/// Names of the entries directly inside `dir`, sorted.
pub fn names_in(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

/// A plain custom role for store tests.
pub fn role(id: &str, name: &str) -> crate::roles::Role {
    crate::roles::Role {
        id: id.to_string(),
        name: name.to_string(),
        template_text: String::new(),
        template_version: 1,
        template_hash: String::new(),
        schema_template_hash: String::new(),
        default_mode: "agent".to_string(),
        injection: "send_on_start".to_string(),
        color: "#0969da".to_string(),
        is_built_in: false,
        fields: vec![],
        updated_at: None,
        handoff_targets: None,
    }
}

pub const DAY: Duration = Duration::from_secs(24 * 60 * 60);
