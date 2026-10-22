//! Pipeline definitions (ADR-014): stages, loop-back edges with round caps
//! and severity thresholds, gates, and checkpoints. Eagle-Eye 1 and 2 are
//! built in (`docs/pipelines/*.json`, bundled with `include_str!`); the
//! user's own pipelines come from `pipelines.json` in app data
//! (`store::PipelineStore`). A chain's `kind` is its pipeline id.
//!
//! The registry is process-wide so the chain-run code (`store/chain_runs.rs`)
//! can look stages up without threading the store through every call.
//!
//! Track H4: each stage has a `kind` (planner, reviewer, implementer,
//! generic), so a copied role behaves like its original; behaviour never
//! keys on a built-in role id. Your own pipelines are checked when they
//! load and whenever the roles change: one that does not validate stays in
//! the list, disabled, with the reason, and is never dropped. An unknown
//! run kind is an error, never a silent Eagle-Eye 1.

pub mod autopilot;
mod gates;
pub mod lane_gates;
pub mod verify;
pub mod stories;
pub mod recovery;
#[cfg(test)]
mod tests;

pub use gates::{run_command_gate, run_pull_request_gate, GateResult};

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::{OnceLock, RwLock};

const EAGLE1_JSON: &str = include_str!("../../../docs/pipelines/eagle1.json");
const EAGLE2_JSON: &str = include_str!("../../../docs/pipelines/eagle2.json");
/// The QA round (R1): Triage, its Plan Reviewer, then your approval.
const ROUND_JSON: &str = include_str!("../../../docs/pipelines/round.json");

pub const DEFAULT_PAUSE_AT_USAGE_PERCENT: u8 = 90;
/// Minutes a Working stage may print nothing and write no log before the
/// stall watchdog stops the run (D30).
pub const DEFAULT_STALL_MINUTES: u32 = 30;
/// Largest `stallMinutes`: one day.
pub(crate) const MAX_STALL_MINUTES: u32 = 24 * 60;
const MAX_PIPELINES: usize = 50;
const MAX_STAGES: usize = 12;
const MAX_ID_CHARS: usize = 64;
const MAX_TEXT_CHARS: usize = 200;
const MAX_COMMAND_CHARS: usize = 2_000;
/// A `verify` gate's steps (L2).
pub const MAX_VERIFY_STEPS_CHARS: usize = 2_000;

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

fn default_min_severity() -> Severity {
    Severity::Medium
}

fn default_pause_percent() -> u8 {
    DEFAULT_PAUSE_AT_USAGE_PERCENT
}

fn default_stall_minutes() -> u32 {
    DEFAULT_STALL_MINUTES
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopBackDef {
    /// Stage id of an earlier stage.
    pub to: String,
    /// Most rounds this edge sends back before autopilot stops. `None`
    /// (the default): no limit, rounds go back until the reviewer approves.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_rounds: Option<u32>,
    /// Findings below this go to follow-ups instead of another round.
    #[serde(default = "default_min_severity")]
    pub min_severity: Severity,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum GateDef {
    /// A shell command in the stage's folder; `auto` picks one. An `auto`
    /// gate that finds nothing to run stops the run (`no_check_found`)
    /// unless it is `optional`.
    #[serde(rename = "command", rename_all = "camelCase")]
    Command {
        run: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timeout_secs: Option<u64>,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        optional: bool,
    },
    /// Every pull request the stage reported exists (`gh pr view`).
    #[serde(rename = "pullRequest")]
    PullRequest,
    /// A check the app cannot run itself (L2, E9), such as a Playwright run
    /// on a Windows staging build: once the stage's other gates pass, the
    /// run waits (`checkpoint`) with these steps until you mark them
    /// verified or failed with a note.
    #[serde(rename = "verify")]
    Verify { steps: String },
}

/// What a stage does, whatever its role is called (D33). Read by every rule
/// that used to key on `role_planner` and friends.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StageKind {
    Planner,
    Reviewer,
    Implementer,
    Generic,
}

impl StageKind {
    /// The kind as written in `pipelines.json`.
    pub fn label(self) -> &'static str {
        match self {
            StageKind::Planner => "planner",
            StageKind::Reviewer => "reviewer",
            StageKind::Implementer => "implementer",
            StageKind::Generic => "generic",
        }
    }

    /// The kind of a built-in role, if `role_id` is one.
    pub fn of_builtin_role(role_id: &str) -> Option<StageKind> {
        match role_id.trim() {
            // R1: Triage plans a round in plan mode, as the Planner plans.
            "role_planner" | "role_triage" => Some(StageKind::Planner),
            "role_plan_reviewer" | "role_pr_reviewer" => Some(StageKind::Reviewer),
            "role_implementer" => Some(StageKind::Implementer),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageDef {
    pub id: String,
    pub role_id: String,
    pub title: String,
    /// What the stage does. Left out: from the built-in role id, else
    /// `reviewer` for a stage with a loop-back, else `generic` (`kind()`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<StageKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loop_back: Option<LoopBackDef>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub gates: Vec<GateDef>,
    /// Autopilot stops before starting this stage.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub checkpoint: bool,
    /// Specialist reviewers (role ids) that review the same work in
    /// parallel with this stage's role; their findings merge into one verdict.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub also_reviewers: Vec<String>,
    /// R1: a Triage stage. A `planner` stage that hands over a QA round
    /// (`round.json`: plans, waves, merge order) instead of tasks.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub round: bool,
}

impl StageDef {
    /// The stage's kind: as set, else from the built-in role id, else a
    /// stage that loops back reviews, else generic.
    pub fn kind(&self) -> StageKind {
        self.kind
            .or_else(|| StageKind::of_builtin_role(&self.role_id))
            .unwrap_or(if self.loop_back.is_some() {
                StageKind::Reviewer
            } else {
                StageKind::Generic
            })
    }

    /// The stage's role, then its parallel reviewers.
    pub fn roles(&self) -> Vec<String> {
        std::iter::once(self.role_id.clone())
            .chain(self.also_reviewers.iter().cloned())
            .collect()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutopilotPolicy {
    #[serde(default = "default_pause_percent")]
    pub pause_at_usage_percent: u8,
    /// While a stage is Working, this many minutes with no terminal output
    /// and no log growth stops the run with `stalled` (Track H3).
    #[serde(default = "default_stall_minutes")]
    pub stall_minutes: u32,
}

impl Default for AutopilotPolicy {
    fn default() -> Self {
        Self {
            pause_at_usage_percent: DEFAULT_PAUSE_AT_USAGE_PERCENT,
            stall_minutes: DEFAULT_STALL_MINUTES,
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
    /// R1: autopilot never completes the run by itself. When its last stage
    /// approves, the run waits with `checkpoint` until you approve it.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub approve_at_end: bool,
    /// Set by the app, never read from a file.
    #[serde(default)]
    pub built_in: bool,
    /// Why this pipeline of yours is disabled (it does not validate, for
    /// example a role it names was deleted). Set by the app on load; a
    /// disabled pipeline is listed but cannot start or drive a run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disabled: Option<String>,
    /// The entry exactly as `pipelines.json` has it, when it could not be
    /// read as a pipeline at all. Settings shows it so nothing is lost.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw: Option<serde_json::Value>,
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

/// One entry of `pipelines.json`. An entry that is not a pipeline at all is
/// kept as a disabled placeholder carrying the entry itself, never dropped.
pub fn parse_user_entry(value: serde_json::Value, index: usize) -> PipelineDef {
    match serde_json::from_value::<PipelineDef>(value.clone()) {
        Ok(def) => def,
        Err(err) => {
            let text = |key: &str| {
                value
                    .get(key)
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
            };
            let id = text("id").unwrap_or_else(|| format!("pipeline_{}", index + 1));
            PipelineDef {
                name: text("name").unwrap_or_else(|| id.clone()),
                id,
                description: String::new(),
                run_kind: None,
                stages: Vec::new(),
                autopilot: AutopilotPolicy::default(),
                approve_at_end: false,
                built_in: false,
                disabled: Some(format!("It could not be read: {err}.")),
                raw: Some(value),
            }
        }
    }
}

fn parse_builtin(json: &str) -> PipelineDef {
    let mut def: PipelineDef = serde_json::from_str(json).expect("built-in pipeline JSON");
    def.built_in = true;
    def
}

pub fn builtins() -> &'static [PipelineDef] {
    static BUILTINS: OnceLock<Vec<PipelineDef>> = OnceLock::new();
    BUILTINS.get_or_init(|| vec![parse_builtin(EAGLE1_JSON), parse_builtin(EAGLE2_JSON), parse_builtin(ROUND_JSON)])
}

fn user_registry() -> &'static RwLock<Vec<PipelineDef>> {
    static USER: OnceLock<RwLock<Vec<PipelineDef>>> = OnceLock::new();
    USER.get_or_init(|| RwLock::new(Vec::new()))
}

/// Role ids that exist (`roles.json`), published by the roles store. `None`
/// until it is: role ids are then not checked.
fn known_roles() -> &'static RwLock<Option<HashSet<String>>> {
    static ROLES: OnceLock<RwLock<Option<HashSet<String>>>> = OnceLock::new();
    ROLES.get_or_init(|| RwLock::new(None))
}

fn known_roles_now() -> Option<HashSet<String>> {
    known_roles().read().ok().and_then(|roles| roles.clone())
}

/// Each pipeline with `disabled` set from its own problem (`roles`: the role
/// ids that exist, `None` to skip that check). An entry that could not be
/// read at all keeps its reason.
pub fn checked_user_pipelines(mut defs: Vec<PipelineDef>, roles: Option<&HashSet<String>>) -> Vec<PipelineDef> {
    for def in defs.iter_mut() {
        def.built_in = false;
        if def.raw.is_none() {
            def.disabled = None;
        }
    }
    let problems = pipeline_problems(&defs, roles);
    for (def, problem) in defs.iter_mut().zip(problems) {
        if def.raw.is_none() {
            def.disabled = problem;
        }
    }
    defs
}

/// Replace the user's pipelines in the registry (after load or save). Each
/// one is checked; one that does not validate is kept, disabled.
pub fn set_user_pipelines(defs: Vec<PipelineDef>) {
    let defs = checked_user_pipelines(defs, known_roles_now().as_ref());
    if let Ok(mut user) = user_registry().write() {
        *user = defs;
    }
}

/// The role ids that exist now (at startup and after a role is added or
/// removed). Your pipelines are checked again: one naming a deleted role
/// becomes disabled, and one whose role came back is enabled again.
pub fn set_known_roles(ids: impl IntoIterator<Item = String>) {
    let ids: HashSet<String> = ids.into_iter().collect();
    if let Ok(mut roles) = known_roles().write() {
        *roles = Some(ids.clone());
    }
    if let Ok(mut user) = user_registry().write() {
        let defs = std::mem::take(&mut *user);
        *user = checked_user_pipelines(defs, Some(&ids));
    }
}

/// Tests share the registry: add or replace one pipeline without touching others.
#[cfg(test)]
pub(crate) fn register_for_test(def: PipelineDef) {
    if let Ok(mut user) = user_registry().write() {
        user.retain(|d| d.id != def.id);
        user.push(def);
    }
}

#[cfg(test)]
pub(crate) fn unregister_for_test(id: &str) {
    if let Ok(mut user) = user_registry().write() {
        user.retain(|d| d.id != id);
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

/// The pipeline `key` names, enabled: an unknown or disabled pipeline is an
/// error that says which and why.
pub fn find_enabled(key: &str) -> Result<PipelineDef, String> {
    let def = find(key).ok_or_else(|| format!("unknown pipeline: {}", key.trim()))?;
    match &def.disabled {
        Some(why) => Err(format!("The pipeline \"{}\" is disabled: {why}", def.name)),
        None => Ok(def),
    }
}

/// `(stage id, role id)` per stage of a run kind or chain kind. An unknown
/// kind is `None`, never Eagle-Eye 1 (every run ever saved has a known one).
pub fn stages(kind: &str) -> Option<Vec<(String, String)>> {
    find(kind).map(|def| def.stage_pairs())
}

/// The kind of the stage a chain tag (`kind` + 1-based `step`) points at:
/// what decides a stage tab's permission mode. `None` when the pipeline or
/// the step is unknown.
pub fn stage_kind_for_chain(chain: &crate::store::ChainRef) -> Option<StageKind> {
    let def = find(&chain.kind)?;
    let index = (chain.step as usize).checked_sub(1)?;
    def.stages.get(index).map(StageDef::kind)
}

/// Run kind for a chain kind (`eagle1` → `full`), if the pipeline exists.
pub fn run_kind_for_chain(chain_kind: &str) -> Option<String> {
    find(chain_kind).map(|def| def.run_kind().to_string())
}

/// Chain kind (pipeline id) for a run kind (`execute` → `eagle2`); `None`
/// for an unknown one.
pub fn chain_kind_for_run(run_kind: &str) -> Option<String> {
    find(run_kind).map(|def| def.id)
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

fn label_of(def: &PipelineDef) -> String {
    if def.name.trim().is_empty() {
        def.id.clone()
    } else {
        def.name.clone()
    }
}

/// Problems a person can fix in Settings: the first one for each pipeline,
/// in order, or `None` when it is fine. `roles` are the role ids that exist
/// (`None`: not checked). A later pipeline reusing an id is the one at fault.
pub fn pipeline_problems(defs: &[PipelineDef], roles: Option<&HashSet<String>>) -> Vec<Option<String>> {
    let builtin_keys: HashSet<String> = builtins()
        .iter()
        .flat_map(|def| [def.id.clone(), def.run_kind().to_string()])
        .collect();
    let mut seen = HashSet::new();
    defs.iter()
        .enumerate()
        .map(|(index, def)| {
            // An id is taken by its first entry, valid, readable or not.
            let repeated = !seen.insert(def.id.clone());
            if let Some(why) = def.disabled.as_ref().filter(|_| def.raw.is_some()) {
                return Some(why.clone());
            }
            if index >= MAX_PIPELINES {
                return Some(format!("at most {MAX_PIPELINES} pipelines."));
            }
            check_pipeline(def, &builtin_keys, roles)
                .err()
                .or_else(|| repeated.then(|| "two pipelines use this id.".to_string()))
        })
        .collect()
}

/// For a save: every pipeline must validate, role ids included (against the
/// roles published by the roles store). Names the first problem.
pub fn validate_user_pipelines(defs: &[PipelineDef]) -> Result<(), String> {
    validate_user_pipelines_with(defs, known_roles_now().as_ref())
}

pub fn validate_user_pipelines_with(defs: &[PipelineDef], roles: Option<&HashSet<String>>) -> Result<(), String> {
    if defs.len() > MAX_PIPELINES {
        return Err(format!("At most {MAX_PIPELINES} pipelines."));
    }
    match defs
        .iter()
        .zip(pipeline_problems(defs, roles))
        .find_map(|(def, problem)| problem.map(|msg| (def, msg)))
    {
        Some((def, msg)) => Err(format!("Pipeline \"{}\": {msg}", label_of(def))),
        None => Ok(()),
    }
}

/// The first problem of one pipeline, on its own.
fn check_pipeline(
    def: &PipelineDef,
    builtin_keys: &HashSet<String>,
    roles: Option<&HashSet<String>>,
) -> Result<(), String> {
    if !valid_id(&def.id) {
        return Err("the id may only use letters, digits, _ and -.".into());
    }
    if builtin_keys.contains(&def.id) {
        return Err(format!("\"{}\" is a built-in pipeline id.", def.id));
    }
    if let Some(kind) = &def.run_kind {
        if kind != &def.id {
            return Err("only built-in pipelines set runKind.".into());
        }
    }
    check_text("the name", &def.name)?;
    if def.stages.is_empty() || def.stages.len() > MAX_STAGES {
        return Err(format!("a pipeline has 1 to {MAX_STAGES} stages."));
    }
    let mut stage_ids = HashSet::new();
    let mut roles_used: HashSet<String> = HashSet::new();
    for stage in &def.stages {
        // A repeat inside one stage is reported below as listed "twice".
        let in_stage: HashSet<String> = stage.roles().into_iter().collect();
        for role in in_stage {
            if !roles_used.insert(role.clone()) {
                return Err(format!(
                    "the role \"{role}\" is in two stages. A run keeps one tab per role, so use a copy of the role (Settings › Roles › Duplicate)."
                ));
            }
        }
    }
    for (index, stage) in def.stages.iter().enumerate() {
        if !valid_id(&stage.id) {
            return Err(format!("stage {} needs an id of letters, digits, _ and -.", index + 1));
        }
        if !stage_ids.insert(stage.id.clone()) {
            return Err(format!("two stages use the id \"{}\".", stage.id));
        }
        if !valid_id(&stage.role_id) {
            return Err(format!("stage \"{}\" needs a role id.", stage.id));
        }
        if let Some(missing) = roles.and_then(|roles| stage.roles().into_iter().find(|role| !roles.contains(role))) {
            return Err(format!(
                "stage \"{}\" uses the role \"{missing}\", which does not exist (deleted or renamed?).",
                stage.id
            ));
        }
        check_text(&format!("stage \"{}\" title", stage.id), &stage.title)?;
        // Autopilot reads a verdict from a stage exactly when it loops back,
        // so a kind written in the file must agree with its loopBack.
        match (stage.kind, stage.loop_back.is_some()) {
            (Some(kind), true) if kind != StageKind::Reviewer => {
                return Err(format!(
                    "stage \"{}\" has a loopBack, so its kind is reviewer (it is set to {}). Change the kind or remove the loopBack.",
                    stage.id,
                    kind.label()
                ));
            }
            (Some(StageKind::Reviewer), false) => {
                return Err(format!(
                    "stage \"{}\" is a reviewer, so it needs a loopBack (reviewers send rounds back). Add one or change the kind.",
                    stage.id
                ));
            }
            _ => {}
        }
        if !stage.also_reviewers.is_empty() {
            if stage.loop_back.is_none() {
                return Err(format!(
                    "stage \"{}\" has alsoReviewers, so it needs a loopBack (reviewers send rounds back).",
                    stage.id
                ));
            }
            if stage.also_reviewers.len() > 4 {
                return Err(format!("stage \"{}\": at most 4 alsoReviewers.", stage.id));
            }
            let mut seen_roles = HashSet::from([stage.role_id.clone()]);
            for role in &stage.also_reviewers {
                if !valid_id(role) || !seen_roles.insert(role.clone()) {
                    return Err(format!(
                        "stage \"{}\": alsoReviewers lists \"{role}\" twice or it is not a role id.",
                        stage.id
                    ));
                }
            }
        }
        // R1: a round is handed over through ExitPlanMode, as a plan is.
        if stage.round && stage.kind() != StageKind::Planner {
            return Err(format!(
                "stage \"{}\" hands over a round, so its kind is planner (it is {}).",
                stage.id,
                stage.kind().label()
            ));
        }
        if let Some(back) = &stage.loop_back {
            let earlier = def.stages[..index].iter().any(|s| s.id == back.to);
            if !earlier {
                return Err(format!(
                    "stage \"{}\" loops back to \"{}\", which is not an earlier stage.",
                    stage.id, back.to
                ));
            }
            if back.max_rounds.is_some_and(|max| max == 0 || max > 20) {
                return Err(format!(
                    "stage \"{}\": maxRounds is 1 to 20, or left out for no limit.",
                    stage.id
                ));
            }
        }
        for gate in &stage.gates {
            if let GateDef::Verify { steps } = gate {
                // L2: the steps are what the overview shows you while the run waits.
                if steps.trim().is_empty() || steps.trim().chars().count() > MAX_VERIFY_STEPS_CHARS {
                    return Err(format!(
                        "stage \"{}\": a verify gate needs steps (1 to {MAX_VERIFY_STEPS_CHARS} characters).",
                        stage.id
                    ));
                }
            }
            if let GateDef::Command { run, timeout_secs, .. } = gate {
                if run.trim().is_empty() || run.chars().count() > MAX_COMMAND_CHARS {
                    return Err(format!(
                        "stage \"{}\": a command gate needs a command (at most {MAX_COMMAND_CHARS} characters).",
                        stage.id
                    ));
                }
                if timeout_secs.is_some_and(|secs| secs == 0 || secs > 6 * 3600) {
                    return Err(format!(
                        "stage \"{}\": timeoutSecs is 1 to 21600.",
                        stage.id
                    ));
                }
            }
        }
    }
    // R1: a round run has no tasks.json, so nothing can fan out of it.
    if def.stages.iter().any(|s| s.round) && def.stages.iter().any(|s| s.kind() == StageKind::Implementer) {
        return Err("a pipeline with a round stage has no implementer stage: each plan of the round gets a run of its own.".into());
    }
    if def.autopilot.pause_at_usage_percent == 0 || def.autopilot.pause_at_usage_percent > 100 {
        return Err("autopilot.pauseAtUsagePercent is 1 to 100.".into());
    }
    if def.autopilot.stall_minutes == 0 || def.autopilot.stall_minutes > MAX_STALL_MINUTES {
        return Err(format!("autopilot.stallMinutes is 1 to {MAX_STALL_MINUTES}."));
    }
    Ok(())
}
