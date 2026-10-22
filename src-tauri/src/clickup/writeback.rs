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
//! - [`send_ticked`] sends only ticked rows (plan decision E4): never one
//!   without a tick, and never the same comment or status twice. Nothing
//!   here holds a token: the [`ClickUp`] client keeps it.

use super::client::{ClickUp, TaskRef};
use super::intake::{TicketList, TicketsSnapshot};
use crate::store::settings_store::ClickUpStatusMap;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// The version of `writeback.json`.
pub const WRITEBACK_SCHEMA: u32 = 1;
/// The longest comment you can send.
pub const MAX_COMMENT_CHARS: usize = 10_000;
/// The longest status name accepted.
const MAX_STATUS_CHARS: usize = 100;

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

/// What was sent for a row, and when.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sent {
    /// RFC 3339.
    pub at: String,
    /// The comment as posted.
    pub comment: String,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sent: Option<Sent>,
    /// The last send's plain-English error.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Proposal {
    /// Sent already, and nothing changed since: sending again would repeat it.
    pub fn sent_as_is(&self) -> bool {
        self.sent
            .as_ref()
            .is_some_and(|sent| sent.comment == self.comment && sent.status == self.status)
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
                .any(|lane| lane.verification.as_ref().is_some_and(|v| v.verified))
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

/// One lane's part of a comment: its pull requests, what changed, and how it
/// was verified.
fn lane_text(lane: &LaneFacts, heading: bool) -> String {
    let mut out = Vec::new();
    if heading && !lane.title.is_empty() {
        out.push(lane.title.clone());
    }
    if !lane.prs.is_empty() {
        out.push("Pull requests:".to_string());
        for pr in &lane.prs {
            match (pr.title.trim(), pr.url.trim()) {
                ("", url) => out.push(format!("- {url}")),
                (title, url) => out.push(format!("- {title}: {url}")),
            }
        }
    }
    if let Some(summary) = lane.summary.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        out.push(String::new());
        out.push("What changed:".to_string());
        out.push(summary.to_string());
    }
    out.push(String::new());
    out.push("How it was verified:".to_string());
    match &lane.verification {
        Some(v) if v.verified => {
            out.push(v.steps.trim().to_string());
            out.push(format!("Marked verified on {}.", day(&v.at)));
            if let Some(note) = v.note.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
                out.push(format!("Note: {note}"));
            }
        }
        _ if !lane.checks_passed.is_empty() => {
            out.push(format!("Checks passed: {}.", lane.checks_passed.join(", ")));
        }
        _ => out.push("Not verified yet.".to_string()),
    }
    out.join("\n")
}

fn comment_for(facts: &RunFacts, lanes: &[&LaneFacts]) -> String {
    let heading = lanes.len() > 1;
    let mut parts = vec![format!("Update from DCTerminal (run {}).", facts.run_id)];
    parts.extend(lanes.iter().map(|lane| lane_text(lane, heading)));
    parts.join("\n\n")
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
            let (lanes, unmatched) = match match_ticket(facts, &row.id, row.custom_id.as_deref()) {
                Match::Lanes(lanes) => (lanes, None),
                Match::Unmatched(why) => (facts.lanes.iter().collect(), Some(why)),
            };
            let lanes = if lanes.is_empty() { vec![&facts.own] } else { lanes };
            let verified = unmatched.is_none()
                && lanes.iter().all(|lane| lane.verification.as_ref().is_some_and(|v| v.verified));
            let (status, status_note) = match (unmatched, verified, &ticket.list) {
                (Some(why), _, _) => (None, Some(why.to_string())),
                (None, false, _) => (None, Some("Not marked verified yet, so no status change is proposed.".to_string())),
                (None, true, None) => (None, Some("This run's tickets.json does not say which list the ticket is in (it was taken before write-back). Pull the ticket again to propose a status.".to_string())),
                (None, true, Some(list)) => match maps.get(&list.id) {
                    Some(map) => (Some(map.verified.clone()), None),
                    None => (None, Some(format!("Map a verified status for the list \"{}\" to propose one.", list_label(list)))),
                },
            };
            Proposal {
                ticket: ProposalTicket {
                    id: row.id.clone(),
                    custom_id: row.custom_id.clone(),
                    title: row.title.clone(),
                    url: row.url.clone(),
                    list: ticket.list.clone(),
                },
                lanes: if unmatched.is_some() {
                    Vec::new()
                } else {
                    lanes.iter().filter_map(|lane| lane.id.clone()).collect()
                },
                comment: comment_for(facts, &lanes),
                status,
                status_note,
                verified,
                ticked: false,
                edited: false,
                status_edited: false,
                skipped: false,
                sent: None,
                error: None,
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

/// `fresh` proposals with what you did to the `old` ones kept: your ticks,
/// skips, edits, and what was sent. A row you edited keeps your text; a row
/// already sent keeps what it sent. Rows for tickets no longer in the
/// snapshot are dropped.
pub fn merge(old: Option<&Writeback>, fresh: Vec<Proposal>) -> Vec<Proposal> {
    let Some(old) = old else {
        return fresh;
    };
    fresh
        .into_iter()
        .map(|mut next| {
            let Some(prev) = old.proposals.iter().find(|p| p.ticket.id == next.ticket.id) else {
                return next;
            };
            next.ticked = prev.ticked;
            next.skipped = prev.skipped;
            next.sent = prev.sent.clone();
            next.error = prev.error.clone();
            next.edited = prev.edited;
            next.status_edited = prev.status_edited;
            // A sent row stays as sent until you edit it.
            let frozen = prev.sent.is_some();
            if prev.edited || frozen {
                next.comment = prev.comment.clone();
            }
            if prev.status_edited || frozen {
                next.status = prev.status.clone();
                next.status_note = prev.status_note.clone();
            }
            next
        })
        .collect()
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
        if comment.is_empty() {
            return Err("A comment cannot be empty.".into());
        }
        if comment.chars().count() > MAX_COMMENT_CHARS {
            return Err(format!("A comment can be at most {MAX_COMMENT_CHARS} characters."));
        }
        if comment != next.comment {
            next.comment = comment.to_string();
            next.edited = true;
        }
    }
    if edit.set_status {
        let status = edit.status.as_deref().map(str::trim).filter(|s| !s.is_empty());
        if status.is_some_and(|s| s.chars().count() > MAX_STATUS_CHARS || s.chars().any(char::is_control)) {
            return Err("That is not a ClickUp status name.".into());
        }
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
        next.ticked = ticked;
    }
    *row = next;
    Ok(())
}

/// What one send did, by ticket id.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendReport {
    pub sent: Vec<String>,
    /// Ticket id and the plain-English error.
    pub failed: Vec<(String, String)>,
}

/// The rows a send would post: ticked, not skipped, not already sent as
/// they are.
pub fn to_send(wb: &Writeback) -> Vec<&Proposal> {
    wb.proposals
        .iter()
        .filter(|p| p.ticked && !p.skipped && !p.sent_as_is())
        .collect()
}

/// Sends one row: its status first (a repeat of a status already set is
/// harmless), then its comment unless that exact comment was posted
/// already. A failure leaves the row ticked with its error, for a retry.
fn send_row(client: &ClickUp, row: &mut Proposal, now: &str) -> Result<(), String> {
    let task = TaskRef::Id(row.ticket.id.clone());
    let comment = row.comment.trim().to_string();
    if comment.is_empty() {
        return Err("A comment cannot be empty.".into());
    }
    if let Some(status) = &row.status {
        if row.sent.as_ref().and_then(|s| s.status.as_ref()) != Some(status) {
            client.set_status(&task, status).map_err(String::from)?;
        }
    }
    if row.sent.as_ref().map(|s| s.comment.as_str()) != Some(comment.as_str()) {
        client.post_comment(&task, &comment).map_err(String::from)?;
    }
    row.sent = Some(Sent {
        at: now.to_string(),
        comment,
        status: row.status.clone(),
    });
    Ok(())
}

/// Sends every ticked row ([`to_send`]) with `client`, and records each
/// result on its row: sent (with the time, and the row unticked) or failed
/// (with the error, still ticked). An unticked row makes no call at all.
pub fn send_ticked(client: &ClickUp, wb: &mut Writeback, now: &str) -> SendReport {
    let mut report = SendReport::default();
    for row in wb.proposals.iter_mut() {
        if !row.ticked || row.skipped {
            continue;
        }
        if row.sent_as_is() {
            row.ticked = false;
            continue;
        }
        match send_row(client, row, now) {
            Ok(()) => {
                row.ticked = false;
                row.error = None;
                report.sent.push(row.ticket.id.clone());
            }
            Err(err) => {
                row.error = Some(err.clone());
                report.failed.push((row.ticket.id.clone(), err));
            }
        }
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clickup::client::tests::{ok, status, FakeClock, Recorded};
    use crate::clickup::intake::{SnapshotLimits, SnapshotSource, Ticket, TicketRow, LIMITS};
    use crate::clickup::{ClickUpToken, Gate};

    const RUN: &str = "ee_1760000000300";
    const NOW: &str = "2026-10-22T12:00:00.000Z";

    fn ticket(id: &str, custom: Option<&str>, list: Option<&str>) -> Ticket {
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

    fn snapshot(tickets: Vec<Ticket>) -> TicketsSnapshot {
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
        // A run that never fanned out: its own stages are the lane.
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
    fn several_lanes_with_no_ticket_mapping_list_every_lane_and_leave_the_status_out() {
        let snap = snapshot(vec![ticket("t1", None, Some("901800112233"))]);
        let run = facts(vec![lane(Some("pr1"), Some(true)), lane(Some("pr2"), Some(true))], lane(None, None));
        let p = &build(&snap, &run, &maps())[0];
        assert_eq!(p.status, None);
        assert!(!p.verified);
        assert!(p.status_note.as_deref().unwrap().contains("several lanes"), "{:?}", p.status_note);
        assert!(p.comment.contains("PR1 — Work\nPull requests:") && p.comment.contains("PR2 — Work\nPull requests:"), "{}", p.comment);
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
            // A custom id matches too; t3 is in both lanes.
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

    fn wb(proposals: Vec<Proposal>) -> Writeback {
        Writeback { schema: WRITEBACK_SCHEMA, run_id: RUN.into(), proposals }
    }

    fn built() -> Vec<Proposal> {
        let snap = snapshot(vec![ticket("t1", None, Some("901800112233")), ticket("t2", None, Some("901800112233"))]);
        build(&snap, &facts(vec![], lane(None, Some(true))), &maps())
    }

    #[test]
    fn a_rebuild_keeps_your_ticks_edits_and_what_was_sent() {
        let mut old = wb(built());
        apply_edit(&mut old, "t1", &RowEdit { comment: Some("Mine.".into()), ticked: Some(true), ..Default::default() }).unwrap();
        apply_edit(&mut old, "t2", &RowEdit { set_status: true, status: None, skipped: Some(true), ..Default::default() }).unwrap();
        let mut fresh = built();
        for p in &mut fresh {
            p.comment.push_str("\nMore.");
        }
        let merged = merge(Some(&old), fresh);
        assert_eq!((merged[0].comment.as_str(), merged[0].ticked, merged[0].edited), ("Mine.", true, true));
        assert_eq!(merged[0].status.as_deref(), Some("QA PASSED"));
        assert!(merged[1].comment.ends_with("More."), "not edited: rebuilt");
        assert_eq!((merged[1].status.clone(), merged[1].skipped), (None, true));
        // Without an old file the fresh rows stand.
        assert_eq!(merge(None, built()), built());
    }

    #[test]
    fn edits_are_checked() {
        let mut w = wb(built());
        let long = "x".repeat(MAX_COMMENT_CHARS + 1);
        for (edit, err) in [
            (RowEdit { comment: Some("  ".into()), ..Default::default() }, "A comment cannot be empty."),
            (RowEdit { comment: Some(long), ..Default::default() }, "A comment can be at most 10000 characters."),
            (RowEdit { set_status: true, status: Some("a\nb".into()), ..Default::default() }, "That is not a ClickUp status name."),
        ] {
            assert_eq!(apply_edit(&mut w, "t1", &edit).unwrap_err(), err);
        }
        assert_eq!(apply_edit(&mut w, "nope", &RowEdit::default()).unwrap_err(), "That ticket has no proposal in this run.");
        apply_edit(&mut w, "t1", &RowEdit { skipped: Some(true), ..Default::default() }).unwrap();
        assert!(apply_edit(&mut w, "t1", &RowEdit { ticked: Some(true), ..Default::default() }).unwrap_err().contains("skipped"));
        assert_eq!(w, wb({
            let mut rows = built();
            rows[0].skipped = true;
            rows
        }));
    }

    fn token() -> ClickUpToken {
        ClickUpToken::parse("pk_test_WRITEBACK").unwrap()
    }

    fn send(api: &Recorded, w: &mut Writeback) -> SendReport {
        let (gate, clock, token) = (Gate::new(), FakeClock::at(1_790_000_000), token());
        send_ticked(&ClickUp::with(api, &token, &gate, &clock), w, NOW)
    }

    #[test]
    fn unticked_rows_make_no_call_at_all() {
        let mut w = wb(built());
        // Skipped and ticked-then-unticked rows count as unticked too.
        apply_edit(&mut w, "t2", &RowEdit { ticked: Some(true), ..Default::default() }).unwrap();
        apply_edit(&mut w, "t2", &RowEdit { ticked: Some(false), skipped: Some(true), ..Default::default() }).unwrap();
        let api = Recorded::default();
        let report = send(&api, &mut w);
        assert_eq!(report, SendReport::default());
        assert!(api.calls.lock().unwrap().is_empty() && api.writes.lock().unwrap().is_empty());
        assert!(to_send(&w).is_empty());
        assert!(w.proposals.iter().all(|p| p.sent.is_none()));
    }

    #[test]
    fn a_ticked_row_sends_its_status_then_its_comment_and_is_recorded() {
        let mut w = wb(built());
        apply_edit(&mut w, "t1", &RowEdit { ticked: Some(true), ..Default::default() }).unwrap();
        let api = Recorded::default()
            .on("PUT /task/t1", ok("{}".into()))
            .on("POST /task/t1/comment", ok("{}".into()));
        let report = send(&api, &mut w);
        assert_eq!(report.sent, ["t1"]);
        let writes = api.writes.lock().unwrap().clone();
        assert_eq!(writes.len(), 2, "t2 was not ticked");
        assert_eq!((writes[0].method, writes[0].path.as_str()), ("PUT", "/task/t1"));
        assert_eq!(writes[0].body, serde_json::json!({ "status": "QA PASSED" }));
        assert_eq!((writes[1].method, writes[1].path.as_str()), ("POST", "/task/t1/comment"));
        assert_eq!(writes[1].body["comment_text"], serde_json::json!(w.proposals[0].comment));
        assert_eq!(writes[1].body["notify_all"], serde_json::json!(false));
        let row = &w.proposals[0];
        assert_eq!(row.sent, Some(Sent { at: NOW.into(), comment: row.comment.clone(), status: Some("QA PASSED".into()) }));
        assert!(!row.ticked && row.error.is_none());
    }

    #[test]
    fn a_failed_row_keeps_its_error_and_its_tick_and_a_retry_sends_it() {
        let mut w = wb(built());
        apply_edit(&mut w, "t1", &RowEdit { ticked: Some(true), ..Default::default() }).unwrap();
        let api = Recorded::default()
            .on("PUT /task/t1", status(400))
            .on("PUT /task/t1", ok("{}".into()))
            .on("POST /task/t1/comment", ok("{}".into()));
        let first = send(&api, &mut w);
        assert_eq!(first.failed.len(), 1);
        let err = w.proposals[0].error.clone().unwrap();
        assert!(err.starts_with("ClickUp refused the change (HTTP 400)"), "{err}");
        assert!(w.proposals[0].ticked && w.proposals[0].sent.is_none());
        assert_eq!(api.writes.lock().unwrap().len(), 1, "no comment after the status failed");
        let again = send(&api, &mut w);
        assert_eq!(again.sent, ["t1"]);
        assert!(w.proposals[0].error.is_none() && w.proposals[0].sent.is_some());
    }

    #[test]
    fn a_sent_row_is_never_sent_twice_unless_you_edit_and_tick_it_again() {
        let mut w = wb(built());
        apply_edit(&mut w, "t1", &RowEdit { ticked: Some(true), ..Default::default() }).unwrap();
        let api = Recorded::default()
            .on("PUT /task/t1", ok("{}".into()))
            .on("POST /task/t1/comment", ok("{}".into()))
            .on("POST /task/t1/comment", ok("{}".into()));
        send(&api, &mut w);
        assert_eq!(
            apply_edit(&mut w, "t1", &RowEdit { ticked: Some(true), ..Default::default() }).unwrap_err(),
            "Already sent. Edit the comment or the status to send it again."
        );
        // Even a tick forced into the file sends nothing.
        w.proposals[0].ticked = true;
        assert_eq!(send(&api, &mut w), SendReport::default());
        assert!(!w.proposals[0].ticked);
        assert_eq!(api.writes.lock().unwrap().len(), 2);
        // A rebuild keeps what was sent.
        let merged = merge(Some(&w), built().into_iter().map(|mut p| { p.comment = "new".into(); p }).collect());
        assert_eq!(merged[0].comment, w.proposals[0].comment);
        // Edit, tick, send: only the new comment goes, the status was set already.
        apply_edit(&mut w, "t1", &RowEdit { comment: Some("Follow-up.".into()), ticked: Some(true), ..Default::default() }).unwrap();
        assert_eq!(send(&api, &mut w).sent, ["t1"]);
        let writes = api.writes.lock().unwrap().clone();
        assert_eq!(writes.len(), 3);
        assert_eq!(writes[2].body["comment_text"], "Follow-up.");
    }

    #[test]
    fn writeback_json_reads_back_as_written_and_older_rows_default() {
        let mut w = wb(built());
        w.proposals[0].sent = Some(Sent { at: NOW.into(), comment: "c".into(), status: None });
        w.proposals[1].error = Some("Could not reach ClickUp. Check your connection.".into());
        let text = serde_json::to_string_pretty(&w).unwrap();
        let back: Writeback = serde_json::from_str(&text).unwrap();
        assert_eq!(back, w);
        let json: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(json["schema"], 1);
        let first = &json["proposals"][0];
        for key in ["ticket", "comment", "status", "ticked", "edited", "sent"] {
            assert!(first.get(key).is_some(), "{key} missing: {first}");
        }
        assert_eq!(json["proposals"][1]["error"], "Could not reach ClickUp. Check your connection.");
        let bare: Writeback = serde_json::from_str(&format!(
            r#"{{"schema":1,"runId":"{RUN}","proposals":[{{"ticket":{{"id":"t1","title":"T"}},"comment":"c"}}]}}"#
        ))
        .unwrap();
        assert!(!bare.proposals[0].ticked && bare.proposals[0].sent.is_none());
    }
}
