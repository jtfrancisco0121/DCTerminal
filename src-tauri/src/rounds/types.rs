//! A QA round as `state.json` lists it (R2): its settings and one entry per
//! plan of its `round.json`, with the plan's run once it started.

use serde::{Deserialize, Serialize};

/// Where a plan of the round stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlanRunState {
    /// In the round, not started yet: its wave, the cap or Commit up to wave holds it.
    Ready,
    /// Its run is under way (or waits for you at a checkpoint).
    Running,
    /// Its run is complete.
    Done,
    /// Its run stopped (or could not start): later waves wait until it is resolved.
    Stopped,
    /// Waiting on a product decision: it starts only once you unpark it.
    Parked,
    /// Its fix is outside our repos: it never starts.
    Deferred,
}

impl PlanRunState {
    pub fn label(self) -> &'static str {
        match self {
            PlanRunState::Ready => "ready",
            PlanRunState::Running => "running",
            PlanRunState::Done => "done",
            PlanRunState::Stopped => "stopped",
            PlanRunState::Parked => "parked",
            PlanRunState::Deferred => "deferred",
        }
    }
}

/// One plan of a round and its run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundPlanRun {
    pub plan_id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wave: Option<u32>,
    pub state: PlanRunState,
    /// The plan's run, once it started.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    /// Why it stopped (its run's stop, or why it could not start), or what
    /// its run waits for.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// A QA round (R2): one run per active plan of a Triage run's approved
/// `round.json`, started wave by wave. Its files are in `rounds/<id>/`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QaRound {
    /// `round_<ms>`.
    pub id: String,
    /// The Triage run whose round this is.
    pub triage_run_id: String,
    pub title: String,
    /// The home folder each plan run starts in (the Triage run's).
    pub cwd: String,
    /// The window the plan runs' tabs open in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_id: Option<String>,
    /// The pipeline each plan runs (default Eagle-Eye 1).
    pub pipeline: String,
    /// Plan runs at once (1 to 8, default 2).
    pub runs_at_once: u32,
    /// **Commit up to wave N**: later waves stay ready but do not start.
    pub commit_up_to_wave: u32,
    /// How many waves the round has.
    pub waves: u32,
    pub plans: Vec<RoundPlanRun>,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

impl QaRound {
    pub fn plan(&self, plan_id: &str) -> Option<&RoundPlanRun> {
        self.plans.iter().find(|plan| plan.plan_id == plan_id)
    }

    pub fn plan_mut(&mut self, plan_id: &str) -> Option<&mut RoundPlanRun> {
        self.plans.iter_mut().find(|plan| plan.plan_id == plan_id)
    }

    /// The plan whose run is `run_id`.
    pub fn plan_of_run(&self, run_id: &str) -> Option<&RoundPlanRun> {
        self.plans.iter().find(|plan| plan.run_id.as_deref() == Some(run_id))
    }
}
