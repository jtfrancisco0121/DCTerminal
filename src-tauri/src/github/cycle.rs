//! One poll of GitHub: every due endpoint, with ETags, bounded parallelism
//! and a rate-limit guard. Nothing here holds a lock while `gh` runs: the
//! cycle works on a copy of the cache and the caller commits the result.

use super::normalize::{normalize_events, parse_time};
use super::runner::{is_signed_out_message, GhApi, GhResponse};
use super::search::{
    build_queries, comment_item, normalize_notifications, normalize_search, parse_comment,
    SearchKind, SearchQuery,
};
use super::{
    valid_name, FeedItem, FeedResponse, PersonalRepo, PushRange, RepoStatus, Scope, Setup,
    SOURCE_ORG, SOURCE_PERSONAL,
};
use crate::store::github_store::{CacheFile, EndpointCache};
use serde::Serialize;
use std::collections::{BTreeMap, HashSet, VecDeque};
use std::sync::Mutex;
use std::time::Instant;

/// `gh` calls in flight at once.
const PARALLEL: usize = 4;
const DAY: i64 = 24 * 60 * 60;
/// Personal repos pushed within this many days are polled every cycle.
const ACTIVE_DAYS: i64 = 30;
/// The rest are polled this often (seconds). So are repos that were gone.
const QUIET_EVERY: i64 = 15 * 60;
const PERSONAL_REFRESH: i64 = 60 * 60;
/// GitHub allows 30 searches a minute; this runs each at most about once.
const SEARCH_EVERY: i64 = 55;
/// A cycle a few seconds early is not skipped for X-Poll-Interval.
const POLL_SLACK: i64 = 5;
const CLOSED_LOOKBACK_DAYS: i64 = 3;
/// Below this many calls left, quiet repos wait.
const LOW_RATE: u32 = 200;
/// Below this, nothing is polled until the limit resets.
const CRITICAL_RATE: u32 = 40;
const MAX_COMMENT_LOOKUPS: usize = 10;
const MAX_FEED_ITEMS: usize = 600;
const MAX_NEEDS_YOU: usize = 40;
const DEFAULT_POLL: u64 = 60;

pub struct CycleConfig {
    pub login: String,
    pub org: String,
    pub watched: Vec<String>,
    pub personal: Vec<PersonalRepo>,
    /// Unix seconds of the last `user/repos` refresh.
    pub personal_refreshed_at: i64,
}

pub struct CycleOutcome {
    pub response: FeedResponse,
    /// True when a 200 changed the cache, so the caller should write it.
    pub cache_dirty: bool,
    /// The refreshed personal repo list, when this cycle fetched one.
    pub personal: Option<Vec<PersonalRepo>>,
}

enum Job {
    Events { repo: String, source: &'static str },
    Notifications,
    Search(SearchKind),
}

struct Task {
    key: String,
    endpoint: String,
    job: Job,
}

#[derive(Default)]
struct Run {
    dirty: bool,
    auth_failed: bool,
    rate_limited: bool,
    offline: Option<String>,
    rate: Option<(u32, Option<i64>)>,
}

/// Runs `work` over `items` on up to `workers` threads, results in order.
pub(crate) fn run_parallel<T: Send, R: Send>(
    items: Vec<T>,
    workers: usize,
    work: impl Fn(T) -> R + Sync,
) -> Vec<R> {
    let count = items.len();
    let queue: Mutex<VecDeque<(usize, T)>> = Mutex::new(items.into_iter().enumerate().collect());
    let done: Mutex<Vec<(usize, R)>> = Mutex::new(Vec::with_capacity(count));
    std::thread::scope(|scope| {
        for _ in 0..workers.min(count).max(1) {
            scope.spawn(|| loop {
                let next = queue.lock().map(|mut q| q.pop_front()).unwrap_or(None);
                let Some((index, item)) = next else { break };
                let result = work(item);
                if let Ok(mut done) = done.lock() {
                    done.push((index, result));
                }
            });
        }
    });
    let mut done = done.into_inner().unwrap_or_default();
    done.sort_by_key(|(index, _)| *index);
    done.into_iter().map(|(_, result)| result).collect()
}

fn date_of(unix: i64) -> String {
    chrono::DateTime::from_timestamp(unix, 0)
        .unwrap_or_default()
        .format("%Y-%m-%d")
        .to_string()
}

fn events_key(owner: &str, name: &str) -> String {
    format!("events:{owner}/{name}")
}

fn etag_for<'a>(cache: &'a CacheFile, key: &str) -> Option<&'a str> {
    cache
        .endpoints
        .get(key)
        .filter(|entry| entry.is_ok())
        .and_then(|entry| entry.etag.as_deref())
}

/// Is `entry` due, given the least time between polls?
fn due(entry: Option<&EndpointCache>, now: i64, every: i64) -> bool {
    let Some(entry) = entry else { return true };
    let asked = (entry.poll_interval as i64 - POLL_SLACK).max(0);
    let wait = if entry.state == "unreachable" {
        every.max(asked).max(QUIET_EVERY)
    } else {
        every.max(asked)
    };
    now - entry.polled_at >= wait
}

fn parse_personal(body: &str, login: &str) -> Result<Vec<PersonalRepo>, String> {
    let repos: serde_json::Value =
        serde_json::from_str(body).map_err(|_| "unreadable repo list".to_string())?;
    let repos = repos.as_array().ok_or("unexpected repo list")?;
    let mut out: Vec<PersonalRepo> = repos
        .iter()
        .filter_map(|repo| {
            let name = repo["name"].as_str()?;
            let owner = repo["owner"]["login"].as_str()?;
            if !owner.eq_ignore_ascii_case(login) || !valid_name(name) {
                return None;
            }
            let pushed_at = repo["pushed_at"]
                .as_str()
                .and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok())
                .map_or(0, |t| t.timestamp());
            Some(PersonalRepo {
                name: name.to_string(),
                pushed_at,
            })
        })
        .collect();
    out.sort_by(|a, b| b.pushed_at.cmp(&a.pushed_at).then(a.name.cmp(&b.name)));
    Ok(out)
}

fn note_headers(cache: &mut CacheFile, run: &mut Run, response: &GhResponse) {
    if let Some(scopes) = &response.scopes {
        if cache.scopes.as_ref() != Some(scopes) {
            cache.scopes = Some(scopes.clone());
            run.dirty = true;
        }
    }
    // Search has its own, much smaller limit; only the core one is guarded.
    let core = response
        .rate_resource
        .as_deref()
        .is_none_or(|r| r == "core");
    if let Some(remaining) = response.rate_remaining.filter(|_| core) {
        if run.rate.is_none_or(|(low, _)| remaining < low) {
            run.rate = Some((remaining, response.rate_reset));
        }
    }
}

fn is_rate_limited(response: &GhResponse) -> bool {
    response.status == 429 || (response.status == 403 && response.rate_remaining == Some(0))
}

fn note_failure(run: &mut Run, message: &str) {
    if is_signed_out_message(message) {
        run.auth_failed = true;
    } else {
        run.offline.get_or_insert_with(|| message.to_string());
    }
}

/// Fetches `user/repos` (a few pages at most). `Ok(None)` means 304.
fn fetch_personal(
    api: &dyn GhApi,
    cache: &mut CacheFile,
    run: &mut Run,
    login: &str,
    have_list: bool,
    now: i64,
) -> Result<Option<Vec<PersonalRepo>>, String> {
    const KEY: &str = "personal-repos";
    let first = "user/repos?affiliation=owner&per_page=100";
    let etag = if have_list {
        etag_for(cache, KEY).map(str::to_string)
    } else {
        None
    };
    let response = api
        .get(first, etag.as_deref())
        .inspect_err(|e| note_failure(run, e))?;
    note_headers(cache, run, &response);
    let entry = cache.endpoints.entry(KEY.to_string()).or_default();
    match response.status {
        304 => {
            entry.polled_at = now;
            Ok(None)
        }
        200 => {
            let mut repos = parse_personal(&response.body, login)?;
            let mut page_len = serde_json::from_str::<Vec<serde_json::Value>>(&response.body)
                .map_or(0, |v| v.len());
            let mut page = 2;
            while page_len >= 100 && page <= 5 {
                let next = api.get(&format!("{first}&page={page}"), None)?;
                if next.status != 200 {
                    break;
                }
                page_len = serde_json::from_str::<Vec<serde_json::Value>>(&next.body)
                    .map_or(0, |v| v.len());
                repos.extend(parse_personal(&next.body, login)?);
                page += 1;
            }
            let entry = cache.endpoints.entry(KEY.to_string()).or_default();
            entry.etag = response.etag;
            entry.polled_at = now;
            entry.state = "ok".into();
            run.dirty = true;
            Ok(Some(repos))
        }
        401 => {
            run.auth_failed = true;
            Err("HTTP 401".to_string())
        }
        _ if is_rate_limited(&response) => {
            run.rate_limited = true;
            Err("rate limited".to_string())
        }
        _ => Err(response.status_line()),
    }
}

fn fail_entry(entry: &mut EndpointCache, now: i64, message: String, clear: bool) {
    entry.state = "error".into();
    entry.error = Some(message);
    entry.polled_at = now;
    if clear {
        entry.etag = None;
    }
}

/// Folds one reply into the cache.
fn apply(
    task: &Task,
    result: Result<GhResponse, String>,
    cache: &mut CacheFile,
    scope: &Scope,
    now: i64,
    run: &mut Run,
) {
    let response = match result {
        Ok(response) => response,
        Err(message) => {
            note_failure(run, &message);
            let entry = cache.endpoints.entry(task.key.clone()).or_default();
            fail_entry(entry, now, message, false);
            return;
        }
    };
    note_headers(cache, run, &response);
    if is_rate_limited(&response) {
        run.rate_limited = true;
        cache.endpoints.entry(task.key.clone()).or_default().error = Some("rate limited".into());
        return;
    }
    let entry = cache.endpoints.entry(task.key.clone()).or_default();
    if let Some(interval) = response.poll_interval {
        entry.poll_interval = interval;
    }
    match response.status {
        304 => {
            entry.polled_at = now;
        }
        200 => {
            let parsed = match &task.job {
                Job::Events { repo, source } => {
                    normalize_events(&response.body, repo, source, &scope.login)
                        .map(|n| (n.items, Vec::new(), n.oldest))
                }
                Job::Notifications => normalize_notifications(&response.body, scope)
                    .map(|threads| (Vec::new(), threads, None)),
                Job::Search(kind) => normalize_search(&response.body, *kind, scope)
                    .map(|items| (items, Vec::new(), None)),
            };
            match parsed {
                Ok((items, threads, oldest)) => {
                    entry.etag = response.etag;
                    entry.polled_at = now;
                    entry.state = "ok".into();
                    entry.error = None;
                    entry.items = items;
                    entry.threads = threads;
                    entry.oldest = oldest;
                    run.dirty = true;
                }
                Err(message) => fail_entry(entry, now, message, true),
            }
        }
        401 => {
            run.auth_failed = true;
            fail_entry(entry, now, "not signed in".into(), true);
        }
        // A repo that was removed, renamed or is no longer accessible: only
        // this repo is marked, the rest of the feed carries on.
        403 | 404 | 410 | 451 if matches!(task.job, Job::Events { .. }) => {
            entry.state = "unreachable".into();
            entry.error = Some(match response.status {
                404 => "Not found, renamed or no longer accessible".to_string(),
                403 => "Access denied".to_string(),
                _ => response.status_line(),
            });
            entry.polled_at = now;
            entry.etag = None;
            entry.items.clear();
            entry.oldest = None;
            run.dirty = true;
        }
        _ => fail_entry(entry, now, response.status_line(), true),
    }
}

/// Looks up the author of the latest comment on each of the user's PR
/// threads, once per comment.
fn resolve_comments(api: &dyn GhApi, cache: &mut CacheFile, run: &mut Run) {
    let wanted: Vec<String> = cache
        .endpoints
        .get("notifications")
        .filter(|entry| entry.is_ok())
        .map(|entry| {
            entry
                .threads
                .iter()
                .filter(|t| !cache.comments.contains_key(&t.comment_path))
                .map(|t| t.comment_path.clone())
                .collect::<HashSet<_>>()
                .into_iter()
                .take(MAX_COMMENT_LOOKUPS)
                .collect()
        })
        .unwrap_or_default();
    let looked = run_parallel(wanted, PARALLEL, |path| {
        let reply = api.get(&path, None);
        (path, reply)
    });
    for (path, reply) in looked {
        match reply {
            Ok(response) => {
                note_headers(cache, run, &response);
                match response.status {
                    200 => {
                        if let Some(info) = parse_comment(&response.body) {
                            cache.comments.insert(path, info);
                            run.dirty = true;
                        }
                    }
                    // Gone: remember that, so it is not asked again.
                    404 | 410 => {
                        cache.comments.insert(path, Default::default());
                        run.dirty = true;
                    }
                    401 => run.auth_failed = true,
                    _ if is_rate_limited(&response) => run.rate_limited = true,
                    _ => {}
                }
            }
            Err(message) => note_failure(run, &message),
        }
    }
}

fn plan(
    cache: &CacheFile,
    scope: &Scope,
    personal: &[PersonalRepo],
    now: i64,
    rate_low: bool,
) -> Vec<Task> {
    let mut tasks = Vec::new();
    for name in &scope.watched {
        let key = events_key(&scope.org, name);
        if due(cache.endpoints.get(&key), now, 0) {
            tasks.push(Task {
                endpoint: format!("repos/{}/{name}/events?per_page=100", scope.org),
                job: Job::Events {
                    repo: format!("{}/{name}", scope.org),
                    source: SOURCE_ORG,
                },
                key,
            });
        }
    }
    for repo in personal {
        let active = repo.pushed_at == 0 || repo.pushed_at >= now - ACTIVE_DAYS * DAY;
        if rate_low && !active {
            continue;
        }
        let key = events_key(&scope.login, &repo.name);
        let every = if active { 0 } else { QUIET_EVERY };
        if due(cache.endpoints.get(&key), now, every) {
            tasks.push(Task {
                endpoint: format!("repos/{}/{}/events?per_page=100", scope.login, repo.name),
                job: Job::Events {
                    repo: format!("{}/{}", scope.login, repo.name),
                    source: SOURCE_PERSONAL,
                },
                key,
            });
        }
    }
    if due(cache.endpoints.get("notifications"), now, 0) {
        tasks.push(Task {
            key: "notifications".into(),
            endpoint: "notifications?per_page=100".into(),
            job: Job::Notifications,
        });
    }
    let since = date_of(now - CLOSED_LOOKBACK_DAYS * DAY);
    for SearchQuery {
        key,
        kind,
        endpoint,
        ..
    } in build_queries(scope, &since)
    {
        if due(cache.endpoints.get(&key), now, SEARCH_EVERY) {
            tasks.push(Task {
                key,
                endpoint,
                job: Job::Search(kind),
            });
        }
    }
    tasks
}

fn sorted_newest(items: &mut [FeedItem]) {
    items.sort_by(|a, b| b.at.cmp(&a.at).then(b.id.cmp(&a.id)));
}

/// One repo's reachability, from what the last polls found.
pub fn repo_status(cache: &CacheFile, owner: &str, name: &str, source: &str) -> RepoStatus {
    let entry = cache.endpoints.get(&events_key(owner, name));
    RepoStatus {
        repo: format!("{owner}/{name}"),
        source: source.to_string(),
        reachable: entry.and_then(|e| match e.state.as_str() {
            "ok" => Some(true),
            "unreachable" => Some(false),
            _ => None,
        }),
        error: entry
            .filter(|e| e.state != "ok")
            .and_then(|e| e.error.clone()),
        oldest: entry.and_then(|e| e.oldest.clone()),
    }
}

fn build_response(
    cache: &CacheFile,
    scope: &Scope,
    personal: &[PersonalRepo],
    run: &Run,
    now: i64,
) -> FeedResponse {
    let mut repos = Vec::new();
    let mut items: Vec<FeedItem> = Vec::new();
    let mut seen_ids = HashSet::new();
    let watched = scope
        .watched
        .iter()
        .map(|n| (scope.org.as_str(), n.as_str(), SOURCE_ORG));
    let owned = personal
        .iter()
        .map(|r| (scope.login.as_str(), r.name.as_str(), SOURCE_PERSONAL));
    for (owner, name, source) in watched.chain(owned) {
        repos.push(repo_status(cache, owner, name, source));
        let entry = cache.endpoints.get(&events_key(owner, name));
        if let Some(entry) = entry.filter(|e| e.has_data()) {
            for item in &entry.items {
                if scope.source_of(&item.repo).is_some() && seen_ids.insert(item.id.clone()) {
                    items.push(item.clone());
                }
            }
        }
    }
    sorted_newest(&mut items);
    items.truncate(MAX_FEED_ITEMS);

    let queries = build_queries(scope, "1970-01-01");
    let mut needs: Vec<FeedItem> = Vec::new();
    let mut ids = HashSet::new();
    let mut ready = true;
    for query in &queries {
        let entry = cache.endpoints.get(&query.key);
        ready &= entry.is_some_and(|e| e.is_ok());
        if let Some(entry) = entry.filter(|e| e.has_data()) {
            for item in &entry.items {
                if scope.source_of(&item.repo).is_some() && ids.insert(item.id.clone()) {
                    needs.push(item.clone());
                }
            }
        }
    }
    let notifications = cache.endpoints.get("notifications");
    ready &= notifications.is_some_and(|e| e.is_ok());
    if let Some(entry) = notifications.filter(|e| e.has_data()) {
        for thread in &entry.threads {
            match cache.comments.get(&thread.comment_path) {
                Some(info) => {
                    if let Some(item) = comment_item(thread, info, scope) {
                        if ids.insert(item.id.clone()) {
                            needs.push(item);
                        }
                    }
                }
                None => ready = false,
            }
        }
    }
    sorted_newest(&mut needs);
    needs.truncate(MAX_NEEDS_YOU);

    let mut errors = BTreeMap::new();
    for (key, entry) in &cache.endpoints {
        if entry.state != "ok" && !entry.state.is_empty() {
            if let Some(error) = &entry.error {
                errors.insert(key.clone(), error.clone());
            }
        }
    }
    let any_ok = cache.endpoints.values().any(|e| e.is_ok());
    let setup = if run.auth_failed {
        Some(Setup::signed_out())
    } else if cache
        .scopes
        .as_ref()
        .is_some_and(|s| !s.iter().any(|scope| scope == "repo"))
    {
        Some(Setup::scope())
    } else if !any_ok && run.offline.is_some() {
        Some(Setup::offline(
            run.offline.as_deref().unwrap_or("no answer"),
        ))
    } else {
        None
    };
    let poll_interval = cache
        .endpoints
        .values()
        .map(|e| e.poll_interval)
        .max()
        .unwrap_or(0)
        .max(DEFAULT_POLL);
    FeedResponse {
        items,
        needs_you: needs,
        needs_you_ready: ready && setup.is_none(),
        repos,
        poll_interval,
        rate_remaining: cache.rate_remaining,
        rate_limited: run.rate_limited,
        setup,
        fetched_at: now,
        errors,
    }
}

/// Polls everything that is due and returns the feed built from the cache.
pub fn run_cycle(
    api: &dyn GhApi,
    cfg: &CycleConfig,
    cache: &mut CacheFile,
    now: i64,
) -> CycleOutcome {
    let watched: Vec<String> = cfg
        .watched
        .iter()
        .filter(|n| valid_name(n))
        .cloned()
        .collect();
    let scope = Scope {
        org: cfg.org.clone(),
        watched,
        login: cfg.login.clone(),
    };
    let mut run = Run::default();
    let mut personal = cfg.personal.clone();
    let mut refreshed = None;

    // Stay under the limit: do nothing while it is nearly spent.
    let spent = cache
        .rate_remaining
        .is_some_and(|left| left < CRITICAL_RATE)
        && cache.rate_reset.is_none_or(|reset| reset > now);
    let rate_low = cache.rate_remaining.is_some_and(|left| left < LOW_RATE)
        && cache.rate_reset.is_none_or(|reset| reset > now);
    if spent {
        run.rate_limited = true;
    } else {
        run.rate = None;
        if personal.is_empty() || now - cfg.personal_refreshed_at >= PERSONAL_REFRESH {
            match fetch_personal(api, cache, &mut run, &cfg.login, !personal.is_empty(), now) {
                Ok(Some(list)) => {
                    personal = list.clone();
                    refreshed = Some(list);
                }
                Ok(None) => refreshed = Some(personal.clone()),
                Err(message) => {
                    let entry = cache.endpoints.entry("personal-repos".into()).or_default();
                    fail_entry(entry, now, message, true);
                }
            }
        }
        let tasks = plan(cache, &scope, &personal, now, rate_low);
        let results = {
            let shared: &CacheFile = cache;
            run_parallel(tasks, PARALLEL, |task| {
                let reply = api.get(&task.endpoint, etag_for(shared, &task.key));
                (task, reply)
            })
        };
        for (task, reply) in results {
            apply(&task, reply, cache, &scope, now, &mut run);
        }
        if !run.rate_limited && !run.auth_failed {
            resolve_comments(api, cache, &mut run);
        }
        if let Some((left, reset)) = run.rate {
            cache.rate_remaining = Some(left);
            cache.rate_reset = reset;
        }
        if run.rate_limited {
            cache.rate_remaining = Some(0);
        }
    }

    // Forget what is no longer watched, so a removed repo's items go away.
    let keep: HashSet<String> = scope
        .watched
        .iter()
        .map(|n| events_key(&scope.org, n))
        .chain(personal.iter().map(|r| events_key(&scope.login, &r.name)))
        .collect();
    let before = cache.endpoints.len();
    cache
        .endpoints
        .retain(|key, _| !key.starts_with("events:") || keep.contains(key));
    if cache.endpoints.len() != before {
        run.dirty = true;
    }
    let live: HashSet<String> = cache
        .endpoints
        .get("notifications")
        .map(|e| e.threads.iter().map(|t| t.comment_path.clone()).collect())
        .unwrap_or_default();
    let comments_before = cache.comments.len();
    cache.comments.retain(|path, _| live.contains(path));
    if cache.comments.len() != comments_before {
        run.dirty = true;
    }

    CycleOutcome {
        response: build_response(cache, &scope, &personal, &run, now),
        cache_dirty: run.dirty,
        personal: refreshed,
    }
}

/// Serializes cycles: a second caller waits for the one in flight and gets
/// its result instead of polling again.
pub struct GithubSync {
    flight: Mutex<()>,
    last: Mutex<Option<(Instant, FeedResponse)>>,
}

impl Default for GithubSync {
    fn default() -> Self {
        Self::new()
    }
}

impl GithubSync {
    pub fn new() -> Self {
        Self {
            flight: Mutex::new(()),
            last: Mutex::new(None),
        }
    }

    pub fn run(
        &self,
        poll: impl FnOnce() -> Result<FeedResponse, String>,
    ) -> Result<FeedResponse, String> {
        let asked = Instant::now();
        let _flight = self.flight.lock().map_err(|e| e.to_string())?;
        if let Some((finished, response)) = self.last.lock().map_err(|e| e.to_string())?.as_ref() {
            if *finished >= asked {
                return Ok(response.clone());
            }
        }
        let response = poll()?;
        *self.last.lock().map_err(|e| e.to_string())? = Some((Instant::now(), response.clone()));
        Ok(response)
    }
}

/// One commit of a push, for the expanded row.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PushCommit {
    pub sha: String,
    pub message: String,
    pub author: String,
    pub url: String,
    pub at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PushCommits {
    pub commits: Vec<PushCommit>,
    /// Commits in the push, which can be more than are listed.
    pub total: u64,
}

fn is_sha(text: &str) -> bool {
    (7..=40).contains(&text.len()) && text.chars().all(|c| c.is_ascii_hexdigit())
}

/// Loads the commits of one push when its row is expanded.
pub fn push_commits(
    api: &dyn GhApi,
    scope: &Scope,
    repo: &str,
    range: &PushRange,
) -> Result<PushCommits, String> {
    if scope.source_of(repo).is_none() {
        return Err("That repository is not being monitored.".into());
    }
    let (owner, name) = repo.split_once('/').ok_or("invalid repository")?;
    if !valid_name(owner) || !valid_name(name) || !is_sha(&range.head) {
        return Err("invalid push".into());
    }
    let first_push = range.before.is_empty() || range.before.chars().all(|c| c == '0');
    if !first_push && !is_sha(&range.before) {
        return Err("invalid push".into());
    }
    let endpoint = if first_push {
        format!("repos/{repo}/commits/{}", range.head)
    } else {
        format!(
            "repos/{repo}/compare/{}...{}?per_page=100",
            range.before, range.head
        )
    };
    let response = api.get(&endpoint, None)?;
    match response.status {
        200 => {}
        404 | 422 => {
            return Err(
                "Those commits are no longer available (the branch was rewritten or removed)."
                    .into(),
            )
        }
        _ => return Err(response.status_line()),
    }
    let body: serde_json::Value =
        serde_json::from_str(&response.body).map_err(|_| "unreadable commits".to_string())?;
    let (list, total) = if first_push {
        (vec![body.clone()], 1)
    } else {
        let list = body["commits"].as_array().cloned().unwrap_or_default();
        let total = body["total_commits"].as_u64().unwrap_or(list.len() as u64);
        (list, total)
    };
    let commits = list
        .iter()
        .rev()
        .take(50)
        .filter_map(|c| {
            let sha = c["sha"].as_str()?.to_string();
            let message = c["commit"]["message"].as_str().unwrap_or_default();
            Some(PushCommit {
                message: message
                    .lines()
                    .next()
                    .unwrap_or_default()
                    .chars()
                    .take(200)
                    .collect(),
                author: c["author"]["login"]
                    .as_str()
                    .or_else(|| c["commit"]["author"]["name"].as_str())
                    .unwrap_or_default()
                    .to_string(),
                url: super::normalize::safe_url(c["html_url"].as_str().unwrap_or_default()),
                at: parse_time(c["commit"]["author"]["date"].as_str().unwrap_or_default())
                    .unwrap_or_default(),
                sha,
            })
        })
        .collect();
    Ok(PushCommits { commits, total })
}

#[cfg(test)]
mod tests;
