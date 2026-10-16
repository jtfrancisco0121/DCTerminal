//! Turns a repo's raw event list into `FeedItem`s. Raw payloads (which carry
//! whole PR objects) are dropped here and never stored.

use super::{FeedItem, PushRange};
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::Value;

const SNIPPET_CHARS: usize = 140;
const GITHUB_PREFIX: &str = "https://github.com/";
const ZERO_SHA: &str = "0000000000000000000000000000000000000000";

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Normalized {
    pub items: Vec<FeedItem>,
    /// Oldest event in the reply, kept or not: how far back the feed reaches.
    pub oldest: Option<String>,
}

/// Bot accounts: a login ending in `[bot]` (event actors carry no `type`
/// field, so this is the check that matters there) or a user object whose
/// `type` is "Bot" (search and notification replies).
pub fn is_bot(login: &str, account_type: Option<&str>) -> bool {
    login.to_ascii_lowercase().ends_with("[bot]")
        || account_type.is_some_and(|t| t.eq_ignore_ascii_case("bot"))
}

/// The address when it is on github.com, else empty.
pub fn safe_url(url: &str) -> String {
    if url.starts_with(GITHUB_PREFIX) && !url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        url.to_string()
    } else {
        String::new()
    }
}

/// True when `body` mentions `@login` as a whole name.
pub fn mentions(body: &str, login: &str) -> bool {
    let body = body.to_ascii_lowercase();
    let needle = format!("@{}", login.to_ascii_lowercase());
    let mut from = 0;
    while let Some(found) = body[from..].find(&needle) {
        let end = from + found + needle.len();
        let next = body[end..].chars().next();
        if !next.is_some_and(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            return true;
        }
        from = end;
    }
    false
}

/// RFC 3339 in UTC with seconds, or None when it does not parse.
pub fn parse_time(text: &str) -> Option<String> {
    DateTime::parse_from_rfc3339(text).ok().map(|t| {
        t.with_timezone(&Utc)
            .to_rfc3339_opts(SecondsFormat::Secs, true)
    })
}

/// First non-empty line, whitespace collapsed, shortened.
pub fn snippet(text: &str) -> Option<String> {
    let line = text.lines().map(str::trim).find(|line| !line.is_empty())?;
    let collapsed = line.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out: String = collapsed.chars().take(SNIPPET_CHARS).collect();
    if collapsed.chars().count() > SNIPPET_CHARS {
        out.push('…');
    }
    Some(out)
}

fn text<'a>(value: &'a Value, path: &[&str]) -> &'a str {
    let mut at = value;
    for key in path {
        at = &at[*key];
    }
    at.as_str().unwrap_or_default()
}

/// Keeps `/` and the characters a branch name may have; escapes the rest.
fn encode_ref(name: &str) -> String {
    let mut out = String::new();
    for byte in name.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'/' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn branch_of(git_ref: &str) -> &str {
    git_ref.strip_prefix("refs/heads/").unwrap_or(git_ref)
}

fn requested_reviewer(pr: &Value, payload: &Value, me: &str) -> bool {
    let listed = pr["requested_reviewers"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|r| text(r, &["login"]).eq_ignore_ascii_case(me));
    listed || text(payload, &["requested_reviewer", "login"]).eq_ignore_ascii_case(me)
}

/// The parts of a pull request the events leave out.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PullInfo {
    pub title: String,
    pub author: String,
    pub author_is_bot: bool,
    pub reviewers: Vec<String>,
    pub mentions_me: bool,
    /// Merged (a "closed" event does not say so).
    pub merged: bool,
    pub etag: Option<String>,
    /// Unix seconds of the last lookup.
    pub fetched_at: i64,
    /// The lookup said 404 or 403: shown with a plain title.
    pub missing: bool,
}

/// Reads the body of `repos/{repo}/pulls/{n}`.
pub fn parse_pull(body: &str, me: &str) -> Option<PullInfo> {
    let pr: Value = serde_json::from_str(body).ok()?;
    let title = text(&pr, &["title"]);
    if title.is_empty() {
        return None;
    }
    let author = text(&pr, &["user", "login"]);
    Some(PullInfo {
        title: title.to_string(),
        author: author.to_string(),
        author_is_bot: is_bot(author, pr["user"]["type"].as_str()),
        reviewers: pr["requested_reviewers"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|r| r["login"].as_str().map(str::to_string))
            .collect(),
        mentions_me: mentions(text(&pr, &["body"]), me),
        merged: pr["merged"] == true || pr["merged_at"].as_str().is_some(),
        ..PullInfo::default()
    })
}

/// True for rows whose PR title and author still have to come from a lookup.
pub fn needs_pull_info(item: &FeedItem) -> bool {
    item.number.is_some()
        && item.pr_author.is_none()
        && item.title.is_empty()
        && matches!(
            item.kind.as_str(),
            "pr_opened"
                | "pr_merged"
                | "pr_closed"
                | "pr_reopened"
                | "review_requested"
                | "review"
                | "comment"
        )
}

/// Fills a row from its PR lookup (or a plain title when there is none).
pub fn apply_pull_info(item: &mut FeedItem, info: Option<&PullInfo>, me: &str) {
    let Some(number) = item.number else { return };
    match info.filter(|i| !i.missing) {
        Some(info) => {
            item.title = info.title.clone();
            if !info.author.is_empty() {
                item.involves_me |= info.author.eq_ignore_ascii_case(me);
                item.pr_author = Some(info.author.clone());
            }
            item.involves_me |= info.mentions_me;
            // A trimmed "closed" event does not say whether the PR merged.
            if item.kind == "pr_closed" && info.merged {
                item.kind = "pr_merged".to_string();
            }
            if item.kind == "review_requested" || item.kind == "pr_opened" {
                item.involves_me |= info.reviewers.iter().any(|r| r.eq_ignore_ascii_case(me));
            }
        }
        None => item.title = format!("Pull request #{number}"),
    }
}

/// Normalizes the JSON body of `repos/{owner}/{repo}/events`.
/// `repo_full` is `owner/repo`; events that name another repo are dropped.
pub fn normalize_events(
    body: &str,
    repo_full: &str,
    source: &str,
    me: &str,
) -> Result<Normalized, String> {
    let events: Value = serde_json::from_str(body).map_err(|_| "unreadable events".to_string())?;
    let events = events.as_array().ok_or("unexpected events reply")?;
    let mut out = Normalized::default();
    for event in events {
        let Some(at) = parse_time(text(event, &["created_at"])) else {
            continue;
        };
        if out.oldest.as_ref().is_none_or(|oldest| &at < oldest) {
            out.oldest = Some(at.clone());
        }
        if !text(event, &["repo", "name"]).eq_ignore_ascii_case(repo_full) {
            continue;
        }
        let id = text(event, &["id"]);
        let actor = text(event, &["actor", "login"]);
        if id.is_empty() || actor.is_empty() {
            continue;
        }
        let account_type = event["actor"]["type"].as_str();
        let base = FeedItem {
            id: id.to_string(),
            kind: String::new(),
            source: source.to_string(),
            repo: repo_full.to_string(),
            actor: actor.to_string(),
            actor_is_bot: is_bot(actor, account_type),
            title: String::new(),
            url: String::new(),
            at,
            number: None,
            git_ref: None,
            pr_author: None,
            involves_me: actor.eq_ignore_ascii_case(me),
            detail: None,
            push: None,
        };
        if let Some(item) = event_item(event, base, repo_full, me) {
            out.items.push(item);
        }
    }
    Ok(out)
}

fn event_item(event: &Value, mut item: FeedItem, repo: &str, me: &str) -> Option<FeedItem> {
    let payload = &event["payload"];
    let action = text(payload, &["action"]);
    match text(event, &["type"]) {
        "PullRequestEvent" => {
            let pr = &payload["pull_request"];
            let merged = action == "merged" || (action == "closed" && pr["merged"] == true);
            item.kind = match action {
                _ if merged => "pr_merged",
                "opened" => "pr_opened",
                "closed" => "pr_closed",
                "reopened" => "pr_reopened",
                "review_requested" => "review_requested",
                _ => return None,
            }
            .to_string();
            fill_pull_request(&mut item, pr, payload["number"].as_u64(), me);
            if item.kind == "review_requested" && requested_reviewer(pr, payload, me) {
                item.involves_me = true;
            }
            item.involves_me |= mentions(text(pr, &["body"]), me);
        }
        "PullRequestReviewEvent" => {
            if action != "created" {
                return None;
            }
            let pr = &payload["pull_request"];
            item.kind = "review".into();
            fill_pull_request(&mut item, pr, None, me);
            let review = &payload["review"];
            item.detail = match text(review, &["state"]).to_ascii_lowercase().as_str() {
                "approved" => Some("approved".to_string()),
                "changes_requested" => Some("requested changes".to_string()),
                "commented" => Some("commented".to_string()),
                "dismissed" => Some("dismissed".to_string()),
                _ => None,
            };
            let url = safe_url(text(review, &["html_url"]));
            if !url.is_empty() {
                item.url = url;
            }
            item.involves_me |= mentions(text(review, &["body"]), me);
        }
        "PullRequestReviewCommentEvent" => {
            if action != "created" {
                return None;
            }
            let pr = &payload["pull_request"];
            item.kind = "comment".into();
            fill_pull_request(&mut item, pr, None, me);
            let comment = &payload["comment"];
            item.detail = snippet(text(comment, &["body"]));
            let url = safe_url(text(comment, &["html_url"]));
            if !url.is_empty() {
                item.url = url;
            }
            item.involves_me |= mentions(text(comment, &["body"]), me);
        }
        "IssueCommentEvent" => {
            if action != "created" {
                return None;
            }
            let issue = &payload["issue"];
            item.kind = "comment".into();
            item.number = issue["number"].as_u64();
            item.title = text(issue, &["title"]).to_string();
            item.url = safe_url(text(issue, &["html_url"]));
            let author = text(issue, &["user", "login"]);
            if !author.is_empty() {
                item.involves_me |= author.eq_ignore_ascii_case(me);
                item.pr_author = Some(author.to_string());
            }
            let comment = &payload["comment"];
            item.detail = snippet(text(comment, &["body"]));
            let url = safe_url(text(comment, &["html_url"]));
            if !url.is_empty() {
                item.url = url;
            }
            item.involves_me |= mentions(text(comment, &["body"]), me);
        }
        "CommitCommentEvent" => {
            item.kind = "comment".into();
            item.title = "Commented on a commit".into();
            let comment = &payload["comment"];
            item.detail = snippet(text(comment, &["body"]));
            item.url = safe_url(text(comment, &["html_url"]));
            item.involves_me |= mentions(text(comment, &["body"]), me);
        }
        "PushEvent" => {
            let git_ref = text(payload, &["ref"]);
            let branch = branch_of(git_ref);
            let (before, head) = (text(payload, &["before"]), text(payload, &["head"]));
            item.kind = "push".into();
            item.title = format!("Pushed to {branch}");
            item.git_ref = Some(branch.to_string());
            item.url = if before.is_empty() || before == ZERO_SHA {
                safe_url(&format!("{GITHUB_PREFIX}{repo}/commit/{head}"))
            } else {
                safe_url(&format!("{GITHUB_PREFIX}{repo}/compare/{before}...{head}"))
            };
            if !head.is_empty() && !before.is_empty() {
                item.push = Some(PushRange {
                    before: before.to_string(),
                    head: head.to_string(),
                });
            }
        }
        "CreateEvent" | "DeleteEvent" => {
            let created = text(event, &["type"]) == "CreateEvent";
            let git_ref = text(payload, &["ref"]);
            let (kind, label) = match (text(payload, &["ref_type"]), created) {
                ("branch", true) => ("branch_created", "Created branch"),
                ("branch", false) => ("branch_deleted", "Deleted branch"),
                ("tag", true) => ("tag_created", "Created tag"),
                ("tag", false) => ("tag_deleted", "Deleted tag"),
                ("repository", true) => ("other", "Created the repository"),
                _ => return None,
            };
            item.kind = kind.into();
            if git_ref.is_empty() {
                item.title = label.to_string();
                item.url = safe_url(&format!("{GITHUB_PREFIX}{repo}"));
            } else {
                item.title = format!("{label} {git_ref}");
                item.git_ref = Some(git_ref.to_string());
                item.url = if created {
                    let route = if kind == "tag_created" {
                        "releases/tag"
                    } else {
                        "tree"
                    };
                    safe_url(&format!(
                        "{GITHUB_PREFIX}{repo}/{route}/{}",
                        encode_ref(git_ref)
                    ))
                } else {
                    safe_url(&format!("{GITHUB_PREFIX}{repo}"))
                };
            }
        }
        "ReleaseEvent" => {
            if action != "published" {
                return None;
            }
            let release = &payload["release"];
            item.kind = "release".into();
            let name = text(release, &["name"]);
            let tag = text(release, &["tag_name"]);
            item.title = if name.is_empty() { tag } else { name }.to_string();
            item.git_ref = (!tag.is_empty()).then(|| tag.to_string());
            item.url = safe_url(text(release, &["html_url"]));
        }
        "IssuesEvent" => {
            item.kind = match action {
                "opened" => "issue_opened",
                "closed" => "issue_closed",
                "reopened" => "issue_reopened",
                _ => return None,
            }
            .to_string();
            let issue = &payload["issue"];
            item.number = issue["number"].as_u64();
            item.title = text(issue, &["title"]).to_string();
            item.url = safe_url(text(issue, &["html_url"]));
            let author = text(issue, &["user", "login"]);
            if !author.is_empty() {
                item.involves_me |= author.eq_ignore_ascii_case(me);
                item.pr_author = Some(author.to_string());
            }
            item.involves_me |= mentions(text(issue, &["body"]), me);
        }
        "ForkEvent" | "WatchEvent" | "PublicEvent" | "MemberEvent" | "GollumEvent" => {
            item.kind = "other".into();
            item.title = match text(event, &["type"]) {
                "ForkEvent" => "Forked the repository",
                "WatchEvent" => "Starred the repository",
                "PublicEvent" => "Made the repository public",
                "MemberEvent" => "Changed collaborators",
                _ => "Edited the wiki",
            }
            .to_string();
            item.url = safe_url(&format!("{GITHUB_PREFIX}{repo}"));
        }
        _ => return None,
    }
    Some(item)
}

/// Live events carry only `url, id, number, head, base` for the PR, so the
/// title and author may be empty here; the cycle fills them from a cached
/// `repos/{repo}/pulls/{n}` lookup (see `PullInfo`). The link never depends
/// on that: it is built from the repo and number.
fn fill_pull_request(item: &mut FeedItem, pr: &Value, number: Option<u64>, me: &str) {
    item.number = number.or_else(|| pr["number"].as_u64());
    item.title = text(pr, &["title"]).to_string();
    item.url = safe_url(text(pr, &["html_url"]));
    if item.url.is_empty() {
        if let Some(n) = item.number {
            item.url = safe_url(&format!("{GITHUB_PREFIX}{}/pull/{n}", item.repo));
        }
    }
    let author = text(pr, &["user", "login"]);
    if !author.is_empty() {
        item.involves_me |= author.eq_ignore_ascii_case(me);
        item.pr_author = Some(author.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ME: &str = "jtfrancisco0121";
    const REPO: &str = "koneksi-tech/koneksi-desktop";

    fn run(fixture: &str) -> Normalized {
        normalize_events(fixture, REPO, "koneksi-tech", ME).unwrap()
    }

    fn fixture() -> Normalized {
        run(include_str!("../../../fixtures/github/repo_events.json"))
    }

    fn kind<'a>(n: &'a Normalized, id: &str) -> &'a FeedItem {
        n.items
            .iter()
            .find(|i| i.id == id)
            .unwrap_or_else(|| panic!("no item {id}"))
    }

    #[test]
    fn both_forms_of_a_merge_are_merges() {
        let n = fixture();
        assert_eq!(kind(&n, "1001").kind, "pr_merged", "action merged");
        assert_eq!(
            kind(&n, "1002").kind,
            "pr_closed",
            "trimmed: the lookup says merged"
        );
        assert_eq!(kind(&n, "1003").kind, "pr_closed", "closed unmerged");
    }

    #[test]
    fn a_full_pull_request_payload_still_reads_closed_and_merged_as_a_merge() {
        let body = r#"[{"id":"9","type":"PullRequestEvent","actor":{"login":"a"},
          "repo":{"name":"koneksi-tech/koneksi-desktop"},"created_at":"2026-10-15T01:00:00Z",
          "payload":{"action":"closed","number":7,"pull_request":{"number":7,"title":"T","merged":true,
          "html_url":"https://github.com/koneksi-tech/koneksi-desktop/pull/7","user":{"login":"alvin-reyes"}}}}]"#;
        let n = run(body);
        assert_eq!(n.items[0].kind, "pr_merged");
        assert_eq!(n.items[0].title, "T");
        assert_eq!(n.items[0].pr_author.as_deref(), Some("alvin-reyes"));
    }

    #[test]
    fn trimmed_pr_events_get_a_link_from_the_repo_and_number() {
        let n = fixture();
        for id in ["1000", "1001", "1002", "1021", "1040", "1042"] {
            let it = kind(&n, id);
            assert!(
                it.url
                    .starts_with("https://github.com/koneksi-tech/koneksi-desktop/pull/"),
                "{id}: {}",
                it.url
            );
            assert!(it.number.is_some(), "{id}");
        }
        assert_eq!(
            kind(&n, "1000").url,
            "https://github.com/koneksi-tech/koneksi-desktop/pull/41"
        );
        assert!(
            super::needs_pull_info(kind(&n, "1000")),
            "title and author come from a lookup"
        );
        assert!(
            !super::needs_pull_info(kind(&n, "1043")),
            "issue comments carry their own"
        );
    }

    #[test]
    fn a_pr_event_carries_number_title_author_and_https_url() {
        let n = fixture();
        let opened = kind(&n, "1000");
        assert_eq!(opened.kind, "pr_opened");
        assert_eq!(opened.number, Some(41));
        // Live events carry no title or author: they come from a lookup.
        assert_eq!(opened.title, "");
        assert_eq!(opened.pr_author, None);
        assert_eq!(
            opened.url,
            "https://github.com/koneksi-tech/koneksi-desktop/pull/41"
        );
        assert_eq!(opened.at, "2026-10-15T06:18:06Z");
        assert_eq!(opened.source, "koneksi-tech");
        assert_eq!(opened.repo, REPO);
    }

    #[test]
    fn push_rows_keep_their_range_and_branch() {
        let n = fixture();
        let push = kind(&n, "1010");
        assert_eq!(push.kind, "push");
        assert_eq!(push.git_ref.as_deref(), Some("staging"));
        assert_eq!(push.title, "Pushed to staging");
        let range = push.push.as_ref().unwrap();
        assert_eq!(range.before, "a".repeat(40));
        assert_eq!(range.head, "b".repeat(40));
        assert_eq!(
            push.url,
            format!(
                "https://github.com/{REPO}/compare/{}...{}",
                "a".repeat(40),
                "b".repeat(40)
            )
        );
        // A new branch has an all-zero "before": link the commit.
        let first = kind(&n, "1011");
        assert!(first.url.ends_with(&format!("/commit/{}", "c".repeat(40))));
    }

    #[test]
    fn involves_me_covers_actor_author_reviewer_and_mention() {
        let n = fixture();
        assert!(kind(&n, "1020").involves_me, "I am the actor");
        assert!(kind(&n, "1022").involves_me, "requested reviewer");
        assert!(kind(&n, "1023").involves_me, "mentioned in a comment");
        assert!(
            !kind(&n, "1000").involves_me,
            "someone else's PR, not for me"
        );
        assert!(!kind(&n, "1024").involves_me, "a longer login is not me");
    }

    #[test]
    fn bots_are_found_by_login_suffix() {
        let n = fixture();
        assert!(kind(&n, "1030").actor_is_bot, "vercel[bot]");
        assert!(!kind(&n, "1000").actor_is_bot);
        assert!(is_bot("dependabot[bot]", None));
        assert!(is_bot("Renovate", Some("Bot")));
        assert!(!is_bot("alvin-reyes", Some("User")));
    }

    #[test]
    fn reviews_comments_branches_and_releases_get_their_kinds() {
        let n = fixture();
        let review = kind(&n, "1040");
        assert_eq!(
            (review.kind.as_str(), review.detail.as_deref()),
            ("review", Some("approved"))
        );
        assert_eq!(
            kind(&n, "1041").detail.as_deref(),
            Some("requested changes")
        );
        assert_eq!(kind(&n, "1042").kind, "comment");
        assert_eq!(kind(&n, "1043").kind, "comment");
        assert_eq!(kind(&n, "1050").kind, "branch_created");
        assert_eq!(
            kind(&n, "1050").url,
            format!("https://github.com/{REPO}/tree/feat/upload%20retry")
        );
        assert_eq!(kind(&n, "1051").kind, "branch_deleted");
        assert_eq!(kind(&n, "1052").kind, "release");
        assert_eq!(kind(&n, "1052").title, "Desktop 1.4.0");
        assert_eq!(kind(&n, "1053").kind, "other");
    }

    #[test]
    fn noise_actions_and_other_repos_are_dropped_but_still_count_for_reach() {
        let n = fixture();
        assert!(n
            .items
            .iter()
            .all(|i| !["1060", "1061", "1062"].contains(&i.id.as_str())));
        // 1062 names another repo and is the oldest event in the reply.
        assert_eq!(n.oldest.as_deref(), Some("2026-09-16T01:00:00Z"));
    }

    #[test]
    fn urls_off_github_are_blanked() {
        assert_eq!(
            safe_url("https://github.com/o/r/pull/1"),
            "https://github.com/o/r/pull/1"
        );
        assert_eq!(safe_url("https://evil.example/o/r"), "");
        assert_eq!(safe_url("javascript:alert(1)"), "");
        assert_eq!(safe_url("https://github.com.evil.example/x"), "");
        assert_eq!(safe_url("https://github.com/o/r pull"), "");
        let n = fixture();
        assert_eq!(
            kind(&n, "1070").url,
            "",
            "a payload url off github.com is dropped"
        );
    }

    #[test]
    fn mentions_need_a_whole_name() {
        assert!(mentions("ping @jtfrancisco0121, please look", ME));
        assert!(mentions("@JTFRANCISCO0121", ME));
        assert!(!mentions("@jtfrancisco01210 hi", ME));
        assert!(!mentions("jtfrancisco0121 without the at", ME));
    }

    #[test]
    fn snippets_take_the_first_line_and_stay_short() {
        assert_eq!(
            snippet("\n  hello   world \nsecond").as_deref(),
            Some("hello world")
        );
        assert_eq!(snippet("   \n"), None);
        let long = snippet(&"x".repeat(300)).unwrap();
        assert_eq!(long.chars().count(), 141);
    }

    #[test]
    fn bad_input_is_an_error_not_a_panic() {
        assert!(normalize_events("not json", REPO, "koneksi-tech", ME).is_err());
        assert!(normalize_events("{\"message\":\"Not Found\"}", REPO, "koneksi-tech", ME).is_err());
        assert_eq!(
            normalize_events("[]", REPO, "koneksi-tech", ME).unwrap(),
            Normalized::default()
        );
    }

    #[test]
    fn events_with_bad_timestamps_are_skipped() {
        let body = r#"[{"id":"1","type":"WatchEvent","actor":{"login":"a"},"repo":{"name":"koneksi-tech/koneksi-desktop"},"created_at":"yesterday","payload":{}}]"#;
        assert!(run(body).items.is_empty());
    }
}
