//! `verify` gates (L2, decisions E5 and E9): checks the app cannot run
//! itself, like the Playwright run on a Windows staging build. Once a
//! stage's other gates pass, `decide` stops the run with `checkpoint` and
//! records the wait (`RunAutopilot::verify`: the steps, the lane, the pull
//! requests). Your answer comes to the run actor as a message: [`answer`]
//! marks the waiting result verified (passed) or failed with your note,
//! adds one [`VerifyRecord`] to the run, and lets the run go on; the actor
//! then decides the same turn again. A failure goes back to the stage as a
//! round with your note and counts toward its gate retries.
//!
//! Why `checkpoint` and not a new stop reason: the plan says the run waits
//! with `checkpoint`, and the wait is told apart by `autopilot.verify`, so
//! the overview shows the steps with **Mark verified** and **Failed**, and
//! every older reader of stop reasons (notifications, the run report, the
//! startup reconcile) treats it as the checkpoint it is.

use super::autopilot::{autopilot, stage_key, stop, Decision};
use super::{GateResult, StageDef};
use crate::store::{PipelineRun, RunStatus, StopReason, VerifyRecord, VerifyWait};

/// Longest note you can send with **Failed**.
pub const MAX_VERIFY_NOTE_CHARS: usize = 4_000;

/// Stop for you on `gate` (a waiting verify result of `stage`'s turn).
pub(super) fn wait_for_you(
    run: &mut PipelineRun,
    stage: &StageDef,
    lane: Option<&str>,
    gate: &GateResult,
    turn: Option<&str>,
) -> Decision {
    let title = lane.and_then(|id| run.lane(id)).map(|l| format!("{}: ", l.title)).unwrap_or_default();
    let reason = format!(
        "{title}{} passed its checks, and {} waits for you. Carry out its steps, then mark it verified, or failed with a note, in the chain overview.",
        stage.title, gate.label
    );
    let decision = stop(run, Some(stage), StopReason::Checkpoint, reason);
    autopilot(run).verify = Some(VerifyWait {
        stage_id: stage.id.clone(),
        lane: lane.map(str::to_string),
        label: gate.label.clone(),
        steps: gate.summary.clone(),
        turn: turn.map(str::to_string),
        prs: Vec::new(),
        at: chrono::Utc::now().to_rfc3339(),
    });
    decision
}

/// What a stage is told when you mark its verification failed.
pub fn failed_message(steps: &str, note: &str) -> String {
    format!(
        "Verification failed after your last turn. The steps that were checked:\n\n{}\n\nWhat failed:\n\n{}\n\nFix the cause, push to the same branch, then end your reply with the same HANDOFF sections as before.",
        steps.trim(),
        note.trim()
    )
}

/// Your answer to the verify gate the run waits on, for `stage_id` in
/// `lane`: marks its result verified or failed (`note` is required then),
/// records it, and sets the run running again. Returns the wait it
/// answered (its turn is the one to decide again). `Err` when the run does
/// not wait on that gate, or a failure has no note; nothing changes then.
pub fn answer(
    run: &mut PipelineRun,
    stage_id: &str,
    lane: Option<&str>,
    verified: bool,
    note: Option<&str>,
    at: &str,
) -> Result<VerifyWait, String> {
    let lane = lane.map(str::trim).filter(|id| !id.is_empty());
    let wait = run
        .autopilot
        .as_ref()
        .and_then(|a| a.verify.clone())
        .filter(|_| run.status == RunStatus::Waiting && run.stop_reason == Some(StopReason::Checkpoint))
        .filter(|wait| wait.stage_id == stage_id && wait.lane.as_deref() == lane)
        .ok_or("The run is not waiting on that verification any more. Reload the overview.")?;
    let note = note.map(str::trim).filter(|note| !note.is_empty());
    if !verified && note.is_none() {
        return Err("Say what failed: the note goes back to the stage.".into());
    }
    if note.is_some_and(|note| note.chars().count() > MAX_VERIFY_NOTE_CHARS) {
        return Err(format!("The note is longer than {MAX_VERIFY_NOTE_CHARS} characters."));
    }
    let round = run.round_for(lane);
    let result = run
        .gates
        .get_mut(&stage_key(stage_id, lane))
        .filter(|gates| gates.round == round)
        .and_then(|gates| gates.results.iter_mut().find(|r| r.waiting_verify() && r.label == wait.label))
        .ok_or("That verification's checks are gone (a newer round started). Reload the overview.")?;
    result.status = if verified { "passed" } else { "failed" }.to_string();
    result.output = note.unwrap_or_default().to_string();
    let attempt = run
        .verifications
        .iter()
        .filter(|r| r.stage_id == stage_id && r.lane.as_deref() == lane && r.round == round)
        .count() as u32
        + 1;
    let (title, repo) = match lane.and_then(|id| run.lane(id)) {
        Some(l) => (format!("{}: ", l.title), l.repo.clone()),
        None => (String::new(), None),
    };
    run.verifications.push(VerifyRecord {
        stage_id: stage_id.to_string(),
        lane: lane.map(str::to_string),
        repo,
        round,
        attempt,
        label: wait.label.clone(),
        steps: wait.steps.clone(),
        result: if verified { "verified" } else { "failed" }.to_string(),
        note: note.map(str::to_string),
        by: "you".to_string(),
        at: at.to_string(),
        prs: wait.prs.clone(),
    });
    let summary = match note {
        _ if verified => format!("{title}{} marked verified by you.", wait.label),
        Some(note) => format!("{title}{} marked failed by you: {note}", wait.label),
        None => format!("{title}{} marked failed by you.", wait.label),
    };
    run.log_in_lane(
        "verify",
        Some(stage_id),
        None,
        lane,
        summary,
        Some(wait.steps.clone()),
        Some(if verified { "verified" } else { "failed" }.to_string()),
    );
    run.set_running();
    Ok(wait)
}

#[cfg(test)]
#[path = "verify_tests.rs"]
mod tests;
