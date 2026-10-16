//! Read-only GitHub monitor. Everything goes through the user's own `gh`
//! login: DCTerminal never sees, stores or logs a token, and nothing here
//! writes to GitHub.
//!
//! - `runner`: runs `gh` with an argument vector and a deadline.
//! - `normalize`: raw repo events -> `FeedItem`.
//! - `search`: PR search queries, notifications -> "Needs you" items.
//! - `cycle`: one poll of every endpoint, with ETags and a rate-limit guard.

mod cycle;
pub mod normalize;
pub mod runner;
pub mod search;

pub use cycle::{push_commits, repo_status, run_cycle, CycleConfig, GithubSync, PushCommits};
pub use runner::{find_gh, GhApi, GhCli};

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const DEFAULT_LOGIN: &str = "jtfrancisco0121";
pub const DEFAULT_ORG: &str = "koneksi-tech";
pub const DEFAULT_WATCHED: [&str; 7] = [
    "koneksi-provenance",
    "koneksi-engine",
    "koneksi-web",
    "koneksi-desktop",
    "koneksi-backend",
    "koneksi-s3-gateway",
    "koneksi-desktop-e2e",
];

/// Where a feed item came from.
pub const SOURCE_ORG: &str = "koneksi-tech";
pub const SOURCE_PERSONAL: &str = "personal";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PushRange {
    pub before: String,
    pub head: String,
}

/// One row of the feed (or of "Needs you"). Normalized: no raw payloads.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FeedItem {
    pub id: String,
    /// pr_opened, pr_merged, pr_closed, pr_reopened, review_requested,
    /// review, comment, push, branch_created, branch_deleted, tag_created,
    /// tag_deleted, release, issue_opened, issue_closed, issue_reopened,
    /// other.
    pub kind: String,
    /// "koneksi-tech" or "personal".
    pub source: String,
    /// `owner/repo`.
    pub repo: String,
    pub actor: String,
    pub actor_is_bot: bool,
    pub title: String,
    /// An https://github.com/ address, or empty.
    pub url: String,
    /// RFC 3339, UTC.
    pub at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub number: Option<u64>,
    #[serde(default, rename = "ref", skip_serializing_if = "Option::is_none")]
    pub git_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pr_author: Option<String>,
    #[serde(default)]
    pub involves_me: bool,
    /// A short extra line: a review's verdict, a comment's first line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub push: Option<PushRange>,
}

/// An owned repo as listed by `user/repos`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PersonalRepo {
    pub name: String,
    /// Unix seconds of the last push (0 when unknown).
    #[serde(default)]
    pub pushed_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    pub repo: String,
    pub source: String,
    /// None until the repo has been polled once.
    pub reachable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Oldest event GitHub still returns for this repo.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oldest: Option<String>,
}

/// Why the feed cannot load, with the fix to show.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Setup {
    /// "missing", "signed_out", "scope" or "offline".
    pub state: String,
    pub fix: String,
}

impl Setup {
    pub fn missing() -> Self {
        Self {
            state: "missing".into(),
            fix: "Install the GitHub CLI from https://cli.github.com, then run `gh auth login`."
                .into(),
        }
    }

    pub fn signed_out() -> Self {
        Self {
            state: "signed_out".into(),
            fix: "Run `gh auth login` in a terminal, then check again.".into(),
        }
    }

    pub fn scope() -> Self {
        Self {
            state: "scope".into(),
            fix: "gh is missing the `repo` scope. Run `gh auth refresh -s repo`, then check again."
                .into(),
        }
    }

    pub fn offline(reason: &str) -> Self {
        Self {
            state: "offline".into(),
            fix: format!("Could not reach GitHub through gh ({reason}). Check your connection."),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct FeedResponse {
    /// Newest first.
    pub items: Vec<FeedItem>,
    /// Newest first. Built from search and notifications, not from events.
    pub needs_you: Vec<FeedItem>,
    /// True once every source of "Needs you" has answered at least once, so
    /// the first-sync baseline is not taken from a half-loaded list.
    pub needs_you_ready: bool,
    pub repos: Vec<RepoStatus>,
    /// Seconds GitHub asked us to wait between polls.
    pub poll_interval: u64,
    /// Calls left in this hour's rate limit, when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rate_remaining: Option<u32>,
    /// True when polling was cut short to protect the rate limit.
    pub rate_limited: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub setup: Option<Setup>,
    /// Unix seconds.
    pub fetched_at: i64,
    /// Per-endpoint failures that did not stop the feed (never a token).
    pub errors: BTreeMap<String, String>,
}

/// Which repos are in scope: the watched koneksi-tech repos and anything the
/// user owns. Everything else (caiden-tech, other koneksi-tech repos, repos
/// of people the user follows) is dropped wherever it shows up.
#[derive(Debug, Clone)]
pub struct Scope {
    pub org: String,
    pub watched: Vec<String>,
    pub login: String,
}

impl Scope {
    /// "koneksi-tech" or "personal" when `full_name` (`owner/repo`) is in
    /// scope.
    pub fn source_of(&self, full_name: &str) -> Option<&'static str> {
        let (owner, name) = full_name.split_once('/')?;
        if owner.eq_ignore_ascii_case(&self.org)
            && self.watched.iter().any(|w| w.eq_ignore_ascii_case(name))
        {
            Some(SOURCE_ORG)
        } else if owner.eq_ignore_ascii_case(&self.login) {
            Some(SOURCE_PERSONAL)
        } else {
            None
        }
    }
}

/// A GitHub login or repo name that is safe to put in an endpoint path.
pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && name != "."
        && name != ".."
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope() -> Scope {
        Scope {
            org: DEFAULT_ORG.into(),
            watched: DEFAULT_WATCHED.iter().map(|s| s.to_string()).collect(),
            login: DEFAULT_LOGIN.into(),
        }
    }

    #[test]
    fn only_watched_and_owned_repos_are_in_scope() {
        let scope = scope();
        assert_eq!(
            scope.source_of("koneksi-tech/koneksi-web"),
            Some(SOURCE_ORG)
        );
        assert_eq!(
            scope.source_of("Koneksi-Tech/Koneksi-Web"),
            Some(SOURCE_ORG)
        );
        assert_eq!(
            scope.source_of("jtfrancisco0121/notes"),
            Some(SOURCE_PERSONAL)
        );
        assert_eq!(scope.source_of("koneksi-tech/koneksi-docs"), None);
        assert_eq!(scope.source_of("caiden-tech/koneksi-web"), None);
        assert_eq!(scope.source_of("someone-i-follow/repo"), None);
        assert_eq!(scope.source_of("no-slash"), None);
    }

    #[test]
    fn names_that_could_escape_a_path_are_rejected() {
        assert!(valid_name("koneksi-desktop-e2e"));
        assert!(valid_name("my_repo.v2"));
        for bad in ["", ".", "..", "a/b", "a b", "a?b", "a#b", "x\n"] {
            assert!(!valid_name(bad), "{bad:?}");
        }
    }
}
