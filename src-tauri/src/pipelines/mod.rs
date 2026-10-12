//! Pipeline definitions (ADR-014): stages, loop-back edges with round caps
//! and severity thresholds, gates, and checkpoints. Eagle-Eye 1 and 2 are
//! built in (`docs/pipelines/*.json`, bundled with `include_str!`); the
//! user's own pipelines come from `pipelines.json` in app data
//! (`store::PipelineStore`). A chain's `kind` is its pipeline id.
//!
//! The registry is process-wide so the chain-run code (`store/chain_runs.rs`)
//! can look stages up without threading the store through every call.

pub mod autopilot;
mod gates;
#[cfg(test)]
mod tests;

pub use gates::{run_command_gate, run_pull_request_gate, GateResult};

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::{OnceLock, RwLock};

const EAGLE1_JSON: &str = include_str!("../../../docs/pipelines/eagle1.json");
const EAGLE2_JSON: &str = include_str!("../../../docs/pipelines/eagle2.json");

pub const DEFAULT_MAX_ROUNDS: u32 = 3;
pub const DEFAULT_PAUSE_AT_USAGE_PERCENT: u8 = 90;
const MAX_PIPELINES: usize = 50;
const MAX_STAGES: usize = 12;
const MAX_ID_CHARS: usize = 64;
const MAX_TEXT_CHARS: usize = 200;
const MAX_COMMAND_CHARS: usize = 2_000;

/// Finding severity, most severe first. Matches the Codebase Audit tags.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Severity {
    Critical,
    High,
    Medium,
    Low,
    Info,
}

impl Severity {
    /// `self` is at least as severe as `threshold`.
    pub fn at_least(self, threshold: Severity) -> bool {
        self <= threshold
    }

    pub fn label(self) -> &'static str {
        match self {
            Severity::Critical => "CRITICAL",
            Severity::High => "HIGH",
            Severity::Medium => "MEDIUM",
            Severity::Low => "LOW",
            Severity::Info => "INFO",
        }
    }

    pub fn parse(text: &str) -> Option<Severity> {
        match text.trim().to_ascii_uppercase().as_str() {
            "CRITICAL" | "BLOCKER" => Some(Severity::Critical),
            "HIGH" | "MAJOR" => Some(Severity::High),
            "MEDIUM" | "MODERATE" => Some(Severity::Medium),
            "LOW" | "MINOR" => Some(Severity::Low),
            "INFO" | "NIT" | "NITPICK" => Some(Severity::Info),
            _ => None,
        }
    }
}

fn default_max_rounds() -> u32 {
    DEFAULT_MAX_ROUNDS
}

fn default_min_severity() -> Severity {
    Severity::Medium
}

fn default_pause_percent() -> u8 {
    DEFAULT_PAUSE_AT_USAGE_PERCENT
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopBackDef {
    /// Stage id of an earlier stage.
    pub to: String,
    #[serde(default = "default_max_rounds")]
    pub max_rounds: u32,
    /// Findings below this go to follow-ups instead of another round.
    #[serde(default = "default_min_severity")]
    pub min_severity: Severity,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum GateDef {
    /// A shell command in the stage's folder; `auto` picks one.
    #[serde(rename = "command", rename_all = "camelCase")]
    Command {
        run: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timeout_secs: Option<u64>,
    },
    /// Every pull request the stage reported exists (`gh pr view`).
    #[serde(rename = "pullRequest")]
    PullRequest,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageDef {
    pub id: String,
    pub role_id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loop_back: Option<LoopBackDef>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub gates: Vec<GateDef>,
    /// Autopilot stops before starting this stage.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub checkpoint: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutopilotPolicy {
    #[serde(default = "default_pause_percent")]
    pub pause_at_usage_percent: u8,
}

impl Default for AutopilotPolicy {
    fn default() -> Self {
        Self {
            pause_at_usage_percent: DEFAULT_PAUSE_AT_USAGE_PERCENT,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineDef {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// Run kind stored on the chain's run. Built-ins keep `full` / `execute`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_kind: Option<String>,
    pub stages: Vec<StageDef>,
    #[serde(default)]
    pub autopilot: AutopilotPolicy,
    /// Set by the app, never read from a file.
    #[serde(default)]
    pub built_in: bool,
}

impl PipelineDef {
    pub fn run_kind(&self) -> &str {
        self.run_kind.as_deref().unwrap_or(&self.id)
    }

    pub fn stage(&self, stage_id: &str) -> Option<&StageDef> {
        self.stages.iter().find(|stage| stage.id == stage_id)
    }

    pub fn stage_index(&self, stage_id: &str) -> Option<usize> {
        self.stages.iter().position(|stage| stage.id == stage_id)
    }

    /// `(stage id, role id)` per stage, in order.
    pub fn stage_pairs(&self) -> Vec<(String, String)> {
        self.stages
            .iter()
            .map(|stage| (stage.id.clone(), stage.role_id.clone()))
            .collect()
    }
}

fn parse_builtin(json: &str) -> PipelineDef {
    let mut def: PipelineDef = serde_json::from_str(json).expect("built-in pipeline JSON");
    def.built_in = true;
    def
}

pub fn builtins() -> &'static [PipelineDef] {
    static BUILTINS: OnceLock<Vec<PipelineDef>> = OnceLock::new();
    BUILTINS.get_or_init(|| vec![parse_builtin(EAGLE1_JSON), parse_builtin(EAGLE2_JSON)])
}

fn user_registry() -> &'static RwLock<Vec<PipelineDef>> {
    static USER: OnceLock<RwLock<Vec<PipelineDef>>> = OnceLock::new();
    USER.get_or_init(|| RwLock::new(Vec::new()))
}

/// Replace the user's pipelines in the registry (after load or save).
pub fn set_user_pipelines(defs: Vec<PipelineDef>) {
    if let Ok(mut user) = user_registry().write() {
        *user = defs
            .into_iter()
            .map(|mut def| {
                def.built_in = false;
                def
            })
            .collect();
    }
}

/// Built-ins first, then the user's pipelines.
pub fn all() -> Vec<PipelineDef> {
    let mut defs = builtins().to_vec();
    if let Ok(user) = user_registry().read() {
        defs.extend(user.iter().cloned());
    }
    defs
}

/// The pipeline whose id (chain kind) or run kind is `key`.
pub fn find(key: &str) -> Option<PipelineDef> {
    let key = key.trim();
    all()
        .into_iter()
        .find(|def| def.id == key || def.run_kind() == key)
}

/// `(stage id, role id)` per stage of a run kind or chain kind. An unknown
/// kind reads as Eagle-Eye 1, like runs saved before pipelines were data.
pub fn stages(kind: &str) -> Vec<(String, String)> {
    find(kind)
        .unwrap_or_else(|| builtins()[0].clone())
        .stage_pairs()
}

/// Run kind for a chain kind (`eagle1` → `full`), if the pipeline exists.
pub fn run_kind_for_chain(chain_kind: &str) -> Option<String> {
    find(chain_kind).map(|def| def.run_kind().to_string())
}

/// Chain kind (pipeline id) for a run kind (`execute` → `eagle2`).
pub fn chain_kind_for_run(run_kind: &str) -> String {
    find(run_kind)
        .map(|def| def.id)
        .unwrap_or_else(|| "eagle1".to_string())
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.chars().count() <= MAX_ID_CHARS
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
}

fn check_text(what: &str, value: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("{what} is empty."));
    }
    if value.chars().count() > MAX_TEXT_CHARS {
        return Err(format!("{what} is longer than {MAX_TEXT_CHARS} characters."));
    }
    Ok(())
}

/// Problems a person can fix in Settings, one message per pipeline.
pub fn validate_user_pipelines(defs: &[PipelineDef]) -> Result<(), String> {
    if defs.len() > MAX_PIPELINES {
        return Err(format!("At most {MAX_PIPELINES} pipelines."));
    }
    let builtin_keys: HashSet<String> = builtins()
        .iter()
        .flat_map(|def| [def.id.clone(), def.run_kind().to_string()])
        .collect();
    let mut seen = HashSet::new();
    for def in defs {
        let label = if def.name.trim().is_empty() {
            def.id.clone()
        } else {
            def.name.clone()
        };
        let fail = |msg: String| Err(format!("Pipeline \"{label}\": {msg}"));
        if !valid_id(&def.id) {
            return fail("the id may only use letters, digits, _ and -.".into());
        }
        if builtin_keys.contains(&def.id) {
            return fail(format!("\"{}\" is a built-in pipeline id.", def.id));
        }
        if let Some(kind) = &def.run_kind {
            if kind != &def.id {
                return fail("only built-in pipelines set runKind.".into());
            }
        }
        if !seen.insert(def.id.clone()) {
            return fail("two pipelines use this id.".into());
        }
        if let Err(msg) = check_text("the name", &def.name) {
            return fail(msg);
        }
        if def.stages.is_empty() || def.stages.len() > MAX_STAGES {
            return fail(format!("a pipeline has 1 to {MAX_STAGES} stages."));
        }
        let mut stage_ids = HashSet::new();
        for (index, stage) in def.stages.iter().enumerate() {
            if !valid_id(&stage.id) {
                return fail(format!("stage {} needs an id of letters, digits, _ and -.", index + 1));
            }
            if !stage_ids.insert(stage.id.clone()) {
                return fail(format!("two stages use the id \"{}\".", stage.id));
            }
            if !valid_id(&stage.role_id) {
                return fail(format!("stage \"{}\" needs a role id.", stage.id));
            }
            if let Err(msg) = check_text(&format!("stage \"{}\" title", stage.id), &stage.title) {
                return fail(msg);
            }
            if let Some(back) = &stage.loop_back {
                let earlier = def.stages[..index].iter().any(|s| s.id == back.to);
                if !earlier {
                    return fail(format!(
                        "stage \"{}\" loops back to \"{}\", which is not an earlier stage.",
                        stage.id, back.to
                    ));
                }
                if back.max_rounds == 0 || back.max_rounds > 20 {
                    return fail(format!("stage \"{}\": maxRounds is 1 to 20.", stage.id));
                }
            }
            for gate in &stage.gates {
                if let GateDef::Command { run, timeout_secs } = gate {
                    if run.trim().is_empty() || run.chars().count() > MAX_COMMAND_CHARS {
                        return fail(format!(
                            "stage \"{}\": a command gate needs a command (at most {MAX_COMMAND_CHARS} characters).",
                            stage.id
                        ));
                    }
                    if timeout_secs.is_some_and(|secs| secs == 0 || secs > 6 * 3600) {
                        return fail(format!(
                            "stage \"{}\": timeoutSecs is 1 to 21600.",
                            stage.id
                        ));
                    }
                }
            }
        }
        if def.autopilot.pause_at_usage_percent == 0 || def.autopilot.pause_at_usage_percent > 100 {
            return fail("autopilot.pauseAtUsagePercent is 1 to 100.".into());
        }
    }
    Ok(())
}
