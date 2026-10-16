//! GitHub monitor storage, in two files in the app data folder:
//!
//! - `github.json`: what the user sets and what must survive a restart: the
//!   watched repos (data, not code), the cached personal repo list, the ids
//!   already seen, and the saved filters.
//! - `github-cache.json`: per-endpoint ETags and the normalized last reply,
//!   so unchanged endpoints answer 304 after a restart. Written only when a
//!   200 changed something; a 304 never writes.
//!
//! No token is ever stored here.

use crate::github::search::{CommentInfo, Thread};
use crate::github::{FeedItem, PersonalRepo, DEFAULT_LOGIN, DEFAULT_ORG, DEFAULT_WATCHED};
use crate::store::json_io::{read_json_or_recover, write_json_atomic};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

pub const GITHUB_SCHEMA_VERSION: u32 = 1;
pub const CACHE_SCHEMA_VERSION: u32 = 1;
const SEEN_LIMIT: usize = 5000;
pub const GITHUB_FILE: &str = "github.json";
pub const CACHE_FILE: &str = "github-cache.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct GithubFilters {
    /// "all", "koneksi-tech" or "mine".
    pub chip: String,
    /// `owner/repo`, or empty for every repo.
    pub repo: String,
    /// Event groups switched off (pr, merge, review, push, branch, comment,
    /// release, other). New groups default to on.
    pub hidden_types: Vec<String>,
    pub involves_me: bool,
    pub show_bots: bool,
}

impl Default for GithubFilters {
    fn default() -> Self {
        Self {
            chip: "all".into(),
            repo: String::new(),
            hidden_types: Vec::new(),
            involves_me: false,
            show_bots: false,
        }
    }
}

impl GithubFilters {
    /// Drops values the UI could not have produced.
    pub fn sanitized(mut self) -> Self {
        if !matches!(self.chip.as_str(), "all" | "koneksi-tech" | "mine") {
            self.chip = "all".into();
        }
        if self.repo.len() > 200 || self.repo.chars().any(char::is_control) {
            self.repo.clear();
        }
        self.hidden_types
            .retain(|t| t.len() <= 32 && !t.chars().any(char::is_control));
        self.hidden_types.sort();
        self.hidden_types.dedup();
        self.hidden_types.truncate(32);
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct GithubFile {
    pub schema_version: u32,
    /// The gh account whose activity is monitored.
    pub login: String,
    pub org: String,
    /// The koneksi-tech repos to watch. Edit this file to change the list.
    pub watched: Vec<String>,
    pub personal: Vec<PersonalRepo>,
    /// Unix seconds of the last `user/repos` refresh.
    pub personal_refreshed_at: i64,
    /// Ids already notified or seen, oldest first.
    pub seen: Vec<String>,
    /// False until the first sync has marked what was already there as seen.
    pub baselined: bool,
    pub filters: GithubFilters,
}

impl Default for GithubFile {
    fn default() -> Self {
        Self {
            schema_version: GITHUB_SCHEMA_VERSION,
            login: DEFAULT_LOGIN.into(),
            org: DEFAULT_ORG.into(),
            watched: DEFAULT_WATCHED
                .iter()
                .map(|name| name.to_string())
                .collect(),
            personal: Vec::new(),
            personal_refreshed_at: 0,
            seen: Vec::new(),
            baselined: false,
            filters: GithubFilters::default(),
        }
    }
}

pub struct GithubStore {
    path: PathBuf,
    pub data: GithubFile,
}

impl GithubStore {
    pub fn open(dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(dir).map_err(|e| format!("github dir: {e}"))?;
        let path = dir.join(GITHUB_FILE);
        let mut data = read_json_or_recover::<GithubFile>(&path)?;
        if data.schema_version > GITHUB_SCHEMA_VERSION {
            data = GithubFile::default();
        }
        data.schema_version = GITHUB_SCHEMA_VERSION;
        data.filters = data.filters.sanitized();
        Ok(Self { path, data })
    }

    pub fn save(&self) -> Result<(), String> {
        write_json_atomic(&self.path, &self.data)
    }

    pub fn set_filters(&mut self, filters: GithubFilters) -> Result<GithubFilters, String> {
        self.data.filters = filters.sanitized();
        self.save()?;
        Ok(self.data.filters.clone())
    }

    pub fn set_personal(&mut self, repos: Vec<PersonalRepo>, now: i64) -> Result<(), String> {
        self.data.personal = repos;
        self.data.personal_refreshed_at = now;
        self.save()
    }

    /// In one step: returns the ids not seen before and marks all of them
    /// seen, so exactly one caller wins an id. The very first call only sets
    /// the baseline (marks everything seen) and returns nothing, so a new
    /// install does not announce what was already there.
    pub fn claim_notifications(&mut self, ids: &[String]) -> Result<Vec<String>, String> {
        let mut known: HashSet<&str> = self.data.seen.iter().map(String::as_str).collect();
        let mut fresh: Vec<String> = Vec::new();
        for id in ids {
            if known.insert(id.as_str()) {
                fresh.push(id.clone());
            }
        }
        let first = !self.data.baselined;
        self.data.baselined = true;
        self.data.seen.extend(fresh.iter().cloned());
        if self.data.seen.len() > SEEN_LIMIT {
            let drop = self.data.seen.len() - SEEN_LIMIT;
            self.data.seen.drain(..drop);
        }
        // Nothing new to remember: no write.
        if first || !fresh.is_empty() {
            self.save()?;
        }
        Ok(if first { Vec::new() } else { fresh })
    }
}

/// What one endpoint last answered.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct EndpointCache {
    pub etag: Option<String>,
    /// Unix seconds of the last answer (200 or 304).
    pub polled_at: i64,
    pub poll_interval: u64,
    /// "ok", "unreachable" or "error".
    pub state: String,
    pub error: Option<String>,
    pub items: Vec<FeedItem>,
    /// Notifications endpoint only: the user's PR threads with a comment.
    pub threads: Vec<Thread>,
    pub oldest: Option<String>,
}

impl EndpointCache {
    pub fn is_ok(&self) -> bool {
        self.state == "ok"
    }

    /// The last good answer is still worth showing: a failed poll keeps it,
    /// a repo that is gone does not.
    pub fn has_data(&self) -> bool {
        self.state == "ok" || self.state == "error"
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct CacheFile {
    pub schema_version: u32,
    pub endpoints: HashMap<String, EndpointCache>,
    /// Comment lookups, by API path.
    pub comments: HashMap<String, CommentInfo>,
    /// Latest `X-OAuth-Scopes` seen (None for tokens without the header).
    pub scopes: Option<Vec<String>>,
    /// Rate limit left, in memory only.
    #[serde(skip)]
    pub rate_remaining: Option<u32>,
    #[serde(skip)]
    pub rate_reset: Option<i64>,
}

impl Default for CacheFile {
    fn default() -> Self {
        Self {
            schema_version: CACHE_SCHEMA_VERSION,
            endpoints: HashMap::new(),
            comments: HashMap::new(),
            scopes: None,
            rate_remaining: None,
            rate_reset: None,
        }
    }
}

pub struct GithubCache {
    path: PathBuf,
    pub data: CacheFile,
}

impl GithubCache {
    pub fn open(dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(dir).map_err(|e| format!("github dir: {e}"))?;
        let path = dir.join(CACHE_FILE);
        let mut data = read_json_or_recover::<CacheFile>(&path)?;
        if data.schema_version > CACHE_SCHEMA_VERSION {
            data = CacheFile::default();
        }
        data.schema_version = CACHE_SCHEMA_VERSION;
        Ok(Self { path, data })
    }

    pub fn save(&self) -> Result<(), String> {
        write_json_atomic(&self.path, &self.data)
    }

    /// Takes the cycle's result. Writes the file only when `dirty`; a cycle
    /// of 304s only moves in-memory poll times.
    pub fn commit(&mut self, data: CacheFile, dirty: bool) -> Result<(), String> {
        self.data = data;
        if dirty {
            self.save()
        } else {
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::temp_path;

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_new_store_is_seeded_with_the_seven_repos() {
        let store = GithubStore::open(&temp_path("gh_store")).unwrap();
        assert_eq!(store.data.watched.len(), 7);
        assert_eq!(store.data.watched[0], "koneksi-provenance");
        assert_eq!(store.data.login, "jtfrancisco0121");
        assert!(!store.data.filters.show_bots, "bots are hidden by default");
        assert!(!store.data.baselined);
    }

    #[test]
    fn the_store_round_trips() {
        let dir = temp_path("gh_store");
        let mut store = GithubStore::open(&dir).unwrap();
        store.data.watched = ids(&["koneksi-web"]);
        store
            .set_filters(GithubFilters {
                show_bots: true,
                chip: "mine".into(),
                ..Default::default()
            })
            .unwrap();
        store
            .set_personal(
                vec![PersonalRepo {
                    name: "notes".into(),
                    pushed_at: 5,
                }],
                99,
            )
            .unwrap();
        let again = GithubStore::open(&dir).unwrap();
        assert_eq!(again.data.watched, ids(&["koneksi-web"]));
        assert!(again.data.filters.show_bots);
        assert_eq!(again.data.filters.chip, "mine");
        assert_eq!(again.data.personal[0].name, "notes");
        assert_eq!(again.data.personal_refreshed_at, 99);
    }

    #[test]
    fn a_corrupt_file_recovers_to_defaults() {
        for name in [GITHUB_FILE, CACHE_FILE] {
            let dir = temp_path("gh_corrupt");
            std::fs::write(dir.join(name), "{ not json").unwrap();
            let store = GithubStore::open(&dir).unwrap();
            assert_eq!(store.data.watched.len(), 7);
            let cache = GithubCache::open(&dir).unwrap();
            assert!(cache.data.endpoints.is_empty());
        }
    }

    #[test]
    fn a_file_from_a_newer_schema_is_reset() {
        let dir = temp_path("gh_future");
        std::fs::write(
            dir.join(GITHUB_FILE),
            r#"{"schemaVersion":99,"watched":["x"]}"#,
        )
        .unwrap();
        let store = GithubStore::open(&dir).unwrap();
        assert_eq!(store.data.watched.len(), 7);
    }

    #[test]
    fn a_partial_file_keeps_seeded_defaults() {
        let dir = temp_path("gh_partial");
        std::fs::write(
            dir.join(GITHUB_FILE),
            r#"{"schemaVersion":1,"login":"someone"}"#,
        )
        .unwrap();
        let store = GithubStore::open(&dir).unwrap();
        assert_eq!(store.data.login, "someone");
        assert_eq!(store.data.watched.len(), 7);
    }

    #[test]
    fn filters_drop_values_the_ui_cannot_produce() {
        let f = GithubFilters {
            chip: "everything".into(),
            hidden_types: ids(&["push", "push", "pr"]),
            ..Default::default()
        }
        .sanitized();
        assert_eq!(f.chip, "all");
        assert_eq!(f.hidden_types, ids(&["pr", "push"]));
    }

    #[test]
    fn the_first_claim_only_sets_the_baseline() {
        let dir = temp_path("gh_claim");
        let mut store = GithubStore::open(&dir).unwrap();
        assert!(store
            .claim_notifications(&ids(&["a", "b"]))
            .unwrap()
            .is_empty());
        assert!(store.data.baselined);
        // Already seen at the baseline: never notifies later.
        assert!(store.claim_notifications(&ids(&["a"])).unwrap().is_empty());
        assert_eq!(
            store.claim_notifications(&ids(&["a", "c", "c"])).unwrap(),
            ids(&["c"])
        );
        assert!(
            GithubStore::open(&dir).unwrap().data.baselined,
            "the baseline is saved"
        );
    }

    #[test]
    fn two_claims_of_the_same_id_have_exactly_one_winner() {
        let mut store = GithubStore::open(&temp_path("gh_race")).unwrap();
        store.claim_notifications(&[]).unwrap();
        let store = std::sync::Mutex::new(store);
        let wins = std::sync::atomic::AtomicUsize::new(0);
        std::thread::scope(|scope| {
            for _ in 0..8 {
                scope.spawn(|| {
                    let won = store
                        .lock()
                        .unwrap()
                        .claim_notifications(&ids(&["review:1"]))
                        .unwrap();
                    wins.fetch_add(won.len(), std::sync::atomic::Ordering::SeqCst);
                });
            }
        });
        assert_eq!(wins.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[test]
    fn the_seen_list_is_bounded() {
        let mut store = GithubStore::open(&temp_path("gh_bound")).unwrap();
        store.claim_notifications(&[]).unwrap();
        let many: Vec<String> = (0..SEEN_LIMIT + 10).map(|i| format!("id{i}")).collect();
        assert_eq!(
            store.claim_notifications(&many).unwrap().len(),
            SEEN_LIMIT + 10
        );
        assert_eq!(store.data.seen.len(), SEEN_LIMIT);
        assert_eq!(
            store.data.seen.last().unwrap(),
            &format!("id{}", SEEN_LIMIT + 9)
        );
    }

    #[test]
    fn the_cache_round_trips_and_skips_the_write_when_clean() {
        let dir = temp_path("gh_cache");
        let mut cache = GithubCache::open(&dir).unwrap();
        let mut data = cache.data.clone();
        data.endpoints.insert(
            "events:o/r".into(),
            EndpointCache {
                etag: Some("e".into()),
                state: "ok".into(),
                ..Default::default()
            },
        );
        cache.commit(data.clone(), false).unwrap();
        assert!(
            !dir.join(CACHE_FILE).exists(),
            "a clean cycle writes nothing"
        );
        cache.commit(data, true).unwrap();
        let again = GithubCache::open(&dir).unwrap();
        assert_eq!(
            again.data.endpoints["events:o/r"].etag.as_deref(),
            Some("e")
        );
    }
}
