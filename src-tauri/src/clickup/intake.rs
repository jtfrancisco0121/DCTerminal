//! Intake (C2): ClickUp tickets in, a snapshot out. The app reads the tasks
//! a window's Claude account can see, filters them, and writes the run's
//! `tickets.json` (`schema: 1`), so the first stage starts from the tickets
//! without Claude ever calling ClickUp (plan decision E1).
//!
//! The snapshot is taken once per run (E3), so the plan does not change
//! under a running stage. [`check_changes`] tells which tickets ClickUp has
//! edited since, and [`pull_again`] re-reads the ones you choose.
//!
//! - Closed tasks are always fetched, then filtered: a list query drops them
//!   unless asked (Phase 0, P1), and a round lists them under Excluded with
//!   their status, as the QA doc does.
//! - Descriptions and comments are capped ([`LIMITS`]) and the file says so.
//! - Nothing here holds the token: the [`ClickUp`] client keeps it, and no
//!   type below has a field it could land in.

use super::client::{ClickUp, ClickUpError, TaskRef, MAX_IN_FLIGHT};
use super::types::{Comment, Task};
use super::valid_id;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

/// The version of `tickets.json`.
pub const TICKETS_SCHEMA: u32 = 1;
/// The priorities a filter can name. `none` is a task with no priority.
pub const PRIORITIES: [&str; 5] = ["urgent", "high", "normal", "low", "none"];
/// The most refs one intake reads, so a pasted page of links cannot spend
/// the rate limit by itself.
pub const MAX_REFS: usize = 50;

/// What the snapshot keeps of each ticket. A Triage stage needs the gist of a
/// description and the latest comments, not a whole spec pasted into a task.
pub const LIMITS: Limits = Limits {
    description_chars: 20_000,
    comment_chars: 4_000,
    comments_per_ticket: 25,
};

/// One link or id you pasted, already read by the UI's parser
/// (`src/clickup/intakeRefs.ts`). `line` is where it was, for errors.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntakeRef {
    /// `task` or `list`.
    pub kind: String,
    pub id: String,
    /// A custom task id's workspace (`/t/<teamId>/<customId>`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_id: Option<String>,
    /// A custom task id (`QA-128`) rather than ClickUp's own.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub custom: bool,
    #[serde(default)]
    pub line: u32,
}

/// Which tickets a round takes. Closed and done tickets are always left out.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntakeFilters {
    /// Keep only these priorities; empty keeps every one.
    #[serde(default)]
    pub priorities: Vec<String>,
    /// Keep only tickets in one of these statuses (by name, any case);
    /// empty keeps every open status.
    #[serde(default)]
    pub statuses: Vec<String>,
    /// Keep only tickets with at least one of these tags (any case); empty
    /// keeps tickets with or without tags.
    #[serde(default)]
    pub tags: Vec<String>,
}

/// The most names a status or tag filter holds, and the longest name.
const MAX_FILTER_NAMES: usize = 50;
const MAX_FILTER_NAME_CHARS: usize = 100;

fn has_name(names: &[String], name: &str) -> bool {
    let name = name.trim();
    names.iter().any(|n| n.trim().eq_ignore_ascii_case(name))
}

impl IntakeFilters {
    fn check(&self) -> Result<(), String> {
        if let Some(bad) = self.priorities.iter().find(|p| !PRIORITIES.contains(&p.as_str())) {
            return Err(format!("\"{bad}\" is not a ClickUp priority."));
        }
        for (what, names) in [("status", &self.statuses), ("tag", &self.tags)] {
            if names.len() > MAX_FILTER_NAMES {
                return Err(format!("A {what} filter takes at most {MAX_FILTER_NAMES} names."));
            }
            if names.iter().any(|n| n.trim().is_empty() || n.chars().count() > MAX_FILTER_NAME_CHARS) {
                return Err(format!("A {what} filter name is empty or too long."));
            }
        }
        Ok(())
    }
}

/// The most tickets one intake keeps (M1): a big list would otherwise cost
/// two ClickUp calls per ticket at Start and a prompt nobody can read.
pub const MAX_TICKETS: usize = 100;

fn over_cap(count: usize) -> String {
    format!(
        "{count} tickets match, more than the {MAX_TICKETS} one intake takes. Narrow the filters (priority, status or tags) or paste a smaller parent."
    )
}

/// A ref that could not be read, by line. The rest of the intake goes on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefProblem {
    pub line: u32,
    pub message: String,
}

/// A task you pasted whose subtasks are the tickets (an epic), or a list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntakeParent {
    pub kind: String,
    pub id: String,
    pub title: String,
    pub url: String,
    pub tickets: usize,
}

/// One ticket in the preview table.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketRow {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_id: Option<String>,
    pub title: String,
    pub priority: String,
    pub status: String,
    pub status_type: String,
    pub url: String,
}

/// A ticket left out, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExcludedTicket {
    #[serde(flatten)]
    pub ticket: TicketRow,
    pub reason: String,
}

/// What Fetch shows before Start.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntakePreview {
    pub parents: Vec<IntakeParent>,
    pub tickets: Vec<TicketRow>,
    pub excluded: Vec<ExcludedTicket>,
    pub problems: Vec<RefProblem>,
    /// The open statuses the fetched tickets are in, for the status filter.
    pub seen_statuses: Vec<String>,
    /// The tags the fetched tickets carry, for the tag filter.
    pub seen_tags: Vec<String>,
    /// More tickets matched than one intake takes ([`MAX_TICKETS`]): how
    /// many. `tickets` and `excluded` are then empty, and the seen statuses
    /// and tags are there so you can narrow the filters (M1).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub over_cap: Option<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Limits {
    pub description_chars: usize,
    pub comment_chars: usize,
    pub comments_per_ticket: usize,
}

/// `tickets.json`'s `limits`: the caps and a line saying what they mean.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotLimits {
    #[serde(flatten)]
    pub limits: Limits,
    pub note: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketComment {
    /// The ClickUp username. Never an email.
    pub author: String,
    /// RFC 3339, UTC.
    pub date: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ticket {
    #[serde(flatten)]
    pub row: TicketRow,
    /// Markdown when ClickUp sent it, else the plain text.
    pub description: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub description_truncated: bool,
    /// Newest first, as ClickUp sends them.
    pub comments: Vec<TicketComment>,
    /// The ticket had more comments than the snapshot keeps.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub comments_truncated: bool,
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    /// RFC 3339, UTC. "Changed since intake" compares it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date_updated: Option<String>,
}

/// Where the tickets came from. The Claude account picked the token and the
/// workspace (E2a); the token itself is never here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotSource {
    /// `clickup`.
    pub kind: String,
    pub account_id: String,
    pub workspace_id: String,
    pub refs: Vec<IntakeRef>,
    pub filters: IntakeFilters,
}

/// One Pull again: when, and which tickets it re-read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotPull {
    pub at: String,
    pub ticket_ids: Vec<String>,
}

/// `runs/<runId>/tickets.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketsSnapshot {
    pub schema: u32,
    pub source: SnapshotSource,
    pub fetched_at: String,
    pub limits: SnapshotLimits,
    pub tickets: Vec<Ticket>,
    pub excluded: Vec<ExcludedTicket>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pulls: Vec<SnapshotPull>,
}

/// A ticket ClickUp edited after intake.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedTicket {
    pub id: String,
    pub title: String,
    /// When ClickUp last edited it, RFC 3339; `None` when it is gone.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date_updated: Option<String>,
    /// ClickUp no longer has it, or this account cannot see it any more.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub missing: bool,
}

/// ClickUp's unix milliseconds as RFC 3339 (UTC, milliseconds).
pub fn ms_to_rfc3339(ms: &str) -> Option<String> {
    let ms: i64 = ms.trim().parse().ok()?;
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|at| at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

/// At most `max` chars of `text`, and whether anything was cut.
fn cap(text: &str, max: usize) -> (String, bool) {
    let text = text.trim();
    match text.char_indices().nth(max) {
        Some((end, _)) => (text[..end].to_string(), true),
        None => (text.to_string(), false),
    }
}

fn priority_of(task: &Task) -> String {
    task.priority
        .as_ref()
        .map(|p| p.priority.trim().to_ascii_lowercase())
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| "none".to_string())
}

pub fn row_of(task: &Task) -> TicketRow {
    TicketRow {
        id: task.id.clone(),
        custom_id: task.custom_id.clone(),
        title: task.name.trim().to_string(),
        priority: priority_of(task),
        status: task.status.status.clone(),
        status_type: task.status.kind.clone(),
        url: task.url.clone(),
    }
}

/// Why a task is left out, or `None` to keep it.
fn exclusion(task: &Task, filters: &IntakeFilters) -> Option<String> {
    if task.status.is_closed() {
        return Some(format!("Status is \"{}\" ({})", task.status.status, task.status.kind));
    }
    let priority = priority_of(task);
    if !filters.priorities.is_empty() && !filters.priorities.contains(&priority) {
        return Some(format!(
            "Priority is {priority}; the filter keeps {}",
            filters.priorities.join(", ")
        ));
    }
    if !filters.statuses.is_empty() && !has_name(&filters.statuses, &task.status.status) {
        return Some(format!(
            "Status is \"{}\"; the filter keeps {}",
            task.status.status,
            filters.statuses.join(", ")
        ));
    }
    if !filters.tags.is_empty() && !task.tags.iter().any(|t| has_name(&filters.tags, &t.name)) {
        let tags: Vec<&str> = task.tags.iter().map(|t| t.name.trim()).filter(|t| !t.is_empty()).collect();
        let has = if tags.is_empty() { "No tags".to_string() } else { format!("Tags are {}", tags.join(", ")) };
        return Some(format!("{has}; the filter keeps {}", filters.tags.join(", ")));
    }
    None
}

/// Names in first-seen order, once each (any case).
fn unique(names: impl Iterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for name in names.map(|n| n.trim().to_string()).filter(|n| !n.is_empty()) {
        if !has_name(&out, &name) {
            out.push(name);
        }
    }
    out
}

/// What one fetch read: the parents, and every task once, in paste order.
#[derive(Debug, Default)]
struct Fetched {
    parents: Vec<IntakeParent>,
    tasks: Vec<Task>,
    problems: Vec<RefProblem>,
}

fn task_ref(r: &IntakeRef, workspace_id: &str) -> Result<TaskRef, String> {
    if !r.custom {
        return Ok(TaskRef::Id(r.id.clone()));
    }
    let team = r.team_id.clone().unwrap_or_else(|| workspace_id.to_string());
    if team != workspace_id {
        return Err("This link is from another ClickUp workspace than this account's.".into());
    }
    Ok(TaskRef::Custom { id: r.id.clone(), team_id: team })
}

/// A ref's error as a line problem when it is about that ref (not found, a
/// bad id); any other error (the token, the rate limit, the network) stops
/// the whole intake.
fn per_ref(line: u32, err: ClickUpError) -> Result<RefProblem, String> {
    let message = match err {
        ClickUpError::NotFound(what) => {
            format!("ClickUp has no {what} with that id, or this account can't see it.")
        }
        ClickUpError::BadId => "That is not a ClickUp id.".to_string(),
        other => return Err(other.to_string()),
    };
    Ok(RefProblem { line, message })
}

fn fetch(client: &ClickUp, refs: &[IntakeRef], workspace_id: &str) -> Result<Fetched, String> {
    if refs.is_empty() {
        return Err("Paste a ClickUp task or list link first.".into());
    }
    if refs.len() > MAX_REFS {
        return Err(format!("Paste at most {MAX_REFS} links at once."));
    }
    let mut out = Fetched::default();
    let mut seen = HashSet::new();
    let mut add = |out: &mut Fetched, task: Task| {
        if seen.insert(task.id.clone()) {
            out.tasks.push(task);
        }
    };
    for r in refs {
        if !valid_id(&r.id) || r.team_id.as_deref().is_some_and(|t| !valid_id(t)) {
            out.problems.push(RefProblem { line: r.line, message: "That is not a ClickUp id.".into() });
            continue;
        }
        match r.kind.as_str() {
            "task" => {
                let task_ref = match task_ref(r, workspace_id) {
                    Ok(task_ref) => task_ref,
                    Err(message) => {
                        out.problems.push(RefProblem { line: r.line, message });
                        continue;
                    }
                };
                let mut task = match client.task(&task_ref) {
                    Ok(task) => task,
                    Err(err) => {
                        out.problems.push(per_ref(r.line, err)?);
                        continue;
                    }
                };
                // A task with subtasks is an epic: its subtasks are the tickets.
                let subtasks = std::mem::take(&mut task.subtasks);
                if subtasks.is_empty() {
                    add(&mut out, task);
                } else {
                    out.parents.push(IntakeParent {
                        kind: "task".into(),
                        id: task.id.clone(),
                        title: task.name.trim().to_string(),
                        url: task.url.clone(),
                        tickets: subtasks.len(),
                    });
                    for sub in subtasks {
                        add(&mut out, sub);
                    }
                }
            }
            "list" => {
                let tasks = match client.list_tasks(&r.id) {
                    Ok(tasks) => tasks,
                    Err(err) => {
                        out.problems.push(per_ref(r.line, err)?);
                        continue;
                    }
                };
                let title = tasks
                    .iter()
                    .map(|t| t.list.name.trim())
                    .find(|name| !name.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("List {}", r.id));
                out.parents.push(IntakeParent {
                    kind: "list".into(),
                    id: r.id.clone(),
                    title,
                    url: format!("https://app.clickup.com/v/li/{}", r.id),
                    tickets: tasks.len(),
                });
                for task in tasks {
                    add(&mut out, task);
                }
            }
            other => out.problems.push(RefProblem {
                line: r.line,
                message: format!("\"{other}\" is not a ClickUp task or list."),
            }),
        }
    }
    Ok(out)
}

/// Splits fetched tasks into kept and excluded, keeping their order.
fn split(tasks: Vec<Task>, filters: &IntakeFilters) -> (Vec<Task>, Vec<ExcludedTicket>) {
    let mut kept = Vec::new();
    let mut excluded = Vec::new();
    for task in tasks {
        match exclusion(&task, filters) {
            Some(reason) => excluded.push(ExcludedTicket { ticket: row_of(&task), reason }),
            None => kept.push(task),
        }
    }
    (kept, excluded)
}

/// Fetch: the parents, the tickets a round would take and the ones it
/// leaves out, with no comments read yet.
pub fn preview(
    client: &ClickUp,
    refs: &[IntakeRef],
    filters: &IntakeFilters,
    workspace_id: &str,
) -> Result<IntakePreview, String> {
    filters.check()?;
    let fetched = fetch(client, refs, workspace_id)?;
    let seen_statuses = unique(
        fetched.tasks.iter().filter(|t| !t.status.is_closed()).map(|t| t.status.status.clone()),
    );
    let seen_tags = unique(fetched.tasks.iter().flat_map(|t| t.tags.iter().map(|tag| tag.name.clone())));
    let (kept, excluded) = split(fetched.tasks, filters);
    if kept.len() > MAX_TICKETS {
        return Ok(IntakePreview {
            parents: fetched.parents,
            tickets: Vec::new(),
            excluded: Vec::new(),
            problems: fetched.problems,
            seen_statuses,
            seen_tags,
            over_cap: Some(kept.len()),
        });
    }
    Ok(IntakePreview {
        parents: fetched.parents,
        tickets: kept.iter().map(row_of).collect(),
        excluded,
        problems: fetched.problems,
        seen_statuses,
        seen_tags,
        over_cap: None,
    })
}

fn comment_of(comment: &Comment, limits: &Limits) -> TicketComment {
    let (text, truncated) = cap(&comment.comment_text, limits.comment_chars);
    TicketComment {
        author: comment.user.username.trim().to_string(),
        date: ms_to_rfc3339(&comment.date).unwrap_or_default(),
        text,
        truncated,
    }
}

fn ticket_of(task: &Task, comments: &[Comment], limits: &Limits) -> Ticket {
    let (description, description_truncated) = cap(task.description(), limits.description_chars);
    Ticket {
        row: row_of(task),
        description,
        description_truncated,
        comments: comments
            .iter()
            .take(limits.comments_per_ticket)
            .map(|c| comment_of(c, limits))
            .collect(),
        comments_truncated: comments.len() > limits.comments_per_ticket,
        tags: task
            .tags
            .iter()
            .map(|t| t.name.trim().to_string())
            .filter(|t| !t.is_empty())
            .collect(),
        parent_id: task.parent.clone(),
        date_updated: task.date_updated.as_deref().and_then(ms_to_rfc3339),
    }
}

/// Runs `work` for every item with at most [`MAX_IN_FLIGHT`] threads (the
/// client's gate holds the same cap), keeping the input order in the output.
fn each_parallel<T: Sync, R: Send>(
    items: &[T],
    work: impl Fn(&T) -> R + Sync,
) -> Vec<R> {
    let next = AtomicUsize::new(0);
    let out: Mutex<Vec<Option<R>>> = Mutex::new((0..items.len()).map(|_| None).collect());
    std::thread::scope(|scope| {
        for _ in 0..MAX_IN_FLIGHT.min(items.len()) {
            scope.spawn(|| loop {
                let index = next.fetch_add(1, Ordering::SeqCst);
                let Some(item) = items.get(index) else { break };
                let result = work(item);
                out.lock().unwrap_or_else(|e| e.into_inner())[index] = Some(result);
            });
        }
    });
    out.into_inner()
        .unwrap_or_else(|e| e.into_inner())
        .into_iter()
        .flatten()
        .collect()
}

/// The ticket as a task ref: its own id, which every task has.
fn own_ref(id: &str) -> TaskRef {
    TaskRef::Id(id.to_string())
}

/// Reads each task's comments; the first error stops the intake.
/// Reads each kept ticket in full and its comments; the first error stops
/// the intake. A parent's `include_subtasks` payload carries no subtask
/// descriptions (seen live on 2026-10-22), so every ticket is fetched again
/// on its own for its Markdown description and tags. A ticket ClickUp no
/// longer finds keeps what the parent or list sent.
///
/// The full read is filtered again (L2): a ticket closed since Fetch, or
/// that no longer matches the filters, is excluded with its reason and
/// gets no comment call.
fn in_full(
    client: &ClickUp,
    tasks: &[Task],
    filters: &IntakeFilters,
    limits: &Limits,
) -> Result<Vec<Result<Ticket, ExcludedTicket>>, String> {
    each_parallel(tasks, |task| -> Result<Result<Ticket, ExcludedTicket>, String> {
        let mut full = match client.task(&own_ref(&task.id)) {
            Ok(full) => full,
            Err(ClickUpError::NotFound(_)) => task.clone(),
            Err(err) => return Err(err.to_string()),
        };
        full.subtasks.clear();
        if full.parent.is_none() {
            full.parent = task.parent.clone();
        }
        if let Some(reason) = exclusion(&full, filters) {
            return Ok(Err(ExcludedTicket { ticket: row_of(&full), reason }));
        }
        let comments = client.comments(&own_ref(&task.id)).map_err(String::from)?;
        Ok(Ok(ticket_of(&full, &comments, limits)))
    })
    .into_iter()
    .collect()
}

/// Start: fetch again, keep the tickets you ticked (`ticket_ids`; `None`
/// keeps every one the filters keep), read their comments and build the
/// snapshot. A ticked ticket the filters now leave out stays excluded.
#[allow(clippy::too_many_arguments)]
pub fn snapshot(
    client: &ClickUp,
    account_id: &str,
    workspace_id: &str,
    refs: &[IntakeRef],
    filters: &IntakeFilters,
    ticket_ids: Option<&[String]>,
    now: &str,
) -> Result<(TicketsSnapshot, Vec<RefProblem>), String> {
    filters.check()?;
    let fetched = fetch(client, refs, workspace_id)?;
    let (kept, mut excluded) = split(fetched.tasks, filters);
    let (kept, dropped): (Vec<Task>, Vec<Task>) = match ticket_ids {
        Some(ids) => kept.into_iter().partition(|t| ids.iter().any(|id| id == &t.id)),
        None => (kept, Vec::new()),
    };
    excluded.extend(dropped.iter().map(|task| ExcludedTicket {
        ticket: row_of(task),
        reason: "Left out at intake".into(),
    }));
    if kept.is_empty() {
        return Err("No tickets are left to start with. Tick at least one.".into());
    }
    if kept.len() > MAX_TICKETS {
        return Err(over_cap(kept.len()));
    }
    let mut tickets = Vec::new();
    for read in in_full(client, &kept, filters, &LIMITS)? {
        match read {
            Ok(ticket) => tickets.push(ticket),
            Err(left_out) => excluded.push(left_out),
        }
    }
    if tickets.is_empty() {
        return Err("None of the ticked tickets still match: ClickUp closed them or they changed since Fetch. Press Fetch again.".into());
    }
    Ok((
        TicketsSnapshot {
            schema: TICKETS_SCHEMA,
            source: SnapshotSource {
                kind: "clickup".into(),
                account_id: account_id.to_string(),
                workspace_id: workspace_id.to_string(),
                refs: refs.to_vec(),
                filters: filters.clone(),
            },
            fetched_at: now.to_string(),
            limits: SnapshotLimits {
                limits: LIMITS,
                note: format!(
                    "Descriptions are cut at {} characters and comments at {}; each ticket keeps its {} newest comments. A cut field says truncated: true. The ticket's url has the rest.",
                    LIMITS.description_chars, LIMITS.comment_chars, LIMITS.comments_per_ticket
                ),
            },
            tickets,
            excluded,
            pulls: Vec::new(),
        },
        fetched.problems,
    ))
}

/// What ClickUp says each snapshot ticket was last edited, by id.
enum Now {
    Updated(Option<String>),
    Missing,
}

fn current(client: &ClickUp, id: &str) -> Result<Now, String> {
    match client.task(&own_ref(id)) {
        Ok(task) => Ok(Now::Updated(task.date_updated.as_deref().and_then(ms_to_rfc3339))),
        Err(ClickUpError::NotFound(_)) => Ok(Now::Missing),
        Err(err) => Err(err.to_string()),
    }
}

/// The snapshot tickets ClickUp edited after intake (or no longer has).
pub fn check_changes(client: &ClickUp, snapshot: &TicketsSnapshot) -> Result<Vec<ChangedTicket>, String> {
    let now = each_parallel(&snapshot.tickets, |ticket| current(client, &ticket.row.id));
    let mut changed = Vec::new();
    for (ticket, now) in snapshot.tickets.iter().zip(now) {
        let entry = |date_updated, missing| ChangedTicket {
            id: ticket.row.id.clone(),
            title: ticket.row.title.clone(),
            date_updated,
            missing,
        };
        match now? {
            Now::Missing => changed.push(entry(None, true)),
            Now::Updated(at) if at.is_some() && at != ticket.date_updated => changed.push(entry(at, false)),
            Now::Updated(_) => {}
        }
    }
    Ok(changed)
}

/// Pull again: re-read `ids` (with their comments) and put them in place in
/// the snapshot. A ticket ClickUp no longer has is kept as it was. Returns
/// the ids it re-read.
pub fn pull_again(
    client: &ClickUp,
    snapshot: &mut TicketsSnapshot,
    ids: &[String],
    now: &str,
) -> Result<Vec<String>, String> {
    let wanted: Vec<String> = snapshot
        .tickets
        .iter()
        .map(|t| t.row.id.clone())
        .filter(|id| ids.contains(id))
        .collect();
    if wanted.is_empty() {
        return Err("None of those tickets are in this run's snapshot.".into());
    }
    let limits = snapshot.limits.limits;
    let fresh = each_parallel(&wanted, |id| -> Result<Option<Ticket>, String> {
        let task = match client.task(&own_ref(id)) {
            Ok(task) => task,
            Err(ClickUpError::NotFound(_)) => return Ok(None),
            Err(err) => return Err(err.to_string()),
        };
        let comments = client.comments(&own_ref(id)).map_err(String::from)?;
        Ok(Some(ticket_of(&task, &comments, &limits)))
    });
    let mut pulled = Vec::new();
    for ticket in fresh {
        let Some(ticket) = ticket? else { continue };
        if let Some(slot) = snapshot.tickets.iter_mut().find(|t| t.row.id == ticket.row.id) {
            pulled.push(ticket.row.id.clone());
            *slot = ticket;
        }
    }
    if !pulled.is_empty() {
        snapshot.pulls.push(SnapshotPull { at: now.to_string(), ticket_ids: pulled.clone() });
    }
    Ok(pulled)
}

/// The most ticket lines a prompt summary lists.
const SUMMARY_LINES: usize = 100;

/// One line per ticket: id (and custom id), priority and title; `with_urls`
/// adds each link, for a stage that has no `tickets.json` to read.
pub fn summary_lines(snapshot: &TicketsSnapshot, with_urls: bool) -> String {
    let mut lines: Vec<String> = snapshot
        .tickets
        .iter()
        .take(SUMMARY_LINES)
        .map(|t| {
            let custom = t.row.custom_id.as_deref().map(|c| format!(" ({c})")).unwrap_or_default();
            let url = if with_urls && !t.row.url.is_empty() { format!(" <{}>", t.row.url) } else { String::new() };
            format!("- {}{custom} [{}] {}{url}", t.row.id, t.row.priority, t.row.title)
        })
        .collect();
    if snapshot.tickets.len() > SUMMARY_LINES {
        lines.push(format!("- …and {} more", snapshot.tickets.len() - SUMMARY_LINES));
    }
    lines.join("\n")
}

fn excluded_line(snapshot: &TicketsSnapshot) -> String {
    match snapshot.excluded.len() {
        0 => String::new(),
        n => format!("\n{n} more were excluded at intake (closed, filtered or left out)."),
    }
}

/// The note an engine-2 run's first stage gets: where `tickets.json` is and
/// one line per ticket.
pub fn snapshot_note(snapshot: &TicketsSnapshot, tickets_path: &str) -> String {
    format!(
        "Tickets from ClickUp ({} in this run's intake snapshot): {tickets_path}\nRead that file for each ticket's description, comments, tags and status.\n{}{}",
        snapshot.tickets.len(),
        summary_lines(snapshot, false),
        excluded_line(snapshot),
    )
}

/// The same tickets for a start with no run folder (engine 1, or the bridge
/// refused): the summary goes into the request, with each ticket's link.
pub fn request_note(snapshot: &TicketsSnapshot) -> String {
    format!(
        "Tickets from ClickUp ({}):\n{}{}",
        snapshot.tickets.len(),
        summary_lines(snapshot, true),
        excluded_line(snapshot),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clickup::client::tests::{fixture, ok, status, FakeClock, Recorded};
    use crate::clickup::{ClickUpToken, Gate};

    const NOW: i64 = 1_790_000_000;
    const EPIC: &str = "/task/7xk2epic01?include_subtasks=true&include_markdown_description=true";
    const LIST0: &str = "/list/901800112233/task?page=0&subtasks=true&include_closed=true";
    const LIST1: &str = "/list/901800112233/task?page=1&subtasks=true&include_closed=true";
    const TOKEN: &str = "pk_81234567_INTAKELEAKCHECK0123456789";

    fn task_path(id: &str) -> String {
        format!("/task/{id}?include_subtasks=true&include_markdown_description=true")
    }

    fn task_ref(kind: &str, id: &str, line: u32) -> IntakeRef {
        IntakeRef { kind: kind.into(), id: id.into(), team_id: None, custom: false, line }
    }

    fn token() -> ClickUpToken {
        ClickUpToken::parse(TOKEN).unwrap()
    }

    fn with_client<T>(api: &Recorded, work: impl FnOnce(&ClickUp) -> T) -> T {
        let (gate, clock, token) = (Gate::new(), FakeClock::at(NOW), token());
        let client = ClickUp::with(api, &token, &gate, &clock);
        work(&client)
    }

    fn ids(rows: &[TicketRow]) -> Vec<&str> {
        rows.iter().map(|r| r.id.as_str()).collect()
    }

    #[test]
    fn an_epic_s_subtasks_are_the_tickets_and_closed_ones_are_excluded_with_their_status() {
        let api = Recorded::default().on(EPIC, ok(fixture("task-with-subtasks.json")));
        let preview = with_client(&api, |c| {
            preview(c, &[task_ref("task", "7xk2epic01", 1)], &IntakeFilters::default(), "9012345678")
        })
        .unwrap();
        assert_eq!(preview.parents.len(), 1);
        assert_eq!(preview.parents[0].title, "QA 1.2.8 Medium/Low fixes");
        assert_eq!(preview.parents[0].tickets, 3);
        assert_eq!(ids(&preview.tickets), ["86b1aa001", "86b1aa002"]);
        assert_eq!(preview.tickets[0].priority, "high");
        assert_eq!(preview.tickets[0].custom_id.as_deref(), Some("QA-129"));
        assert_eq!(preview.excluded.len(), 1);
        assert_eq!(preview.excluded[0].ticket.id, "86b1aa003");
        assert_eq!(preview.excluded[0].reason, "Status is \"closed\" (closed)");
        assert!(preview.problems.is_empty());
    }

    #[test]
    fn a_list_is_read_with_closed_tasks_and_the_priority_filter_explains_what_it_leaves_out() {
        let api = Recorded::default()
            .on(LIST0, ok(fixture("list-tasks-page0.json")))
            .on(LIST1, ok(fixture("list-tasks-page1.json")));
        let filters = IntakeFilters { priorities: vec!["urgent".into(), "high".into()], ..Default::default() };
        let preview =
            with_client(&api, |c| preview(c, &[task_ref("list", "901800112233", 1)], &filters, "9012345678"))
                .unwrap();
        // The list query asked for closed tasks (C1's include_closed=true).
        assert!(api.paths().iter().all(|p| p.contains("include_closed=true")));
        assert_eq!(preview.parents[0].kind, "list");
        assert_eq!(preview.parents[0].title, "QA 1.2.8");
        assert_eq!(ids(&preview.tickets), ["86b1aa001"]);
        let reasons: Vec<(&str, &str)> =
            preview.excluded.iter().map(|e| (e.ticket.id.as_str(), e.reason.as_str())).collect();
        assert_eq!(
            reasons,
            [
                ("86b1aa002", "Priority is none; the filter keeps urgent, high"),
                ("86b1aa003", "Status is \"closed\" (closed)"),
            ]
        );
    }

    #[test]
    fn a_ticket_pasted_twice_or_in_both_its_epic_and_its_list_is_listed_once() {
        let api = Recorded::default()
            .on(EPIC, ok(fixture("task-with-subtasks.json")))
            .on(LIST0, ok(fixture("list-tasks-page0.json")))
            .on(LIST1, ok(fixture("list-tasks-page1.json")));
        let refs = [task_ref("task", "7xk2epic01", 1), task_ref("list", "901800112233", 2)];
        let preview = with_client(&api, |c| preview(c, &refs, &IntakeFilters::default(), "9012345678")).unwrap();
        assert_eq!(ids(&preview.tickets), ["86b1aa001", "86b1aa002"]);
        assert_eq!(preview.excluded.len(), 1);
    }

    #[test]
    fn a_ref_clickup_cannot_find_is_a_problem_on_its_line_and_the_rest_still_reads() {
        let not_authorized = Ok(crate::clickup::Reply {
            status: 401,
            body: "{\"err\":\"Team not authorized\",\"ECODE\":\"OAUTH_027\"}".into(),
            ..Default::default()
        });
        let api = Recorded::default()
            .on(&task_path("86zzzz999"), not_authorized)
            .on(&task_path("86yyyy888"), status(404))
            .on(&task_path("86b1aa001"), ok(r#"{"id":"86b1aa001","name":"Sync","status":{"status":"to do","type":"open"}}"#.into()));
        let refs = [
            task_ref("task", "86zzzz999", 1),
            task_ref("task", "86yyyy888", 2),
            task_ref("task", "a/b", 3),
            task_ref("task", "86b1aa001", 4),
        ];
        let preview = with_client(&api, |c| preview(c, &refs, &IntakeFilters::default(), "9012345678")).unwrap();
        assert_eq!(ids(&preview.tickets), ["86b1aa001"]);
        let problems: Vec<(u32, &str)> = preview.problems.iter().map(|p| (p.line, p.message.as_str())).collect();
        assert_eq!(
            problems,
            [
                (1, "ClickUp has no task with that id, or this account can't see it."),
                (2, "ClickUp has no task with that id, or this account can't see it."),
                (3, "That is not a ClickUp id."),
            ]
        );
    }

    #[test]
    fn a_rejected_token_stops_the_whole_intake() {
        let api = Recorded::default().on(EPIC, status(401));
        let err = with_client(&api, |c| {
            preview(c, &[task_ref("task", "7xk2epic01", 1)], &IntakeFilters::default(), "9012345678")
        })
        .unwrap_err();
        assert_eq!(err, "ClickUp rejected the token. Check it under Settings › Integrations.");
    }

    #[test]
    fn a_custom_id_is_read_in_this_account_s_workspace_and_a_link_from_another_is_refused() {
        let path = "/task/QA-129?include_subtasks=true&include_markdown_description=true&custom_task_ids=true&team_id=9012345678";
        let api = Recorded::default().on(
            path,
            ok(r#"{"id":"86b1aa001","custom_id":"QA-129","name":"Sync","status":{"status":"to do","type":"open"}}"#.into()),
        );
        let custom = |team: Option<&str>, line| IntakeRef {
            kind: "task".into(),
            id: "QA-129".into(),
            team_id: team.map(str::to_string),
            custom: true,
            line,
        };
        let refs = [custom(None, 1), custom(Some("9087654321"), 2)];
        let preview = with_client(&api, |c| preview(c, &refs, &IntakeFilters::default(), "9012345678")).unwrap();
        assert_eq!(ids(&preview.tickets), ["86b1aa001"]);
        assert_eq!(preview.problems.len(), 1);
        assert_eq!(preview.problems[0].line, 2);
        assert!(preview.problems[0].message.contains("another ClickUp workspace"));
    }

    #[test]
    fn bad_filters_and_empty_or_huge_pastes_are_refused_before_any_call() {
        let api = Recorded::default();
        let bad = IntakeFilters { priorities: vec!["p1".into()], ..Default::default() };
        with_client(&api, |c| {
            assert!(preview(c, &[task_ref("task", "a1", 1)], &bad, "w").unwrap_err().contains("p1"));
            assert!(preview(c, &[], &IntakeFilters::default(), "w").is_err());
            let many: Vec<IntakeRef> = (0..=MAX_REFS as u32).map(|n| task_ref("task", "a1", n)).collect();
            assert!(preview(c, &many, &IntakeFilters::default(), "w").is_err());
        });
        assert!(api.paths().is_empty());
    }

    fn epic_snapshot(ticked: Option<&[String]>) -> (TicketsSnapshot, Recorded) {
        let api = Recorded::default()
            .on(EPIC, ok(fixture("task-with-subtasks.json")))
            .on(&task_path("86b1aa001"), ok(fixture("task-86b1aa001.json")))
            .on(&task_path("86b1aa002"), ok(fixture("task-86b1aa002.json")))
            .on("/task/86b1aa001/comment", ok(fixture("comments.json")))
            .on("/task/86b1aa002/comment", ok(r#"{"comments":[]}"#.into()));
        let (snap, problems) = with_client(&api, |c| {
            snapshot(
                c,
                "default",
                "9012345678",
                &[task_ref("task", "7xk2epic01", 1)],
                &IntakeFilters::default(),
                ticked,
                "2026-10-22T09:00:00.000Z",
            )
        })
        .unwrap();
        assert!(problems.is_empty());
        (snap, api)
    }

    #[test]
    fn the_snapshot_has_the_planned_shape() {
        let (snap, _) = epic_snapshot(None);
        let json = serde_json::to_value(&snap).unwrap();
        assert_eq!(json["schema"], 1);
        assert_eq!(json["source"]["kind"], "clickup");
        assert_eq!(json["source"]["accountId"], "default");
        assert_eq!(json["source"]["workspaceId"], "9012345678");
        assert_eq!(json["source"]["refs"][0], serde_json::json!({ "kind": "task", "id": "7xk2epic01", "line": 1 }));
        assert_eq!(json["source"]["filters"], serde_json::json!({ "priorities": [], "statuses": [], "tags": [] }));
        assert_eq!(json["fetchedAt"], "2026-10-22T09:00:00.000Z");
        assert_eq!(json["limits"]["descriptionChars"], 20_000);
        assert!(json["limits"]["note"].as_str().unwrap().contains("truncated: true"));
        let first = &json["tickets"][0];
        assert_eq!(first["id"], "86b1aa001");
        assert_eq!(first["customId"], "QA-129");
        assert_eq!(first["title"], "Sync stalls on a folder of 7,839 files");
        assert_eq!(first["priority"], "high");
        assert_eq!(first["status"], "to do");
        assert_eq!(first["statusType"], "open");
        assert_eq!(first["url"], "https://app.clickup.com/t/86b1aa001");
        // From the ticket's own fetch: its Markdown and all its tags.
        assert_eq!(
            first["description"],
            "Upload of a large folder stops at **61%** on Windows.\n\n## Steps\n1. Pick a folder of 7,839 files.\n2. Start sync."
        );
        assert_eq!(first["tags"], serde_json::json!(["desktop", "windows"]));
        // No Markdown: the plain text.
        assert_eq!(json["tickets"][1]["description"], "Every sync line is written twice to engine.log.");
        assert_eq!(first["parentId"], "7xk2epic01");
        assert_eq!(first["dateUpdated"], "2026-09-21T00:20:00.000Z");
        assert_eq!(first["comments"][0]["author"], "Dana Reyes");
        assert_eq!(first["comments"][0]["date"], "2026-09-21T00:20:00.000Z");
        assert!(first["comments"][0]["text"].as_str().unwrap().contains("7,839 files"));
        assert!(first["comments"][0].get("truncated").is_none());
        assert_eq!(json["tickets"][1]["comments"], serde_json::json!([]));
        assert_eq!(json["excluded"][0]["id"], "86b1aa003");
        assert_eq!(json["excluded"][0]["reason"], "Status is \"closed\" (closed)");
        assert!(json.get("pulls").is_none());
        // No emails, no ClickUp user ids, no token.
        let text = serde_json::to_string(&snap).unwrap();
        for leak in ["@example.com", "81234567", TOKEN] {
            assert!(!text.contains(leak), "{leak} in the snapshot");
        }
        // It reads back as written.
        let back: TicketsSnapshot = serde_json::from_str(&text).unwrap();
        assert_eq!(back, snap);
    }

    #[test]
    fn unticked_tickets_are_excluded_as_left_out_and_get_no_comment_call() {
        let ticked = vec!["86b1aa001".to_string()];
        let api = Recorded::default()
            .on(EPIC, ok(fixture("task-with-subtasks.json")))
            .on(&task_path("86b1aa001"), ok(fixture("task-86b1aa001.json")))
            .on("/task/86b1aa001/comment", ok(fixture("comments.json")));
        let (snap, _) = with_client(&api, |c| {
            snapshot(c, "default", "w1", &[task_ref("task", "7xk2epic01", 1)], &IntakeFilters::default(), Some(&ticked), "t")
        })
        .unwrap();
        assert_eq!(snap.tickets.len(), 1);
        let reasons: Vec<&str> = snap.excluded.iter().map(|e| e.reason.as_str()).collect();
        assert_eq!(reasons, ["Status is \"closed\" (closed)", "Left out at intake"]);
        assert!(!api.paths().iter().any(|p| p.contains("86b1aa002")));
        // Nothing ticked: nothing to start.
        let api = Recorded::default().on(EPIC, ok(fixture("task-with-subtasks.json")));
        let none: Vec<String> = Vec::new();
        let err = with_client(&api, |c| {
            snapshot(c, "default", "w1", &[task_ref("task", "7xk2epic01", 1)], &IntakeFilters::default(), Some(&none), "t")
        })
        .unwrap_err();
        assert!(err.contains("Tick at least one"));
    }

    #[test]
    fn long_descriptions_and_comments_are_capped_and_say_so() {
        let long = "é".repeat(LIMITS.description_chars + 10);
        let comment = "x".repeat(LIMITS.comment_chars + 1);
        let task = format!(
            r#"{{"id":"a1","name":"Long","text_content":"{long}","status":{{"status":"to do","type":"open"}}}}"#
        );
        let many: Vec<String> = (0..30)
            .map(|n| format!(r#"{{"id":"c{n}","comment_text":"{comment}","user":{{"username":"Kim"}},"date":"1789950000000"}}"#))
            .collect();
        let api = Recorded::default()
            .on(&task_path("a1"), ok(task.clone()))
            .on(&task_path("a1"), ok(task))
            .on("/task/a1/comment", ok(format!(r#"{{"comments":[{}]}}"#, many.join(","))));
        let (snap, _) = with_client(&api, |c| {
            snapshot(c, "default", "w1", &[task_ref("task", "a1", 1)], &IntakeFilters::default(), None, "t")
        })
        .unwrap();
        let ticket = &snap.tickets[0];
        assert_eq!(ticket.description.chars().count(), LIMITS.description_chars);
        assert!(ticket.description_truncated);
        assert_eq!(ticket.comments.len(), LIMITS.comments_per_ticket);
        assert!(ticket.comments_truncated);
        assert!(ticket.comments[0].truncated);
        assert_eq!(ticket.comments[0].text.len(), LIMITS.comment_chars);
    }

    #[test]
    fn the_change_check_finds_edited_and_missing_tickets() {
        let (snap, _) = epic_snapshot(None);
        let api = Recorded::default()
            // Edited after intake.
            .on(&task_path("86b1aa001"), ok(r#"{"id":"86b1aa001","name":"Sync","date_updated":"1790000000000"}"#.into()))
            // Gone.
            .on(&task_path("86b1aa002"), status(404));
        let changed = with_client(&api, |c| check_changes(c, &snap)).unwrap();
        assert_eq!(
            changed,
            [
                ChangedTicket {
                    id: "86b1aa001".into(),
                    title: "Sync stalls on a folder of 7,839 files".into(),
                    date_updated: Some("2026-09-21T14:13:20.000Z".into()),
                    missing: false,
                },
                ChangedTicket {
                    id: "86b1aa002".into(),
                    title: "Duplicate lines in the engine log".into(),
                    date_updated: None,
                    missing: true,
                },
            ]
        );
        // Unchanged tickets are not listed.
        let api = Recorded::default()
            .on(&task_path("86b1aa001"), ok(r#"{"id":"86b1aa001","date_updated":"1789950000000"}"#.into()))
            .on(&task_path("86b1aa002"), ok(r#"{"id":"86b1aa002","date_updated":"1789960000000"}"#.into()));
        assert!(with_client(&api, |c| check_changes(c, &snap)).unwrap().is_empty());
    }

    #[test]
    fn pull_again_rereads_only_the_chosen_tickets_and_records_the_pull() {
        let (mut snap, _) = epic_snapshot(None);
        let before = snap.tickets[1].clone();
        let api = Recorded::default()
            .on(
                &task_path("86b1aa001"),
                ok(r#"{"id":"86b1aa001","name":"Sync stalls (repro steps added)","text_content":"Now with steps.","status":{"status":"qa failed","type":"custom"},"priority":{"priority":"urgent"},"date_updated":"1790000000000"}"#.into()),
            )
            .on("/task/86b1aa001/comment", ok(r#"{"comments":[]}"#.into()));
        let pulled = with_client(&api, |c| {
            pull_again(c, &mut snap, &["86b1aa001".into(), "not-in-run".into()], "2026-10-22T10:00:00.000Z")
        })
        .unwrap();
        assert_eq!(pulled, ["86b1aa001"]);
        let ticket = &snap.tickets[0];
        assert_eq!(ticket.row.title, "Sync stalls (repro steps added)");
        assert_eq!(ticket.row.priority, "urgent");
        assert_eq!(ticket.description, "Now with steps.");
        assert_eq!(ticket.date_updated.as_deref(), Some("2026-09-21T14:13:20.000Z"));
        assert_eq!(snap.tickets[1], before, "the other ticket is untouched");
        assert_eq!(snap.pulls, [SnapshotPull { at: "2026-10-22T10:00:00.000Z".into(), ticket_ids: pulled }]);
        assert_eq!(snap.fetched_at, "2026-10-22T09:00:00.000Z", "intake time stays");
        let api = Recorded::default();
        assert!(with_client(&api, |c| pull_again(c, &mut snap, &["nope".into()], "t")).is_err());
    }

    #[test]
    fn the_prompt_summary_is_one_line_per_ticket() {
        let (snap, _) = epic_snapshot(None);
        let note = snapshot_note(&snap, "/data/runs/ee_1/tickets.json");
        assert_eq!(
            note,
            "Tickets from ClickUp (2 in this run's intake snapshot): /data/runs/ee_1/tickets.json\n\
             Read that file for each ticket's description, comments, tags and status.\n\
             - 86b1aa001 (QA-129) [high] Sync stalls on a folder of 7,839 files\n\
             - 86b1aa002 [normal] Duplicate lines in the engine log\n\
             1 more were excluded at intake (closed, filtered or left out)."
        );
        let request = request_note(&snap);
        assert!(request.starts_with("Tickets from ClickUp (2):\n"));
        assert!(request.contains("- 86b1aa001 (QA-129) [high] Sync stalls on a folder of 7,839 files <https://app.clickup.com/t/86b1aa001>"));
        assert!(!request.contains("tickets.json"));
    }

    #[test]
    fn clickup_times_read_as_rfc3339() {
        assert_eq!(ms_to_rfc3339("1789950000000").as_deref(), Some("2026-09-21T00:20:00.000Z"));
        assert_eq!(ms_to_rfc3339("soon"), None);
        assert_eq!(cap("abc", 2), ("ab".to_string(), true));
        assert_eq!(cap(" abc ", 3), ("abc".to_string(), false));
    }

    #[test]
    fn start_fetches_each_kept_ticket_in_full_because_subtasks_carry_no_description() {
        // The epic's embedded subtasks have no description at all, as ClickUp sends them.
        let epic = fixture("task-with-subtasks.json").replace(
            "\"text_content\": \"Upload of a large folder stops at 61% on Windows.\",",
            "\"text_content\": \"\",",
        );
        let api = Recorded::default()
            .on(EPIC, ok(epic))
            .on(&task_path("86b1aa001"), ok(fixture("task-86b1aa001.json")))
            .on("/task/86b1aa001/comment", ok(r#"{"comments":[]}"#.into()))
            // Gone since the epic was read: the embedded object is kept.
            .on(&task_path("86b1aa002"), status(404))
            .on("/task/86b1aa002/comment", ok(r#"{"comments":[]}"#.into()));
        let (snap, _) = with_client(&api, |c| {
            snapshot(c, "default", "w1", &[task_ref("task", "7xk2epic01", 1)], &IntakeFilters::default(), None, "t")
        })
        .unwrap();
        assert!(snap.tickets[0].description.contains("## Steps"), "{}", snap.tickets[0].description);
        assert_eq!(snap.tickets[0].tags, ["desktop", "windows"]);
        assert_eq!(snap.tickets[0].parent_id.as_deref(), Some("7xk2epic01"));
        assert_eq!(snap.tickets[1].row.title, "Duplicate lines in the engine log");
        // The ticket call went through the client (and so the Gate) next to the comment call.
        let paths = api.paths();
        assert!(paths.contains(&task_path("86b1aa001")) && paths.contains(&"/task/86b1aa001/comment".to_string()));
    }

    fn many_tasks(n: usize) -> String {
        let tasks: Vec<String> = (0..n)
            .map(|i| {
                let (status, tag) = if i % 2 == 0 { ("to do", "desktop") } else { ("qa failed", "web") };
                format!(
                    r#"{{"id":"t{i:05}","name":"Ticket {i}","status":{{"status":"{status}","type":"open"}},"tags":[{{"name":"{tag}"}}],"priority":{{"priority":"{}"}}}}"#,
                    if i % 2 == 0 { "high" } else { "low" }
                )
            })
            .collect();
        format!(r#"{{"tasks":[{}],"last_page":true}}"#, tasks.join(","))
    }

    #[test]
    fn over_a_hundred_kept_tickets_the_preview_names_the_count_and_still_offers_the_filters() {
        let list = "/list/901800112299/task?page=0&subtasks=true&include_closed=true";
        let refs = [task_ref("list", "901800112299", 1)];
        let api = Recorded::default().on(list, ok(many_tasks(150)));
        let over = with_client(&api, |c| preview(c, &refs, &IntakeFilters::default(), "w1")).unwrap();
        assert_eq!(over.over_cap, Some(150));
        assert!(over.tickets.is_empty() && over.excluded.is_empty());
        assert_eq!(over.seen_statuses, ["to do", "qa failed"]);
        assert_eq!(over.seen_tags, ["desktop", "web"]);
        assert_eq!(serde_json::to_value(&over).unwrap()["overCap"], 150);
        // Start keeps the hard error, and makes no ticket or comment call.
        let api = Recorded::default().on(list, ok(many_tasks(150)));
        let err = with_client(&api, |c| snapshot(c, "default", "w1", &refs, &IntakeFilters::default(), None, "t")).unwrap_err();
        assert_eq!(
            err,
            "150 tickets match, more than the 100 one intake takes. Narrow the filters (priority, status or tags) or paste a smaller parent."
        );
        assert_eq!(api.paths().len(), 1);
        // Narrowed by a seen tag, it reads under the cap.
        let api = Recorded::default().on(list, ok(many_tasks(150)));
        let web = IntakeFilters { tags: vec!["web".into()], ..Default::default() };
        let narrowed = with_client(&api, |c| preview(c, &refs, &web, "w1")).unwrap();
        assert_eq!((narrowed.over_cap, narrowed.tickets.len(), narrowed.excluded.len()), (None, 75, 75));
        assert!(serde_json::to_value(&narrowed).unwrap().get("overCap").is_none());
    }

    #[test]
    fn start_excludes_a_ticket_its_full_read_shows_closed_or_no_longer_matching() {
        let closed = r#"{"id":"86b1aa001","name":"Sync stalls","status":{"status":"complete","type":"closed"}}"#;
        let api = Recorded::default()
            .on(EPIC, ok(fixture("task-with-subtasks.json")))
            .on(&task_path("86b1aa001"), ok(closed.into()))
            .on(&task_path("86b1aa002"), ok(fixture("task-86b1aa002.json")))
            .on("/task/86b1aa002/comment", ok(r#"{"comments":[]}"#.into()));
        let epic = [task_ref("task", "7xk2epic01", 1)];
        let (snap, _) = with_client(&api, |c| snapshot(c, "default", "w1", &epic, &IntakeFilters::default(), None, "t")).unwrap();
        let kept: Vec<&str> = snap.tickets.iter().map(|t| t.row.id.as_str()).collect();
        assert_eq!(kept, ["86b1aa002"]);
        let last = snap.excluded.last().unwrap();
        assert_eq!((last.ticket.id.as_str(), last.reason.as_str()), ("86b1aa001", "Status is \"complete\" (closed)"));
        assert!(!api.paths().contains(&"/task/86b1aa001/comment".to_string()), "no comment call for it");

        // Retagged since Fetch: the tag filter drops it, and with none left Start says so.
        let retagged = r#"{"id":"86b1aa001","name":"Sync stalls","status":{"status":"to do","type":"open"},"tags":[{"name":"web"}]}"#;
        let api = Recorded::default()
            .on(EPIC, ok(fixture("task-with-subtasks.json")))
            .on(&task_path("86b1aa001"), ok(retagged.into()));
        let desktop = IntakeFilters { tags: vec!["desktop".into()], ..Default::default() };
        let err = with_client(&api, |c| snapshot(c, "default", "w1", &epic, &desktop, None, "t")).unwrap_err();
        assert!(err.starts_with("None of the ticked tickets still match"), "{err}");
    }

    #[test]
    fn status_and_tag_filters_exclude_with_their_own_reasons_and_the_preview_lists_what_it_saw() {
        let api = Recorded::default()
            .on(LIST0, ok(fixture("list-tasks-page0.json")))
            .on(LIST1, ok(fixture("list-tasks-page1.json")));
        let refs = [task_ref("list", "901800112233", 1)];
        let all = with_client(&api, |c| preview(c, &refs, &IntakeFilters::default(), "w1")).unwrap();
        // Closed statuses are never offered: closed tickets are always left out.
        assert_eq!(all.seen_statuses, ["to do", "qa failed"]);
        assert_eq!(all.seen_tags, ["desktop"]);

        let api = Recorded::default()
            .on(LIST0, ok(fixture("list-tasks-page0.json")))
            .on(LIST1, ok(fixture("list-tasks-page1.json")));
        let by_status = IntakeFilters { statuses: vec!["QA Failed".into()], ..Default::default() };
        let shown = with_client(&api, |c| preview(c, &refs, &by_status, "w1")).unwrap();
        assert_eq!(ids(&shown.tickets), ["86b1aa002"], "any case");
        assert_eq!(shown.excluded[0].reason, "Status is \"to do\"; the filter keeps QA Failed");

        let api = Recorded::default()
            .on(LIST0, ok(fixture("list-tasks-page0.json")))
            .on(LIST1, ok(fixture("list-tasks-page1.json")));
        let by_tag = IntakeFilters { tags: vec!["Desktop".into(), "web".into()], ..Default::default() };
        let shown = with_client(&api, |c| preview(c, &refs, &by_tag, "w1")).unwrap();
        assert_eq!(ids(&shown.tickets), ["86b1aa001"]);
        assert_eq!(shown.excluded[0].reason, "No tags; the filter keeps Desktop, web");

        let api = Recorded::default();
        let empty = IntakeFilters { tags: vec!["  ".into()], ..Default::default() };
        assert!(with_client(&api, |c| preview(c, &refs, &empty, "w1")).is_err());
        assert!(api.paths().is_empty());
    }

}
