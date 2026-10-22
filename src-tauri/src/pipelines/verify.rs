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
use super::lane_gates::waiting_verify;
use super::{GateResult, StageDef};
use crate::store::{PipelineRun, RunStatus, StageGates, StopReason, VerifyRecord, VerifyWait};

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
    // Turns held for an earlier verification stay held for this one: your
    // next answer decides them (a stop for anything else releases them).
    let held = std::mem::take(&mut autopilot(run).held);
    let decision = stop(run, Some(stage), lane, StopReason::Checkpoint, reason);
    autopilot(run).held = held;
    autopilot(run).verify = Some(VerifyWait {
        stage_id: stage.id.clone(),
        lane: lane.map(str::to_string),
        label: gate.label.clone(),
        steps: gate.summary.clone(),
        // The turn's own key, never a `#verify` one it was decided again under.
        turn: turn.map(plain_turn_key).map(str::to_string),
        prs: Vec::new(),
        at: chrono::Utc::now().to_rfc3339(),
    });
    decision
}

/// A decision key without the `#verify<n>` it may carry: the turn's own key.
pub fn plain_turn_key(key: &str) -> &str {
    key.rsplit_once("#verify").map_or(key, |(plain, _)| plain)
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
    // The wait is what you answer. Its waiting result is rebuilt when it is
    // gone from the stage's gate results (overwritten by results of an
    // older build, say), so the answer still reaches `decide`.
    let gates = run.gates.entry(stage_key(stage_id, lane)).or_insert_with(|| StageGates {
        round,
        at: at.to_string(),
        results: Vec::new(),
    });
    if gates.round != round {
        *gates = StageGates {
            round,
            at: at.to_string(),
            results: Vec::new(),
        };
    }
    let index = match gates.results.iter().position(|r| r.waiting_verify() && r.label == wait.label) {
        Some(index) => index,
        None => {
            gates.results.push(waiting_verify(wait.label.clone(), &wait.steps));
            gates.results.len() - 1
        }
    };
    let result = &mut gates.results[index];
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
        turn: wait.turn.clone(),
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
    // Your answer ends the wait: its held turns stay held for the actor to
    // decide (`decide_held_turns`), not released as yours.
    let held = run.autopilot.as_mut().map(|a| std::mem::take(&mut a.held)).unwrap_or_default();
    run.set_running();
    if let Some(autopilot) = run.autopilot.as_mut() {
        autopilot.held = held;
    }
    Ok(wait)
}

/// The results of the overview's **Run checks** for `stage_id` in `lane`,
/// as they are kept on the run (L2). Run checks never runs a verify gate,
/// so when every new result passed, the verify results still waiting this
/// round are carried over and the wait stays answerable. When one failed
/// while the run waits on that stage's verification, the wait ends the
/// normal way: the run stops for you (`checkpoint`) with the failure, and
/// the verify gate waits again once the checks pass on a later turn.
pub fn manual_results(
    run: &mut PipelineRun,
    stage_id: &str,
    lane: Option<&str>,
    round: u32,
    mut results: Vec<GateResult>,
) -> Vec<GateResult> {
    let key = stage_key(stage_id, lane);
    let all_passed = results.iter().all(|r| !r.failed() && !r.no_check_found());
    if all_passed {
        let waiting: Vec<GateResult> = run
            .gates
            .get(&key)
            .filter(|gates| gates.round == round)
            // Waiting and answered alike: your answers this round stand.
            .map(|gates| gates.results.iter().filter(|r| r.kind == "verify").cloned().collect())
            .unwrap_or_default();
        results.extend(waiting);
        return results;
    }
    // Whatever the run's status: the wait is kept while autopilot is off
    // (L3 review fix), and a failed check ends it then too.
    let waits_here = run
        .autopilot
        .as_ref()
        .and_then(|a| a.verify.as_ref())
        .is_some_and(|wait| wait.stage_id == stage_id && wait.lane.as_deref() == lane);
    if waits_here {
        let failed = results.iter().find(|r| r.failed() || r.no_check_found()).map(|r| r.label.clone()).unwrap_or_default();
        let title = lane.and_then(|id| run.lane(id)).map(|l| format!("{}: ", l.title)).unwrap_or_default();
        let stage = super::find(&run.kind)
            .and_then(|def| def.stage(stage_id).map(|stage| stage.title.clone()))
            .unwrap_or_else(|| stage_id.to_string());
        let reason = format!(
            "{title}the {failed} check failed when you ran the checks, so the verification no longer waits. Send the output back to {stage}, or hand it on yourself."
        );
        run.stop_for_in_lane(StopReason::Checkpoint, Some(stage_id), None, lane, reason, None);
    }
    results
}

#[cfg(test)]
#[path = "verify_tests.rs"]
mod tests;
