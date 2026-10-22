//! The ClickUp read calls. Each one is a GET through a [`Transport`], with
//! the rules the GitHub poller follows: at most 4 calls in flight across the
//! app, the rate-limit headers honoured, a 429 backed off and retried, and
//! errors in plain English. Nothing here writes to ClickUp.
//!
//! ClickUp counts calls per token per minute. When a reply says none are
//! left, later calls wait for the reset instead of spending a 429 each; a
//! wait longer than [`MAX_WAIT_SECS`] is returned as an error instead, so a
//! command never hangs on it.

use super::transport::{NoReply, Reply, Transport, REQUEST_TIMEOUT};
use super::types::{Comment, Comments, List, Task, TaskPage, Team, Teams};
use super::{valid_id, ClickUpToken};
use serde::de::DeserializeOwned;
use std::fmt;
use std::sync::{Condvar, Mutex};
use std::time::Duration;

/// ClickUp calls in flight at once, app-wide (the GitHub poller's rule).
pub const MAX_IN_FLIGHT: usize = 4;
/// The longest a call waits for the rate limit before giving up.
const MAX_WAIT_SECS: u64 = 60;
/// A 429 is retried this many times.
const RETRIES_ON_429: u32 = 2;
/// The wait after a 429 that names no reset time.
const DEFAULT_429_WAIT: u64 = 10;
/// ClickUp's page size for `GET /list/{id}/task`.
const PAGE_SIZE: usize = 100;
/// The most pages read from one list (10,000 tasks).
const MAX_PAGES: u32 = 100;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClickUpError {
    NoToken,
    /// 401 or 403.
    Rejected,
    /// 404. Names what was asked for.
    NotFound(&'static str),
    BadId,
    /// Seconds until the limit resets, when known.
    RateLimited(u64),
    Server(u16),
    Unexpected(u16),
    Unreadable,
    NoReply(NoReply),
}

impl fmt::Display for ClickUpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NoToken => {
                f.write_str("No ClickUp token yet. Add one under Settings › Integrations.")
            }
            Self::Rejected => {
                f.write_str("ClickUp rejected the token. Check it under Settings › Integrations.")
            }
            Self::NotFound(what) => write!(
                f,
                "ClickUp has no {what} with that id, or your token cannot see it."
            ),
            Self::BadId => f.write_str("That is not a ClickUp id."),
            Self::RateLimited(secs) => write!(
                f,
                "ClickUp's rate limit is used up. Try again in {secs} seconds."
            ),
            Self::Server(status) => write!(
                f,
                "ClickUp is having trouble (HTTP {status}). Try again in a minute."
            ),
            Self::Unexpected(status) => write!(f, "ClickUp answered with HTTP {status}."),
            Self::Unreadable => f.write_str("ClickUp sent a reply DCTerminal could not read."),
            Self::NoReply(NoReply::Timeout) => write!(
                f,
                "ClickUp did not answer within {} seconds. Try again.",
                REQUEST_TIMEOUT.as_secs()
            ),
            Self::NoReply(NoReply::Offline) => {
                f.write_str("Could not reach ClickUp. Check your connection.")
            }
            Self::NoReply(NoReply::Failed) => {
                f.write_str("The connection to ClickUp failed. Try again.")
            }
        }
    }
}

impl From<ClickUpError> for String {
    fn from(err: ClickUpError) -> Self {
        err.to_string()
    }
}

/// Time, so tests can run the rate-limit waits without sleeping.
pub trait Clock: Sync {
    /// Unix seconds.
    fn now(&self) -> i64;
    fn sleep(&self, secs: u64);
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> i64 {
        chrono::Utc::now().timestamp()
    }

    fn sleep(&self, secs: u64) {
        std::thread::sleep(Duration::from_secs(secs));
    }
}

/// What the last reply said about the rate limit.
#[derive(Debug, Default)]
struct Window {
    remaining: Option<u32>,
    reset_at: Option<i64>,
}

/// Shared by every call: the in-flight cap and the rate-limit window.
pub struct Gate {
    in_flight: Mutex<usize>,
    freed: Condvar,
    window: Mutex<Window>,
}

impl Default for Gate {
    fn default() -> Self {
        Self::new()
    }
}

impl Gate {
    pub const fn new() -> Self {
        Self {
            in_flight: Mutex::new(0),
            freed: Condvar::new(),
            window: Mutex::new(Window {
                remaining: None,
                reset_at: None,
            }),
        }
    }

    /// The app's one gate.
    pub fn shared() -> &'static Gate {
        static GATE: Gate = Gate::new();
        &GATE
    }

    fn acquire(&self) -> Permit<'_> {
        let mut count = self.in_flight.lock().unwrap_or_else(|e| e.into_inner());
        while *count >= MAX_IN_FLIGHT {
            count = self.freed.wait(count).unwrap_or_else(|e| e.into_inner());
        }
        *count += 1;
        Permit(self)
    }

    /// Seconds to wait before the next call, when no calls are left.
    fn wait_needed(&self, now: i64) -> u64 {
        let mut window = self.window.lock().unwrap_or_else(|e| e.into_inner());
        match (window.remaining, window.reset_at) {
            (Some(0), Some(reset)) if reset > now => (reset - now) as u64,
            (Some(0), _) => {
                *window = Window::default();
                0
            }
            _ => 0,
        }
    }

    fn note(&self, reply: &Reply, now: i64, wait_429: Option<u64>) {
        let mut window = self.window.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(remaining) = reply.rate_remaining {
            window.remaining = Some(remaining);
            window.reset_at = reply.rate_reset;
        }
        if let Some(wait) = wait_429 {
            window.remaining = Some(0);
            window.reset_at = Some(now + wait as i64);
        }
    }
}

struct Permit<'a>(&'a Gate);

impl Drop for Permit<'_> {
    fn drop(&mut self) {
        let mut count = self.0.in_flight.lock().unwrap_or_else(|e| e.into_inner());
        *count = count.saturating_sub(1);
        self.0.freed.notify_one();
    }
}

/// How long a 429 asks us to wait: `Retry-After`, else the reset time, else
/// a short default.
fn wait_after_429(reply: &Reply, now: i64) -> u64 {
    reply
        .retry_after
        .or_else(|| reply.rate_reset.map(|reset| (reset - now).max(1) as u64))
        .unwrap_or(DEFAULT_429_WAIT)
}

/// ClickUp answers 401 for an id the token cannot see, not only for a bad
/// token: a missing or foreign task or list comes back as `OAUTH_027` ("Team
/// not authorized"), a bad token as `OAUTH_025` ("Token invalid"). Seen live on
/// 2026-10-22. Only the `ECODE` field is read, never the body's text.
fn not_visible(body: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("ECODE")
                .and_then(|code| code.as_str())
                .map(|code| code == "OAUTH_027")
        })
        .unwrap_or(false)
}

/// A task by ClickUp's own id (`86b1aa001`, the usual case), or by a custom
/// task id (`QA-128`), which the API only finds with the workspace id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TaskRef {
    Id(String),
    Custom { id: String, team_id: String },
}

impl TaskRef {
    fn id(&self) -> &str {
        match self {
            Self::Id(id) | Self::Custom { id, .. } => id,
        }
    }

    /// `custom_task_ids=true&team_id=…` for a custom id, else nothing.
    fn custom_query(&self) -> Option<String> {
        match self {
            Self::Id(_) => None,
            Self::Custom { team_id, .. } => Some(format!("custom_task_ids=true&team_id={team_id}")),
        }
    }

    fn valid(&self) -> bool {
        match self {
            Self::Id(id) => valid_id(id),
            Self::Custom { id, team_id } => valid_id(id) && valid_id(team_id),
        }
    }
}

/// One token's read access to ClickUp.
pub struct ClickUp<'a> {
    transport: &'a dyn Transport,
    token: &'a ClickUpToken,
    gate: &'a Gate,
    clock: &'a dyn Clock,
}

impl<'a> ClickUp<'a> {
    pub fn new(transport: &'a dyn Transport, token: &'a ClickUpToken) -> Self {
        Self::with(transport, token, Gate::shared(), &SystemClock)
    }

    pub fn with(
        transport: &'a dyn Transport,
        token: &'a ClickUpToken,
        gate: &'a Gate,
        clock: &'a dyn Clock,
    ) -> Self {
        Self {
            transport,
            token,
            gate,
            clock,
        }
    }

    /// GET `path` and read the JSON. `what` names the thing for a 404.
    fn get<T: DeserializeOwned>(&self, path: &str, what: &'static str) -> Result<T, ClickUpError> {
        let mut retries = 0;
        loop {
            let wait = self.gate.wait_needed(self.clock.now());
            if wait > MAX_WAIT_SECS {
                return Err(ClickUpError::RateLimited(wait));
            }
            if wait > 0 {
                self.clock.sleep(wait);
            }
            let reply = {
                let _permit = self.gate.acquire();
                self.transport.get(path, self.token)
            }
            .map_err(ClickUpError::NoReply)?;
            let now = self.clock.now();
            let wait_429 = (reply.status == 429).then(|| wait_after_429(&reply, now));
            self.gate.note(&reply, now, wait_429);
            return match reply.status {
                200..=299 => {
                    serde_json::from_str(&reply.body).map_err(|_| ClickUpError::Unreadable)
                }
                429 => {
                    let wait = wait_429.unwrap_or(DEFAULT_429_WAIT);
                    if retries < RETRIES_ON_429 && wait <= MAX_WAIT_SECS {
                        retries += 1;
                        // The gate now holds the reset, so the loop's wait sleeps it.
                        continue;
                    }
                    Err(ClickUpError::RateLimited(wait))
                }
                401 | 403 if not_visible(&reply.body) => Err(ClickUpError::NotFound(what)),
                401 | 403 => Err(ClickUpError::Rejected),
                404 => Err(ClickUpError::NotFound(what)),
                500..=599 => Err(ClickUpError::Server(reply.status)),
                status => Err(ClickUpError::Unexpected(status)),
            };
        }
    }

    /// The workspaces this token can see (`GET /team`).
    pub fn teams(&self) -> Result<Vec<Team>, ClickUpError> {
        Ok(self.get::<Teams>("/team", "workspace")?.teams)
    }

    /// One task with its subtasks, closed ones included, and its Markdown
    /// description.
    pub fn task(&self, task: &TaskRef) -> Result<Task, ClickUpError> {
        if !task.valid() {
            return Err(ClickUpError::BadId);
        }
        let mut path = format!(
            "/task/{}?include_subtasks=true&include_markdown_description=true",
            task.id()
        );
        if let Some(custom) = task.custom_query() {
            path.push('&');
            path.push_str(&custom);
        }
        self.get(&path, "task")
    }

    /// A task's comments, newest first (ClickUp sends the latest 25).
    pub fn comments(&self, task: &TaskRef) -> Result<Vec<Comment>, ClickUpError> {
        if !task.valid() {
            return Err(ClickUpError::BadId);
        }
        let mut path = format!("/task/{}/comment", task.id());
        if let Some(custom) = task.custom_query() {
            path.push('?');
            path.push_str(&custom);
        }
        Ok(self.get::<Comments>(&path, "task")?.comments)
    }

    /// One page (from 0) of a list's tasks, subtasks and closed tasks
    /// included. ClickUp leaves closed tasks out unless asked, and intake
    /// lists them as excluded, so the caller filters.
    pub fn list_tasks_page(&self, list_id: &str, page: u32) -> Result<TaskPage, ClickUpError> {
        if !valid_id(list_id) {
            return Err(ClickUpError::BadId);
        }
        self.get(
            &format!("/list/{list_id}/task?page={page}&subtasks=true&include_closed=true"),
            "list",
        )
    }

    /// Every task in a list, page by page.
    pub fn list_tasks(&self, list_id: &str) -> Result<Vec<Task>, ClickUpError> {
        let mut tasks = Vec::new();
        for page in 0..MAX_PAGES {
            let reply = self.list_tasks_page(list_id, page)?;
            let count = reply.tasks.len();
            tasks.extend(reply.tasks);
            let last = reply.last_page.unwrap_or(count < PAGE_SIZE);
            if last || count == 0 {
                break;
            }
        }
        Ok(tasks)
    }

    /// A list and its statuses.
    pub fn list(&self, list_id: &str) -> Result<List, ClickUpError> {
        if !valid_id(list_id) {
            return Err(ClickUpError::BadId);
        }
        self.get(&format!("/list/{list_id}"), "list")
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::collections::{HashMap, VecDeque};
    use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};

    pub(crate) fn fixture(name: &str) -> String {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../fixtures/clickup")
            .join(name);
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
    }

    pub(crate) fn ok(body: String) -> Result<Reply, NoReply> {
        Ok(Reply {
            status: 200,
            rate_remaining: Some(99),
            rate_reset: Some(1_790_000_060),
            body,
            ..Reply::default()
        })
    }

    pub(crate) fn status(status: u16) -> Result<Reply, NoReply> {
        Ok(Reply {
            status,
            body: "{\"err\":\"Token invalid\",\"ECODE\":\"OAUTH_025\"}".into(),
            ..Reply::default()
        })
    }

    /// Recorded replies by path, served in order; every request is logged
    /// with the `Authorization` value it carried.
    #[derive(Default)]
    pub(crate) struct Recorded {
        pub replies: Mutex<HashMap<String, VecDeque<Result<Reply, NoReply>>>>,
        pub calls: Mutex<Vec<(String, String)>>,
    }

    impl Recorded {
        pub(crate) fn on(self, path: &str, reply: Result<Reply, NoReply>) -> Self {
            self.replies
                .lock()
                .unwrap()
                .entry(path.to_string())
                .or_default()
                .push_back(reply);
            self
        }

        pub(crate) fn paths(&self) -> Vec<String> {
            self.calls
                .lock()
                .unwrap()
                .iter()
                .map(|(p, _)| p.clone())
                .collect()
        }
    }

    impl Transport for Recorded {
        fn get(&self, path: &str, token: &ClickUpToken) -> Result<Reply, NoReply> {
            self.calls
                .lock()
                .unwrap()
                .push((path.to_string(), token.expose().to_string()));
            self.replies
                .lock()
                .unwrap()
                .get_mut(path)
                .and_then(VecDeque::pop_front)
                .unwrap_or_else(|| panic!("no recorded reply for {path}"))
        }
    }

    /// A clock that only moves when slept.
    pub(crate) struct FakeClock {
        pub now: AtomicI64,
        pub slept: Mutex<Vec<u64>>,
    }

    impl FakeClock {
        pub(crate) fn at(now: i64) -> Self {
            Self {
                now: AtomicI64::new(now),
                slept: Mutex::new(Vec::new()),
            }
        }
    }

    impl Clock for FakeClock {
        fn now(&self) -> i64 {
            self.now.load(Ordering::SeqCst)
        }

        fn sleep(&self, secs: u64) {
            self.slept.lock().unwrap().push(secs);
            self.now.fetch_add(secs as i64, Ordering::SeqCst);
        }
    }

    const NOW: i64 = 1_790_000_000;

    fn token() -> ClickUpToken {
        ClickUpToken::parse("pk_test_TOKEN").unwrap()
    }

    #[test]
    fn reads_workspaces_and_sends_the_token_as_the_authorization_header() {
        let api = Recorded::default().on("/team", ok(fixture("teams.json")));
        let (gate, clock, token) = (Gate::new(), FakeClock::at(NOW), token());
        let teams = ClickUp::with(&api, &token, &gate, &clock).teams().unwrap();
        assert_eq!(
            teams,
            vec![
                Team {
                    id: "9012345678".into(),
                    name: "Koneksi QA".into()
                },
                Team {
                    id: "9087654321".into(),
                    name: "Sandbox".into()
                },
            ]
        );
        assert_eq!(
            *api.calls.lock().unwrap(),
            vec![("/team".to_string(), "pk_test_TOKEN".to_string())]
        );
    }

    #[test]
    fn reads_a_task_with_every_subtask_and_its_markdown_description() {
        let path = "/task/7xk2epic01?include_subtasks=true&include_markdown_description=true";
        let api = Recorded::default().on(path, ok(fixture("task-with-subtasks.json")));
        let (gate, clock, token) = (Gate::new(), FakeClock::at(NOW), token());
        let task = ClickUp::with(&api, &token, &gate, &clock)
            .task(&TaskRef::Id("7xk2epic01".into()))
            .unwrap();
        assert_eq!(task.id, "7xk2epic01");
        assert_eq!(task.custom_id, None);
        assert_eq!(task.status.status, "in progress");
        assert!(task.description().contains("**medium**"));
        // Closed subtasks come back too.
        assert_eq!(task.subtasks.len(), 3);
        let closed = &task.subtasks[2];
        assert!(closed.status.is_closed());
        assert_eq!(closed.priority, None);
        assert_eq!(task.subtasks[0].priority.as_ref().unwrap().priority, "high");
        assert_eq!(task.subtasks[0].tags[0].name, "desktop");
        assert_eq!(task.subtasks[0].parent.as_deref(), Some("7xk2epic01"));
        assert_eq!(task.subtasks[0].custom_id.as_deref(), Some("QA-129"));
        // No Markdown description: the plain text one.
        assert_eq!(
            task.subtasks[0].description(),
            "Upload of a large folder stops at 61% on Windows."
        );
        assert_eq!(task.list.id, "901800112233");
    }

    #[test]
    fn a_custom_task_id_is_looked_up_with_the_workspace() {
        let path = "/task/QA-129?include_subtasks=true&include_markdown_description=true&custom_task_ids=true&team_id=9012345678";
        let comments = "/task/QA-129/comment?custom_task_ids=true&team_id=9012345678";
        let api = Recorded::default()
            .on(
                path,
                ok(r#"{"id":"86b1aa001","custom_id":"QA-129","name":"Sync"}"#.into()),
            )
            .on(comments, ok(r#"{"comments":[]}"#.into()));
        let (gate, clock, token) = (Gate::new(), FakeClock::at(NOW), token());
        let client = ClickUp::with(&api, &token, &gate, &clock);
        let task = TaskRef::Custom {
            id: "QA-129".into(),
            team_id: "9012345678".into(),
        };
        assert_eq!(client.task(&task).unwrap().id, "86b1aa001");
        assert!(client.comments(&task).unwrap().is_empty());
    }

    #[test]
    fn reads_comments_and_list_statuses() {
        let api = Recorded::default()
            .on("/task/86b1aa001/comment", ok(fixture("comments.json")))
            .on("/list/901800112233", ok(fixture("list.json")));
        let (gate, clock, token) = (Gate::new(), FakeClock::at(NOW), token());
        let client = ClickUp::with(&api, &token, &gate, &clock);
        let comments = client.comments(&TaskRef::Id("86b1aa001".into())).unwrap();
        assert_eq!(comments.len(), 2);
        assert_eq!(comments[0].user.username, "Dana Reyes");
        assert_eq!(comments[0].user.id, "81234567");
        assert_eq!(comments[0].user.email, "dana@example.com");
        assert_eq!(comments[0].date, "1789950000000");
        assert!(comments[0].comment_text.contains("7,839 files"));
        let list = client.list("901800112233").unwrap();
        let names: Vec<&str> = list.statuses.iter().map(|s| s.status.as_str()).collect();
        assert_eq!(
            names,
            ["to do", "in progress", "qa failed", "canceled", "complete"]
        );
        let kinds: Vec<&str> = list.statuses.iter().map(|s| s.kind.as_str()).collect();
        assert_eq!(kinds, ["open", "custom", "custom", "done", "closed"]);
        assert!(list.statuses[3].is_closed() && list.statuses[4].is_closed());
    }

    #[test]
    fn pages_through_a_list_until_the_last_page() {
        let api = Recorded::default()
            .on(
                "/list/901800112233/task?page=0&subtasks=true&include_closed=true",
                ok(fixture("list-tasks-page0.json")),
            )
            .on(
                "/list/901800112233/task?page=1&subtasks=true&include_closed=true",
                ok(fixture("list-tasks-page1.json")),
            );
        let (gate, clock, token) = (Gate::new(), FakeClock::at(NOW), token());
        let tasks = ClickUp::with(&api, &token, &gate, &clock)
            .list_tasks("901800112233")
            .unwrap();
        let ids: Vec<&str> = tasks.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, ["86b1aa001", "86b1aa002", "86b1aa003"]);
        assert_eq!(api.paths().len(), 2);
    }

    #[test]
    fn a_short_page_without_last_page_ends_the_list() {
        let api = Recorded::default().on(
            "/list/901800112233/task?page=0&subtasks=true&include_closed=true",
            ok(r#"{"tasks":[{"id":"a1","name":"One"}]}"#.into()),
        );
        let (gate, clock, token) = (Gate::new(), FakeClock::at(NOW), token());
        let tasks = ClickUp::with(&api, &token, &gate, &clock)
            .list_tasks("901800112233")
            .unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].status, Default::default());
    }

    #[test]
    fn errors_are_plain_english() {
        let cases = [
            (
                status(401),
                "ClickUp rejected the token. Check it under Settings › Integrations.",
            ),
            (
                status(403),
                "ClickUp rejected the token. Check it under Settings › Integrations.",
            ),
            (
                status(404),
                "ClickUp has no task with that id, or your token cannot see it.",
            ),
            (
                Ok(Reply {
                    status: 401,
                    body: "{\"err\":\"Team not authorized\",\"ECODE\":\"OAUTH_027\"}".into(),
                    ..Reply::default()
                }),
                "ClickUp has no task with that id, or your token cannot see it.",
            ),
            (
                Ok(Reply {
                    status: 401,
                    body: "not json".into(),
                    ..Reply::default()
                }),
                "ClickUp rejected the token. Check it under Settings › Integrations.",
            ),
            (
                status(502),
                "ClickUp is having trouble (HTTP 502). Try again in a minute.",
            ),
            (status(418), "ClickUp answered with HTTP 418."),
            (
                Err(NoReply::Offline),
                "Could not reach ClickUp. Check your connection.",
            ),
            (
                Err(NoReply::Timeout),
                "ClickUp did not answer within 25 seconds. Try again.",
            ),
            (
                ok("not json".into()),
                "ClickUp sent a reply DCTerminal could not read.",
            ),
        ];
        for (reply, message) in cases {
            let path = "/task/abc?include_subtasks=true&include_markdown_description=true";
            let api = Recorded::default().on(path, reply);
            let (gate, clock, token) = (Gate::new(), FakeClock::at(NOW), token());
            let err = ClickUp::with(&api, &token, &gate, &clock)
                .task(&TaskRef::Id("abc".into()))
                .unwrap_err();
            assert_eq!(err.to_string(), message);
        }
    }

    #[test]
    fn ids_that_could_change_the_path_are_refused_before_any_call() {
        let api = Recorded::default();
        let (gate, clock, token) = (Gate::new(), FakeClock::at(NOW), token());
        let client = ClickUp::with(&api, &token, &gate, &clock);
        assert_eq!(
            client.task(&TaskRef::Id("a/../team".into())),
            Err(ClickUpError::BadId)
        );
        assert_eq!(
            client.comments(&TaskRef::Custom {
                id: "QA-1".into(),
                team_id: "1&x=2".into()
            }),
            Err(ClickUpError::BadId)
        );
        assert_eq!(client.list("x?y").unwrap_err(), ClickUpError::BadId);
        assert!(api.paths().is_empty());
    }

    #[test]
    fn a_429_waits_for_the_reset_and_retries() {
        let limited = Ok(Reply {
            status: 429,
            rate_remaining: Some(0),
            rate_reset: Some(NOW + 7),
            ..Reply::default()
        });
        let api = Recorded::default()
            .on("/team", limited)
            .on("/team", ok(fixture("teams.json")));
        let (gate, clock, token) = (Gate::new(), FakeClock::at(NOW), token());
        let teams = ClickUp::with(&api, &token, &gate, &clock).teams().unwrap();
        assert_eq!(teams.len(), 2);
        assert_eq!(*clock.slept.lock().unwrap(), vec![7]);
    }

    #[test]
    fn retry_after_wins_and_repeated_429s_give_up() {
        let limited = || {
            Ok(Reply {
                status: 429,
                retry_after: Some(3),
                ..Reply::default()
            })
        };
        let api = Recorded::default()
            .on("/team", limited())
            .on("/team", limited())
            .on("/team", limited());
        let (gate, clock, token) = (Gate::new(), FakeClock::at(NOW), token());
        let err = ClickUp::with(&api, &token, &gate, &clock)
            .teams()
            .unwrap_err();
        assert_eq!(err, ClickUpError::RateLimited(3));
        assert_eq!(*clock.slept.lock().unwrap(), vec![3, 3]);
        assert_eq!(api.paths().len(), 3);
    }

    #[test]
    fn no_calls_left_waits_for_the_window_and_a_long_wait_is_an_error() {
        let spent = Ok(Reply {
            status: 200,
            rate_remaining: Some(0),
            rate_reset: Some(NOW + 20),
            body: fixture("teams.json"),
            ..Reply::default()
        });
        let api = Recorded::default()
            .on("/team", spent)
            .on("/team", ok(fixture("teams.json")));
        let (gate, clock, token) = (Gate::new(), FakeClock::at(NOW), token());
        let client = ClickUp::with(&api, &token, &gate, &clock);
        client.teams().unwrap();
        client.teams().unwrap();
        assert_eq!(*clock.slept.lock().unwrap(), vec![20]);

        let far = Gate::new();
        far.note(
            &Reply {
                rate_remaining: Some(0),
                rate_reset: Some(NOW + 600),
                ..Reply::default()
            },
            NOW,
            None,
        );
        let idle = Recorded::default();
        let err = ClickUp::with(&idle, &token, &far, &FakeClock::at(NOW))
            .teams()
            .unwrap_err();
        assert_eq!(err, ClickUpError::RateLimited(600));
        assert!(idle.paths().is_empty(), "no call is spent on a known 429");
    }

    /// Counts calls in flight; each one takes a moment.
    struct Slow {
        now: AtomicUsize,
        peak: AtomicUsize,
    }

    impl Transport for Slow {
        fn get(&self, _path: &str, _token: &ClickUpToken) -> Result<Reply, NoReply> {
            let now = self.now.fetch_add(1, Ordering::SeqCst) + 1;
            self.peak.fetch_max(now, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(30));
            self.now.fetch_sub(1, Ordering::SeqCst);
            ok(r#"{"teams":[]}"#.into())
        }
    }

    #[test]
    fn at_most_four_calls_are_in_flight() {
        let api = Slow {
            now: AtomicUsize::new(0),
            peak: AtomicUsize::new(0),
        };
        let (gate, clock, token) = (Gate::new(), FakeClock::at(NOW), token());
        let client = ClickUp::with(&api, &token, &gate, &clock);
        std::thread::scope(|scope| {
            for _ in 0..12 {
                scope.spawn(|| client.teams().unwrap());
            }
        });
        let peak = api.peak.load(Ordering::SeqCst);
        assert!(peak <= MAX_IN_FLIGHT, "peak {peak}");
        assert!(peak > 1, "calls ran one at a time");
    }
}
