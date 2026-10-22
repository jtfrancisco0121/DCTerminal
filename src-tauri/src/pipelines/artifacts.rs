//! F1: the `artifact` stage kind. An artifact stage writes documents into
//! the run folder (a brief, a PRD, an architecture) and reports them
//! through `submit_result` (`bridge::artifact`):
//!
//! - `complete` advances, as any stage with no loop-back does.
//! - `partial` (decisions are missing) waits with `checkpoint` and records
//!   an `autopilot.artifact_wait` with the questions. Your **Answer** is a
//!   run actor message that resumes the stage's session with your answers.
//! - `blocked` waits the same way with its reason; **Continue** resumes the
//!   session with your note, or you hand the stage on yourself.
//!
//! The wait is one of the waits for your answer, next to L2's verify gate
//! and L3's checkpoint story (`RunAutopilot::waits_on_answer`): it survives
//! an autopilot toggle, and any other end of the wait clears it.
//!
//! The next stages see the documents: `artifacts.json` (written by the
//! bridge) lists each stage's latest ones, and the run's hand-off files name
//! them ([`run_documents`]). Everything here is pure over the pipeline, the
//! run and the files given; the actor does the rest.

use super::autopilot::{autopilot, stop, Decision};
use super::{PipelineDef, StageDef, StageKind};
use crate::store::{ArtifactWait, PipelineRun, StopReason};
use serde::Deserialize;
use std::path::Path;

/// Longest answer (or note) you can send back to an artifact stage.
pub const MAX_ANSWER_CHARS: usize = 8_000;

/// What an artifact stage's accepted result said (`TurnReport::artifact`).
#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactReport {
    /// `complete`, `partial` or `blocked`.
    pub status: String,
    #[serde(default)]
    pub artifacts: Vec<String>,
    #[serde(default)]
    pub open_questions: Vec<String>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
}

/// An artifact result in a turn's `submit_result` arguments, if it is one.
pub fn report_of(result: &serde_json::Value) -> Option<ArtifactReport> {
    result.get("artifacts")?;
    result.get("status")?.as_str()?;
    serde_json::from_value(result.clone()).ok()
}

/// What is wrong with stage `index` of `def` as an artifact stage, if it is
/// one: it comes before the Implementer (documents are for the whole run,
/// never one pull request's lane), runs no gates and sends no rounds back.
/// Any stage may not loop back to an artifact stage, which has no plan or
/// pull request to revise.
pub fn stage_problem(def: &PipelineDef, index: usize) -> Option<String> {
    let stage = def.stages.get(index)?;
    if let Some(back) = &stage.loop_back {
        if def.stage(&back.to).is_some_and(|target| target.kind() == StageKind::Artifact) {
            return Some(format!(
                "stage \"{}\" loops back to \"{}\", an artifact stage. A reviewer sends rounds back to a planner or an implementer.",
                stage.id, back.to
            ));
        }
    }
    if stage.kind() != StageKind::Artifact {
        return None;
    }
    if def.stages[..index].iter().any(|s| s.kind() == StageKind::Implementer) {
        return Some(format!(
            "stage \"{}\" is an artifact stage after the implementer. Its documents are for the whole run, so put it before the implementer.",
            stage.id
        ));
    }
    if !stage.gates.is_empty() {
        return Some(format!(
            "stage \"{}\" is an artifact stage, which runs no gates (the stages after it check its documents).",
            stage.id
        ));
    }
    None
}

/// `decide` for an artifact stage's report: `partial` and `blocked` wait for
/// you (`checkpoint`, with the wait recorded); `complete` is `None`, so the
/// turn decides as a stage with no loop-back does (on to the next stage).
pub(super) fn decide_report(run: &mut PipelineRun, stage: &StageDef, report: &ArtifactReport, turn: Option<&str>) -> Option<Decision> {
    let (why, questions, reason) = match report.status.as_str() {
        "partial" => {
            let listed: Vec<String> = report.open_questions.iter().map(|q| format!("- {}", q.trim())).collect();
            (
                format!(
                    "{} has open questions. Answer them in the chain overview; the answers go back to it in the same session:\n{}",
                    stage.title,
                    listed.join("\n")
                ),
                report.open_questions.clone(),
                None,
            )
        }
        "blocked" => {
            let reason = report.reason.clone().unwrap_or_default();
            (
                format!(
                    "{} is blocked: {}. Continue in the chain overview with a note, or hand the stage on yourself.",
                    stage.title,
                    reason.trim().trim_end_matches('.')
                ),
                Vec::new(),
                Some(reason),
            )
        }
        _ => return None,
    };
    // Turns held for an earlier wait stay held for this one, as for a
    // checkpoint story (L3): your answer decides them.
    let held = std::mem::take(&mut autopilot(run).held);
    let decision = stop(run, Some(stage), None, StopReason::Checkpoint, why);
    autopilot(run).held = held;
    autopilot(run).artifact_wait = Some(ArtifactWait {
        stage_id: stage.id.clone(),
        stage_title: stage.title.clone(),
        status: report.status.clone(),
        questions,
        reason,
        artifacts: report.artifacts.clone(),
        turn: turn.map(str::to_string),
        at: chrono::Utc::now().to_rfc3339(),
    });
    Some(decision)
}

/// Your answer to `wait`, checked: trimmed, at most [`MAX_ANSWER_CHARS`],
/// and not empty for open questions (a blocked stage may go on with no note).
pub fn checked_answer(wait: &ArtifactWait, text: Option<&str>) -> Result<String, String> {
    let text = text.map(str::trim).unwrap_or_default();
    if text.chars().count() > MAX_ANSWER_CHARS {
        return Err(format!("The answer is longer than {MAX_ANSWER_CHARS} characters."));
    }
    if wait.status == "partial" && text.is_empty() {
        return Err(format!("Write your answers to {}'s questions first.", wait.stage_title));
    }
    Ok(text.to_string())
}

/// The prompt that resumes the artifact stage's session with your answer.
pub fn answer_message(wait: &ArtifactWait, answer: &str) -> String {
    let documents = if wait.artifacts.is_empty() {
        "your document".to_string()
    } else {
        wait.artifacts.join(", ")
    };
    if wait.status == "partial" {
        let questions: Vec<String> = wait.questions.iter().enumerate().map(|(i, q)| format!("{}. {}", i + 1, q)).collect();
        return format!(
            "The user answered your open questions.\n\nYour questions:\n{}\n\nTheir answers:\n{}\n\n\
             Update {documents} with these decisions, then call submit_result again: `complete` when nothing is left open, \
             or `partial` with the questions that still are.",
            questions.join("\n"),
            answer.trim()
        );
    }
    let reason = wait.reason.as_deref().unwrap_or("").trim();
    let note = if answer.trim().is_empty() {
        "The user asked you to carry on.".to_string()
    } else {
        format!("The user's note:\n{}", answer.trim())
    };
    format!(
        "You reported that you were blocked: {reason}\n\n{note}\n\n\
         Carry on with {documents}, then call submit_result again (`complete`, `partial` with questions, or `blocked` with the reason)."
    )
}

/// The documents artifact stages reported (the run folder's
/// `artifacts.json`), in pipeline order, as (what, path) for the run's
/// hand-off files. A document from a stage that did not report `complete`
/// is listed as such, so a stage you handed on yourself is still seen.
pub fn run_documents(run_dir: &Path, def: &PipelineDef) -> Vec<(String, String)> {
    let Some(file) = crate::bridge::folder::read_artifacts(run_dir) else {
        return Vec::new();
    };
    let mut entries: Vec<_> = file.stages.iter().collect();
    entries.sort_by_key(|entry| def.stage_index(&entry.stage_id).unwrap_or(usize::MAX));
    let mut out = Vec::new();
    for entry in entries {
        let title = def.stage(&entry.stage_id).map(|s| s.title.clone()).unwrap_or_else(|| entry.stage_id.clone());
        let what = if entry.status == "complete" {
            format!("{title} document")
        } else {
            format!("{title} document ({}, not complete)", entry.status)
        };
        for path in &entry.artifacts {
            let full = run_dir.join(path);
            if full.is_file() {
                out.push((what.clone(), full.display().to_string()));
            }
        }
    }
    out
}

#[cfg(test)]
#[path = "artifacts_tests.rs"]
mod tests;
