//! Recent and favorite working folders. Deduped by `folder_key`
//! (case-insensitive for Windows and UNC paths).

use crate::paths::{folder_key, validate_working_folder};
use crate::store::json_io::{read_json_or_recover, write_json_atomic};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const PROJECTS_SCHEMA_VERSION: u32 = 1;
pub const RECENT_LIMIT: usize = 20;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRef {
    pub path: String,
    pub last_used_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectsFile {
    pub schema_version: u32,
    #[serde(default)]
    pub recent: Vec<ProjectRef>,
    #[serde(default)]
    pub favorites: Vec<ProjectRef>,
}

impl Default for ProjectsFile {
    fn default() -> Self {
        Self {
            schema_version: PROJECTS_SCHEMA_VERSION,
            recent: Vec::new(),
            favorites: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListedProject {
    pub path: String,
    pub available: bool,
    pub favorite: bool,
}

pub struct ProjectsStore {
    pub path: PathBuf,
    pub data: ProjectsFile,
}

impl ProjectsStore {
    pub fn open(dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(dir).map_err(|e| format!("projects dir: {e}"))?;
        let path = dir.join("projects.json");
        let mut data = read_json_or_recover::<ProjectsFile>(&path)?;
        if data.schema_version > PROJECTS_SCHEMA_VERSION {
            data = ProjectsFile::default();
        }
        data.schema_version = PROJECTS_SCHEMA_VERSION;
        Ok(Self { path, data })
    }

    pub fn save(&self) -> Result<(), String> {
        write_json_atomic(&self.path, &self.data)
    }

    pub fn remember(&mut self, raw: &str, now: &str) {
        let path = raw.trim();
        if path.is_empty() {
            return;
        }
        let key = folder_key(path);
        self.data.recent.retain(|item| folder_key(&item.path) != key);
        self.data.recent.insert(
            0,
            ProjectRef {
                path: path.to_string(),
                last_used_at: now.to_string(),
                label: None,
            },
        );
        self.data.recent.truncate(RECENT_LIMIT);
        if let Some(fav) = self
            .data
            .favorites
            .iter_mut()
            .find(|item| folder_key(&item.path) == key)
        {
            fav.path = path.to_string();
            fav.last_used_at = now.to_string();
        }
    }

    pub fn toggle_favorite(&mut self, raw: &str, now: &str) -> bool {
        let path = raw.trim();
        if path.is_empty() {
            return false;
        }
        let key = folder_key(path);
        if let Some(idx) = self
            .data
            .favorites
            .iter()
            .position(|item| folder_key(&item.path) == key)
        {
            self.data.favorites.remove(idx);
            return false;
        }
        self.data.favorites.insert(
            0,
            ProjectRef {
                path: path.to_string(),
                last_used_at: now.to_string(),
                label: None,
            },
        );
        true
    }

    pub fn remove(&mut self, raw: &str, favorite: bool) {
        let key = folder_key(raw.trim());
        let list = if favorite {
            &mut self.data.favorites
        } else {
            &mut self.data.recent
        };
        list.retain(|item| folder_key(&item.path) != key);
    }

    /// Favorites first, then recent entries that are not already favorites.
    pub fn list(&self) -> (Vec<ListedProject>, Vec<ListedProject>) {
        let favorites = self
            .data
            .favorites
            .iter()
            .map(|item| listed(item, true))
            .collect::<Vec<_>>();
        let fav_keys: Vec<String> = favorites.iter().map(|item| folder_key(&item.path)).collect();
        let recent = self
            .data
            .recent
            .iter()
            .filter(|item| !fav_keys.iter().any(|key| key == &folder_key(&item.path)))
            .map(|item| listed(item, false))
            .collect();
        (favorites, recent)
    }
}

fn listed(item: &ProjectRef, favorite: bool) -> ListedProject {
    ListedProject {
        path: item.path.clone(),
        available: validate_working_folder(&item.path).is_ok(),
        favorite,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn dir() -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("dcterminal_projects_{nanos}"));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn dedupes_windows_paths_and_caps_recent() {
        let dir = dir();
        let mut store = ProjectsStore::open(&dir).unwrap();
        store.remember(r"C:\Work\App", "t1");
        store.remember(r"c:/work/app", "t2");
        store.remember(r"\\Server\Share\Proj\", "t3");
        store.remember("//server/share/proj", "t4");
        assert_eq!(store.data.recent.len(), 2);
        assert_eq!(store.data.recent[0].path, "//server/share/proj");
        assert_eq!(store.data.recent[1].path, "c:/work/app");

        for i in 0..25 {
            store.remember(&format!(r"C:\Other\p{i}"), &format!("n{i}"));
        }
        assert_eq!(store.data.recent.len(), RECENT_LIMIT);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn favorites_stay_above_recent_and_missing_folders_can_be_removed() {
        let dir = dir();
        let mut store = ProjectsStore::open(&dir).unwrap();
        let real = dir.join("repo");
        std::fs::create_dir_all(&real).unwrap();
        let real_path = real.display().to_string();
        store.remember(&real_path, "t1");
        store.remember(r"C:\missing\gone", "t2");
        assert!(store.toggle_favorite(r"c:\missing\gone", "t3"));
        let (favorites, recent) = store.list();
        assert_eq!(favorites.len(), 1);
        assert!(!favorites[0].available);
        assert!(favorites[0].favorite);
        assert!(recent.iter().all(|item| item.available));
        assert!(recent.iter().any(|item| item.path == real_path));
        store.remove(r"C:\MISSING\gone", true);
        let (favorites, _) = store.list();
        assert!(favorites.is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn corrupt_projects_file_recovers_to_empty() {
        let dir = dir();
        std::fs::write(dir.join("projects.json"), b"[]").unwrap();
        let store = ProjectsStore::open(&dir).unwrap();
        assert!(store.data.recent.is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }
}
