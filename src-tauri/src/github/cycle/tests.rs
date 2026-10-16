use super::*;
use crate::github::runner::GhResponse;
use crate::github::{DEFAULT_LOGIN, DEFAULT_ORG, DEFAULT_WATCHED};
use std::sync::atomic::{AtomicUsize, Ordering};

const NOW: i64 = 1_792_000_000; // 2026-10-14
const EVENTS: &str = include_str!("../../../../fixtures/github/repo_events.json");

type Handler = Box<dyn Fn(&str, Option<&str>) -> Result<GhResponse, String> + Send + Sync>;

struct Fake {
    handler: Handler,
    calls: Mutex<Vec<(String, Option<String>)>>,
}

impl Fake {
    fn new(
        handler: impl Fn(&str, Option<&str>) -> Result<GhResponse, String> + Send + Sync + 'static,
    ) -> Self {
        Self {
            handler: Box::new(handler),
            calls: Mutex::new(Vec::new()),
        }
    }

    fn endpoints(&self) -> Vec<String> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .map(|(e, _)| e.clone())
            .collect()
    }

    fn take(&self) -> Vec<(String, Option<String>)> {
        std::mem::take(&mut *self.calls.lock().unwrap())
    }
}

impl GhApi for Fake {
    fn get(&self, endpoint: &str, etag: Option<&str>) -> Result<GhResponse, String> {
        self.calls
            .lock()
            .unwrap()
            .push((endpoint.to_string(), etag.map(str::to_string)));
        (self.handler)(endpoint, etag)
    }
}

fn reply(status: u16, body: &str, etag: &str) -> GhResponse {
    GhResponse {
        status,
        etag: (!etag.is_empty()).then(|| etag.to_string()),
        poll_interval: Some(60),
        scopes: Some(vec!["gist".into(), "repo".into()]),
        rate_remaining: Some(4900),
        rate_reset: Some(NOW + 3000),
        rate_resource: Some("core".into()),
        body: body.to_string(),
    }
}

fn not_modified() -> GhResponse {
    reply(304, "", "")
}

const PERSONAL: &str = r#"[
  {"name":"notes","owner":{"login":"jtfrancisco0121"},"pushed_at":"2026-10-12T00:00:00Z"},
  {"name":"old-thing","owner":{"login":"jtfrancisco0121"},"pushed_at":"2025-01-01T00:00:00Z"},
  {"name":"not-mine","owner":{"login":"someone-else"},"pushed_at":"2026-10-12T00:00:00Z"}
]"#;

const NOTIFICATIONS: &str = r#"[
 {"id":"9","reason":"author","updated_at":"2026-10-14T00:00:00Z",
  "subject":{"title":"My change","type":"PullRequest","url":"https://api.github.com/repos/koneksi-tech/koneksi-web/pulls/45",
   "latest_comment_url":"https://api.github.com/repos/koneksi-tech/koneksi-web/issues/comments/700"},
  "repository":{"full_name":"koneksi-tech/koneksi-web"}},
 {"id":"10","reason":"author","updated_at":"2026-10-14T00:00:00Z",
  "subject":{"title":"Other org","type":"PullRequest","url":"https://api.github.com/repos/caiden-tech/app/pulls/1",
   "latest_comment_url":"https://api.github.com/repos/caiden-tech/app/issues/comments/1"},
  "repository":{"full_name":"caiden-tech/app"}}
]"#;

const COMMENT: &str = r#"{"user":{"login":"alvin-reyes","type":"User"},"html_url":"https://github.com/koneksi-tech/koneksi-web/pull/45#issuecomment-700","created_at":"2026-10-13T23:59:00Z","body":"Could you rebase?"}"#;

fn search_item(number: u32, closed: bool, merged: bool) -> String {
    format!(
        r#"{{"number":{number},"title":"PR {number}","html_url":"https://github.com/koneksi-tech/koneksi-web/pull/{number}",
        "repository_url":"https://api.github.com/repos/koneksi-tech/koneksi-web",
        "user":{{"login":"alvin-reyes","type":"User"}},"updated_at":"2026-10-13T22:00:00Z",
        "closed_at":{closed_at},"pull_request":{{"merged_at":{merged_at}}}}}"#,
        closed_at = if closed {
            "\"2026-10-13T21:00:00Z\""
        } else {
            "null"
        },
        merged_at = if merged {
            "\"2026-10-13T21:00:00Z\""
        } else {
            "null"
        },
    )
}

/// A GitHub that serves the fixtures, with an ETag on every 200 and a 304
/// whenever that ETag comes back.
fn github() -> Fake {
    Fake::new(|endpoint, etag| {
        let tag = format!("\"{}\"", endpoint.len());
        if etag == Some(tag.as_str()) {
            return Ok(not_modified());
        }
        let body = if endpoint.starts_with("user/repos") {
            PERSONAL.to_string()
        } else if endpoint.contains("koneksi-s3-gateway/events") {
            return Ok(reply(404, r#"{"message":"Not Found"}"#, ""));
        } else if endpoint.contains("koneksi-desktop/events") {
            EVENTS.to_string()
        } else if endpoint.contains("/events") {
            "[]".to_string()
        } else if endpoint.starts_with("notifications") {
            NOTIFICATIONS.to_string()
        } else if endpoint.starts_with("search/issues") {
            let items = if endpoint.contains("review-requested") {
                search_item(7, false, false)
            } else if endpoint.contains("closed%3A") && endpoint.contains("koneksi-web") {
                format!(
                    "{},{}",
                    search_item(8, true, true),
                    search_item(9, true, false)
                )
            } else {
                String::new()
            };
            format!(r#"{{"total_count":0,"items":[{items}]}}"#)
        } else if let Some(n) = endpoint.split("/pulls/").nth(1) {
            let n: u32 = n.parse().unwrap();
            if n == 46 {
                return Ok(reply(404, "{}", ""));
            }
            let author = if n == 45 {
                "jtfrancisco0121"
            } else {
                "alvin-reyes"
            };
            format!(
                r#"{{"number":{n},"title":"PR {n} title","body":"","user":{{"login":"{author}","type":"User"}},
                "merged":{},"requested_reviewers":[]}}"#,
                n == 43
            )
        } else if endpoint.contains("issues/comments/700") {
            COMMENT.to_string()
        } else {
            return Ok(reply(404, "{}", ""));
        };
        Ok(reply(200, &body, &tag))
    })
}

fn config() -> CycleConfig {
    CycleConfig {
        login: DEFAULT_LOGIN.into(),
        org: DEFAULT_ORG.into(),
        watched: DEFAULT_WATCHED.iter().map(|s| s.to_string()).collect(),
        personal: Vec::new(),
        personal_refreshed_at: 0,
    }
}

fn first_cycle(api: &Fake) -> (CycleOutcome, CacheFile, CycleConfig) {
    let mut cfg = config();
    let mut cache = CacheFile::default();
    let out = run_cycle(api, &cfg, &mut cache, NOW);
    cfg.personal = out.personal.clone().unwrap();
    cfg.personal_refreshed_at = NOW;
    (out, cache, cfg)
}

#[test]
fn the_first_cycle_calls_only_in_scope_endpoints() {
    let api = github();
    first_cycle(&api);
    let calls = api.endpoints();
    for repo in DEFAULT_WATCHED {
        assert!(
            calls.contains(&format!("repos/koneksi-tech/{repo}/events?per_page=100")),
            "{repo}"
        );
    }
    assert!(calls.contains(&"repos/jtfrancisco0121/notes/events?per_page=100".to_string()));
    assert!(calls.contains(&"user/repos?affiliation=owner&per_page=100".to_string()));
    assert!(calls.contains(&"notifications?per_page=100".to_string()));
    assert!(calls.iter().any(|c| c.starts_with("search/issues")));
    for call in &calls {
        assert!(!call.contains("caiden"), "{call}");
        assert!(!call.contains("received_events"), "{call}");
        assert!(!call.contains("/events/orgs"), "{call}");
        assert!(!call.starts_with("users/"), "{call}");
        assert!(
            !call.contains("not-mine"),
            "another owner's repo is never polled: {call}"
        );
    }
}

#[test]
fn one_missing_repo_is_reported_while_the_rest_load() {
    let api = github();
    let (out, _, _) = first_cycle(&api);
    let gateway = out
        .response
        .repos
        .iter()
        .find(|r| r.repo.ends_with("koneksi-s3-gateway"))
        .unwrap();
    assert_eq!(gateway.reachable, Some(false));
    assert!(gateway.error.as_deref().unwrap().contains("Not found"));
    let desktop = out
        .response
        .repos
        .iter()
        .find(|r| r.repo.ends_with("koneksi-desktop"))
        .unwrap();
    assert_eq!(desktop.reachable, Some(true));
    assert_eq!(desktop.oldest.as_deref(), Some("2026-09-16T01:00:00Z"));
    assert!(!out.response.items.is_empty());
    assert!(out.response.setup.is_none());
    assert!(out
        .response
        .errors
        .contains_key("events:koneksi-tech/koneksi-s3-gateway"));
}

#[test]
fn the_feed_holds_only_watched_and_owned_repos_newest_first() {
    let api = github();
    let (out, _, _) = first_cycle(&api);
    let scope = Scope {
        org: DEFAULT_ORG.into(),
        watched: DEFAULT_WATCHED.iter().map(|s| s.to_string()).collect(),
        login: DEFAULT_LOGIN.into(),
    };
    assert!(out
        .response
        .items
        .iter()
        .all(|i| scope.source_of(&i.repo).is_some()));
    assert!(out.response.items.windows(2).all(|w| w[0].at >= w[1].at));
    assert!(out
        .response
        .items
        .iter()
        .all(|i| !i.repo.starts_with("caiden-tech")));
    let repos: Vec<&str> = out.response.repos.iter().map(|r| r.repo.as_str()).collect();
    assert!(repos.contains(&"jtfrancisco0121/old-thing"));
    assert!(!repos.contains(&"jtfrancisco0121/not-mine"));
}

#[test]
fn a_second_cycle_sends_etags_and_a_304_changes_and_writes_nothing() {
    let api = github();
    let (first, mut cache, cfg) = first_cycle(&api);
    assert!(first.cache_dirty);
    api.take();
    let second = run_cycle(&api, &cfg, &mut cache, NOW + 61);
    let calls = api.take();
    assert!(!second.cache_dirty, "only 304s: nothing to write");
    assert_eq!(second.response.items, first.response.items);
    assert_eq!(second.response.needs_you, first.response.needs_you);
    // Every event endpoint that answered 200 before is asked with its ETag.
    let desktop = calls
        .iter()
        .find(|(e, _)| e.contains("koneksi-desktop/events"))
        .unwrap();
    assert!(desktop.1.is_some(), "If-None-Match was sent");
    let notes = calls
        .iter()
        .find(|(e, _)| e.contains("notes/events"))
        .unwrap();
    assert!(notes.1.is_some());
    // The repo that 404ed has no ETag and is not retried for 15 minutes.
    assert!(!calls
        .iter()
        .any(|(e, _)| e.contains("koneksi-s3-gateway/events")));
}

#[test]
fn quiet_personal_repos_are_polled_every_fifteen_minutes() {
    let api = github();
    let (_, mut cache, cfg) = first_cycle(&api);
    assert!(
        api.endpoints()
            .iter()
            .any(|c| c.contains("old-thing/events")),
        "polled once at first"
    );
    api.take();
    run_cycle(&api, &cfg, &mut cache, NOW + 61);
    let calls = api.take();
    assert!(
        !calls.iter().any(|(e, _)| e.contains("old-thing")),
        "quiet repo waits"
    );
    assert!(
        calls.iter().any(|(e, _)| e.contains("notes/events")),
        "active repo every cycle"
    );
    run_cycle(&api, &cfg, &mut cache, NOW + 16 * 60);
    let calls = api.take();
    assert!(calls.iter().any(|(e, _)| e.contains("old-thing/events")));
    assert!(
        calls
            .iter()
            .any(|(e, _)| e.contains("koneksi-s3-gateway/events")),
        "a gone repo is retried too"
    );
}

#[test]
fn the_personal_list_is_refreshed_about_once_an_hour() {
    let api = github();
    let (_, mut cache, cfg) = first_cycle(&api);
    api.take();
    let out = run_cycle(&api, &cfg, &mut cache, NOW + 61);
    assert!(out.personal.is_none());
    assert!(!api.take().iter().any(|(e, _)| e.starts_with("user/repos")));
    let out = run_cycle(&api, &cfg, &mut cache, NOW + 3601);
    let calls = api.take();
    let list = calls
        .iter()
        .find(|(e, _)| e.starts_with("user/repos"))
        .unwrap();
    assert!(list.1.is_some(), "the refresh is conditional");
    assert_eq!(
        out.personal.unwrap().len(),
        2,
        "a 304 keeps the list and bumps the clock"
    );
}

#[test]
fn needs_you_comes_from_search_and_notifications_in_scope() {
    let api = github();
    let (out, _, _) = first_cycle(&api);
    let ids: Vec<&str> = out
        .response
        .needs_you
        .iter()
        .map(|i| i.id.as_str())
        .collect();
    assert!(
        ids.contains(&"review_requested:koneksi-tech/koneksi-web#7"),
        "{ids:?}"
    );
    assert!(
        ids.contains(&"pr_merged:koneksi-tech/koneksi-web#8"),
        "{ids:?}"
    );
    assert!(
        ids.contains(&"pr_closed:koneksi-tech/koneksi-web#9"),
        "{ids:?}"
    );
    assert!(
        ids.contains(&"comment:repos/koneksi-tech/koneksi-web/issues/comments/700"),
        "{ids:?}"
    );
    assert!(ids.iter().all(|id| !id.contains("caiden")), "{ids:?}");
    assert!(out.response.needs_you_ready);
    let comment = out
        .response
        .needs_you
        .iter()
        .find(|i| i.kind == "comment")
        .unwrap();
    assert_eq!(comment.actor, "alvin-reyes");
    assert!(!comment.actor_is_bot);
}

#[test]
fn needs_you_is_not_ready_until_every_source_has_answered() {
    let api = Fake::new(|endpoint, _| {
        if endpoint.starts_with("search/issues") {
            Ok(reply(500, "{}", ""))
        } else if endpoint.starts_with("user/repos") {
            Ok(reply(200, "[]", "\"p\""))
        } else {
            Ok(reply(200, "[]", "\"x\""))
        }
    });
    let (out, _, _) = {
        let mut cache = CacheFile::default();
        let cfg = config();
        let out = run_cycle(&api, &cfg, &mut cache, NOW);
        (out, cache, cfg)
    };
    assert!(
        !out.response.needs_you_ready,
        "a failed search is not an empty list"
    );
    assert!(out.response.errors.keys().any(|k| k.starts_with("search:")));
}

#[test]
fn a_signed_out_gh_shows_the_fix_not_an_error() {
    let api = Fake::new(|_, _| {
        Err("To get started with GitHub CLI, please run:  gh auth login".to_string())
    });
    let mut cache = CacheFile::default();
    let out = run_cycle(&api, &config(), &mut cache, NOW);
    let setup = out.response.setup.unwrap();
    assert_eq!(setup.state, "signed_out");
    assert!(setup.fix.contains("gh auth login"));
    assert!(!out.response.needs_you_ready);
}

#[test]
fn a_401_reply_is_also_signed_out() {
    let api = Fake::new(|_, _| Ok(reply(401, r#"{"message":"Bad credentials"}"#, "")));
    let mut cache = CacheFile::default();
    let out = run_cycle(&api, &config(), &mut cache, NOW);
    assert_eq!(out.response.setup.unwrap().state, "signed_out");
}

#[test]
fn a_token_without_the_repo_scope_shows_the_scope_fix() {
    let api = Fake::new(|_, _| {
        let mut r = reply(200, "[]", "\"x\"");
        r.scopes = Some(vec!["gist".into()]);
        Ok(r)
    });
    let mut cache = CacheFile::default();
    let out = run_cycle(&api, &config(), &mut cache, NOW);
    let setup = out.response.setup.unwrap();
    assert_eq!(setup.state, "scope");
    assert!(setup.fix.contains("gh auth refresh -s repo"));
}

#[test]
fn offline_with_nothing_cached_says_so() {
    let api = Fake::new(|_, _| Err("gh timed out".to_string()));
    let mut cache = CacheFile::default();
    let out = run_cycle(&api, &config(), &mut cache, NOW);
    assert_eq!(out.response.setup.unwrap().state, "offline");
}

#[test]
fn offline_with_a_cache_keeps_showing_the_last_data() {
    let api = github();
    let (first, mut cache, cfg) = first_cycle(&api);
    let down = Fake::new(|_, _| Err("gh timed out".to_string()));
    let out = run_cycle(&down, &cfg, &mut cache, NOW + 61);
    assert!(out.response.setup.is_none());
    assert_eq!(out.response.items, first.response.items);
}

#[test]
fn a_nearly_spent_rate_limit_stops_polling_until_reset() {
    let api = github();
    let (_, mut cache, cfg) = first_cycle(&api);
    cache.rate_remaining = Some(10);
    cache.rate_reset = Some(NOW + 600);
    api.take();
    let out = run_cycle(&api, &cfg, &mut cache, NOW + 61);
    assert!(api.take().is_empty(), "no calls while the limit is spent");
    assert!(out.response.rate_limited);
    assert!(
        !out.response.items.is_empty(),
        "the cached feed still shows"
    );
    // After the reset time polling resumes.
    let out = run_cycle(&api, &cfg, &mut cache, NOW + 700);
    assert!(!api.take().is_empty());
    assert!(!out.response.rate_limited);
}

#[test]
fn the_search_limit_is_not_mistaken_for_the_core_limit() {
    let api = Fake::new(|endpoint, _| {
        let mut r = reply(
            200,
            if endpoint.starts_with("search") {
                r#"{"items":[]}"#
            } else {
                "[]"
            },
            "\"x\"",
        );
        if endpoint.starts_with("search") {
            r.rate_remaining = Some(3);
            r.rate_resource = Some("search".into());
        }
        Ok(r)
    });
    let mut cache = CacheFile::default();
    let out = run_cycle(&api, &config(), &mut cache, NOW);
    assert_eq!(out.response.rate_remaining, Some(4900));
    api.take();
    run_cycle(&api, &config(), &mut cache, NOW + 61);
    assert!(
        !api.take().is_empty(),
        "a low search bucket does not stop polling"
    );
}

#[test]
fn a_low_rate_limit_polls_only_active_repos() {
    let api = github();
    let (_, mut cache, cfg) = first_cycle(&api);
    cache.rate_remaining = Some(100);
    cache.rate_reset = Some(NOW + 5000);
    api.take();
    run_cycle(&api, &cfg, &mut cache, NOW + 16 * 60);
    let calls = api.take();
    assert!(calls.iter().any(|(e, _)| e.contains("notes/events")));
    assert!(
        !calls.iter().any(|(e, _)| e.contains("old-thing")),
        "quiet repos wait"
    );
}

#[test]
fn a_403_with_no_calls_left_is_a_rate_limit_not_an_unreachable_repo() {
    let api = Fake::new(|endpoint, _| {
        if endpoint.starts_with("user/repos") {
            return Ok(reply(200, "[]", "\"p\""));
        }
        let mut r = reply(403, r#"{"message":"API rate limit exceeded"}"#, "");
        r.rate_remaining = Some(0);
        Ok(r)
    });
    let mut cache = CacheFile::default();
    let out = run_cycle(&api, &config(), &mut cache, NOW);
    assert!(out.response.rate_limited);
    assert!(out
        .response
        .repos
        .iter()
        .all(|r| r.reachable != Some(false)));
}

#[test]
fn repos_no_longer_watched_leave_the_cache_and_the_feed() {
    let api = github();
    let (_, mut cache, mut cfg) = first_cycle(&api);
    cfg.watched = vec!["koneksi-web".into()];
    let out = run_cycle(&api, &cfg, &mut cache, NOW + 61);
    assert!(out.cache_dirty);
    assert!(!cache
        .endpoints
        .contains_key("events:koneksi-tech/koneksi-desktop"));
    assert!(out
        .response
        .items
        .iter()
        .all(|i| i.repo != "koneksi-tech/koneksi-desktop"));
    assert_eq!(
        out.response
            .repos
            .iter()
            .filter(|r| r.source == "koneksi-tech")
            .count(),
        1
    );
}

#[test]
fn unsafe_repo_names_in_the_watch_list_are_never_polled() {
    let api = github();
    let mut cfg = config();
    cfg.watched = vec!["../../user".into(), "ok-repo".into(), "a b".into()];
    run_cycle(&api, &cfg, &mut CacheFile::default(), NOW);
    let calls = api.endpoints();
    assert!(calls
        .iter()
        .any(|c| c.contains("koneksi-tech/ok-repo/events")));
    assert!(!calls.iter().any(|c| c.contains("..") || c.contains("a b")));
}

#[test]
fn a_comment_is_looked_up_once_and_the_answer_is_kept() {
    let api = github();
    let (_, mut cache, cfg) = first_cycle(&api);
    assert!(cache
        .comments
        .contains_key("repos/koneksi-tech/koneksi-web/issues/comments/700"));
    api.take();
    // Make the notifications reply change so the thread list is re-read.
    run_cycle(&api, &cfg, &mut cache, NOW + 61);
    assert!(!api
        .take()
        .iter()
        .any(|(e, _)| e.contains("issues/comments")));
}

#[test]
fn push_commits_are_loaded_from_the_compare_endpoint() {
    let scope = Scope {
        org: DEFAULT_ORG.into(),
        watched: DEFAULT_WATCHED.iter().map(|s| s.to_string()).collect(),
        login: DEFAULT_LOGIN.into(),
    };
    let api = Fake::new(|endpoint, _| {
        assert!(endpoint.starts_with(&format!(
            "repos/koneksi-tech/koneksi-desktop/compare/{}...{}",
            "a".repeat(40),
            "b".repeat(40)
        )));
        Ok(reply(
            200,
            r#"{"total_commits":2,"commits":[
              {"sha":"1111111","html_url":"https://github.com/koneksi-tech/koneksi-desktop/commit/1111111","author":{"login":"alvin-reyes"},"commit":{"message":"first\n\nbody","author":{"name":"Alvin","date":"2026-10-14T01:00:00Z"}}},
              {"sha":"2222222","html_url":"https://evil.example/x","author":null,"commit":{"message":"second","author":{"name":"Someone","date":"2026-10-14T02:00:00Z"}}}]}"#,
            "",
        ))
    });
    let range = PushRange {
        before: "a".repeat(40),
        head: "b".repeat(40),
    };
    let pushed = push_commits(&api, &scope, "koneksi-tech/koneksi-desktop", &range).unwrap();
    assert_eq!(pushed.total, 2);
    assert_eq!(pushed.commits[0].message, "second", "newest first");
    assert_eq!(pushed.commits[0].author, "Someone");
    assert_eq!(pushed.commits[0].url, "", "off-github links are dropped");
    assert_eq!(pushed.commits[1].message, "first");
    assert_eq!(pushed.commits[1].at, "2026-10-14T01:00:00Z");
}

#[test]
fn a_first_push_loads_one_commit_and_bad_input_is_refused() {
    let scope = Scope {
        org: DEFAULT_ORG.into(),
        watched: vec!["koneksi-web".into()],
        login: DEFAULT_LOGIN.into(),
    };
    let api = Fake::new(|endpoint, _| {
        assert_eq!(
            endpoint,
            format!("repos/koneksi-tech/koneksi-web/commits/{}", "c".repeat(40))
        );
        Ok(reply(
            200,
            r#"{"sha":"cccccccc","commit":{"message":"init","author":{"name":"A","date":"2026-10-14T01:00:00Z"}}}"#,
            "",
        ))
    });
    let first = PushRange {
        before: "0".repeat(40),
        head: "c".repeat(40),
    };
    assert_eq!(
        push_commits(&api, &scope, "koneksi-tech/koneksi-web", &first)
            .unwrap()
            .commits
            .len(),
        1
    );
    let never = Fake::new(|_, _| panic!("must not call gh"));
    let good = PushRange {
        before: "a".repeat(40),
        head: "b".repeat(40),
    };
    assert!(push_commits(&never, &scope, "caiden-tech/app", &good).is_err());
    assert!(push_commits(&never, &scope, "koneksi-tech/koneksi-docs", &good).is_err());
    let flag = PushRange {
        before: "--hostname".into(),
        head: "b".repeat(40),
    };
    assert!(push_commits(&never, &scope, "koneksi-tech/koneksi-web", &flag).is_err());
    let path = PushRange {
        before: "a".repeat(40),
        head: "b/../c".into(),
    };
    assert!(push_commits(&never, &scope, "koneksi-tech/koneksi-web", &path).is_err());
}

#[test]
fn a_rewritten_branch_gives_a_readable_error() {
    let scope = Scope {
        org: DEFAULT_ORG.into(),
        watched: vec!["koneksi-web".into()],
        login: DEFAULT_LOGIN.into(),
    };
    let api = Fake::new(|_, _| Ok(reply(404, "{}", "")));
    let range = PushRange {
        before: "a".repeat(40),
        head: "b".repeat(40),
    };
    let err = push_commits(&api, &scope, "koneksi-tech/koneksi-web", &range).unwrap_err();
    assert!(err.contains("no longer available"));
}

#[test]
fn parallel_work_keeps_order_and_is_bounded() {
    let live = AtomicUsize::new(0);
    let peak = AtomicUsize::new(0);
    let out = run_parallel((0..20).collect::<Vec<_>>(), 4, |n| {
        let now = live.fetch_add(1, Ordering::SeqCst) + 1;
        peak.fetch_max(now, Ordering::SeqCst);
        std::thread::sleep(std::time::Duration::from_millis(5));
        live.fetch_sub(1, Ordering::SeqCst);
        n * 2
    });
    assert_eq!(out, (0..20).map(|n| n * 2).collect::<Vec<_>>());
    assert!(peak.load(Ordering::SeqCst) <= 4);
    assert!(run_parallel(Vec::<u8>::new(), 4, |n| n).is_empty());
}

#[test]
fn a_second_caller_waits_for_the_cycle_in_flight_and_shares_its_result() {
    let sync = GithubSync::new();
    let polls = AtomicUsize::new(0);
    let started = std::sync::Barrier::new(2);
    std::thread::scope(|scope| {
        let first = scope.spawn(|| {
            sync.run(|| {
                polls.fetch_add(1, Ordering::SeqCst);
                started.wait();
                std::thread::sleep(std::time::Duration::from_millis(150));
                Ok(FeedResponse {
                    fetched_at: 1,
                    ..Default::default()
                })
            })
        });
        started.wait();
        // The first cycle is running now; this caller asks while it flies.
        let second = sync.run(|| {
            polls.fetch_add(1, Ordering::SeqCst);
            Ok(FeedResponse {
                fetched_at: 2,
                ..Default::default()
            })
        });
        assert_eq!(first.join().unwrap().unwrap().fetched_at, 1);
        assert_eq!(second.unwrap().fetched_at, 1, "same result, no second poll");
    });
    assert_eq!(polls.load(Ordering::SeqCst), 1);
    // A later caller starts its own cycle.
    let later = sync.run(|| {
        Ok(FeedResponse {
            fetched_at: 3,
            ..Default::default()
        })
    });
    assert_eq!(later.unwrap().fetched_at, 3);
}

fn row<'a>(out: &'a CycleOutcome, id: &str) -> &'a FeedItem {
    out.response
        .items
        .iter()
        .find(|i| i.id == id)
        .unwrap_or_else(|| panic!("no row {id}"))
}

#[test]
fn trimmed_pr_events_get_a_title_a_link_and_an_author_from_a_cached_lookup() {
    let api = github();
    let (out, mut cache, cfg) = first_cycle(&api);
    let opened = row(&out, "1000");
    assert_eq!(opened.title, "PR 41 title");
    assert_eq!(opened.pr_author.as_deref(), Some("alvin-reyes"));
    assert_eq!(
        opened.url,
        "https://github.com/koneksi-tech/koneksi-desktop/pull/41"
    );
    // Reviews and review comments are filled the same way.
    assert_eq!(row(&out, "1040").title, "PR 49 title");
    assert_eq!(row(&out, "1042").pr_author.as_deref(), Some("alvin-reyes"));
    // Issue comments already carry their own title.
    assert_eq!(row(&out, "1043").title, "Plain");
    // The author is me: the row involves me although I did nothing.
    assert!(row(&out, "1021").involves_me);
    assert!(!row(&out, "1000").involves_me);
    // A trimmed "closed" event is a merge when the PR says so.
    assert_eq!(row(&out, "1002").kind, "pr_merged");
    assert_eq!(row(&out, "1003").kind, "pr_closed");
    // A PR that cannot be read still gets a plain title and a link.
    let gone = row(&out, "1022");
    assert_eq!(gone.title, "Pull request #46");
    assert!(gone.url.ends_with("/pull/46"));

    // Looked up once: the next cycle asks nothing, and nothing is written.
    api.take();
    let again = run_cycle(&api, &cfg, &mut cache, NOW + 61);
    assert!(!api.take().iter().any(|(e, _)| e.contains("/pulls/")));
    assert!(!again.cache_dirty);
    assert_eq!(row(&again, "1000").title, "PR 41 title");
}

#[test]
fn pr_lookups_are_capped_per_cycle_and_the_rest_follow() {
    let events: Vec<String> = (1..=40)
        .map(|n| {
            format!(
                r#"{{"id":"{n}","type":"PullRequestEvent","actor":{{"login":"a"}},"repo":{{"name":"koneksi-tech/koneksi-web"}},
                "created_at":"2026-10-14T{:02}:{:02}:00Z","payload":{{"action":"opened","number":{n},"pull_request":{{"number":{n}}}}}}}"#,
                n / 60,
                n % 60
            )
        })
        .collect();
    let body = format!("[{}]", events.join(","));
    let api = Fake::new(move |endpoint, _| {
        if endpoint.contains("koneksi-web/events") {
            Ok(reply(200, &body, "\"e\""))
        } else if endpoint.contains("/pulls/") {
            let n: u32 = endpoint.rsplit('/').next().unwrap().parse().unwrap();
            Ok(reply(
                200,
                &format!(r#"{{"title":"T{n}","user":{{"login":"x"}}}}"#),
                "\"p\"",
            ))
        } else if endpoint.starts_with("user/repos") {
            Ok(reply(200, "[]", "\"u\""))
        } else if endpoint.starts_with("search") {
            Ok(reply(200, r#"{"items":[]}"#, "\"s\""))
        } else {
            Ok(reply(200, "[]", "\"x\""))
        }
    });
    let mut cache = CacheFile::default();
    let cfg = config();
    run_cycle(&api, &cfg, &mut cache, NOW);
    let first = api
        .take()
        .iter()
        .filter(|(e, _)| e.contains("/pulls/"))
        .count();
    assert_eq!(first, 25);
    let out = run_cycle(&api, &cfg, &mut cache, NOW + 61);
    let second = api
        .take()
        .iter()
        .filter(|(e, _)| e.contains("/pulls/"))
        .count();
    assert_eq!(second, 15, "the rest follow on the next cycle");
    assert!(out.response.items.iter().all(|i| i.title.starts_with('T')));
}

#[test]
fn a_pr_is_rechecked_with_its_etag_after_a_while() {
    let api = github();
    let (_, mut cache, cfg) = first_cycle(&api);
    api.take();
    run_cycle(&api, &cfg, &mut cache, NOW + 7 * 60 * 60);
    let pulls: Vec<_> = api
        .take()
        .into_iter()
        .filter(|(e, _)| e.contains("/pulls/"))
        .collect();
    assert!(!pulls.is_empty());
    assert!(pulls
        .iter()
        .filter(|(e, _)| !e.ends_with("/46"))
        .all(|(_, etag)| etag.is_some()));
}
