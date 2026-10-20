//! The autopilot decision (ADR-014): after a stage's turn ends, advance,
//! loop back, retry after a failed gate, re-ask for missing HANDOFF
//! sections, or stop for the user. Pure over the pipeline definition, the
//! run and the turn report, so every rule is unit-tested. It records what it
//! decided in the run's ledger and autopilot state; the caller saves.
//!
//! It acts only while the run is `running` (Track H2): a stop puts the run
//! in `waiting` with a reason code until you act, and `complete` is final.
//! An `auto` gate that found nothing to run stops it with `no_check_found`
//! unless the gate is optional (Track H4, D31). The rules read the stage's
//! loop-back and kind, never a role id, so a copied role decides the same.

use super::{PipelineDef, Severity, StageDef};
use crate::store::{claim_key, PipelineRun, RunAutopilot, RunStatus, StopReason, MAX_DECIDED_TURNS};
use serde::{Deserialize, Serialize};

/// Failed-gate retries per stage and round before autopilot stops.
pub const MAX_GATE_RETRIES: u32 = 2;

#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FindingReport {
    pub severity: String,
    #[serde(default)]
    pub summary: String,
}

/// What the frontend read from the stage's finished turn.
#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TurnReport {
    pub stage_id: String,
    /// `APPROVED`, `APPROVED WITH CHANGES`, `REQUIRES REVISION`, `REQUEST CHANGES`, `REJECTED`.
    #[serde(default)]
    pub verdict: Option<String>,
    #[serde(default)]
    pub findings: Vec<FindingReport>,
    /// The reply carried a structured result, so `findings` is complete.
    #[serde(default)]
    pub findings_known: bool,
    #[serde(default)]
    pub missing_sections: Vec<String>,
    /// Highest of the Claude 5-hour and 7-day usage, in percent. `None`
    /// when usage is unknown (never read, or the window reset since the
    /// last reading): autopilot carries on, and `rate_limit` stops it.
    #[serde(default)]
    pub usage_percent: Option<u8>,
    /// The rate-limit error Claude wrote into the stage's session log this
    /// turn ("You've hit your limit · resets 3pm"), if any.
    #[serde(default)]
    pub rate_limit: Option<String>,
    /// The stage's tab is a chat tab (autopilot drives terminals only).
    #[serde(default)]
    pub chat: bool,
    /// The fanned-out pull request this stage belongs to, if any.
    #[serde(default)]
    pub lane: Option<String>,
    /// The run's round (or the lane's) when the turn was read. A turn from a
    /// round that has ended since is skipped.
    #[serde(default)]
    pub round: Option<u32>,
    /// The turn (`tab|session|prompt`): each one is decided on once.
    #[serde(default)]
    pub turn: Option<String>,
}

/// Key of per-stage state (gate results, retries): `stage` or `stage@lane`.
pub fn stage_key(stage_id: &str, lane: Option<&str>) -> String {
    match lane {
        Some(lane) => format!("{stage_id}@{lane}"),
        None => stage_id.to_string(),
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    /// `advance`, `loopBack`, `retry`, `reask`, `stop`, `complete`, `laneDone`,
    /// `ignore` (a late turn in an approved lane, or a turn already decided
    /// on: nothing to do or tell), `skip` (a stale turn, or a hand-off made
    /// already: the ledger says so, nothing else happens).
    pub action: String,
    /// Stage to send into (`advance`, `loopBack`, `retry`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role_id: Option<String>,
    pub reason: String,
    /// Text to send into the stage's own tab (`retry`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// LOW findings kept for later instead of another round.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub follow_ups: Vec<String>,
    /// The lane the decision is for (same as the report's).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lane: Option<String>,
    /// `laneDone`: waiting lanes whose dependencies are now all approved.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub unblocked: Vec<String>,
    /// `advance`, `loopBack`: the hand-off claim made for it. The caller
    /// releases it when it cannot carry the decision out.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claim: Option<String>,
    /// `stop`: why, as a reason code (the notification names it).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<StopReason>,
}

impl Decision {
    fn new(action: &str, reason: impl Into<String>) -> Self {
        Self {
            action: action.into(),
            stage_id: None,
            role_id: None,
            reason: reason.into(),
            message: None,
            follow_ups: Vec::new(),
            lane: None,
            unblocked: Vec::new(),
            claim: None,
            stop_reason: None,
        }
    }

    fn for_stage(mut self, stage: &StageDef) -> Self {
        self.stage_id = Some(stage.id.clone());
        self.role_id = Some(stage.role_id.clone());
        self
    }
}

fn needs_revision(verdict: &str) -> bool {
    matches!(verdict, "REQUIRES REVISION" | "REQUEST CHANGES" | "REJECTED")
}

fn autopilot(run: &mut PipelineRun) -> &mut RunAutopilot {
    run.autopilot.get_or_insert_with(RunAutopilot::default)
}

fn stop(run: &mut PipelineRun, stage: Option<&StageDef>, code: StopReason, reason: String) -> Decision {
    run.stop_for(
        code,
        stage.map(|s| s.id.as_str()),
        stage.map(|s| s.role_id.as_str()),
        reason.clone(),
        None,
    );
    let mut decision = Decision::new("stop", reason);
    decision.stop_reason = Some(code);
    match stage {
        Some(stage) => decision.for_stage(stage),
        None => decision,
    }
}

/// The run's pipeline is unknown or disabled (`why` says which): nothing can
/// be decided, so a running run stops and says so instead of guessing a
/// pipeline. Off or complete, it is left as it is, like `decide` does.
pub fn stop_for_pipeline(run: &mut PipelineRun, why: String) -> Decision {
    if !run.autopilot.as_ref().is_some_and(|a| a.enabled) {
        return Decision::new("stop", "Autopilot is off for this run.");
    }
    if run.status == RunStatus::Complete {
        return Decision::new("ignore", "The run is complete.");
    }
    stop(run, None, StopReason::CarryOutFailed, format!("Autopilot stopped: {why}"))
}

fn go(run: &mut PipelineRun, decision: Decision, detail: Option<String>) -> Decision {
    if decision.action == "complete" {
        run.set_complete();
    } else {
        run.set_running();
    }
    let kind = if decision.action == "complete" { "complete" } else { "autopilot" };
    let (lane_id, summary) = match decision.lane.as_deref().and_then(|id| run.lane(id)) {
        Some(lane) if decision.action != "laneDone" && decision.action != "complete" => {
            (Some(lane.id.clone()), format!("{}: {}", lane.title, decision.reason))
        }
        _ => (None, decision.reason.clone()),
    };
    run.log_in_lane(
        kind,
        decision.stage_id.as_deref(),
        decision.role_id.as_deref(),
        lane_id.as_deref(),
        summary,
        detail,
        Some(decision.action.clone()),
    );
    decision
}

/// A ledger line for a turn autopilot leaves alone, and the `skip` decision.
fn skip(run: &mut PipelineRun, stage: &StageDef, lane: Option<&str>, reason: String) -> Decision {
    let lane_id = lane.filter(|id| run.lane(id).is_some());
    let tag = lane_id
        .and_then(|id| run.lane(id))
        .map(|l| format!("{}: ", l.title))
        .unwrap_or_default();
    run.log_in_lane(
        "autopilot",
        Some(&stage.id),
        Some(&stage.role_id),
        lane_id,
        format!("{tag}{reason}"),
        None,
        Some("skip".to_string()),
    );
    let mut decision = Decision::new("skip", reason).for_stage(stage);
    decision.lane = lane.map(str::to_string);
    decision
}

/// Claims the hand-off on (`advance`) or send-back (`back`) from `stage` in
/// this round for autopilot. When you or autopilot made it already, the
/// `skip` decision that says so instead.
fn claim(
    run: &mut PipelineRun,
    kind: &str,
    stage: &StageDef,
    lane: Option<&str>,
    turn: Option<&str>,
) -> Result<String, Box<Decision>> {
    let key = claim_key(kind, &stage.id, run.round_for(lane), lane);
    if let Some(made) = run.claim_for(&key, turn) {
        let who = if made.by == "you" { "you" } else { "autopilot" };
        let what = if kind == "back" { "sent back" } else { "handed on" };
        let reason = format!("{} finished: already {what} by {who}.", stage.title);
        return Err(Box::new(skip(run, stage, lane, reason)));
    }
    run.add_claim(key.clone(), turn.map(str::to_string), "autopilot");
    Ok(key)
}

/// Next stage after `index`, or completion. Stops at a checkpoint not yet passed.
/// `applied` are findings the reviewer already applied; they go in the
/// event detail only, never in the follow-ups.
#[allow(clippy::too_many_arguments)]
fn advance(
    def: &PipelineDef,
    run: &mut PipelineRun,
    index: usize,
    why: &str,
    follow_ups: Vec<String>,
    applied: Vec<String>,
    lane: Option<&str>,
    turn: Option<&str>,
) -> Decision {
    let lines: Vec<String> = applied
        .iter()
        .map(|f| format!("Applied: {f}"))
        .chain(follow_ups.iter().cloned())
        .collect();
    let detail = (!lines.is_empty()).then(|| lines.join("\n"));
    let Some(next) = def.stages.get(index + 1) else {
        if let Some(lane_id) = lane.filter(|id| run.lane(id).is_some()) {
            // One pull request is done; the run is done when every one is.
            let title = run.lane(lane_id).map(|l| l.title.clone()).unwrap_or_default();
            if let Some(l) = run.lane_mut(lane_id) {
                l.status = "approved".to_string();
            }
            if run.lanes.iter().all(|l| l.status == "approved") {
                let mut done = Decision::new("complete", format!("{why}: every pull request is approved; the run is complete."));
                done.follow_ups = follow_ups;
                done.lane = Some(lane_id.to_string());
                return go(run, done, detail);
            }
            let unblocked = run.unblocked_lanes();
            let reason = if unblocked.is_empty() {
                format!("{why}: {title} is approved. Waiting on the other pull requests.")
            } else {
                format!("{why}: {title} is approved. Starting {}.", unblocked.join(", "))
            };
            let mut done = Decision::new("laneDone", reason);
            done.follow_ups = follow_ups;
            done.lane = Some(lane_id.to_string());
            done.unblocked = unblocked;
            return go(run, done, detail);
        }
        let mut done = Decision::new("complete", format!("{why}: the run is complete."));
        done.follow_ups = follow_ups;
        return go(run, done, detail);
    };
    let passed = run
        .autopilot
        .as_ref()
        .is_some_and(|a| a.passed_checkpoints.contains(&next.id));
    if next.checkpoint && !passed {
        let reason = format!(
            "Checkpoint before {}: check the work so far, then send it yourself. Autopilot carries on after that.",
            next.title
        );
        return stop(run, Some(next), StopReason::Checkpoint, reason);
    }
    let key = match claim(run, "advance", &def.stages[index], lane, turn) {
        Ok(key) => key,
        Err(skipped) => return *skipped,
    };
    let mut decision = Decision::new("advance", format!("{why}: on to {}.", next.title)).for_stage(next);
    decision.follow_ups = follow_ups;
    decision.lane = lane.map(str::to_string);
    decision.claim = Some(key);
    go(run, decision, detail)
}

pub fn decide(def: &PipelineDef, run: &mut PipelineRun, report: &TurnReport) -> Decision {
    let enabled = run.autopilot.as_ref().is_some_and(|a| a.enabled);
    if !enabled {
        // Turning autopilot off already stopped the run (`paused_by_you`);
        // only the notification needs the code.
        let mut decision = Decision::new("stop", "Autopilot is off for this run.");
        decision.stop_reason = Some(StopReason::PausedByYou);
        return decision;
    }
    if run.status == RunStatus::Complete {
        // Final: a late turn (a background task reporting in) changes nothing.
        return Decision::new("ignore", "The run is complete.");
    }
    let Some(index) = def.stage_index(&report.stage_id) else {
        return stop(
            run,
            None,
            StopReason::CarryOutFailed,
            format!("Stage \"{}\" is not in {}.", report.stage_id, def.name),
        );
    };
    let stage = def.stages[index].clone();
    if let Some(lane) = report.lane.as_deref().and_then(|id| run.lane(id)).filter(|l| l.status == "approved") {
        // Approved already (by hand, or a late turn): nothing to rework, and
        // nothing to wait for, so no stop is recorded or shown.
        let mut decision = Decision::new("ignore", "That pull request is already approved.").for_stage(&stage);
        decision.lane = Some(lane.id.clone());
        return decision;
    }
    let lane = report.lane.as_deref().filter(|id| run.lane(id).is_some());
    let key_of_stage = stage_key(&stage.id, lane);
    let round = run.round_for(lane);
    let turn = report.turn.as_deref().map(str::trim).filter(|t| !t.is_empty());
    if let Some(turn) = turn {
        // A reply is acted on once, even when it is read again.
        let decided = &mut autopilot(run).decided;
        if decided.iter().any(|seen| seen == turn) {
            return Decision::new("ignore", "That turn was already decided on.").for_stage(&stage);
        }
        decided.push(turn.to_string());
        if decided.len() > MAX_DECIDED_TURNS {
            let drop = decided.len() - MAX_DECIDED_TURNS;
            decided.drain(..drop);
        }
    }
    if run.status != RunStatus::Running {
        // Stopped for you: you hand on, send back or approve, and autopilot
        // carries on from the next turn. Never acted on by itself.
        let why = run
            .autopilot
            .as_ref()
            .and_then(|a| a.waiting.clone())
            .map(|why| format!(" ({})", why.trim_end_matches('.')))
            .unwrap_or_default();
        return skip(
            run,
            &stage,
            lane,
            format!("{} finished while the run is waiting for you{why}. Hand it on yourself.", stage.title),
        );
    }
    if let Some(read_in) = report.round.filter(|read_in| *read_in != round) {
        // A round sent back while this turn's checks ran: the turn is stale.
        return skip(
            run,
            &stage,
            lane,
            format!(
                "Skipped {}'s turn from round {read_in}: the run is on round {round} now.",
                stage.title
            ),
        );
    }
    if report.chat {
        return stop(
            run,
            Some(&stage),
            StopReason::CarryOutFailed,
            format!("{} is a chat tab. Autopilot drives terminal tabs only, so hand it on yourself.", stage.title),
        );
    }
    if let Some(error) = report.rate_limit.as_deref().map(str::trim).filter(|e| !e.is_empty()) {
        return stop(
            run,
            Some(&stage),
            StopReason::UsageLimit,
            format!(
                "{} hit a Claude usage limit: {}. Carry on yourself once it resets.",
                stage.title,
                error.trim_end_matches('.')
            ),
        );
    }
    let pause = def.autopilot.pause_at_usage_percent;
    if let Some(used) = report.usage_percent.filter(|used| *used >= pause) {
        return stop(
            run,
            Some(&stage),
            StopReason::UsageLimit,
            format!("Paused: Claude usage is at {used}% (autopilot pauses at {pause}%)."),
        );
    }
    if !report.missing_sections.is_empty() {
        let key = format!("{key_of_stage}#{round}");
        let missing = report.missing_sections.join(", ");
        if autopilot(run).reasked.contains(&key) {
            return stop(
                run,
                Some(&stage),
                StopReason::NoResult,
                format!("{}'s reply still lacks HANDOFF sections ({missing}).", stage.title),
            );
        }
        autopilot(run).reasked.push(key);
        let mut decision = Decision::new("reask", format!("Asked {} for the missing HANDOFF sections ({missing}).", stage.title))
            .for_stage(&stage);
        decision.lane = lane.map(str::to_string);
        return go(run, decision, None);
    }
    let this_round = run.gates.get(&key_of_stage).filter(|gates| gates.round == round);
    if let Some(gate) = this_round.and_then(|gates| gates.results.iter().find(|r| r.no_check_found()).cloned()) {
        // D31: an `auto` check that found nothing to run is not a pass.
        // A built-in pipeline cannot be edited, so say what you can do.
        let fix = if def.built_in {
            "Add a check to the project (an npm `check` or `test` script, or a Cargo.toml) and hand the stage on yourself, \
             or make your own pipeline in Settings › Pipelines with the same stages and mark this gate optional."
        } else {
            "Add a check command to the pipeline in Settings › Pipelines, or mark the gate optional."
        };
        let reason = format!(
            "{} finished, but its `{}` check has nothing to run: {} {fix}",
            stage.title, gate.label, gate.summary
        );
        return stop(run, Some(&stage), StopReason::NoCheckFound, reason);
    }
    let failed_gate = run
        .gates
        .get(&key_of_stage)
        .filter(|gates| gates.round == round)
        .and_then(|gates| gates.results.iter().find(|r| r.failed()).cloned());
    if let Some(gate) = failed_gate {
        let retries = *autopilot(run).gate_retries.get(&key_of_stage).unwrap_or(&0);
        if retries >= MAX_GATE_RETRIES {
            return stop(
                run,
                Some(&stage),
                StopReason::GateFailed,
                format!("The {} check failed {} times in a row. {}", gate.label, retries + 1, gate.summary),
            );
        }
        autopilot(run).gate_retries.insert(key_of_stage.clone(), retries + 1);
        let mut decision = Decision::new(
            "retry",
            format!("The {} check failed; sent the output back to {}.", gate.label, stage.title),
        )
        .for_stage(&stage);
        decision.lane = lane.map(str::to_string);
        let output = if gate.output.trim().is_empty() {
            String::new()
        } else {
            format!("\n\n```\n{}\n```", gate.output.trim())
        };
        decision.message = Some(format!(
            "The `{}` check failed after your last turn: {}{}\n\nFix the cause, push to the same branch, then end your reply with the same HANDOFF sections as before.",
            gate.label, gate.summary, output
        ));
        return go(run, decision, Some(gate.output.clone()));
    }
    // Every check passed (or none ran) this round: a later failure starts counting again.
    autopilot(run).gate_retries.remove(&key_of_stage);
    let Some(verdict) = report.verdict.as_deref().map(str::trim).filter(|v| !v.is_empty()) else {
        if stage.loop_back.is_some() {
            return stop(run, Some(&stage), StopReason::NoVerdict, format!("No verdict could be read from {}'s reply.", stage.title));
        }
        return advance(def, run, index, &format!("{} finished", stage.title), Vec::new(), Vec::new(), lane, turn);
    };
    let threshold = stage
        .loop_back
        .as_ref()
        .map(|back| back.min_severity)
        .unwrap_or(Severity::Medium);
    let severities: Vec<(Option<Severity>, &FindingReport)> = report
        .findings
        .iter()
        .map(|f| (Severity::parse(&f.severity), f))
        .collect();
    let follow_ups: Vec<String> = severities
        .iter()
        .filter(|(sev, _)| sev.is_some_and(|s| !s.at_least(threshold)))
        .map(|(sev, f)| {
            let tag = sev.map(Severity::label).unwrap_or("?");
            format!("[{tag}] {}", f.summary.trim())
        })
        .collect();
    if needs_revision(verdict) {
        // An unlabelled finding counts as blocking.
        let blocking = severities
            .iter()
            .filter(|(sev, _)| sev.is_none_or(|s| s.at_least(threshold)))
            .count();
        if report.findings_known && blocking == 0 {
            return advance(
                def,
                run,
                index,
                &format!(
                    "{verdict} with only findings below {} (kept as follow-ups)",
                    threshold.label()
                ),
                follow_ups,
                Vec::new(),
                lane,
                turn,
            );
        }
        let Some(back) = stage.loop_back.clone() else {
            return stop(
                run,
                Some(&stage),
                StopReason::BlockingFindings,
                format!("{} asked for changes, but this stage has no loop-back.", stage.title),
            );
        };
        // Rounds per loop-back edge: this reviewer's own rounds so far. With
        // no cap, rounds go back until the reviewer approves.
        let edge_round = review_round(run, lane, &stage);
        if let Some(cap) = back.max_rounds.filter(|cap| edge_round >= *cap) {
            return stop(
                run,
                Some(&stage),
                StopReason::RoundCap,
                format!(
                    "Round cap reached ({edge_round} of {cap}): {} still asks for changes.",
                    stage.title
                ),
            );
        }
        let Some(target) = def.stage(&back.to).cloned() else {
            return stop(
                run,
                Some(&stage),
                StopReason::CarryOutFailed,
                format!("Loop-back stage \"{}\" is missing.", back.to),
            );
        };
        let mut decision = Decision::new(
            "loopBack",
            format!(
                "{verdict}: round {} goes back to {}.",
                review_round(run, lane, &stage),
                target.title
            ),
        )
        .for_stage(&target);
        decision.lane = lane.map(str::to_string);
        decision.claim = match claim(run, "back", &stage, lane, turn) {
            Ok(key) => Some(key),
            Err(skipped) => return *skipped,
        };
        return go(run, decision, None);
    }
    let blocking: Vec<String> = severities
        .iter()
        .filter(|(sev, _)| sev.is_some_and(|s| s.at_least(threshold)))
        .map(|(sev, f)| format!("[{}] {}", sev.map(Severity::label).unwrap_or("?"), f.summary.trim()))
        .collect();
    // A plain APPROVED that still lists findings at or above the threshold
    // is not a clean pass: stop and show them. APPROVED WITH CHANGES means
    // the reviewer applied them already, so it moves on, except at the last
    // stage, where moving on would complete the work with them unchecked.
    let last_stage = index + 1 == def.stages.len();
    let stops_on_findings = verdict == "APPROVED" || (verdict == "APPROVED WITH CHANGES" && last_stage);
    if stops_on_findings && report.findings_known && !blocking.is_empty() {
        let next_step = if !last_stage {
            "Check them, then send it on or back yourself."
        } else if lane.is_some() {
            "Send it back, or mark it approved in the chain overview's Pull requests list."
        } else {
            "Send it back, or press Mark complete in the chain overview."
        };
        let reason = format!(
            "{} said {verdict} but lists {} finding(s) at {} or above. {next_step}",
            stage.title,
            blocking.len(),
            threshold.label()
        );
        run.stop_for(
            StopReason::BlockingFindings,
            Some(&stage.id),
            Some(&stage.role_id),
            reason.clone(),
            Some(blocking.join("\n")),
        );
        let mut decision = Decision::new("stop", reason).for_stage(&stage);
        decision.lane = lane.map(str::to_string);
        decision.stop_reason = Some(StopReason::BlockingFindings);
        return decision;
    }
    let applied = if report.findings_known { blocking } else { Vec::new() };
    advance(def, run, index, verdict, follow_ups, applied, lane, turn)
}

/// The round a reviewer stage is on along its loop-back edge: the recorded
/// send-backs of any of its roles (in its lane, or the run) plus one. A
/// specialist's manual send-back counts too. Other edges do not count.
fn review_round(run: &PipelineRun, lane: Option<&str>, stage: &StageDef) -> u32 {
    let verdicts = match lane.and_then(|id| run.lane(id)) {
        Some(l) => &l.verdicts,
        None => &run.verdicts,
    };
    let roles = stage.roles();
    verdicts.iter().filter(|v| roles.contains(&v.role_id)).count() as u32 + 1
}

#[cfg(test)]
#[path = "autopilot_tests.rs"]
mod tests;
