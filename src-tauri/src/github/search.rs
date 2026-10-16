//! "Needs you": PR search and the notifications list, normalized.
//!
//! Search queries are split so each stays under GitHub's 256-character limit.
//! Everything returned is checked against the scope again, whatever the
//! query asked for.

use super::normalize::{is_bot, parse_time, safe_url, snippet};
use super::{FeedItem, Scope};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// GitHub rejects search queries longer than 256 characters.
pub const MAX_QUERY_LEN: usize = 256;
const API_PREFIX: &str = "https://api.github.com/";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchKind {
    /// Open PRs where a review is requested from the user.
    ReviewRequested,
    /// The user's PRs closed (merged or not) since a date.
    Closed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchQuery {
    /// Stable cache key.
    pub key: String,
    pub kind: SearchKind,
    pub query: String,
    pub endpoint: String,
}

/// Percent-encodes everything but the unreserved characters.
pub fn encode_component(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Packs `repo:` qualifiers into groups so `prefix` plus a group fits.
fn chunk_repos(prefix: &str, qualifiers: &[String]) -> Vec<String> {
    let mut chunks: Vec<String> = Vec::new();
    for qualifier in qualifiers {
        let fits = chunks
            .last()
            .is_some_and(|last| prefix.len() + last.len() + 1 + qualifier.len() < MAX_QUERY_LEN);
        if fits {
            let last = chunks.last_mut().expect("checked above");
            last.push(' ');
            last.push_str(qualifier);
        } else {
            chunks.push(qualifier.clone());
        }
    }
    chunks
}

/// The review-request and recently-closed queries for the watched repos and
/// the user's own repos. `since` is a `YYYY-MM-DD` date.
pub fn build_queries(scope: &Scope, since: &str) -> Vec<SearchQuery> {
    let org_repos: Vec<String> = scope
        .watched
        .iter()
        .map(|name| format!("repo:{}/{name}", scope.org))
        .collect();
    let me = &scope.login;
    let review_prefix = format!("is:pr is:open review-requested:{me} ");
    let closed_prefix = format!("is:pr is:closed author:{me} closed:>={since} ");
    let mut queries = Vec::new();
    for (name, kind, prefix) in [
        ("review", SearchKind::ReviewRequested, &review_prefix),
        ("closed", SearchKind::Closed, &closed_prefix),
    ] {
        let mut scopes: Vec<(String, String)> = chunk_repos(prefix, &org_repos)
            .into_iter()
            .enumerate()
            .map(|(i, repos)| (format!("search:{name}:org:{i}"), repos))
            .collect();
        scopes.push((format!("search:{name}:user"), format!("user:{me}")));
        for (key, filter) in scopes {
            let query = format!("{prefix}{filter}");
            let endpoint = format!(
                "search/issues?q={}&sort=updated&order=desc&per_page=50",
                encode_component(&query)
            );
            queries.push(SearchQuery {
                key,
                kind,
                query,
                endpoint,
            });
        }
    }
    queries
}

fn text<'a>(value: &'a Value, path: &[&str]) -> &'a str {
    let mut at = value;
    for key in path {
        at = &at[*key];
    }
    at.as_str().unwrap_or_default()
}

/// `https://api.github.com/repos/o/r` -> `o/r`.
fn repo_from_api_url(url: &str) -> Option<&str> {
    url.strip_prefix("https://api.github.com/repos/")
}

/// Normalizes a `search/issues` reply into "Needs you" items. Results from
/// outside the scope are dropped.
pub fn normalize_search(
    body: &str,
    kind: SearchKind,
    scope: &Scope,
) -> Result<Vec<FeedItem>, String> {
    let reply: Value = serde_json::from_str(body).map_err(|_| "unreadable search".to_string())?;
    let found = reply["items"].as_array().ok_or("unexpected search reply")?;
    let mut items = Vec::new();
    for pr in found {
        if pr["pull_request"].is_null() {
            continue;
        }
        let Some(repo) = repo_from_api_url(text(pr, &["repository_url"])) else {
            continue;
        };
        let Some(source) = scope.source_of(repo) else {
            continue;
        };
        let Some(number) = pr["number"].as_u64() else {
            continue;
        };
        let author = text(pr, &["user", "login"]);
        let author_bot = is_bot(author, pr["user"]["type"].as_str());
        let merged_at = parse_time(text(pr, &["pull_request", "merged_at"]));
        let (item_kind, at) = match kind {
            SearchKind::ReviewRequested => {
                ("review_requested", parse_time(text(pr, &["updated_at"])))
            }
            SearchKind::Closed if merged_at.is_some() => ("pr_merged", merged_at),
            SearchKind::Closed => ("pr_closed", parse_time(text(pr, &["closed_at"]))),
        };
        let Some(at) = at else { continue };
        items.push(FeedItem {
            id: format!("{item_kind}:{repo}#{number}"),
            kind: item_kind.to_string(),
            source: source.to_string(),
            repo: repo.to_string(),
            actor: author.to_string(),
            actor_is_bot: author_bot,
            title: text(pr, &["title"]).to_string(),
            url: safe_url(text(pr, &["html_url"])),
            at,
            number: Some(number),
            git_ref: None,
            pr_author: Some(author.to_string()),
            involves_me: true,
            detail: None,
            push: None,
        });
    }
    Ok(items)
}

/// A notification thread on one of the user's own PRs.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    pub id: String,
    pub repo: String,
    pub number: u64,
    pub title: String,
    pub updated_at: String,
    /// The latest comment, as an API path (`repos/o/r/issues/comments/9`).
    pub comment_path: String,
}

/// Threads where GitHub says "you created the thread" (reason `author`) on a
/// pull request in scope, with a latest comment to look up.
pub fn normalize_notifications(body: &str, scope: &Scope) -> Result<Vec<Thread>, String> {
    let reply: Value =
        serde_json::from_str(body).map_err(|_| "unreadable notifications".to_string())?;
    let threads = reply.as_array().ok_or("unexpected notifications reply")?;
    let mut out = Vec::new();
    for thread in threads {
        if text(thread, &["reason"]) != "author"
            || text(thread, &["subject", "type"]) != "PullRequest"
        {
            continue;
        }
        let repo = text(thread, &["repository", "full_name"]);
        if scope.source_of(repo).is_none() {
            continue;
        }
        let comment_url = text(thread, &["subject", "latest_comment_url"]);
        let Some(comment_path) = comment_url.strip_prefix(API_PREFIX) else {
            continue;
        };
        if comment_path
            .chars()
            .any(|c| c.is_whitespace() || c.is_control())
        {
            continue;
        }
        let number = text(thread, &["subject", "url"])
            .rsplit('/')
            .next()
            .and_then(|n| n.parse::<u64>().ok());
        let (Some(number), Some(updated_at)) = (number, parse_time(text(thread, &["updated_at"])))
        else {
            continue;
        };
        out.push(Thread {
            id: text(thread, &["id"]).to_string(),
            repo: repo.to_string(),
            number,
            title: text(thread, &["subject", "title"]).to_string(),
            updated_at,
            comment_path: comment_path.to_string(),
        });
    }
    Ok(out)
}

/// Who wrote a comment, from one lookup of the comment itself.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CommentInfo {
    /// Empty when the comment could not be read (deleted, no access).
    pub login: String,
    pub is_bot: bool,
    pub url: String,
    pub at: String,
    pub detail: Option<String>,
}

pub fn parse_comment(body: &str) -> Option<CommentInfo> {
    let comment: Value = serde_json::from_str(body).ok()?;
    let login = text(&comment, &["user", "login"]);
    if login.is_empty() {
        return None;
    }
    Some(CommentInfo {
        login: login.to_string(),
        is_bot: is_bot(login, comment["user"]["type"].as_str()),
        url: safe_url(text(&comment, &["html_url"])),
        at: parse_time(text(&comment, &["created_at"])).unwrap_or_default(),
        detail: snippet(text(&comment, &["body"])),
    })
}

/// The "new comment on your PR" item, or None when the comment is the user's
/// own or could not be read.
pub fn comment_item(thread: &Thread, info: &CommentInfo, scope: &Scope) -> Option<FeedItem> {
    if info.login.is_empty() || info.login.eq_ignore_ascii_case(&scope.login) {
        return None;
    }
    let source = scope.source_of(&thread.repo)?;
    let pr_url = safe_url(&format!(
        "https://github.com/{}/pull/{}",
        thread.repo, thread.number
    ));
    Some(FeedItem {
        id: format!("comment:{}", thread.comment_path),
        kind: "comment".into(),
        source: source.to_string(),
        repo: thread.repo.clone(),
        actor: info.login.clone(),
        actor_is_bot: info.is_bot,
        title: thread.title.clone(),
        url: if info.url.is_empty() {
            pr_url
        } else {
            info.url.clone()
        },
        at: if info.at.is_empty() {
            thread.updated_at.clone()
        } else {
            info.at.clone()
        },
        number: Some(thread.number),
        git_ref: None,
        pr_author: Some(scope.login.clone()),
        involves_me: true,
        detail: info.detail.clone(),
        push: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::github::{DEFAULT_LOGIN, DEFAULT_ORG, DEFAULT_WATCHED};

    fn scope() -> Scope {
        Scope {
            org: DEFAULT_ORG.into(),
            watched: DEFAULT_WATCHED.iter().map(|s| s.to_string()).collect(),
            login: DEFAULT_LOGIN.into(),
        }
    }

    #[test]
    fn every_query_is_under_the_search_limit() {
        let queries = build_queries(&scope(), "2026-10-09");
        assert!(queries.len() >= 4);
        for q in &queries {
            assert!(
                q.query.len() < MAX_QUERY_LEN,
                "{} chars: {}",
                q.query.len(),
                q.query
            );
        }
        // A longer watch list still splits instead of overflowing.
        let mut big = scope();
        big.watched = (0..40)
            .map(|i| format!("koneksi-service-number-{i}"))
            .collect();
        for q in build_queries(&big, "2026-10-09") {
            assert!(q.query.len() < MAX_QUERY_LEN, "{}", q.query.len());
        }
    }

    #[test]
    fn queries_cover_exactly_the_seven_repos_and_the_user_and_nothing_else() {
        let queries = build_queries(&scope(), "2026-10-09");
        let review: String = queries
            .iter()
            .filter(|q| q.kind == SearchKind::ReviewRequested && q.key.contains(":org:"))
            .map(|q| q.query.clone())
            .collect::<Vec<_>>()
            .join(" ");
        for repo in DEFAULT_WATCHED {
            assert!(
                review.contains(&format!("repo:koneksi-tech/{repo}")),
                "{repo}"
            );
        }
        assert!(queries
            .iter()
            .any(|q| q.query.ends_with("user:jtfrancisco0121")));
        assert!(queries.iter().all(|q| !q.query.contains("caiden")));
        assert!(queries
            .iter()
            .any(|q| q.query.contains("review-requested:jtfrancisco0121")));
        assert!(queries
            .iter()
            .any(|q| q.query.contains("closed:>=2026-10-09")));
    }

    #[test]
    fn endpoints_are_encoded_and_read_only() {
        for q in build_queries(&scope(), "2026-10-09") {
            assert!(q.endpoint.starts_with("search/issues?q="));
            assert!(!q.endpoint.contains(' ') && !q.endpoint.contains(':'));
            assert!(!q.endpoint.contains('\n'));
        }
    }

    const SEARCH: &str = r#"{"items":[
      {"number":7,"title":"Add retry","html_url":"https://github.com/koneksi-tech/koneksi-web/pull/7",
       "repository_url":"https://api.github.com/repos/koneksi-tech/koneksi-web",
       "user":{"login":"alvin-reyes","type":"User"},"updated_at":"2026-10-15T01:00:00Z",
       "closed_at":"2026-10-15T02:00:00Z","pull_request":{"merged_at":"2026-10-15T02:00:00Z"}},
      {"number":8,"title":"Dep bump","html_url":"https://github.com/koneksi-tech/koneksi-web/pull/8",
       "repository_url":"https://api.github.com/repos/koneksi-tech/koneksi-web",
       "user":{"login":"dependabot[bot]","type":"Bot"},"updated_at":"2026-10-15T01:00:00Z",
       "closed_at":"2026-10-15T03:00:00Z","pull_request":{"merged_at":null}},
      {"number":9,"title":"Not watched","html_url":"https://github.com/koneksi-tech/koneksi-docs/pull/9",
       "repository_url":"https://api.github.com/repos/koneksi-tech/koneksi-docs",
       "user":{"login":"x","type":"User"},"updated_at":"2026-10-15T01:00:00Z","pull_request":{}},
      {"number":10,"title":"Other org","html_url":"https://github.com/caiden-tech/app/pull/10",
       "repository_url":"https://api.github.com/repos/caiden-tech/app",
       "user":{"login":"x","type":"User"},"updated_at":"2026-10-15T01:00:00Z","pull_request":{}},
      {"number":11,"title":"Mine","html_url":"https://github.com/jtfrancisco0121/notes/pull/11",
       "repository_url":"https://api.github.com/repos/jtfrancisco0121/notes",
       "user":{"login":"jtfrancisco0121","type":"User"},"updated_at":"2026-10-15T01:00:00Z",
       "closed_at":"2026-10-14T00:00:00Z","pull_request":{"merged_at":null}},
      {"number":12,"title":"An issue","html_url":"https://github.com/koneksi-tech/koneksi-web/issues/12",
       "repository_url":"https://api.github.com/repos/koneksi-tech/koneksi-web",
       "user":{"login":"x","type":"User"},"updated_at":"2026-10-15T01:00:00Z"}
    ]}"#;

    #[test]
    fn search_keeps_only_prs_in_scope() {
        let closed = normalize_search(SEARCH, SearchKind::Closed, &scope()).unwrap();
        let ids: Vec<&str> = closed.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "pr_merged:koneksi-tech/koneksi-web#7",
                "pr_closed:koneksi-tech/koneksi-web#8",
                "pr_closed:jtfrancisco0121/notes#11"
            ],
            "caiden-tech, unwatched koneksi repos and plain issues are out"
        );
        assert_eq!(closed[0].at, "2026-10-15T02:00:00Z");
        assert_eq!(closed[2].source, "personal");
    }

    #[test]
    fn review_requests_flag_bot_authors() {
        let reviews = normalize_search(SEARCH, SearchKind::ReviewRequested, &scope()).unwrap();
        assert!(reviews.iter().all(|i| i.kind == "review_requested"));
        let bot = reviews.iter().find(|i| i.number == Some(8)).unwrap();
        assert!(bot.actor_is_bot);
        assert!(
            !reviews
                .iter()
                .find(|i| i.number == Some(7))
                .unwrap()
                .actor_is_bot
        );
    }

    fn notifications() -> String {
        let thread = |id: &str, reason: &str, kind: &str, repo: &str, n: u32, comment: &str| {
            format!(
                r#"{{"id":"{id}","reason":"{reason}","updated_at":"2026-10-15T04:00:00Z",
                "subject":{{"title":"T{n}","type":"{kind}","url":"https://api.github.com/repos/{repo}/pulls/{n}",
                "latest_comment_url":{comment}}},"repository":{{"full_name":"{repo}"}}}}"#
            )
        };
        let c = |path: &str| format!("\"https://api.github.com/{path}\"");
        format!(
            "[{}]",
            [
                thread(
                    "1",
                    "author",
                    "PullRequest",
                    "koneksi-tech/koneksi-web",
                    7,
                    &c("repos/koneksi-tech/koneksi-web/issues/comments/55")
                ),
                thread(
                    "2",
                    "author",
                    "PullRequest",
                    "caiden-tech/app",
                    8,
                    &c("repos/caiden-tech/app/issues/comments/56")
                ),
                thread(
                    "3",
                    "author",
                    "PullRequest",
                    "koneksi-tech/koneksi-docs",
                    9,
                    &c("repos/koneksi-tech/koneksi-docs/issues/comments/57")
                ),
                thread(
                    "4",
                    "ci_activity",
                    "CheckSuite",
                    "koneksi-tech/koneksi-web",
                    10,
                    "null"
                ),
                thread(
                    "5",
                    "mention",
                    "PullRequest",
                    "koneksi-tech/koneksi-web",
                    11,
                    &c("repos/koneksi-tech/koneksi-web/issues/comments/58")
                ),
                thread(
                    "6",
                    "author",
                    "PullRequest",
                    "koneksi-tech/koneksi-web",
                    12,
                    "null"
                ),
                thread(
                    "7",
                    "author",
                    "PullRequest",
                    "jtfrancisco0121/notes",
                    13,
                    &c("repos/jtfrancisco0121/notes/issues/comments/59")
                ),
            ]
            .join(",")
        )
    }

    #[test]
    fn notifications_keep_author_threads_on_prs_in_scope() {
        let threads = normalize_notifications(&notifications(), &scope()).unwrap();
        let repos: Vec<(&str, u64)> = threads
            .iter()
            .map(|t| (t.repo.as_str(), t.number))
            .collect();
        assert_eq!(
            repos,
            [
                ("koneksi-tech/koneksi-web", 7),
                ("jtfrancisco0121/notes", 13)
            ]
        );
        assert_eq!(
            threads[0].comment_path,
            "repos/koneksi-tech/koneksi-web/issues/comments/55"
        );
    }

    #[test]
    fn comment_items_skip_my_own_and_unreadable_comments() {
        let thread = normalize_notifications(&notifications(), &scope())
            .unwrap()
            .remove(0);
        let info = parse_comment(
            r#"{"user":{"login":"alvin-reyes","type":"User"},"html_url":"https://github.com/koneksi-tech/koneksi-web/pull/7#issuecomment-55","created_at":"2026-10-15T03:59:00Z","body":"Please rebase\nthanks"}"#,
        )
        .unwrap();
        let item = comment_item(&thread, &info, &scope()).unwrap();
        assert_eq!(
            item.id,
            "comment:repos/koneksi-tech/koneksi-web/issues/comments/55"
        );
        assert_eq!(item.actor, "alvin-reyes");
        assert_eq!(item.detail.as_deref(), Some("Please rebase"));
        assert_eq!(item.at, "2026-10-15T03:59:00Z");
        assert!(item.url.ends_with("#issuecomment-55"));

        let mine = CommentInfo {
            login: "JTFrancisco0121".into(),
            ..info.clone()
        };
        assert!(comment_item(&thread, &mine, &scope()).is_none());
        assert!(comment_item(&thread, &CommentInfo::default(), &scope()).is_none());
        let bot = parse_comment(r#"{"user":{"login":"vercel[bot]"},"body":"x"}"#).unwrap();
        assert!(comment_item(&thread, &bot, &scope()).unwrap().actor_is_bot);
    }
}
