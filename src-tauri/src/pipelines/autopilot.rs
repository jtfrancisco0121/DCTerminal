//! The autopilot decision (ADR-014): after a stage's turn ends, advance,
//! loop back, retry after a failed gate, re-ask for missing HANDOFF
//! sections, or stop for the user. Pure over the pipeline definition, the
//! run and the turn report, so every rule is unit-tested. It records what it
//! decided in the run's ledger and autopilot state; the caller saves.

use super::{PipelineDef, Severity, StageDef};
use crate::store::{PipelineRun, RunAutopilot};
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
    /// Highest of the Claude 5-hour and 7-day usage, in percent.
    #[serde(default)]
    pub usage_percent: Option<u8>,
    /// The stage's tab is a chat tab (autopilot drives terminals only).
    #[serde(default)]
    pub chat: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Decision {
    /// `advance`, `loopBack`, `retry`, `reask`, `stop`, `complete`.
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

fn stop(run: &mut PipelineRun, stage: Option<&StageDef>, reason: String) -> Decision {
    autopilot(run).waiting = Some(reason.clone());
    run.log(
        "stop",
        stage.map(|s| s.id.as_str()),
        stage.map(|s| s.role_id.as_str()),
        reason.clone(),
        None,
    );
    let decision = Decision::new("stop", reason);
    match stage {
        Some(stage) => decision.for_stage(stage),
        None => decision,
    }
}

fn go(run: &mut PipelineRun, decision: Decision, detail: Option<String>) -> Decision {
    autopilot(run).waiting = None;
    let kind = if decision.action == "complete" { "complete" } else { "autopilot" };
    run.log(
        kind,
        decision.stage_id.as_deref(),
        decision.role_id.as_deref(),
        decision.reason.clone(),
        detail,
    );
    decision
}

/// Next stage after `index`, or completion. Stops at a checkpoint not yet passed.
fn advance(
    def: &PipelineDef,
    run: &mut PipelineRun,
    index: usize,
    why: &str,
    follow_ups: Vec<String>,
) -> Decision {
    let Some(next) = def.stages.get(index + 1) else {
        let mut done = Decision::new("complete", format!("{why}: the run is complete."));
        done.follow_ups = follow_ups.clone();
        return go(run, done, (!follow_ups.is_empty()).then(|| follow_ups.join("\n")));
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
        return stop(run, Some(next), reason);
    }
    let mut decision = Decision::new("advance", format!("{why}: on to {}.", next.title)).for_stage(next);
    decision.follow_ups = follow_ups.clone();
    go(run, decision, (!follow_ups.is_empty()).then(|| follow_ups.join("\n")))
}

pub fn decide(def: &PipelineDef, run: &mut PipelineRun, report: &TurnReport) -> Decision {
    let enabled = run.autopilot.as_ref().is_some_and(|a| a.enabled);
    if !enabled {
        return Decision::new("stop", "Autopilot is off for this run.");
    }
    let Some(index) = def.stage_index(&report.stage_id) else {
        return stop(run, None, format!("Stage \"{}\" is not in {}.", report.stage_id, def.name));
    };
    let stage = def.stages[index].clone();
    if report.chat {
        return stop(
            run,
            Some(&stage),
            format!("{} is a chat tab. Autopilot drives terminal tabs only, so hand it on yourself.", stage.title),
        );
    }
    let pause = def.autopilot.pause_at_usage_percent;
    if let Some(used) = report.usage_percent.filter(|used| *used >= pause) {
        return stop(
            run,
            Some(&stage),
            format!("Paused: Claude usage is at {used}% (autopilot pauses at {pause}%)."),
        );
    }
    if !report.missing_sections.is_empty() {
        let key = format!("{}@{}", stage.id, run.round.max(1));
        let missing = report.missing_sections.join(", ");
        if autopilot(run).reasked.contains(&key) {
            return stop(
                run,
                Some(&stage),
                format!("{}'s reply still lacks HANDOFF sections ({missing}).", stage.title),
            );
        }
        autopilot(run).reasked.push(key);
        let decision = Decision::new("reask", format!("Asked {} for the missing HANDOFF sections ({missing}).", stage.title))
            .for_stage(&stage);
        return go(run, decision, None);
    }
    let round = run.round.max(1);
    let failed_gate = run
        .gates
        .get(&stage.id)
        .filter(|gates| gates.round == round)
        .and_then(|gates| gates.results.iter().find(|r| r.failed()).cloned());
    if let Some(gate) = failed_gate {
        let retries = *autopilot(run).gate_retries.get(&stage.id).unwrap_or(&0);
        if retries >= MAX_GATE_RETRIES {
            return stop(
                run,
                Some(&stage),
                format!("The {} check failed {} times in a row. {}", gate.label, retries + 1, gate.summary),
            );
        }
        autopilot(run).gate_retries.insert(stage.id.clone(), retries + 1);
        let mut decision = Decision::new(
            "retry",
            format!("The {} check failed; sent the output back to {}.", gate.label, stage.title),
        )
        .for_stage(&stage);
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
    let Some(verdict) = report.verdict.as_deref().map(str::trim).filter(|v| !v.is_empty()) else {
        if stage.loop_back.is_some() {
            return stop(run, Some(&stage), format!("No verdict could be read from {}'s reply.", stage.title));
        }
        return advance(def, run, index, &format!("{} finished", stage.title), Vec::new());
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
            );
        }
        let Some(back) = stage.loop_back.clone() else {
            return stop(run, Some(&stage), format!("{} asked for changes, but this stage has no loop-back.", stage.title));
        };
        if round >= back.max_rounds {
            return stop(
                run,
                Some(&stage),
                format!("Round cap reached ({round} of {}): {} still asks for changes.", back.max_rounds, stage.title),
            );
        }
        let Some(target) = def.stage(&back.to).cloned() else {
            return stop(run, Some(&stage), format!("Loop-back stage \"{}\" is missing.", back.to));
        };
        let decision = Decision::new(
            "loopBack",
            format!("{verdict}: round {round} goes back to {}.", target.title),
        )
        .for_stage(&target);
        return go(run, decision, None);
    }
    advance(def, run, index, verdict, follow_ups)
}

#[cfg(test)]
#[path = "autopilot_tests.rs"]
mod tests;
