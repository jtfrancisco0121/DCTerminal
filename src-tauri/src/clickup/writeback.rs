//! Write-back (C3): what a run proposes to tell ClickUp about each ticket,
//! your ticks and edits, and what was sent. Kept in the run folder as
//! `writeback.json` (`schema: 1`), written only by the app.
//!
//! - Proposals appear once a lane's `verify` gate is marked verified (L2,
//!   plan decision E5) or the run completes. Each ticket in `tickets.json`
//!   gets one, built by [`build`] from the run's own files: the pull
//!   requests and the Implementer's summary (`prs.json`, `prs-<lane>.json`),
//!   and how it was verified (the run's verify records, else its passed
//!   checks).
//! - A status change is proposed only for a ticket whose lanes were all
//!   verified, and only to the status you mapped for its list
//!   (Settings › Integrations, or next to the proposals).
//! - Which lane fixed which ticket: the plan's tasks when they name tickets
//!   (`tasks[].tickets`, or `tasks[].stories[].tickets` once stories exist);
//!   otherwise a run with one lane (or none) gives every ticket to it, and a
//!   run with several gives no status change and says why.
//! - Ticks live in the app's memory ([`RunMemory`]), not in the file: a
//!   stage can write the run folder, so a tick in `writeback.json` counts
//!   only when you gave it in this app session, with that exact comment and
//!   status. Ticks do not survive a restart.
//! - A rebuild ([`merge`]) never carries a tick onto content you did not
//!   see: a row whose comment or status changed is unticked. A row already
//!   sent stays as sent; when a later verification makes its ticket newly
//!   verified (or, unless you picked the status, adds its mapped status),
//!   it becomes an unticked follow-up. A verification answered again, or a
//!   later failure, makes no follow-up.
//! - [`send_requests`] sends only what you saw and ticked (plan decision
//!   E4): the UI names each row with its comment and status, and a row is
//!   sent only when the file and the memory both say exactly that and its
//!   ticket is in `tickets.json`. Each step is saved before the next call.
//!   A comment whose POST did not finish cleanly (a quit or crash mid-call,
//!   a timeout, a broken connection, a server error) is marked as maybe
//!   posted, and sending it again needs your confirmation.
//!   Nothing here holds a token: the [`ClickUp`] client keeps it.

use super::client::{ClickUp, ClickUpError, TaskRef};
use super::intake::{TicketList, TicketsSnapshot};
use super::transport::NoReply;
use crate::store::settings_store::ClickUpStatusMap;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};

/// The version of `writeback.json`.
pub const WRITEBACK_SCHEMA: u32 = 1;
/// The longest comment you can send.
pub const MAX_COMMENT_CHARS: usize = 10_000;
/// The longest status name accepted.
const MAX_STATUS_CHARS: usize = 100;
/// Ends a built comment that was cut to fit [`MAX_COMMENT_CHARS`].
const CUT_NOTE: &str = "\n\n(Cut to fit ClickUp's comment limit. The run's files have the rest.)";
/// Why a row you ticked was not sent: the file no longer says what you saw.
pub const CHANGED_SINCE_TICK: &str = "Changed since you ticked it. Review it and tick it again.";
/// Follows the error of a comment POST that ClickUp may still have acted on.
pub const MAYBE_POSTED: &str = "ClickUp may have posted the comment anyway, so check the ticket in ClickUp before sending it again.";
/// Why a row whose comment may have been posted is not sent without you.
pub const RESEND_NEEDS_CONFIRM: &str = "ClickUp may already have this comment: its last send did not finish cleanly. Check the ticket in ClickUp, then confirm to send it again.";

/// The ticket a proposal is for, as the snapshot has it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposalTicket {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_id: Option<String>,
    pub title: String,
    #[serde(default)]
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub list: Option<TicketList>,
}

/// What ClickUp has from this row: the last comment posted and the last
/// status set, and when.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sent {
    /// RFC 3339.
    pub at: String,
    /// The comment as posted; `None` when only a status was set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
    /// The status it was moved to, when one was set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

/// One ticket's proposal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    pub ticket: ProposalTicket,
    /// The lanes it was matched to (`pr1`); empty: the run's own stages.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub lanes: Vec<String>,
    pub comment: String,
    /// The status to move the ticket to; `None`: no status change.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// Why no status change is proposed, when there is none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_note: Option<String>,
    /// Every lane the ticket is matched to was marked verified.
    #[serde(default)]
    pub verified: bool,
    /// Send this row. Never set by the app, only by you.
    #[serde(default)]
    pub ticked: bool,
    /// You edited the comment, so a rebuild keeps yours.
    #[serde(default)]
    pub edited: bool,
    /// You picked the status, so a rebuild keeps yours.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub status_edited: bool,
    /// You skipped it: it is never sent until you take it back.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub skipped: bool,
    /// A follow-up to an update already sent: a later verification added
    /// to it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub follow_up: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sent: Option<Sent>,
    /// The last comment POST did not finish cleanly, so ClickUp may have it: ticking
    /// again needs you to confirm.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub sent_maybe: bool,
    /// The last send's plain-English error.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// The comment a follow-up would carry; [`build`] fills it for
    /// [`merge`], and it is never written.
    #[serde(skip)]
    pub follow_up_comment: Option<String>,
}

impl Proposal {
    /// Sent already, and nothing changed since: sending again would repeat it.
    pub fn sent_as_is(&self) -> bool {
        self.sent.as_ref().is_some_and(|sent| {
            sent.comment.as_deref() == Some(self.comment.as_str())
                && (self.status.is_none() || sent.status == self.status)
        })
    }
}

/// `runs/<runId>/writeback.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Writeback {
    pub schema: u32,
    pub run_id: String,
    pub proposals: Vec<Proposal>,
}

/// A pull request an Implementer reported.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PrLink {
    pub title: String,
    pub url: String,
}

/// How a lane was verified: your answer to its verify gate.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct VerifyFacts {
    pub verified: bool,
    pub steps: String,
    pub note: Option<String>,
    /// RFC 3339.
    pub at: String,
}

/// What the run's files say about one lane (or, with `id: None`, the run's
/// own stages when it never fanned out).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct LaneFacts {
    pub id: Option<String>,
    pub title: String,
    pub prs: Vec<PrLink>,
    /// The Implementer's summary of what changed.
    pub summary: Option<String>,
    /// The latest verify answer for the lane.
    pub verification: Option<VerifyFacts>,
    /// The labels of the checks that passed last.
    pub checks_passed: Vec<String>,
}

impl LaneFacts {
    fn verified(&self) -> Option<&VerifyFacts> {
        self.verification.as_ref().filter(|v| v.verified)
    }
}

/// What [`build`] reads about the run, copied out of the store and the run
/// folder beforehand.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RunFacts {
    pub run_id: String,
    pub complete: bool,
    /// The run's lanes, in order; empty when it never fanned out.
    pub lanes: Vec<LaneFacts>,
    /// The run's own stages: the lane when there are no lanes.
    pub own: LaneFacts,
    /// Task (lane) id → the ticket ids its plan names, when it names any.
    pub task_tickets: BTreeMap<String, Vec<String>>,
}

impl RunFacts {
    /// Proposals are due: a lane (or the run) was marked verified, or the
    /// run completed.
    pub fn due(&self) -> bool {
        self.complete
            || self
                .lanes
                .iter()
                .chain(std::iter::once(&self.own))
                .any(|lane| lane.verified().is_some())
    }
}

/// The lanes `ticket` is matched to, or why it is matched to none.
enum Match<'a> {
    Lanes(Vec<&'a LaneFacts>),
    Unmatched(&'static str),
}

fn match_ticket<'a>(facts: &'a RunFacts, id: &str, custom_id: Option<&str>) -> Match<'a> {
    let names = |tickets: &Vec<String>| {
        tickets.iter().any(|t| t == id || Some(t.as_str()) == custom_id)
    };
    if facts.task_tickets.values().any(|tickets| !tickets.is_empty()) {
        let tasks: Vec<&String> = facts
            .task_tickets
            .iter()
            .filter(|(_, tickets)| names(tickets))
            .map(|(task, _)| task)
            .collect();
        if tasks.is_empty() {
            return Match::Unmatched("No task in the plan names this ticket, so no status change is proposed.");
        }
        if facts.lanes.is_empty() {
            return Match::Lanes(vec![&facts.own]);
        }
        let lanes: Vec<&LaneFacts> = facts
            .lanes
            .iter()
            .filter(|lane| lane.id.as_ref().is_some_and(|lane| tasks.contains(&lane)))
            .collect();
        if lanes.is_empty() {
            return Match::Unmatched("The plan's task for this ticket has no lane in this run, so no status change is proposed.");
        }
        return Match::Lanes(lanes);
    }
    match facts.lanes.len() {
        0 => Match::Lanes(vec![&facts.own]),
        1 => Match::Lanes(vec![&facts.lanes[0]]),
        _ => Match::Unmatched("This run has several lanes and its plan does not say which ticket each one fixes, so no status change is proposed. Pick one yourself if you want it."),
    }
}

/// `2026-10-22` from an RFC 3339 time.
fn day(at: &str) -> &str {
    at.get(..10).unwrap_or(at)
}

/// `text`, cut to fit [`MAX_COMMENT_CHARS`] with a line saying so, so every
/// built comment stays sendable and editable.
fn fit(text: String) -> String {
    if text.chars().count() <= MAX_COMMENT_CHARS {
        return text;
    }
    let keep = MAX_COMMENT_CHARS - CUT_NOTE.chars().count();
    let mut out: String = text.chars().take(keep).collect();
    out.push_str(CUT_NOTE);
    out
}

fn pr_lines(prs: &[PrLink], out: &mut Vec<String>) {
    for pr in prs {
        match (pr.title.trim(), pr.url.trim()) {
            ("", url) => out.push(format!("- {url}")),
            (title, url) => out.push(format!("- {title}: {url}")),
        }
    }
}

/// How a lane was verified, in lines: your steps and note, else its checks.
fn verified_lines(lane: &LaneFacts, out: &mut Vec<String>) {
    match lane.verified() {
        Some(v) => {
            out.push(v.steps.trim().to_string());
            out.push(format!("Marked verified on {}.", day(&v.at)));
            if let Some(note) = v.note.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
                out.push(format!("Note: {note}"));
            }
        }
        None if !lane.checks_passed.is_empty() => {
            out.push(format!("Checks passed: {}.", lane.checks_passed.join(", ")));
        }
        None => out.push("Not verified yet.".to_string()),
    }
}

/// One lane's part of a comment: its pull requests, what changed, and how it
/// was verified.
fn lane_text(lane: &LaneFacts, heading: bool) -> String {
    let mut out = Vec::new();
    if heading && !lane.title.is_empty() {
        out.push(lane.title.clone());
    }
    if !lane.prs.is_empty() {
        out.push("Pull requests:".to_string());
        pr_lines(&lane.prs, &mut out);
    }
    if let Some(summary) = lane.summary.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        out.push(String::new());
        out.push("What changed:".to_string());
        out.push(summary.to_string());
    }
    out.push(String::new());
    out.push("How it was verified:".to_string());
    verified_lines(lane, &mut out);
    out.join("\n")
}

fn comment_for(facts: &RunFacts, lanes: &[&LaneFacts]) -> String {
    let heading = lanes.len() > 1;
    let mut parts = vec![format!("Update from DCTerminal (run {}).", facts.run_id)];
    parts.extend(lanes.iter().map(|lane| lane_text(lane, heading)));
    fit(parts.join("\n\n"))
}

/// A ticket the plan does not tie to a lane: a note with every pull request,
/// and no claim that it was verified.
fn unmatched_comment(facts: &RunFacts) -> String {
    let prs: Vec<PrLink> = facts
        .lanes
        .iter()
        .chain(std::iter::once(&facts.own))
        .flat_map(|lane| lane.prs.iter().cloned())
        .collect();
    let mut out = vec![format!("Update from DCTerminal (run {}).", facts.run_id)];
    if prs.is_empty() {
        out.push("This run has no pull requests yet.".to_string());
    } else {
        out.push("The plan does not say which of this run's pull requests is for this ticket. They are:".to_string());
        pr_lines(&prs, &mut out);
    }
    fit(out.join("\n"))
}

/// What a follow-up to a sent update says: the lanes now verified, and how.
fn follow_up_for(facts: &RunFacts, lanes: &[&LaneFacts]) -> String {
    let mut parts = vec![format!("Update from DCTerminal (run {}).", facts.run_id)];
    for lane in lanes {
        let Some(v) = lane.verified() else { continue };
        let who = if lane.title.is_empty() { "The work" } else { lane.title.as_str() };
        let mut lines = vec![format!("{who} was marked verified on {}.", day(&v.at))];
        lines.push(format!("How: {}", v.steps.trim()));
        if let Some(note) = v.note.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
            lines.push(format!("Note: {note}"));
        }
        parts.push(lines.join("\n"));
    }
    fit(parts.join("\n\n"))
}

/// One proposal per ticket of `snapshot`, from `facts`, with each list's
/// mapped status from `maps` (by list id). Empty when no proposal is due
/// yet ([`RunFacts::due`]). Pure: no file, no network.
pub fn build(
    snapshot: &TicketsSnapshot,
    facts: &RunFacts,
    maps: &BTreeMap<String, ClickUpStatusMap>,
) -> Vec<Proposal> {
    if !facts.due() {
        return Vec::new();
    }
    snapshot
        .tickets
        .iter()
        .map(|ticket| {
            let row = &ticket.row;
            let matched = match_ticket(facts, &row.id, row.custom_id.as_deref());
            let (lanes, unmatched) = match matched {
                Match::Lanes(lanes) => (lanes, None),
                Match::Unmatched(why) => (Vec::new(), Some(why)),
            };
            let verified = unmatched.is_none() && lanes.iter().all(|lane| lane.verified().is_some());
            let (status, status_note) = match (unmatched, verified, &ticket.list) {
                (Some(why), _, _) => (None, Some(why.to_string())),
                (None, false, _) => (None, Some("Not marked verified yet, so no status change is proposed.".to_string())),
                (None, true, None) => (None, Some("This run's tickets.json does not say which list the ticket is in (it was taken before write-back). Pull the ticket again to propose a status.".to_string())),
                (None, true, Some(list)) => match maps.get(&list.id) {
                    Some(map) => (Some(map.verified.clone()), None),
                    None => (None, Some(format!("Map a verified status for the list \"{}\" to propose one.", list_label(list)))),
                },
            };
            let (comment, follow_up_comment) = match unmatched {
                Some(_) => (unmatched_comment(facts), None),
                None => (comment_for(facts, &lanes), Some(follow_up_for(facts, &lanes))),
            };
            Proposal {
                ticket: ProposalTicket {
                    id: row.id.clone(),
                    custom_id: row.custom_id.clone(),
                    title: row.title.clone(),
                    url: row.url.clone(),
                    list: ticket.list.clone(),
                },
                lanes: lanes.iter().filter_map(|lane| lane.id.clone()).collect(),
                comment,
                status,
                status_note,
                verified,
                ticked: false,
                edited: false,
                status_edited: false,
                skipped: false,
                follow_up: false,
                sent: None,
                sent_maybe: false,
                error: None,
                follow_up_comment,
            }
        })
        .collect()
}

/// A list's name, or its id when it has none.
pub fn list_label(list: &TicketList) -> &str {
    if list.name.trim().is_empty() {
        &list.id
    } else {
        list.name.trim()
    }
}

/// The hash a remembered tick is kept under: the comment and status you
/// ticked.
fn tick_key(comment: &str, status: Option<&str>) -> String {
    // Each field is length-prefixed, so no two (comment, status) pairs share
    // a byte stream.
    let mut hash = Sha256::new();
    hash.update((comment.len() as u64).to_le_bytes());
    hash.update(comment.as_bytes());
    match status {
        Some(status) => {
            hash.update([1]);
            hash.update((status.len() as u64).to_le_bytes());
            hash.update(status.as_bytes());
        }
        None => hash.update([0]),
    }
    hash.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// What the app remembers about one run's rows for as long as it runs, out
/// of reach of anything that can write the run folder: the ticks you gave
/// (each with the comment and status you ticked) and the comments that may
/// have been posted. A tick in `writeback.json` counts only when it is
/// remembered here, so a tick written into the file by anything else (a
/// stage can write the run folder) never sends. Ticks are not kept across
/// a restart, on purpose.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RunMemory {
    /// Ticket id → the [`tick_key`] of what you ticked.
    ticks: HashMap<String, String>,
    /// Tickets whose comment may have been posted.
    maybe: HashSet<String>,
}

impl RunMemory {
    /// You ticked `ticket_id` with exactly this comment and status.
    pub fn has_tick(&self, ticket_id: &str, comment: &str, status: Option<&str>) -> bool {
        self.ticks.get(ticket_id) == Some(&tick_key(comment, status))
    }

    fn remember(&mut self, row: &Proposal) {
        if row.ticked {
            self.ticks
                .insert(row.ticket.id.clone(), tick_key(&row.comment, row.status.as_deref()));
        } else {
            self.ticks.remove(&row.ticket.id);
        }
    }

    pub fn maybe_posted(&self, ticket_id: &str) -> bool {
        self.maybe.contains(ticket_id)
    }

    fn set_maybe(&mut self, ticket_id: &str, maybe: bool) {
        if maybe {
            self.maybe.insert(ticket_id.to_string());
        } else {
            self.maybe.remove(ticket_id);
        }
    }
}

/// Puts the app's memory over rows read from the file: a tick you did not
/// give here is dropped, and a comment the app knows may have been posted
/// stays marked so, whatever the file says.
pub fn sanitize(rows: &mut [Proposal], memory: &mut RunMemory) {
    for row in rows.iter_mut() {
        // Latched both ways: a mark in the file (say, from before a
        // restart) is remembered, and only your confirmed resend clears it.
        if row.sent_maybe {
            memory.set_maybe(&row.ticket.id, true);
        }
        if memory.maybe_posted(&row.ticket.id) {
            row.sent_maybe = true;
        }
        if row.ticked && !memory.has_tick(&row.ticket.id, &row.comment, row.status.as_deref()) {
            row.ticked = false;
        }
        if !row.ticked {
            memory.ticks.remove(&row.ticket.id);
        }
    }
}

/// A sent row has something new to say: a status it has not set yet, or a
/// verification it did not have. When you picked the status yourself, only
/// a new verification counts: the mapped status never overrides yours.
fn needs_follow_up(prev: &Proposal, next: &Proposal) -> bool {
    let newly_verified = next.verified && !prev.verified;
    if prev.status_edited {
        return newly_verified;
    }
    let set = prev.sent.as_ref().and_then(|s| s.status.as_ref());
    (next.status.is_some() && next.status.as_ref() != set) || newly_verified
}

/// `fresh` proposals with what you did to the `old` ones kept: skips,
/// edits, and what was sent. A row you edited keeps your text. A tick is
/// kept only while it is one you gave in this app session ([`RunMemory`])
/// and the row's comment and status are what they were, so it never
/// carries onto content you did not see. A row sent as it is stays so,
/// unless the new build adds to it: then it becomes an unticked follow-up
/// that keeps your own status choice and your skip. Rows for tickets no
/// longer in the snapshot are dropped.
pub fn merge(old: Option<&Writeback>, fresh: Vec<Proposal>, memory: &mut RunMemory) -> Vec<Proposal> {
    let mut old_rows: Vec<Proposal> = old.map(|old| old.proposals.clone()).unwrap_or_default();
    sanitize(&mut old_rows, memory);
    let rows: Vec<Proposal> = fresh
        .into_iter()
        .map(|mut next| {
            let follow = next.follow_up_comment.take();
            let Some(prev) = old_rows.iter().find(|p| p.ticket.id == next.ticket.id) else {
                return next;
            };
            if prev.sent_as_is() && !prev.sent_maybe {
                if !needs_follow_up(prev, &next) {
                    let mut kept = prev.clone();
                    kept.ticket = next.ticket;
                    kept.ticked = false;
                    return kept;
                }
                let mut follow_up = Proposal {
                    comment: follow.unwrap_or(next.comment),
                    follow_up: true,
                    sent: prev.sent.clone(),
                    skipped: prev.skipped,
                    ..next
                };
                if prev.status_edited {
                    follow_up.status = prev.status.clone();
                    follow_up.status_note = prev.status_note.clone();
                    follow_up.status_edited = true;
                }
                return follow_up;
            }
            let generated = match (prev.follow_up, follow) {
                (true, Some(follow)) => follow,
                _ => next.comment.clone(),
            };
            next.comment = if prev.edited { prev.comment.clone() } else { generated };
            if prev.status_edited {
                next.status = prev.status.clone();
                next.status_note = prev.status_note.clone();
            }
            next.edited = prev.edited;
            next.status_edited = prev.status_edited;
            next.skipped = prev.skipped;
            next.follow_up = prev.follow_up;
            next.sent = prev.sent.clone();
            next.sent_maybe = prev.sent_maybe;
            next.error = prev.error.clone();
            next.ticked = prev.ticked && next.comment == prev.comment && next.status == prev.status;
            next
        })
        .collect();
    for row in &rows {
        if !row.ticked {
            memory.ticks.remove(&row.ticket.id);
        }
    }
    rows
}

/// A change you make to one row.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowEdit {
    #[serde(default)]
    pub comment: Option<String>,
    /// Change the status to `status`; with `status` left out or empty, the
    /// row proposes no status change.
    #[serde(default)]
    pub set_status: bool,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub ticked: Option<bool>,
    #[serde(default)]
    pub skipped: Option<bool>,
    /// You checked the ticket after a timed-out send and want it sent again.
    #[serde(default)]
    pub confirm_resend: bool,
}

/// A comment and status that are fine to send.
fn check_content(comment: &str, status: Option<&str>) -> Result<(), String> {
    if comment.trim().is_empty() {
        return Err("A comment cannot be empty.".into());
    }
    if comment.chars().count() > MAX_COMMENT_CHARS {
        return Err(format!("A comment can be at most {MAX_COMMENT_CHARS} characters."));
    }
    if status.is_some_and(|s| s.trim().is_empty() || s.chars().count() > MAX_STATUS_CHARS || s.chars().any(char::is_control)) {
        return Err("That is not a ClickUp status name.".into());
    }
    Ok(())
}

/// Applies `edit` to `ticket_id`'s row. Nothing changes on an error.
pub fn apply_edit(wb: &mut Writeback, ticket_id: &str, edit: &RowEdit) -> Result<(), String> {
    let row = wb
        .proposals
        .iter_mut()
        .find(|p| p.ticket.id == ticket_id)
        .ok_or("That ticket has no proposal in this run.")?;
    let mut next = row.clone();
    if let Some(comment) = &edit.comment {
        let comment = comment.trim();
        check_content(comment, None)?;
        if comment != next.comment {
            next.comment = comment.to_string();
            next.edited = true;
        }
    }
    if edit.set_status {
        let status = edit.status.as_deref().map(str::trim).filter(|s| !s.is_empty());
        check_content("x", status)?;
        let status = status.map(str::to_string);
        if status != next.status {
            next.status = status;
            next.status_note = None;
            next.status_edited = true;
        }
    }
    if let Some(skipped) = edit.skipped {
        next.skipped = skipped;
        if skipped {
            next.ticked = false;
        }
    }
    if let Some(ticked) = edit.ticked {
        if ticked && next.skipped {
            return Err("This row is skipped. Take it back first.".into());
        }
        if ticked && next.sent_as_is() {
            return Err("Already sent. Edit the comment or the status to send it again.".into());
        }
        if ticked && next.sent_maybe {
            if !edit.confirm_resend {
                return Err(RESEND_NEEDS_CONFIRM.into());
            }
            next.sent_maybe = false;
        }
        next.ticked = ticked;
    }
    *row = next;
    Ok(())
}

/// One row you ticked, as you saw it: the send goes ahead only if the file
/// still says exactly this.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendRequest {
    pub ticket_id: String,
    pub comment: String,
    #[serde(default)]
    pub status: Option<String>,
}

/// What one send did, by ticket id.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendReport {
    /// Ticket id and what was sent (`comment, status QA PASSED`).
    pub sent: Vec<(String, String)>,
    /// Ticket id and the plain-English error.
    pub failed: Vec<(String, String)>,
    /// Ticket id and why it was not sent at all (no call was made).
    pub not_sent: Vec<(String, String)>,
}

/// Your edit to one row, with the app's memory: a tick you give is
/// remembered with the comment and status you ticked, an untick forgets
/// it, and a confirmed resend forgets that the comment may have been
/// posted. The file's own ticks and flags are put under the memory first.
pub fn edit_row(wb: &mut Writeback, memory: &mut RunMemory, ticket_id: &str, edit: &RowEdit) -> Result<(), String> {
    sanitize(&mut wb.proposals, memory);
    apply_edit(wb, ticket_id, edit)?;
    if let Some(row) = wb.proposals.iter().find(|p| p.ticket.id == ticket_id) {
        if edit.confirm_resend && row.ticked {
            memory.set_maybe(ticket_id, false);
        }
        memory.remember(row);
    }
    Ok(())
}

/// The file's row for `request`, when it may be sent: its ticket is in
/// `tickets.json` (`tickets`), you ticked it in this app session with this
/// exact comment and status (`memory`), the file says the same and is not
/// skipped, it was not sent as it is, its comment is not one that may have
/// been posted, and its content passes the caps.
pub fn check_request(
    wb: &Writeback,
    memory: &RunMemory,
    tickets: &HashSet<String>,
    request: &SendRequest,
) -> Result<Proposal, String> {
    if !tickets.contains(&request.ticket_id) {
        return Err("This ticket is not in the run's tickets.json, so nothing was sent.".into());
    }
    let row = wb
        .proposals
        .iter()
        .find(|p| p.ticket.id == request.ticket_id)
        .ok_or(CHANGED_SINCE_TICK)?;
    let remembered = memory.has_tick(&request.ticket_id, &request.comment, request.status.as_deref());
    if !remembered || !row.ticked || row.skipped || row.comment != request.comment || row.status != request.status {
        return Err(CHANGED_SINCE_TICK.into());
    }
    if row.sent_maybe || memory.maybe_posted(&row.ticket.id) {
        return Err(RESEND_NEEDS_CONFIRM.into());
    }
    if row.sent_as_is() {
        return Err("Already sent.".into());
    }
    check_content(&row.comment, row.status.as_deref())?;
    Ok(row.clone())
}

/// An error after which ClickUp may still have acted on the POST: no clean
/// answer came back (timed out, or the connection broke mid-call: a reset,
/// a broken read), or the server failed while handling it. Only `Offline`
/// (the name did not resolve, the connection was never made) and ClickUp's
/// own refusals mean the comment was certainly not posted.
fn may_have_posted(err: &ClickUpError) -> bool {
    matches!(
        err,
        ClickUpError::NoReply(NoReply::Timeout | NoReply::Failed)
            | ClickUpError::Server(_)
            | ClickUpError::Unexpected(_)
    )
}

/// What ClickUp now has from `row`, at `now`.
fn sent_mut<'r>(row: &'r mut Proposal, now: &str) -> &'r mut Sent {
    let sent = row.sent.get_or_insert(Sent { at: now.to_string(), comment: None, status: None });
    sent.at = now.to_string();
    sent
}

/// `what` for the report: `comment, status QA PASSED`.
fn what_went(comment: bool, status: Option<&str>) -> String {
    match (comment, status) {
        (true, Some(status)) => format!("comment, status {status}"),
        (true, None) => "comment".to_string(),
        (false, Some(status)) => format!("status {status}"),
        (false, None) => "nothing new".to_string(),
    }
}

/// Where a send reads and saves `writeback.json` and the app's memory of
/// the run: [`RowStore::with`] runs `f` on both as they are now, and saves
/// the file when `f` returns true.
pub trait RowStore {
    fn with(&mut self, f: &mut dyn FnMut(&mut Writeback, &mut RunMemory) -> bool) -> Result<(), String>;
}

/// Sends each of `requests` that [`check_request`] allows, one at a time,
/// saving each step before the next call:
///
/// 1. the status, unless already set, and then that it was set;
/// 2. before the comment POST, the row is marked as maybe posted and
///    unticked (in the file and in memory), so a send cut short there (a
///    quit, a crash) never posts it again without your confirmation;
/// 3. the POST's result: posted (the mark is cleared), maybe posted (a
///    timeout, a broken connection or a server error: the mark stays), or
///    not posted (the mark is cleared and the row is ticked again to retry).
///
/// Nothing outside `requests` is ever sent, whatever the file's ticks say.
/// On a save failure it stops and returns what it did with the error.
pub fn send_requests(
    client: &ClickUp,
    store: &mut dyn RowStore,
    tickets: &HashSet<String>,
    requests: &[SendRequest],
    now: &dyn Fn() -> String,
) -> Result<SendReport, (SendReport, String)> {
    let mut report = SendReport::default();
    let mut seen = HashSet::new();
    macro_rules! save {
        ($f:expr) => {
            if let Err(err) = store.with(&mut $f) {
                return Err((report, err));
            }
        };
    }
    for request in requests {
        if !seen.insert(request.ticket_id.clone()) {
            continue;
        }
        let mut checked = Err(CHANGED_SINCE_TICK.to_string());
        save!(|wb: &mut Writeback, memory: &mut RunMemory| {
            checked = check_request(wb, memory, tickets, request);
            false
        });
        let row = match checked {
            Ok(row) => row,
            Err(why) => {
                report.not_sent.push((request.ticket_id.clone(), why));
                continue;
            }
        };
        let id = row.ticket.id.clone();
        let task = TaskRef::Id(id.clone());
        let sent_before = row.sent.clone();
        let mut status_set: Option<String> = None;
        if let Some(status) = &row.status {
            if sent_before.as_ref().and_then(|s| s.status.as_ref()) != Some(status) {
                if let Err(err) = client.set_status(&task, status) {
                    let err = err.to_string();
                    report.failed.push((id.clone(), err.clone()));
                    save!(|wb: &mut Writeback, _: &mut RunMemory| {
                        match wb.proposals.iter_mut().find(|p| p.ticket.id == id) {
                            Some(stored) => {
                                stored.error = Some(err.clone());
                                true
                            }
                            None => false,
                        }
                    });
                    continue;
                }
                status_set = Some(status.clone());
                let at = now();
                save!(|wb: &mut Writeback, _: &mut RunMemory| {
                    match wb.proposals.iter_mut().find(|p| p.ticket.id == id) {
                        Some(stored) => {
                            sent_mut(stored, &at).status = Some(status.clone());
                            true
                        }
                        None => false,
                    }
                });
            }
        }
        let posted_before = sent_before.as_ref().and_then(|s| s.comment.as_deref()) == Some(row.comment.as_str());
        if posted_before {
            report.sent.push((id.clone(), what_went(false, status_set.as_deref())));
            save!(|wb: &mut Writeback, memory: &mut RunMemory| {
                memory.ticks.remove(&id);
                match wb.proposals.iter_mut().find(|p| p.ticket.id == id) {
                    Some(stored) => {
                        stored.ticked = false;
                        stored.error = None;
                        stored.follow_up = false;
                        true
                    }
                    None => false,
                }
            });
            continue;
        }
        // From here on, until ClickUp answers cleanly, the comment may be posted.
        save!(|wb: &mut Writeback, memory: &mut RunMemory| {
            memory.ticks.remove(&id);
            memory.set_maybe(&id, true);
            match wb.proposals.iter_mut().find(|p| p.ticket.id == id) {
                Some(stored) => {
                    stored.sent_maybe = true;
                    stored.ticked = false;
                    true
                }
                None => false,
            }
        });
        let posted = client.post_comment(&task, &row.comment);
        let at = now();
        let suffix = status_set.as_ref().map(|s| format!(" (Its status was set to {s}.)")).unwrap_or_default();
        match posted {
            Ok(()) => {
                report.sent.push((id.clone(), what_went(true, status_set.as_deref())));
                save!(|wb: &mut Writeback, memory: &mut RunMemory| {
                    memory.set_maybe(&id, false);
                    match wb.proposals.iter_mut().find(|p| p.ticket.id == id) {
                        Some(stored) => {
                            sent_mut(stored, &at).comment = Some(row.comment.clone());
                            stored.sent_maybe = false;
                            stored.error = None;
                            stored.follow_up = false;
                            true
                        }
                        None => false,
                    }
                });
            }
            Err(err) if may_have_posted(&err) => {
                let message = format!("{err} {MAYBE_POSTED}");
                report.failed.push((id.clone(), format!("{message}{suffix}")));
                save!(|wb: &mut Writeback, _: &mut RunMemory| {
                    match wb.proposals.iter_mut().find(|p| p.ticket.id == id) {
                        Some(stored) => {
                            stored.error = Some(message.clone());
                            true
                        }
                        None => false,
                    }
                });
            }
            Err(err) => {
                let message = err.to_string();
                report.failed.push((id.clone(), format!("{message}{suffix}")));
                save!(|wb: &mut Writeback, memory: &mut RunMemory| {
                    memory.set_maybe(&id, false);
                    match wb.proposals.iter_mut().find(|p| p.ticket.id == id) {
                        Some(stored) => {
                            stored.sent_maybe = false;
                            stored.error = Some(message.clone());
                            // Not posted: ticked again to retry, but only
                            // when the row is still what you ticked.
                            if stored.comment == row.comment && stored.status == row.status {
                                stored.ticked = true;
                                memory
                                    .ticks
                                    .insert(id.clone(), tick_key(&row.comment, row.status.as_deref()));
                            }
                            true
                        }
                        None => false,
                    }
                });
            }
        }
    }
    Ok(report)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::clickup::client::tests::{ok, status, FakeClock, Recorded};
    use crate::clickup::intake::{SnapshotLimits, SnapshotSource, Ticket, TicketRow, LIMITS};
    use crate::clickup::{ClickUpToken, Gate};

    const RUN: &str = "ee_1760000000300";
    const NOW: &str = "2026-10-22T12:00:00.000Z";

    pub(crate) fn ticket(id: &str, custom: Option<&str>, list: Option<&str>) -> Ticket {
        Ticket {
            row: TicketRow {
                id: id.into(),
                custom_id: custom.map(str::to_string),
                title: format!("Ticket {id}"),
                priority: "high".into(),
                status: "to do".into(),
                status_type: "open".into(),
                url: format!("https://app.clickup.com/t/{id}"),
            },
            description: String::new(),
            description_truncated: false,
            comments: Vec::new(),
            comments_truncated: false,
            tags: Vec::new(),
            parent_id: None,
            date_updated: None,
            list: list.map(|id| TicketList { id: id.into(), name: "QA 1.2.8".into() }),
        }
    }

    pub(crate) fn snapshot(tickets: Vec<Ticket>) -> TicketsSnapshot {
        TicketsSnapshot {
            schema: 1,
            source: SnapshotSource {
                kind: "clickup".into(),
                account_id: "default".into(),
                workspace_id: "9012345678".into(),
                refs: Vec::new(),
                filters: Default::default(),
            },
            fetched_at: NOW.into(),
            limits: SnapshotLimits { limits: LIMITS, note: String::new() },
            tickets,
            excluded: Vec::new(),
            pulls: Vec::new(),
        }
    }

    fn lane(id: Option<&str>, verified: Option<bool>) -> LaneFacts {
        let n = id.unwrap_or("own");
        LaneFacts {
            id: id.map(str::to_string),
            title: format!("{} — Work", n.to_uppercase()),
            prs: vec![PrLink { title: format!("Fix {n}"), url: format!("https://github.com/o/r/pull/{}", n.len()) }],
            summary: Some(format!("Changed {n}.")),
            verification: verified.map(|verified| VerifyFacts {
                verified,
                steps: "Run the qa128 Playwright project on Windows staging.".into(),
                note: verified.then(|| "All green.".to_string()),
                at: NOW.into(),
            }),
            checks_passed: vec!["npm run check".into()],
        }
    }

    fn maps() -> BTreeMap<String, ClickUpStatusMap> {
        BTreeMap::from([(
            "901800112233".to_string(),
            ClickUpStatusMap { verified: "QA PASSED".into(), list_name: "QA 1.2.8".into() },
        )])
    }

    fn facts(lanes: Vec<LaneFacts>, own: LaneFacts) -> RunFacts {
        RunFacts { run_id: RUN.into(), complete: false, lanes, own, task_tickets: BTreeMap::new() }
    }

    /// A run's file and the app's memory of it, as the commands keep them.
    #[derive(Debug, Clone, PartialEq, Eq)]
    struct Rows {
        wb: Writeback,
        memory: RunMemory,
    }

    impl RowStore for Rows {
        fn with(&mut self, f: &mut dyn FnMut(&mut Writeback, &mut RunMemory) -> bool) -> Result<(), String> {
            f(&mut self.wb, &mut self.memory);
            Ok(())
        }
    }

    impl Rows {
        fn new(proposals: Vec<Proposal>) -> Self {
            let mut memory = RunMemory::default();
            let proposals = merge(None, proposals, &mut memory);
            Rows { wb: Writeback { schema: WRITEBACK_SCHEMA, run_id: RUN.into(), proposals }, memory }
        }

        fn edit(&mut self, id: &str, edit: RowEdit) -> Result<(), String> {
            edit_row(&mut self.wb, &mut self.memory, id, &edit)
        }

        fn tick(&mut self, id: &str) {
            self.edit(id, RowEdit { ticked: Some(true), ..Default::default() }).unwrap();
        }

        fn rebuild(&mut self, fresh: Vec<Proposal>) {
            let old = self.wb.clone();
            self.wb.proposals = merge(Some(&old), fresh, &mut self.memory);
        }

        fn row(&self, id: &str) -> &Proposal {
            self.wb.proposals.iter().find(|p| p.ticket.id == id).unwrap()
        }

        fn row_mut(&mut self, id: &str) -> &mut Proposal {
            self.wb.proposals.iter_mut().find(|p| p.ticket.id == id).unwrap()
        }
    }

    fn ids(list: &[&str]) -> HashSet<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    /// What the UI sends for a row it shows ticked.
    fn req(p: &Proposal) -> SendRequest {
        SendRequest { ticket_id: p.ticket.id.clone(), comment: p.comment.clone(), status: p.status.clone() }
    }

    fn shown(rows: &Rows) -> Vec<SendRequest> {
        let mut view = rows.wb.proposals.clone();
        sanitize(&mut view, &mut rows.memory.clone());
        view.iter().filter(|p| p.ticked && !p.skipped).map(req).collect()
    }

    fn token() -> ClickUpToken {
        ClickUpToken::parse("pk_test_WRITEBACK").unwrap()
    }

    /// Sends what the UI shows ticked, for tickets `in_snapshot`.
    fn send(api: &Recorded, rows: &mut Rows, in_snapshot: &[&str]) -> SendReport {
        let requests = shown(rows);
        send_with(api, rows, in_snapshot, &requests)
    }

    fn send_with(api: &Recorded, rows: &mut Rows, in_snapshot: &[&str], requests: &[SendRequest]) -> SendReport {
        let (gate, clock, token) = (Gate::new(), FakeClock::at(1_790_000_000), token());
        send_requests(&ClickUp::with(api, &token, &gate, &clock), rows, &ids(in_snapshot), requests, &|| NOW.to_string()).unwrap()
    }

    #[test]
    fn nothing_is_proposed_before_a_verification_or_the_run_s_end() {
        let snap = snapshot(vec![ticket("t1", None, Some("901800112233"))]);
        let mut run = facts(vec![], lane(None, None));
        assert!(build(&snap, &run, &maps()).is_empty());
        run.own.verification = Some(VerifyFacts { verified: false, ..Default::default() });
        assert!(build(&snap, &run, &maps()).is_empty(), "a failed verification is not a trigger");
        run.complete = true;
        assert_eq!(build(&snap, &run, &maps()).len(), 1);
    }

    #[test]
    fn a_single_lane_s_verified_tickets_get_the_comment_and_the_mapped_status() {
        let snap = snapshot(vec![
            ticket("t1", Some("QA-1"), Some("901800112233")),
            ticket("t2", None, Some("901800112233")),
        ]);
        let run = facts(vec![lane(Some("pr1"), Some(true))], lane(None, None));
        let proposals = build(&snap, &run, &maps());
        assert_eq!(proposals.len(), 2, "one per ticket");
        let first = &proposals[0];
        assert_eq!(first.lanes, ["pr1"]);
        assert!(first.verified);
        assert_eq!(first.status.as_deref(), Some("QA PASSED"));
        assert_eq!(first.status_note, None);
        assert!(!first.ticked, "never ticked by the app");
        assert_eq!(
            first.comment,
            format!(
                "Update from DCTerminal (run {RUN}).\n\nPull requests:\n- Fix pr1: https://github.com/o/r/pull/3\n\nWhat changed:\nChanged pr1.\n\nHow it was verified:\nRun the qa128 Playwright project on Windows staging.\nMarked verified on 2026-10-22.\nNote: All green."
            )
        );
        let own = facts(vec![], lane(None, Some(true)));
        let proposals = build(&snap, &own, &maps());
        assert!(proposals[0].lanes.is_empty());
        assert_eq!(proposals[0].status.as_deref(), Some("QA PASSED"));
    }

    #[test]
    fn a_completed_run_that_was_not_verified_proposes_a_comment_with_its_checks_and_no_status() {
        let snap = snapshot(vec![ticket("t1", None, Some("901800112233"))]);
        let mut run = facts(vec![lane(Some("pr1"), None)], lane(None, None));
        run.complete = true;
        let p = &build(&snap, &run, &maps())[0];
        assert!(!p.verified);
        assert_eq!(p.status, None);
        assert_eq!(p.status_note.as_deref(), Some("Not marked verified yet, so no status change is proposed."));
        assert!(p.comment.ends_with("How it was verified:\nChecks passed: npm run check."), "{}", p.comment);
        run.lanes[0].checks_passed.clear();
        let p = &build(&snap, &run, &maps())[0];
        assert!(p.comment.ends_with("Not verified yet."), "{}", p.comment);
    }

    #[test]
    fn several_lanes_with_no_ticket_mapping_list_every_pr_and_claim_no_verification() {
        let snap = snapshot(vec![ticket("t1", None, Some("901800112233"))]);
        let run = facts(vec![lane(Some("pr1"), Some(true)), lane(Some("pr2"), Some(true))], lane(None, None));
        let p = &build(&snap, &run, &maps())[0];
        assert_eq!(p.status, None);
        assert!(!p.verified && p.lanes.is_empty());
        assert!(p.status_note.as_deref().unwrap().contains("several lanes"), "{:?}", p.status_note);
        assert_eq!(
            p.comment,
            format!("Update from DCTerminal (run {RUN}).\nThe plan does not say which of this run's pull requests is for this ticket. They are:\n- Fix pr1: https://github.com/o/r/pull/3\n- Fix pr2: https://github.com/o/r/pull/3\n- Fix own: https://github.com/o/r/pull/3")
        );
        assert!(!p.comment.contains("verified"), "an unmatched ticket claims nothing");
    }

    #[test]
    fn task_tickets_match_tickets_to_their_lanes_and_only_verified_lanes_get_a_status() {
        let snap = snapshot(vec![
            ticket("t1", None, Some("901800112233")),
            ticket("t2", Some("QA-2"), Some("901800112233")),
            ticket("t3", None, Some("901800112233")),
            ticket("t4", None, Some("901800112233")),
        ]);
        let mut run = facts(vec![lane(Some("pr1"), Some(true)), lane(Some("pr2"), None)], lane(None, None));
        run.task_tickets = BTreeMap::from([
            ("pr1".to_string(), vec!["t1".to_string(), "t3".to_string()]),
            ("pr2".to_string(), vec!["QA-2".to_string(), "t3".to_string()]),
        ]);
        let by_id = |id: &str| build(&snap, &run, &maps()).into_iter().find(|p| p.ticket.id == id).unwrap();
        let t1 = by_id("t1");
        assert_eq!((t1.lanes.clone(), t1.status.as_deref()), (vec!["pr1".to_string()], Some("QA PASSED")));
        assert!(t1.comment.contains("Fix pr1") && !t1.comment.contains("Fix pr2"));
        let t2 = by_id("t2");
        assert_eq!((t2.lanes.clone(), t2.status.clone()), (vec!["pr2".to_string()], None));
        assert!(t2.status_note.as_deref().unwrap().starts_with("Not marked verified"));
        let t3 = by_id("t3");
        assert_eq!(t3.lanes, ["pr1", "pr2"]);
        assert_eq!(t3.status, None, "verified only when every lane it is in is");
        let t4 = by_id("t4");
        assert!(t4.lanes.is_empty() && t4.status.is_none());
        assert!(t4.status_note.as_deref().unwrap().contains("No task in the plan names this ticket"));
        assert!(!t4.comment.contains("Marked verified"));
    }

    #[test]
    fn a_list_with_no_mapping_or_a_ticket_with_no_list_says_what_to_do() {
        let snap = snapshot(vec![ticket("t1", None, Some("777")), ticket("t2", None, None)]);
        let run = facts(vec![], lane(None, Some(true)));
        let proposals = build(&snap, &run, &maps());
        assert_eq!(proposals[0].status, None);
        assert_eq!(
            proposals[0].status_note.as_deref(),
            Some("Map a verified status for the list \"QA 1.2.8\" to propose one.")
        );
        assert!(proposals[0].verified, "verified, only unmapped");
        assert!(proposals[1].status_note.as_deref().unwrap().contains("Pull the ticket again"));
    }

    #[test]
    fn a_built_comment_is_cut_to_fit_and_says_so() {
        let snap = snapshot(vec![ticket("t1", None, Some("901800112233"))]);
        let mut own = lane(None, Some(true));
        own.summary = Some("x".repeat(MAX_COMMENT_CHARS * 2));
        let p = build(&snap, &facts(vec![], own), &maps()).remove(0);
        assert_eq!(p.comment.chars().count(), MAX_COMMENT_CHARS);
        assert!(p.comment.ends_with("(Cut to fit ClickUp's comment limit. The run's files have the rest.)"));
        let mut rows = Rows::new(vec![p]);
        rows.tick("t1");
        assert!(check_request(&rows.wb, &rows.memory, &ids(&["t1"]), &req(rows.row("t1"))).is_ok(), "still sendable");
    }

    /// Proposals as a load writes them (the follow-up text is never kept).
    fn built() -> Vec<Proposal> {
        let snap = snapshot(vec![ticket("t1", None, Some("901800112233")), ticket("t2", None, Some("901800112233"))]);
        build(&snap, &facts(vec![], lane(None, Some(true))), &maps())
    }

    #[test]
    fn a_rebuild_keeps_your_edits_and_a_tick_only_on_unchanged_content() {
        let mut rows = Rows::new(built());
        rows.edit("t1", RowEdit { comment: Some("Mine.".into()), ticked: Some(true), ..Default::default() }).unwrap();
        rows.edit("t2", RowEdit { set_status: true, status: None, skipped: Some(true), ..Default::default() }).unwrap();
        rows.rebuild(built());
        assert_eq!((rows.row("t1").comment.as_str(), rows.row("t1").ticked, rows.row("t1").edited), ("Mine.", true, true));
        assert_eq!((rows.row("t2").status.clone(), rows.row("t2").skipped), (None, true));
        let mut fresh = built();
        for p in &mut fresh {
            p.comment.push_str("\nMore.");
        }
        rows.rebuild(fresh);
        assert!(rows.row("t1").ticked, "your own text did not change");
        assert!(rows.row("t2").comment.ends_with("More."), "not edited: rebuilt");
    }

    #[test]
    fn a_tick_forged_into_the_file_is_dropped_and_never_sent() {
        let mut rows = Rows::new(built());
        // A stage rewrites the row: your-edit flag, its own comment, a tick.
        let forged = rows.row_mut("t1");
        forged.comment = "Approved by QA, close it.".into();
        forged.edited = true;
        forged.ticked = true;
        let echoed = req(rows.row("t1"));
        rows.rebuild(built());
        assert!(!rows.row("t1").ticked, "no tick you gave: unticked on load");
        assert_eq!(rows.row("t1").comment, "Approved by QA, close it.", "the text stays, for you to see");
        // Even if the UI echoed it back as ticked, it is not sent.
        rows.row_mut("t1").ticked = true;
        let api = Recorded::default();
        let report = send_with(&api, &mut rows, &["t1", "t2"], &[echoed]);
        assert_eq!(report.not_sent, [("t1".to_string(), CHANGED_SINCE_TICK.to_string())]);
        assert!(api.writes.lock().unwrap().is_empty());
        // Once you tick it yourself, it is yours to send.
        rows.row_mut("t1").ticked = false;
        rows.tick("t1");
        assert!(check_request(&rows.wb, &rows.memory, &ids(&["t1"]), &req(rows.row("t1"))).is_ok());
    }

    /// t3 is in pr1 and pr2: pr1 verified first, pr2 later.
    fn t3_build(pr2_verified: bool) -> Vec<Proposal> {
        let snap = snapshot(vec![ticket("t3", None, Some("901800112233"))]);
        let mut run = facts(
            vec![lane(Some("pr1"), Some(true)), lane(Some("pr2"), pr2_verified.then_some(true))],
            lane(None, None),
        );
        run.task_tickets = BTreeMap::from([
            ("pr1".to_string(), vec!["t3".to_string()]),
            ("pr2".to_string(), vec!["t3".to_string()]),
        ]);
        build(&snap, &run, &maps())
    }

    #[test]
    fn a_tick_on_an_interim_row_does_not_survive_a_rebuild_that_adds_a_status() {
        let mut rows = Rows::new(t3_build(false));
        assert_eq!(rows.row("t3").status, None, "interim: no status yet");
        rows.tick("t3");
        let seen = req(rows.row("t3"));
        rows.rebuild(t3_build(true));
        assert_eq!(rows.row("t3").status.as_deref(), Some("QA PASSED"));
        assert!(!rows.row("t3").ticked, "changed content is unticked");
        rows.row_mut("t3").ticked = true;
        assert_eq!(check_request(&rows.wb, &rows.memory, &ids(&["t3"]), &seen).unwrap_err(), CHANGED_SINCE_TICK);
    }

    #[test]
    fn a_sent_row_gets_an_unticked_follow_up_when_a_later_lane_is_verified() {
        let mut rows = Rows::new(t3_build(false));
        rows.tick("t3");
        let api = Recorded::default()
            .on("POST /task/t3/comment", ok("{}".into()))
            .on("PUT /task/t3", ok("{}".into()))
            .on("POST /task/t3/comment", ok("{}".into()));
        assert_eq!(send(&api, &mut rows, &["t3"]).sent, [("t3".to_string(), "comment".to_string())]);
        let interim = rows.row("t3").comment.clone();
        rows.rebuild(t3_build(true));
        let row = rows.row("t3").clone();
        assert!(row.follow_up && !row.ticked);
        assert!(row.verified && row.status_note.is_none());
        assert_eq!(row.status.as_deref(), Some("QA PASSED"));
        assert_eq!(row.sent.as_ref().and_then(|s| s.comment.as_deref()), Some(interim.as_str()), "what was sent stays");
        assert!(row.comment.contains("PR2 — Work was marked verified on 2026-10-22."), "{}", row.comment);
        assert!(!row.comment.contains("Pull requests:"), "a short follow-up: {}", row.comment);
        let before = rows.clone();
        rows.rebuild(t3_build(true));
        assert_eq!(rows, before, "a second rebuild keeps the follow-up as it is");
        rows.tick("t3");
        assert_eq!(send(&api, &mut rows, &["t3"]).sent, [("t3".to_string(), "comment, status QA PASSED".to_string())]);
        assert!(!rows.row("t3").follow_up);
        let before = rows.clone();
        rows.rebuild(t3_build(true));
        assert_eq!(rows, before, "nothing new to say after that");
    }

    #[test]
    fn your_own_status_choice_is_never_overridden_by_a_follow_up() {
        // Verified, but you chose no status change: sent, and no follow-up for the mapped status.
        let mut rows = Rows::new(built());
        rows.edit("t1", RowEdit { set_status: true, status: None, ticked: Some(true), ..Default::default() }).unwrap();
        let api = Recorded::default()
            .on("POST /task/t1/comment", ok("{}".into()))
            .on("PUT /task/t3", ok("{}".into()))
            .on("POST /task/t3/comment", ok("{}".into()))
            .on("POST /task/t3/comment", ok("{}".into()));
        send(&api, &mut rows, &["t1", "t2"]);
        let before = rows.clone();
        rows.rebuild(built());
        assert_eq!(rows, before, "no follow-up: you chose no status change");
        // Your own status on an interim row, then a newly verified lane: a follow-up that keeps your status.
        let mut rows = Rows::new(t3_build(false));
        rows.edit("t3", RowEdit { set_status: true, status: Some("in review".into()), ticked: Some(true), ..Default::default() }).unwrap();
        send(&api, &mut rows, &["t3"]);
        rows.rebuild(t3_build(false));
        assert!(!rows.row("t3").follow_up, "the mapped status alone is no reason");
        rows.rebuild(t3_build(true));
        let row = rows.row("t3");
        assert!(row.follow_up && !row.ticked);
        assert_eq!(row.status.as_deref(), Some("in review"));
        assert!(row.status_edited);
    }

    #[test]
    fn edits_are_checked() {
        let mut rows = Rows::new(built());
        let long = "x".repeat(MAX_COMMENT_CHARS + 1);
        for (edit, err) in [
            (RowEdit { comment: Some("  ".into()), ..Default::default() }, "A comment cannot be empty."),
            (RowEdit { comment: Some(long), ..Default::default() }, "A comment can be at most 10000 characters."),
            (RowEdit { set_status: true, status: Some("a\nb".into()), ..Default::default() }, "That is not a ClickUp status name."),
        ] {
            assert_eq!(rows.edit("t1", edit).unwrap_err(), err);
        }
        assert_eq!(rows.edit("nope", RowEdit::default()).unwrap_err(), "That ticket has no proposal in this run.");
        rows.edit("t1", RowEdit { skipped: Some(true), ..Default::default() }).unwrap();
        assert!(rows.edit("t1", RowEdit { ticked: Some(true), ..Default::default() }).unwrap_err().contains("skipped"));
        let mut expected = Rows::new(built());
        expected.row_mut("t1").skipped = true;
        assert_eq!(rows, expected);
    }

    #[test]
    fn unticked_rows_and_ticks_written_into_the_file_make_no_call() {
        let mut rows = Rows::new(built());
        rows.tick("t2");
        rows.edit("t2", RowEdit { ticked: Some(false), skipped: Some(true), ..Default::default() }).unwrap();
        let api = Recorded::default();
        assert_eq!(send(&api, &mut rows, &["t1", "t2"]), SendReport::default());
        rows.row_mut("t1").ticked = true;
        assert_eq!(send_with(&api, &mut rows, &["t1", "t2"], &[]), SendReport::default());
        let skipped = req(rows.row("t2"));
        let report = send_with(&api, &mut rows, &["t1", "t2"], &[skipped]);
        assert_eq!(report.not_sent, [("t2".to_string(), CHANGED_SINCE_TICK.to_string())]);
        assert!(api.calls.lock().unwrap().is_empty() && api.writes.lock().unwrap().is_empty());
    }

    #[test]
    fn a_row_injected_into_the_file_or_content_you_did_not_see_is_never_sent() {
        let mut rows = Rows::new(built());
        let mut foreign = rows.row("t1").clone();
        foreign.ticket.id = "evil1".into();
        foreign.ticked = true;
        rows.wb.proposals.push(foreign.clone());
        rows.tick("t1");
        rows.tick("t2");
        let seen = req(rows.row("t1"));
        rows.row_mut("t1").comment = "Something else.".into();
        rows.row_mut("t2").comment = "x".repeat(MAX_COMMENT_CHARS + 1);
        let over = req(rows.row("t2"));
        let api = Recorded::default();
        let report = send_with(&api, &mut rows, &["t1", "t2"], &[seen, req(&foreign), over]);
        assert_eq!(report.not_sent.len(), 3, "{report:?}");
        assert_eq!(report.not_sent[0].1, CHANGED_SINCE_TICK);
        assert!(report.not_sent[1].1.contains("not in the run's tickets.json"));
        assert_eq!(report.not_sent[2].1, CHANGED_SINCE_TICK, "not what you ticked");
        assert!(api.writes.lock().unwrap().is_empty());
    }

    #[test]
    fn a_ticked_row_sends_its_status_then_its_comment_and_is_recorded() {
        let mut rows = Rows::new(built());
        rows.tick("t1");
        let api = Recorded::default()
            .on("PUT /task/t1", ok("{}".into()))
            .on("POST /task/t1/comment", ok("{}".into()));
        let report = send(&api, &mut rows, &["t1", "t2"]);
        assert_eq!(report.sent, [("t1".to_string(), "comment, status QA PASSED".to_string())]);
        let writes = api.writes.lock().unwrap().clone();
        assert_eq!(writes.len(), 2, "t2 was not ticked");
        assert_eq!((writes[0].method, writes[0].path.as_str()), ("PUT", "/task/t1"));
        assert_eq!(writes[0].body, serde_json::json!({ "status": "QA PASSED" }));
        assert_eq!((writes[1].method, writes[1].path.as_str()), ("POST", "/task/t1/comment"));
        assert_eq!(writes[1].body["comment_text"], serde_json::json!(rows.row("t1").comment));
        assert_eq!(writes[1].body["notify_all"], serde_json::json!(false));
        let row = rows.row("t1");
        assert_eq!(row.sent, Some(Sent { at: NOW.into(), comment: Some(row.comment.clone()), status: Some("QA PASSED".into()) }));
        assert!(!row.ticked && row.error.is_none() && !row.sent_maybe);
        assert!(!rows.memory.has_tick("t1", &row.comment, row.status.as_deref()), "the tick is spent");
    }

    #[test]
    fn a_failed_row_keeps_its_error_and_its_tick_and_a_retry_sends_it() {
        let mut rows = Rows::new(built());
        rows.tick("t1");
        let api = Recorded::default()
            .on("PUT /task/t1", status(400))
            .on("PUT /task/t1", ok("{}".into()))
            .on("POST /task/t1/comment", status(400))
            .on("PUT /task/t1", ok("{}".into()))
            .on("POST /task/t1/comment", ok("{}".into()));
        let first = send(&api, &mut rows, &["t1"]);
        assert!(first.failed[0].1.starts_with("ClickUp refused the change (HTTP 400)"), "{first:?}");
        assert!(rows.row("t1").ticked && rows.row("t1").sent.is_none());
        assert_eq!(api.writes.lock().unwrap().len(), 1, "no comment after the status failed");
        // A comment ClickUp refused was not posted: still ticked, no confirm needed.
        let second = send(&api, &mut rows, &["t1"]);
        assert!(second.failed[0].1.ends_with("(Its status was set to QA PASSED.)"), "{second:?}");
        assert!(rows.row("t1").ticked && !rows.row("t1").sent_maybe);
        let third = send(&api, &mut rows, &["t1"]);
        assert_eq!(third.sent.len(), 1);
        assert!(rows.row("t1").error.is_none());
        let puts = api.writes.lock().unwrap().iter().filter(|w| w.method == "PUT").count();
        assert_eq!(puts, 2, "the status recorded as set is not set again");
    }

    #[test]
    fn a_comment_post_that_did_not_finish_cleanly_needs_your_confirmation_to_resend() {
        for (reply, label) in [
            (Err(NoReply::Timeout), "timeout"),
            (Err(NoReply::Failed), "broken connection"),
            (status(502), "server error"),
            (status(418), "unexpected answer"),
        ] {
            let mut rows = Rows::new(built());
            rows.edit("t2", RowEdit { set_status: true, status: None, ticked: Some(true), ..Default::default() }).unwrap();
            let api = Recorded::default()
                .on("POST /task/t2/comment", reply)
                .on("POST /task/t2/comment", ok("{}".into()));
            let first = send(&api, &mut rows, &["t2"]);
            assert!(first.failed[0].1.ends_with(MAYBE_POSTED), "{label}: {first:?}");
            assert!(rows.row("t2").sent_maybe && !rows.row("t2").ticked, "{label}");
            let tick = RowEdit { ticked: Some(true), ..Default::default() };
            assert_eq!(rows.edit("t2", tick.clone()).unwrap_err(), RESEND_NEEDS_CONFIRM, "{label}");
            // A file rewritten to clear the mark and tick the row is not enough while the app runs.
            rows.row_mut("t2").sent_maybe = false;
            rows.row_mut("t2").ticked = true;
            assert_eq!(rows.edit("t2", tick.clone()).unwrap_err(), RESEND_NEEDS_CONFIRM, "{label}");
            assert_eq!(send(&api, &mut rows, &["t2"]).not_sent.len(), 0, "{label}: not shown ticked");
            assert_eq!(api.writes.lock().unwrap().len(), 1, "{label}");
            rows.edit("t2", RowEdit { confirm_resend: true, ..tick }).unwrap();
            assert_eq!(send(&api, &mut rows, &["t2"]).sent.len(), 1, "{label}");
            assert!(!rows.row("t2").sent_maybe && !rows.memory.maybe_posted("t2"), "{label}");
        }
    }

    #[test]
    fn a_comment_that_certainly_did_not_go_stays_ticked_without_a_mark() {
        let mut rows = Rows::new(built());
        rows.edit("t2", RowEdit { set_status: true, status: None, ticked: Some(true), ..Default::default() }).unwrap();
        let api = Recorded::default()
            .on("POST /task/t2/comment", Err(NoReply::Offline))
            .on("POST /task/t2/comment", ok("{}".into()));
        let first = send(&api, &mut rows, &["t2"]);
        assert_eq!(first.failed[0].1, "Could not reach ClickUp. Check your connection.");
        assert!(rows.row("t2").ticked && !rows.row("t2").sent_maybe && !rows.memory.maybe_posted("t2"));
        assert_eq!(send(&api, &mut rows, &["t2"]).sent.len(), 1, "retried without a confirmation");
    }

    #[test]
    fn a_maybe_posted_mark_in_the_file_is_latched_until_you_confirm() {
        // As after a restart: the file has the mark, the memory is new.
        let mut rows = Rows::new(built());
        rows.row_mut("t1").sent_maybe = true;
        let tick = RowEdit { ticked: Some(true), ..Default::default() };
        assert_eq!(rows.edit("t1", tick.clone()).unwrap_err(), RESEND_NEEDS_CONFIRM);
        assert!(rows.memory.maybe_posted("t1"), "latched");
        rows.row_mut("t1").sent_maybe = false;
        assert_eq!(rows.edit("t1", tick.clone()).unwrap_err(), RESEND_NEEDS_CONFIRM, "clearing the file is not enough");
        rows.edit("t1", RowEdit { confirm_resend: true, ..tick }).unwrap();
        assert!(!rows.memory.maybe_posted("t1") && rows.row("t1").ticked);
    }

    /// Changes `t2`'s comment in the file just before the `at`th step.
    struct Meddling {
        rows: Rows,
        calls: usize,
        at: usize,
    }

    impl RowStore for Meddling {
        fn with(&mut self, f: &mut dyn FnMut(&mut Writeback, &mut RunMemory) -> bool) -> Result<(), String> {
            self.calls += 1;
            if self.calls == self.at {
                self.rows.row_mut("t2").comment = "Rewritten meanwhile.".into();
            }
            f(&mut self.rows.wb, &mut self.rows.memory);
            Ok(())
        }
    }

    #[test]
    fn a_refused_comment_is_ticked_again_only_if_the_row_is_still_what_you_ticked() {
        let mut rows = Rows::new(built());
        rows.edit("t2", RowEdit { set_status: true, status: None, ticked: Some(true), ..Default::default() }).unwrap();
        let requests = shown(&rows);
        // Steps: the check, the mark before the POST, then the result.
        let mut store = Meddling { rows, calls: 0, at: 3 };
        let api = Recorded::default().on("POST /task/t2/comment", status(400));
        let (gate, clock, token) = (Gate::new(), FakeClock::at(1_790_000_000), token());
        let report = send_requests(&ClickUp::with(&api, &token, &gate, &clock), &mut store, &ids(&["t2"]), &requests, &|| NOW.to_string()).unwrap();
        assert_eq!(report.failed.len(), 1);
        let row = store.rows.row("t2");
        assert!(!row.ticked, "the file changed: not ticked again");
        assert!(!store.rows.memory.has_tick("t2", &row.comment, None));
        assert!(!row.sent_maybe, "a refusal was not posted");
    }

    #[test]
    fn a_follow_up_keeps_your_skip() {
        let mut rows = Rows::new(t3_build(false));
        rows.tick("t3");
        let api = Recorded::default().on("POST /task/t3/comment", ok("{}".into()));
        send(&api, &mut rows, &["t3"]);
        rows.edit("t3", RowEdit { skipped: Some(true), ..Default::default() }).unwrap();
        rows.rebuild(t3_build(true));
        let row = rows.row("t3");
        assert!(row.follow_up && row.skipped && !row.ticked);
    }

    /// A store that saves `ok` times, then fails. Like the real one, the
    /// memory changes in place before the file is written.
    struct Failing {
        rows: Rows,
        ok: usize,
    }

    impl RowStore for Failing {
        fn with(&mut self, f: &mut dyn FnMut(&mut Writeback, &mut RunMemory) -> bool) -> Result<(), String> {
            let mut wb = self.rows.wb.clone();
            if f(&mut wb, &mut self.rows.memory) {
                if self.ok == 0 {
                    return Err("disk full".into());
                }
                self.ok -= 1;
                self.rows.wb = wb;
            }
            Ok(())
        }
    }

    #[test]
    fn a_save_failure_stops_the_send_and_reports_what_went() {
        let mut rows = Rows::new(built());
        rows.edit("t1", RowEdit { set_status: true, status: None, ticked: Some(true), ..Default::default() }).unwrap();
        rows.edit("t2", RowEdit { set_status: true, status: None, ticked: Some(true), ..Default::default() }).unwrap();
        let requests = shown(&rows);
        // The mark before t1's POST saves, the result after it does not.
        let mut store = Failing { rows, ok: 1 };
        let api = Recorded::default().on("POST /task/t1/comment", ok("{}".into()));
        let (gate, clock, token) = (Gate::new(), FakeClock::at(1_790_000_000), token());
        let (report, err) = send_requests(&ClickUp::with(&api, &token, &gate, &clock), &mut store, &ids(&["t1", "t2"]), &requests, &|| NOW.to_string())
            .unwrap_err();
        assert_eq!(err, "disk full");
        assert_eq!(report.sent, [("t1".to_string(), "comment".to_string())], "what went is reported");
        assert_eq!(api.writes.lock().unwrap().len(), 1, "t2 was not sent after the failure");
        // The file still marks t1 as maybe posted: a later send asks you first.
        assert!(store.rows.row("t1").sent_maybe && !store.rows.row("t1").ticked);
    }

    #[test]
    fn a_sent_row_is_never_sent_twice_unless_you_edit_and_tick_it_again() {
        let mut rows = Rows::new(built());
        rows.tick("t1");
        let api = Recorded::default()
            .on("PUT /task/t1", ok("{}".into()))
            .on("POST /task/t1/comment", ok("{}".into()))
            .on("POST /task/t1/comment", ok("{}".into()));
        let seen = shown(&rows);
        send(&api, &mut rows, &["t1"]);
        assert_eq!(
            rows.edit("t1", RowEdit { ticked: Some(true), ..Default::default() }).unwrap_err(),
            "Already sent. Edit the comment or the status to send it again."
        );
        rows.row_mut("t1").ticked = true;
        assert_eq!(send_with(&api, &mut rows, &["t1"], &seen).not_sent[0].1, CHANGED_SINCE_TICK);
        assert_eq!(api.writes.lock().unwrap().len(), 2);
        rows.row_mut("t1").ticked = false;
        rows.rebuild(built().into_iter().map(|mut p| { p.comment = "new".into(); p }).collect());
        assert_ne!(rows.row("t1").comment, "new", "a sent row keeps what it sent");
        rows.edit("t1", RowEdit { comment: Some("Follow-up.".into()), ticked: Some(true), ..Default::default() }).unwrap();
        assert_eq!(send(&api, &mut rows, &["t1"]).sent, [("t1".to_string(), "comment".to_string())]);
        let writes = api.writes.lock().unwrap().clone();
        assert_eq!(writes.len(), 3);
        assert_eq!(writes[2].body["comment_text"], "Follow-up.");
    }

    #[test]
    fn writeback_json_reads_back_as_written_and_older_rows_default() {
        let mut rows = Rows::new(built());
        rows.row_mut("t1").sent = Some(Sent { at: NOW.into(), comment: Some("c".into()), status: None });
        rows.row_mut("t2").error = Some("Could not reach ClickUp. Check your connection.".into());
        let text = serde_json::to_string_pretty(&rows.wb).unwrap();
        let back: Writeback = serde_json::from_str(&text).unwrap();
        assert_eq!(back, rows.wb);
        let json: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(json["schema"], 1);
        let first = &json["proposals"][0];
        for key in ["ticket", "comment", "status", "ticked", "edited", "sent"] {
            assert!(first.get(key).is_some(), "{key} missing: {first}");
        }
        assert!(first.get("followUpComment").is_none(), "never written");
        assert_eq!(json["proposals"][1]["error"], "Could not reach ClickUp. Check your connection.");
        let bare: Writeback = serde_json::from_str(&format!(
            r#"{{"schema":1,"runId":"{RUN}","proposals":[{{"ticket":{{"id":"t1","title":"T"}},"comment":"c"}}]}}"#
        ))
        .unwrap();
        assert!(!bare.proposals[0].ticked && bare.proposals[0].sent.is_none());
    }
}

