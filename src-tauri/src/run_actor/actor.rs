//! One run's actor: what each message does. See the module header in
//! `mod.rs` for the model. Every step copies what it needs out of the store,
//! drops the lock, then does the slow part (a gate, a spawn, a resume), and
//! locks again only to write the result back (`store/mod.rs`).

use super::prompts::{self, StageSources};
use super::{lock, ActorMsg, Host, Prefill, StageLaunch, UserAction, UserOutcome};
use crate::bridge::folder::{read_json, RunFindings, RunPrs, TASKS_FILE};
use crate::bridge::launch::{
    clear_stage_turn, launch_flags, plan_for, prepare_stage, read_stage_turn, relaunch_flags, restore_stage_turn,
    set_stage_mode, BridgePlan,
};
use crate::bridge::{BridgeTag, BridgeTurn, StageMode, TurnOutcome};
use crate::commands::pipeline::{approve, note, set_lane_status, turn_finished};
use crate::pipelines::autopilot::{decide, review_round, stage_key, Decision, FindingReport, TurnReport};
use crate::pipelines::recovery::bridge_turn_key;
use crate::pipelines::{GateDef, GateResult, PipelineDef, StageDef, StageKind};
use crate::store::{
    claim_key, tab_label, ChainRef, PipelineRun, RoleSnapshot, RunStatus, StageGates, StopReason, TabRecord,
    TerminalTabDraft,
};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::Sender;
use std::sync::Arc;

/// What a re-ask pastes (engine-1 wording; a bridged stage is never re-asked
/// for HANDOFF sections, `submit_result` is its result).
const ASK_FOR_RESULT: &str = "Your reply is missing its result. Repeat your result, complete and self-contained, and report it as your instructions say.";
/// What a round sent back asks of the Planner and of the Implementer
/// (`src/handoff/routing.ts`, which reads them back).
const PLANNER_ASK: &str = "Revise the plan to address these findings, then reply with the full revised plan, ending with the `## HANDOFF: Plan` and `## HANDOFF: Open questions` sections.";
const IMPLEMENTER_ASK: &str = "Address these findings, then push to the same branch of each pull request they name so the existing pull requests update (do not open new ones). End your reply with the HANDOFF sections: Implementation summary, Files changed, Tests run, Deviations from the plan, and Pull requests (the same URLs).";

/// A tab of this run and where it sits.
#[derive(Debug, Clone)]
struct Placed {
    def: PipelineDef,
    index: usize,
    stage: StageDef,
    chain: ChainRef,
    tab: TabRecord,
    /// The lane, when the run has it.
    lane: Option<String>,
}

impl Placed {
    fn revise(&self) -> &'static str {
        revise_word(&self.def, &self.stage)
    }
}

/// How a terminal the actor opens joins the chain.
enum Tagging {
    /// The next stage: the hand-off text is recorded on the run.
    Advance { text: String },
    /// A round sent back to a new terminal of the earlier stage.
    LoopBack { reviewer_role: String, verdict: String, text: String },
    /// A lane's own tab, tagged at fan-out.
    Existing,
}

struct Open {
    role_id: String,
    chain: ChainRef,
    cwd: String,
    window_id: String,
    preferred_tab: Option<String>,
    values: HashMap<String, String>,
    handoff_plan: String,
    tagging: Tagging,
}

pub(super) struct Actor<H: Host> {
    run_id: String,
    host: Arc<H>,
    me: Sender<ActorMsg>,
    /// Bridged tabs: the turn (Claude's `prompt_id`) last taken up.
    handled: HashMap<String, String>,
    /// Gate runs started and not yet back.
    gates_running: usize,
}

impl<H: Host> Actor<H> {
    pub(super) fn new(run_id: String, host: Arc<H>, me: Sender<ActorMsg>) -> Self {
        Self {
            run_id,
            host,
            me,
            handled: HashMap::new(),
            gates_running: 0,
        }
    }

    /// Gates are running: the thread waits for them before it goes idle.
    pub(super) fn busy(&self) -> bool {
        self.gates_running > 0
    }

    /// Handle one message. True when the run is over (complete or gone) and
    /// nothing is pending, so the thread can end.
    pub(super) fn handle(&mut self, msg: ActorMsg) -> bool {
        match msg {
            ActorMsg::Turn(turn) => self.on_turn(turn, false),
            ActorMsg::User { action, reply } => {
                let result = self.on_user(action);
                if let Some(reply) = reply {
                    let _ = reply.send(result);
                }
            }
            ActorMsg::GatesDone { turn, round, results } => {
                self.gates_running = self.gates_running.saturating_sub(1);
                self.on_gates_done(turn, round, results);
            }
            ActorMsg::Exited { tab_id, code } => self.on_exit(&tab_id, code),
        }
        !self.busy() && self.run_over()
    }

    /// Nothing more for this thread: the run is complete, gone, or not an
    /// engine-2 run (the frontend drives those).
    fn run_over(&self) -> bool {
        let store = lock(self.host.store());
        store.pipeline_run_by_id(&self.run_id).is_none_or(|run| {
            run.status == RunStatus::Complete || run.engine < crate::bridge::launch::ENGINE_V2
        })
    }

    fn changed(&self) {
        self.host.run_changed(&self.run_id);
    }

    // ---- Where things are ----

    /// `tab_id` on this run: its stage, chain and lane. `None` for a tab on
    /// another run, or none.
    fn place_tab(&self, tab_id: &str) -> Option<Placed> {
        let store = lock(self.host.store());
        let tab = store.tab_by_id(tab_id)?.clone();
        let chain = tab.chain.clone()?;
        if store.chain_run_id(&chain.chain_id).as_deref() != Some(self.run_id.as_str()) {
            return None;
        }
        // An engine-1 run keeps the v1 path (the frontend's autopilot).
        let run = store
            .pipeline_run_by_id(&self.run_id)
            .filter(|run| run.engine >= crate::bridge::launch::ENGINE_V2)?;
        let def = crate::pipelines::find(&run.kind)?;
        let index = (chain.step as usize).checked_sub(1)?;
        let stage = def.stages.get(index)?.clone();
        let lane = chain.lane.clone().filter(|id| run.lane(id).is_some());
        Some(Placed {
            def,
            index,
            stage,
            chain,
            tab,
            lane,
        })
    }

    /// The tab a bridge turn came from, when it still holds that stage.
    fn place_turn(&self, turn: &BridgeTurn) -> Option<Placed> {
        if turn.run_id != self.run_id {
            return None;
        }
        let placed = self.place_tab(&turn.tab_id)?;
        let tag = placed.tab.bridge.as_ref()?;
        (tag.run_id == turn.run_id && tag.stage == turn.stage_key && placed.stage.id == turn.stage_id).then_some(placed)
    }

    /// The stage terminal's usage-limit error for its latest turn (its
    /// session log, read with no store lock held).
    fn rate_limit(&self, placed: &Placed) -> Option<String> {
        self.host
            .rate_limit(&placed.tab.id)
            .map(|error| error.trim().to_string())
            .filter(|error| !error.is_empty())
    }

    /// `key` is on the run's decided-turn list.
    fn decided(&self, key: &str) -> bool {
        let store = lock(self.host.store());
        store
            .pipeline_run_by_id(&self.run_id)
            .and_then(|run| run.autopilot.as_ref())
            .is_some_and(|autopilot| autopilot.decided.iter().any(|seen| seen == key))
    }

    fn round(&self, lane: Option<&str>) -> u32 {
        let store = lock(self.host.store());
        store
            .pipeline_run_by_id(&self.run_id)
            .map(|run| run.round_for(lane))
            .unwrap_or(1)
    }

    /// The stage's terminal runs and its latest turn has ended: it can be
    /// sent its next prompt. Read from the bridge's `turn.json`, never from
    /// the screen.
    fn idle(&self, tab: &TabRecord) -> bool {
        let Some(tag) = tab.bridge.as_ref() else {
            return false;
        };
        self.host.terminal_live(&tab.id) && read_stage_turn(&self.host.runs_root(), tag, &tab.id).is_some()
    }

    /// You took `tab_id` over (V5, D28): autopilot leaves it alone.
    fn taken_over(&self, tab_id: &str) -> bool {
        let store = lock(self.host.store());
        store
            .pipeline_run_by_id(&self.run_id)
            .is_some_and(|run| run.taken_over.iter().any(|id| id == tab_id))
    }

    // ---- Finished turns ----

    /// A bridged stage finished a turn: record it, then (autopilot on) run
    /// its gates or decide. `again`: Continue re-reads a turn on purpose.
    fn on_turn(&mut self, turn: BridgeTurn, again: bool) {
        let Some(placed) = self.place_turn(&turn) else {
            return;
        };
        if !again && self.handled.get(&turn.tab_id) == Some(&turn.turn) {
            return;
        }
        self.handled.insert(turn.tab_id.clone(), turn.turn.clone());
        // Decided already (by this thread before it went idle, or before a
        // restart): no checks, no ledger line, nothing carried out again.
        // The key is H3's (`recovery::bridge_turn_key`), so the startup
        // reconcile sees the same turn as decided.
        if self.decided(&bridge_turn_key(&turn.tab_id, &turn.turn)) {
            return;
        }
        let verdict = bridge_verdict(review(&turn).and_then(|r| r.get("verdict")).and_then(Value::as_str), placed.revise());
        let (enabled, status, round, mine) = {
            let mut store = lock(self.host.store());
            // intentionally silent: the lanes only lose a bar end.
            let _ = turn_finished(
                &mut store,
                &self.run_id,
                &placed.stage.id,
                &placed.tab.role_id,
                placed.lane.as_deref(),
                verdict.as_deref(),
            );
            match store.pipeline_run_by_id(&self.run_id) {
                Some(run) => (
                    run.autopilot.as_ref().is_some_and(|a| a.enabled),
                    run.status,
                    run.round_for(placed.lane.as_deref()),
                    run.taken_over.iter().any(|id| id == &placed.tab.id),
                ),
                None => return,
            }
        };
        self.changed();
        // You drive a stage you took over: its turns are recorded, never
        // decided (D28). Hand back decides the one that has a result.
        if !enabled || status == RunStatus::Complete || mine {
            return;
        }
        self.take_up(&placed, turn, round, status);
    }

    /// Act on a finished turn: its gates first (on a running run), then a
    /// decision. A blocked Implementer opened nothing to check: it waits for
    /// you (V2b). A turn Claude refused for the usage limit stops before any
    /// check runs (H5).
    fn take_up(&mut self, placed: &Placed, turn: BridgeTurn, round: u32, status: RunStatus) {
        let refused = self.rate_limit(placed);
        if status == RunStatus::Running && !placed.stage.gates.is_empty() && blocked(&turn).is_none() && refused.is_none() {
            self.start_gates(placed, turn, round);
            return;
        }
        self.decide_and_carry_out(placed, &turn, round);
    }

    /// Run the stage's gates on a thread of their own; the results come
    /// back as `GatesDone`.
    fn start_gates(&mut self, placed: &Placed, turn: BridgeTurn, round: u32) {
        let gates = placed.stage.gates.clone();
        let folder = {
            let store = lock(self.host.store());
            let run_cwd = store.pipeline_run_by_id(&self.run_id).map(|r| r.cwd.clone()).unwrap_or_default();
            PathBuf::from(if placed.tab.cwd.trim().is_empty() { run_cwd } else { placed.tab.cwd.clone() })
        };
        let prs = pr_urls(&turn);
        let host = self.host.clone();
        let me = self.me.clone();
        self.gates_running += 1;
        let spawned = std::thread::Builder::new()
            .name(format!("run-gates-{}", self.run_id))
            .spawn(move || {
                let results = gates
                    .iter()
                    .map(|gate| {
                        // H4: `decide` stops on an `auto` check with nothing
                        // to run unless the gate is optional, so the result
                        // carries the gate's flag (as `pipeline_run_gates`).
                        let optional = matches!(gate, GateDef::Command { optional: true, .. });
                        let result =
                            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| host.run_gate(gate, &folder, &prs)))
                                .unwrap_or_else(|_| GateResult {
                                    kind: "command".into(),
                                    label: "check".into(),
                                    status: "failed".into(),
                                    summary: "The check could not run (internal error).".into(),
                                    output: String::new(),
                                    duration_ms: 0,
                                    optional: false,
                                });
                        GateResult { optional, ..result }
                    })
                    .collect();
                let _ = me.send(ActorMsg::GatesDone { turn, round, results });
            });
        if let Err(err) = spawned {
            self.gates_running -= 1;
            self.stop_run(Some(&placed.stage.id), Some(&placed.tab.id), &format!("Autopilot could not run the checks: {err}"), None);
        }
    }

    fn on_gates_done(&mut self, turn: BridgeTurn, round: u32, results: Vec<GateResult>) {
        let Some(placed) = self.place_turn(&turn) else {
            return;
        };
        let lane = placed.lane.as_deref();
        {
            let mut store = lock(self.host.store());
            let Some(run) = store.pipeline_run_by_id_mut(&self.run_id) else {
                return;
            };
            // Results from a round that has ended since are not kept.
            if round == run.round_for(lane) {
                let tag = lane.and_then(|id| run.lane(id)).map(|l| format!("{}: ", l.title)).unwrap_or_default();
                for result in &results {
                    run.log_in_lane(
                        "gate",
                        Some(&placed.stage.id),
                        None,
                        lane,
                        format!("{tag}{}: {}", result.label, result.summary),
                        (!result.output.is_empty()).then(|| result.output.clone()),
                        Some(result.status.clone()),
                    );
                }
                run.gates.insert(
                    stage_key(&placed.stage.id, lane),
                    StageGates {
                        round,
                        at: chrono::Utc::now().to_rfc3339(),
                        results,
                    },
                );
                if let Err(err) = store.save() {
                    eprintln!("DCTerminal: run {}: gate results not saved: {err}", self.run_id);
                }
            }
        }
        self.changed();
        // You took the stage over while its checks ran: Hand back decides.
        if self.taken_over(&placed.tab.id) {
            return;
        }
        // The checks take a while: a turn started since is the stage's result now.
        let tag = placed.tab.bridge.clone().unwrap_or(BridgeTag {
            run_id: self.run_id.clone(),
            stage: turn.stage_key.clone(),
        });
        let latest = read_stage_turn(&self.host.runs_root(), &tag, &placed.tab.id);
        if latest.as_ref().map(|t| t.turn.as_str()) != Some(turn.turn.as_str()) {
            let summary = format!(
                "Skipped {}'s turn: {} got a newer prompt while its checks ran.",
                placed.stage.title, placed.tab.label
            );
            self.note(Some(&placed.stage.id), &summary, false);
            return;
        }
        self.decide_and_carry_out(&placed, &turn, round);
    }

    fn decide_and_carry_out(&mut self, placed: &Placed, turn: &BridgeTurn, round: u32) {
        let usage = self.host.usage_percent(&self.run_id);
        let mut report = turn_report(&placed.stage, turn, usage, placed.lane.clone(), placed.revise());
        // H5: `decide` stops with `usage_limit` for it, ahead of `no_result`.
        report.rate_limit = self.rate_limit(placed);
        report.round = Some(round);
        report.turn = Some(bridge_turn_key(&turn.tab_id, &turn.turn));
        let (decision, held) = {
            let mut store = lock(self.host.store());
            let Some(run) = store.pipeline_run_by_id_mut(&self.run_id) else {
                return;
            };
            // Decided on a copy first: a decision that would act on a stage
            // you took over is not taken at all (D28), so Hand back decides
            // the same turn afresh.
            let mut trial = run.clone();
            let decision = decide(&placed.def, &mut trial, &report);
            let held = taken_over_target(&placed.def, run, placed, &decision);
            if held.is_some() {
                (decision, held)
            } else {
                *run = trial;
                if let Err(err) = store.save() {
                    eprintln!("DCTerminal: run {}: decision not saved: {err}", self.run_id);
                }
                (decision, None)
            }
        };
        if let Some((tab_id, stage_id, title)) = held {
            let summary = format!(
                "{} finished, and autopilot would act on {title}, which you took over. Hand it back to let autopilot carry on.",
                placed.stage.title
            );
            self.stop_run(Some(&stage_id), Some(&tab_id), &summary, Some(StopReason::TakenOver));
            return;
        }
        self.changed();
        self.carry_out(placed, turn, &decision, report.verdict.as_deref());
    }

    // ---- Carrying a decision out ----

    fn carry_out(&mut self, placed: &Placed, turn: &BridgeTurn, decision: &Decision, verdict: Option<&str>) {
        let fail = |actor: &mut Self, what: String| actor.fail(decision, Some(&placed.tab.id), &what);
        match decision.action.as_str() {
            // A late turn, one decided already, or a stale one: the ledger says which.
            "ignore" | "skip" => {}
            "stop" => {
                let reason = self.stop_reason().unwrap_or(StopReason::CarryOutFailed);
                self.host.stopped(&self.run_id, Some(&placed.tab.id), reason, &decision.reason);
            }
            "complete" => self.host.notice(&self.run_id, "Run complete", &decision.reason),
            "laneDone" => {
                for lane in &decision.unblocked {
                    if let Err(err) = self.start_lane(lane) {
                        fail(self, format!("start {lane}: {err}"));
                    }
                }
            }
            "reask" | "retry" => {
                let text = match decision.action.as_str() {
                    "reask" => ASK_FOR_RESULT.to_string(),
                    _ => decision.message.clone().unwrap_or_default(),
                };
                if !self.idle(&placed.tab) {
                    fail(self, format!("send to {}: the terminal is not open and idle.", placed.tab.label));
                    return;
                }
                // A failed check resumes the stage's session with its output (D17).
                let sent = match session_of(&placed.tab).filter(|_| decision.action == "retry") {
                    Some(session) => self.resume(&placed.tab, &session, &text, None),
                    None => self.host.paste(&placed.tab.id, &text),
                };
                match sent {
                    // The run is manual now; its Timeline note says so.
                    Err(err) if err == MANUAL_NOW => {}
                    Err(err) => fail(self, format!("send to {}: {err}", placed.tab.label)),
                    Ok(()) => {}
                }
            }
            "advance" => {
                if let Err(err) = self.advance(placed, turn, decision) {
                    let stage = decision.stage_id.clone().unwrap_or_default();
                    fail(self, format!("open {stage}: {err}"));
                }
            }
            "loopBack" => {
                let verdict = verdict.unwrap_or(placed.revise()).to_string();
                match self.loop_back(placed, turn, decision, &verdict) {
                    // The run is manual now; its Timeline note says so.
                    Err(err) if err == MANUAL_NOW => {}
                    Err(err) => fail(self, format!("send the round back: {err}")),
                    Ok(_) => {}
                }
            }
            other => fail(self, format!("carry out \"{other}\".")),
        }
    }

    fn stop_reason(&self) -> Option<StopReason> {
        let store = lock(self.host.store());
        store.pipeline_run_by_id(&self.run_id).and_then(|run| run.stop_reason)
    }

    /// The decision could not be carried out: give its hand-off record back
    /// and stop with `carry_out_failed`.
    fn fail(&mut self, decision: &Decision, tab_id: Option<&str>, what: &str) {
        if let Some(key) = decision.claim.as_deref() {
            let mut store = lock(self.host.store());
            let _ = store.release_handoff_claim(&self.run_id, key);
        }
        self.stop_run(decision.stage_id.as_deref(), tab_id, &format!("Autopilot could not {what}"), None);
    }

    fn stop_run(&mut self, stage_id: Option<&str>, tab_id: Option<&str>, summary: &str, reason: Option<StopReason>) {
        let reason = reason.unwrap_or(StopReason::CarryOutFailed);
        {
            let mut store = lock(self.host.store());
            if let Err(err) = note(&mut store, &self.run_id, stage_id, summary, None, true, Some(reason)) {
                eprintln!("DCTerminal: run {}: stop not recorded: {err}", self.run_id);
            }
        }
        self.changed();
        self.host.stopped(&self.run_id, tab_id, reason, summary);
    }

    fn note(&mut self, stage_id: Option<&str>, summary: &str, stop: bool) {
        {
            let mut store = lock(self.host.store());
            // intentionally silent: the ledger line is extra; nothing else happens either way.
            let _ = note(&mut store, &self.run_id, stage_id, summary, None, stop, None);
        }
        self.changed();
    }

    /// What `target`'s prompt is built from: the step-1 form, the plan, the
    /// pull requests, what the turn said, and (for a reviewer) the findings
    /// its previous round sent back. The run folder is read before the store
    /// is locked.
    fn sources(&self, placed: &Placed, target: &StageDef, turn: Option<&BridgeTurn>, findings: Option<String>) -> StageSources {
        let runs = self.host.runs_root();
        let run_dir = crate::bridge::folder::run_dir(&runs, &self.run_id);
        let plan_file = run_dir
            .as_ref()
            .and_then(|dir| std::fs::read_to_string(dir.join(crate::bridge::folder::PLAN_FILE)).ok())
            .filter(|text| !text.trim().is_empty());
        let prs = run_dir
            .as_ref()
            .and_then(|dir| read_json::<RunPrs>(&dir.join(crate::bridge::folder::prs_file_name(placed.lane.as_deref()))))
            .map(|prs| prs.result);
        let lane_note = placed.lane.as_deref().and_then(|lane| lane_note(run_dir.as_deref(), lane));
        let run_files = run_dir
            .as_ref()
            .map(|dir| {
                [
                    ("Plan", crate::bridge::folder::PLAN_FILE.to_string()),
                    ("Tasks", TASKS_FILE.to_string()),
                    ("Pull requests", crate::bridge::folder::prs_file_name(placed.lane.as_deref())),
                ]
                .into_iter()
                .map(|(what, name)| (what.to_string(), dir.join(name)))
                .filter(|(_, path)| path.is_file())
                .map(|(what, path)| (what, path.display().to_string()))
                .collect()
            })
            .unwrap_or_default();
        // The stage a reviewer sends its rounds back to got the last findings.
        let sent_back_to = target
            .loop_back
            .as_ref()
            .and_then(|back| placed.def.stage(&back.to))
            .map(|stage| stage.role_id.clone());
        let store = lock(self.host.store());
        let run = store.pipeline_run_by_id(&self.run_id);
        let first_role = placed.def.stages.first().map(|s| s.role_id.clone()).unwrap_or_default();
        let first_answers = run
            .and_then(|run| run.tab_ids.get(&first_role))
            .and_then(|id| store.tab_by_id(id))
            .map(|tab| tab.answers.clone())
            .unwrap_or_default();
        let plan = run
            .and_then(|run| run.approved_plan.clone())
            .filter(|text| !text.trim().is_empty())
            .or(plan_file)
            .or_else(|| placed.tab.answers.get("approvedPlan").cloned().filter(|t| !t.trim().is_empty()));
        let previous_review = run.zip(sent_back_to).and_then(|(run, role)| {
            let handoffs = match placed.lane.as_deref().and_then(|id| run.lane(id)) {
                Some(lane) => &lane.handoffs,
                None => &run.handoffs,
            };
            handoffs
                .get(&role)
                .map(|h| h.text.clone())
                .filter(|text| text.starts_with("Review findings from the"))
        });
        StageSources {
            first_answers,
            first_role,
            plan,
            prs,
            reply: turn.map(|t| t.last_assistant_message.clone()).unwrap_or_default(),
            findings,
            previous_review,
            lane_note,
            task_type: store.chain_task_type(&self.run_id),
            cwd: placed.tab.cwd.clone(),
            run_files,
        }
    }

    fn advance(&mut self, placed: &Placed, turn: &BridgeTurn, decision: &Decision) -> Result<String, String> {
        let stage_id = decision.stage_id.as_deref().ok_or("the decision names no stage")?;
        let target_index = placed.def.stage_index(stage_id).ok_or("that stage is not in the pipeline")?;
        let target = placed.def.stages[target_index].clone();
        let role = self.host.role(&target.role_id).ok_or_else(|| format!("unknown role {}", target.role_id))?;
        let sources = self.sources(placed, &target, Some(turn), None);
        let built = prompts::stage_values(&role, target.kind() == StageKind::Reviewer, &sources);
        let chain = ChainRef {
            chain_id: placed.chain.chain_id.clone(),
            kind: placed.chain.kind.clone(),
            step: target_index as u32 + 1,
            total: placed.def.stages.len() as u32,
            round: self.round(placed.lane.as_deref()),
            lane: placed.lane.clone(),
        };
        self.open_stage(Open {
            role_id: target.role_id.clone(),
            chain,
            cwd: placed.tab.cwd.clone(),
            window_id: placed.tab.window_id.clone(),
            preferred_tab: None,
            values: built.values,
            handoff_plan: built.handoff_plan,
            tagging: Tagging::Advance { text: built.handoff_text },
        })
    }

    fn loop_back(&mut self, placed: &Placed, turn: &BridgeTurn, decision: &Decision, verdict: &str) -> Result<String, String> {
        let target_id = decision.stage_id.as_deref().ok_or("the decision names no stage")?;
        let target_index = placed.def.stage_index(target_id).ok_or("that stage is not in the pipeline")?;
        let target = placed.def.stages[target_index].clone();
        let findings = review(turn)
            .and_then(|r| r.get("findings"))
            .and_then(Value::as_array)
            .map(|items| findings_text(items))
            .filter(|text| !text.trim().is_empty())
            .unwrap_or_else(|| turn.last_assistant_message.trim().to_string());
        let round = {
            let store = lock(self.host.store());
            store
                .pipeline_run_by_id(&self.run_id)
                .map(|run| review_round(run, placed.lane.as_deref(), &placed.stage))
                .unwrap_or(1)
        };
        let file = self.write_findings(turn, round)?;
        let reviewer_name = self.host.role(&placed.tab.role_id).map(|r| r.name).unwrap_or_else(|| placed.stage.title.clone());
        let text = loop_back_message(target.kind() == StageKind::Planner, &reviewer_name, &findings, round, file.as_deref());
        self.send_back(placed, &target, verdict, &text, None, None, Some(turn), file.as_deref())
    }

    /// The reviewer's round as `findings-<stage>-r<N>.json` (V4), when its
    /// turn reported one; the path the resumed stage is pointed at.
    fn write_findings(&self, turn: &BridgeTurn, round: u32) -> Result<Option<PathBuf>, String> {
        let Some(result) = review(turn) else {
            return Ok(None);
        };
        let run_dir = crate::bridge::folder::run_dir(&self.host.runs_root(), &self.run_id)
            .ok_or_else(|| format!("not a run id: {}", self.run_id))?;
        let findings = RunFindings {
            schema: crate::bridge::folder::SCHEMA,
            run_id: self.run_id.clone(),
            stage_key: turn.stage_key.clone(),
            round,
            turn: turn.turn.clone(),
            at: chrono::Utc::now().to_rfc3339(),
            verdict: result.get("verdict").and_then(Value::as_str).unwrap_or_default().to_string(),
            findings: result.get("findings").cloned().unwrap_or_else(|| Value::Array(Vec::new())),
        };
        crate::bridge::folder::write_findings(&run_dir, &findings)
            .map(Some)
            .map_err(|err| format!("could not save the findings in {}: {err}", run_dir.display()))
    }

    /// Resume `tab`'s session (V4, D17): its program is stopped, then
    /// `claude --resume <session>` starts in the same terminal with the same
    /// flags and `prompt` as its next turn. The tab and its view stay.
    ///
    /// When the D24 / hooks-off gate now refuses the bridge, the run is
    /// manual from then on (V2a: `actor_gate_on` → `make_manual`) and nothing
    /// is resumed, since a resume is autopilot's own action: [`MANUAL_NOW`].
    /// The one Timeline note says where `findings` (the round's file) is.
    fn resume(&mut self, tab: &TabRecord, session_id: &str, prompt: &str, findings: Option<&Path>) -> Result<(), String> {
        let tag = tab.bridge.as_ref().ok_or_else(|| format!("{} does not report through the pipeline bridge", tab.label))?;
        let program = self
            .host
            .bridge_program()
            .ok_or("DCTerminal could not find its own executable for the pipeline bridge.")?;
        let flags = relaunch_flags(&self.host.runs_root(), tag, &tab.id, &program)
            .ok_or_else(|| format!("{} no longer holds its stage in the run folder", tab.label))?;
        let cwd = crate::paths::validate_working_folder(&tab.cwd).map_err(|err| err.message())?;
        // D24 and hooks-off again, as at a Restart: the CLI or the settings
        // may have changed since the stage opened.
        if !self.host.bridge_gate(&self.run_id, &tag.stage, &cwd)? {
            self.note_not_resumed(findings);
            return Err(MANUAL_NOW.to_string());
        }
        let bridge = Some(flags);
        let runs = self.host.runs_root();
        let cleared = clear_stage_turn(&runs, tag, &tab.id)?;
        let resumed = self.host.resume_stage(&StageLaunch {
            run_id: self.run_id.clone(),
            tab_id: tab.id.clone(),
            role_id: tab.role_id.clone(),
            cwd,
            prompt: prompt.to_string(),
            session_id: session_id.to_string(),
            bridge,
        });
        if let Err(err) = resumed {
            // Its last turn stays the stage's result (idle again for a Send
            // back by hand), unless a new one was written meanwhile.
            if let Some(saved) = cleared {
                if let Err(restore) = restore_stage_turn(&runs, tag, &tab.id, &saved) {
                    eprintln!("DCTerminal: run {}: turn not restored: {restore}", self.run_id);
                }
            }
            return Err(err);
        }
        // A view that saw the old program end attaches to the new one.
        self.host.tab_opened(&self.run_id, &tab.id);
        self.changed();
        Ok(())
    }

    /// The gate made the run manual at a resume: its one Timeline note (and
    /// engine note) also says what was not sent and where the findings are.
    fn note_not_resumed(&mut self, findings: Option<&Path>) {
        let extra = match findings {
            Some(file) => format!(" This round's findings are in {}: send them back yourself.", file.display()),
            None => " What autopilot was sending back was not sent: send it yourself.".to_string(),
        };
        {
            let mut store = lock(self.host.store());
            if let Some(run) = store.pipeline_run_by_id_mut(&self.run_id) {
                if let Some(event) = run.events.iter_mut().rev().find(|e| e.kind == "note") {
                    event.summary.push_str(&extra);
                }
                if let Some(note) = run.engine_note.as_mut() {
                    note.push_str(&extra);
                }
                if let Err(err) = store.save() {
                    eprintln!("DCTerminal: run {}: note not saved: {err}", self.run_id);
                }
            }
        }
        self.changed();
    }

    /// A round goes back to `target`: its tab's session is resumed with
    /// `text` (V4: the terminal is stopped and relaunched with `--resume`,
    /// running and idle or already exited), else a new terminal of that stage
    /// opens. A tab with no saved session that still runs gets `text` pasted.
    #[allow(clippy::too_many_arguments)]
    fn send_back(
        &mut self,
        placed: &Placed,
        target: &StageDef,
        verdict: &str,
        text: &str,
        values: Option<HashMap<String, String>>,
        handoff_plan: Option<String>,
        turn: Option<&BridgeTurn>,
        findings: Option<&Path>,
    ) -> Result<String, String> {
        let existing = {
            let store = lock(self.host.store());
            let run = store.pipeline_run_by_id(&self.run_id).ok_or("the run is gone")?;
            let tab_ids = match placed.lane.as_deref().and_then(|id| run.lane(id)) {
                Some(lane) => &lane.tab_ids,
                None => &run.tab_ids,
            };
            tab_ids.get(&target.role_id).and_then(|id| store.tab_by_id(id)).cloned()
        };
        let live = existing.as_ref().is_some_and(|tab| self.host.terminal_live(&tab.id));
        let session = existing.as_ref().and_then(session_of);
        if let Some(tab) = existing.filter(|_| live || session.is_some()) {
            if live && !self.idle(&tab) {
                return Err(format!("{} is still working. Send the findings back when its turn ends.", tab.label));
            }
            // Record the round first: sent into an unrecorded round, the
            // stage's next turn would be skipped as handed on already.
            {
                let mut store = lock(self.host.store());
                store.chain_loop_back_in(
                    &placed.chain.chain_id,
                    placed.lane.as_deref(),
                    &placed.tab.role_id,
                    &tab.id,
                    Some(verdict),
                    Some(text),
                )?;
            }
            self.changed();
            match session {
                Some(session) => self.resume(&tab, &session, text, findings)?,
                None => self.host.paste(&tab.id, text)?,
            }
            return Ok(tab.id);
        }
        // The earlier stage's terminal is gone: a new one on the chain.
        let role = self.host.role(&target.role_id).ok_or_else(|| format!("unknown role {}", target.role_id))?;
        let (values, handoff_plan) = match values {
            Some(values) => (values, handoff_plan.unwrap_or_default()),
            None => {
                let sources = self.sources(placed, target, turn, Some(text.to_string()));
                let built = prompts::stage_values(&role, false, &sources);
                (built.values, built.handoff_plan)
            }
        };
        let target_index = placed.def.stage_index(&target.id).ok_or("that stage is not in the pipeline")?;
        let chain = ChainRef {
            chain_id: placed.chain.chain_id.clone(),
            kind: placed.chain.kind.clone(),
            step: target_index as u32 + 1,
            total: placed.def.stages.len() as u32,
            round: self.round(placed.lane.as_deref()) + 1,
            lane: placed.lane.clone(),
        };
        self.open_stage(Open {
            role_id: target.role_id.clone(),
            chain,
            cwd: placed.tab.cwd.clone(),
            window_id: placed.tab.window_id.clone(),
            preferred_tab: None,
            values,
            handoff_plan,
            tagging: Tagging::LoopBack {
                reviewer_role: placed.tab.role_id.clone(),
                verdict: verdict.to_string(),
                text: text.to_string(),
            },
        })
    }

    /// Open a stage terminal: merge its prompt, save its tab on the chain,
    /// write its run folder and start it through the host, with no store
    /// lock held across the spawn.
    fn open_stage(&mut self, open: Open) -> Result<String, String> {
        let role = self.host.role(&open.role_id).ok_or_else(|| format!("unknown role {}", open.role_id))?;
        let cwd = crate::paths::validate_working_folder(&open.cwd).map_err(|err| err.message())?;
        let plan: BridgePlan = {
            let store = lock(self.host.store());
            let run = store.pipeline_run_by_id(&self.run_id).ok_or("the run is gone")?;
            let def = crate::pipelines::find(&run.kind).ok_or_else(|| format!("unknown pipeline {}", run.kind))?;
            plan_for(run, &def, &open.chain, &open.role_id)
                .ok_or_else(|| format!("{} does not report through the pipeline bridge, so autopilot cannot follow it", role.name))?
        };
        // D24 and hooks-off, as at every bridged start: an engine-1 outcome
        // switches the run for good and, mid-run, makes it manual (autopilot
        // off, V2a); this stage opens unbridged for you to hand on.
        let plan = if self.host.bridge_gate(&plan.run_id, &plan.stage_key, &cwd)? {
            Some(plan)
        } else {
            self.changed();
            None
        };
        let mut values = open.values.clone();
        values.insert("cwd".to_string(), cwd.display().to_string());
        let instructions = plan
            .as_ref()
            .map(|plan| crate::bridge::schema::result_instructions(plan.kind))
            .unwrap_or_default();
        let preview = crate::template::merge_role_prompt_with(&role, &values, &instructions);
        if !preview.errors.is_empty() {
            let problems: Vec<String> = preview.errors.iter().map(|e| e.message.clone()).collect();
            return Err(format!("the {} prompt is incomplete: {}", role.name, problems.join("; ")));
        }
        let merged = preview.merged.ok_or("the prompt merged to nothing")?;
        let prompt = crate::pty::launch::handoff_terminal_prompt(&merged.text, &open.handoff_plan);
        let session_id = crate::provider::new_claude_session_id();
        let tab_id = {
            let mut store = lock(self.host.store());
            store.bind_window(Some(&open.window_id));
            let tab_id = store.save_terminal_tab(
                open.preferred_tab.as_deref(),
                TerminalTabDraft {
                    launch: "role".to_string(),
                    cwd: cwd.display().to_string(),
                    label: tab_label(&role.name, &values),
                    role_id: role.id.clone(),
                    role_snapshot: RoleSnapshot {
                        name: role.name.clone(),
                        template_version: role.template_version,
                        mode: role.default_mode.clone(),
                        injection: role.injection.clone(),
                    },
                    color: role.color.clone(),
                    answers: values.clone(),
                    merged_prompt: prompt.clone(),
                    startup_prompt_sent: true,
                    provider: Some(crate::provider::ProviderId::Claude),
                },
            )?;
            match &open.tagging {
                Tagging::Advance { text } => store.set_tab_chain(&tab_id, Some(open.chain.clone()), Some(text))?,
                Tagging::LoopBack { reviewer_role, verdict, text } => {
                    store.chain_loop_back_in(
                        &open.chain.chain_id,
                        open.chain.lane.as_deref(),
                        reviewer_role,
                        &tab_id,
                        Some(verdict),
                        Some(text),
                    )?;
                }
                Tagging::Existing => {}
            }
            store.remember_claude_terminal_session(&tab_id, &session_id)?;
            tab_id
        };
        let bridge = match &plan {
            Some(plan) => {
                let program = self
                    .host
                    .bridge_program()
                    .ok_or("DCTerminal could not find its own executable for the pipeline bridge.")?;
                let run_dir = prepare_stage(&self.host.runs_root(), plan, &tab_id)?;
                Some(launch_flags(plan.kind, &program, &run_dir, &plan.run_id, &plan.stage_key, &tab_id))
            }
            None => None,
        };
        {
            let mut store = lock(self.host.store());
            let tag = plan.as_ref().map(|plan| BridgeTag {
                run_id: plan.run_id.clone(),
                stage: plan.stage_key.clone(),
            });
            store.set_tab_bridge(&tab_id, tag)?;
        }
        self.host.spawn_stage(&StageLaunch {
            run_id: self.run_id.clone(),
            tab_id: tab_id.clone(),
            role_id: role.id.clone(),
            cwd,
            prompt,
            session_id,
            bridge,
        })?;
        self.host.tab_opened(&self.run_id, &tab_id);
        self.changed();
        Ok(tab_id)
    }

    /// Start a waiting lane's stage in the tab fan-out prepared for it.
    /// `Ok(None)` when it was not waiting any more.
    fn start_lane(&mut self, lane_id: &str) -> Result<Option<String>, String> {
        let (tab, role_id, title) = {
            let mut store = lock(self.host.store());
            let run = store.pipeline_run_by_id(&self.run_id).ok_or("the run is gone")?;
            let lane = run.lane(lane_id).ok_or_else(|| format!("no lane {lane_id}"))?;
            if lane.status != "waiting" {
                return Ok(None);
            }
            let def = crate::pipelines::find(&run.kind).ok_or_else(|| format!("unknown pipeline {}", run.kind))?;
            let role_id = run
                .fan_out_stage
                .as_deref()
                .and_then(|id| def.stage(id))
                .or_else(|| implementer_stage(&def))
                .map(|s| s.role_id.clone())
                .ok_or_else(|| format!("{} has no Implementer stage to fan out at", def.name))?;
            let tab_id = lane.tab_ids.get(&role_id).cloned().ok_or_else(|| format!("{} has no {role_id} tab", lane.title))?;
            let tab = store.tab_by_id(&tab_id).cloned().ok_or_else(|| format!("{}'s tab is closed", lane.title))?;
            let title = lane.title.clone();
            set_lane_status(&mut store, &self.run_id, lane_id, "active")?;
            (tab, role_id, title)
        };
        self.changed();
        let chain = tab.chain.clone().ok_or_else(|| format!("{title}'s tab is not on the run"))?;
        let mut values = tab.answers.clone();
        values.insert("cwd".to_string(), tab.cwd.clone());
        // A plan too long for the form waits in the run folder.
        let cut = values.values().any(|v| v.starts_with("The full text (") && v.contains("follows"));
        let handoff_plan = if cut {
            crate::bridge::folder::run_dir(&self.host.runs_root(), &self.run_id)
                .and_then(|dir| std::fs::read_to_string(dir.join(crate::bridge::folder::PLAN_FILE)).ok())
                .unwrap_or_default()
        } else {
            String::new()
        };
        let opened = self.open_stage(Open {
            role_id,
            chain,
            cwd: tab.cwd.clone(),
            window_id: tab.window_id.clone(),
            preferred_tab: Some(tab.id.clone()),
            values,
            handoff_plan,
            tagging: Tagging::Existing,
        });
        match opened {
            Ok(tab_id) => Ok(Some(tab_id)),
            Err(err) => {
                let mut store = lock(self.host.store());
                // intentionally silent: the start error is the one to show.
                let _ = set_lane_status(&mut store, &self.run_id, lane_id, "waiting");
                drop(store);
                self.changed();
                Err(err)
            }
        }
    }

    // ---- Your buttons ----

    fn on_user(&mut self, action: UserAction) -> Result<UserOutcome, String> {
        let engine_2 = {
            let store = lock(self.host.store());
            let run = store
                .pipeline_run_by_id(&self.run_id)
                .ok_or_else(|| format!("unknown pipeline run: {}", self.run_id))?;
            run.engine >= crate::bridge::launch::ENGINE_V2
        };
        if !engine_2 {
            return Err("This run uses the older pipeline engine; its buttons work as before.".into());
        }
        match action {
            UserAction::Send {
                source_tab_id,
                target_role_id,
                values,
                handoff_plan,
                handoff_text,
                force,
            } => self.user_send(&source_tab_id, &target_role_id, values, handoff_plan, handoff_text, force),
            UserAction::SendBack {
                source_tab_id,
                target_role_id,
                text,
                verdict,
                values,
                handoff_plan,
                force,
            } => self.user_send_back(&source_tab_id, &target_role_id, &text, verdict, values, handoff_plan, force),
            UserAction::Approve { lane } => self.user_approve(lane.as_deref()),
            UserAction::Continue => self.user_continue(),
            UserAction::TakeOver { tab_id } => self.user_take_over(&tab_id),
            UserAction::HandBack { tab_id } => self.user_hand_back(&tab_id),
            UserAction::Prefill {
                source_tab_id,
                target_role_id,
            } => self.user_prefill(&source_tab_id, &target_role_id),
        }
    }

    /// The next stage's form as the run folder fills it (D20): what a Send
    /// with no values of yours would carry.
    fn user_prefill(&mut self, source_tab_id: &str, target_role_id: &str) -> Result<UserOutcome, String> {
        let placed = self.place_tab(source_tab_id).ok_or("That tab is not on this run.")?;
        let target = placed
            .def
            .stages
            .get(placed.index + 1)
            .filter(|stage| stage.role_id == target_role_id)
            .cloned()
            .ok_or_else(|| format!("{target_role_id} is not the stage after {}.", placed.stage.title))?;
        let role = self.host.role(&target.role_id).ok_or_else(|| format!("unknown role {}", target.role_id))?;
        let turn = placed
            .tab
            .bridge
            .as_ref()
            .and_then(|tag| read_stage_turn(&self.host.runs_root(), tag, &placed.tab.id));
        let sources = self.sources(&placed, &target, turn.as_ref(), None);
        let mut built = prompts::stage_values(&role, target.kind() == StageKind::Reviewer, &sources);
        built.values.remove("cwd");
        Ok(UserOutcome {
            prefill: Some(Box::new(Prefill {
                values: built.values,
                handoff_text: built.handoff_text,
            })),
            ..UserOutcome::default()
        })
    }

    /// Records your hand-off (`advance` / `back`) from `placed`'s stage in
    /// this round. `Err(outcome)` when autopilot made it already and you
    /// have not pressed again (`force`).
    fn claim_for_you(&mut self, placed: &Placed, kind: &str, force: bool) -> Result<String, UserOutcome> {
        let mut store = lock(self.host.store());
        let Some(run) = store.pipeline_run_by_id_mut(&self.run_id) else {
            return Err(UserOutcome::default());
        };
        let key = claim_key(kind, &placed.stage.id, run.round_for(placed.lane.as_deref()), placed.lane.as_deref());
        if let Some(made) = run.claim_for(&key, None).filter(|made| made.by == "autopilot") {
            if !force {
                let (what, again) = if kind == "back" {
                    ("sent this round back", "send it back")
                } else {
                    ("handed this turn on", "hand it on")
                };
                let at = made.at.get(11..16).unwrap_or_default();
                return Err(UserOutcome {
                    warning: Some(format!(
                        "Autopilot already {what} ({at}): see the run's timeline. Press Send again to {again} anyway."
                    )),
                    ..UserOutcome::default()
                });
            }
        }
        run.add_claim(key.clone(), None, "you");
        if let Err(err) = store.save() {
            eprintln!("DCTerminal: run {}: hand-off not recorded: {err}", self.run_id);
        }
        Ok(key)
    }

    fn release(&mut self, key: &str) {
        let mut store = lock(self.host.store());
        // intentionally silent: a record left behind only adds a warning to a later hand-off.
        let _ = store.release_handoff_claim(&self.run_id, key);
    }

    #[allow(clippy::too_many_arguments)]
    fn user_send(
        &mut self,
        source_tab_id: &str,
        target_role_id: &str,
        values: Option<HashMap<String, String>>,
        handoff_plan: Option<String>,
        handoff_text: Option<String>,
        force: bool,
    ) -> Result<UserOutcome, String> {
        let placed = self.place_tab(source_tab_id).ok_or("That tab is not on this run.")?;
        let target_index = placed.index + 1;
        let target = placed
            .def
            .stages
            .get(target_index)
            .filter(|stage| stage.role_id == target_role_id)
            .cloned()
            .ok_or_else(|| format!("{target_role_id} is not the stage after {}.", placed.stage.title))?;
        let role = self.host.role(&target.role_id).ok_or_else(|| format!("unknown role {}", target.role_id))?;
        let key = match self.claim_for_you(&placed, "advance", force) {
            Ok(key) => key,
            Err(outcome) => return Ok(outcome),
        };
        let (values, plan, text) = match values {
            Some(values) => {
                let text = handoff_text
                    .filter(|t| !t.trim().is_empty())
                    .or_else(|| handoff_plan.clone().filter(|t| !t.trim().is_empty()))
                    .unwrap_or_else(|| prompts::carried_text(&role, &values));
                (values, handoff_plan.unwrap_or_default(), text)
            }
            None => {
                let sources = self.sources(&placed, &target, None, None);
                let built = prompts::stage_values(&role, target.kind() == StageKind::Reviewer, &sources);
                (built.values, built.handoff_plan, built.handoff_text)
            }
        };
        let chain = ChainRef {
            chain_id: placed.chain.chain_id.clone(),
            kind: placed.chain.kind.clone(),
            step: target_index as u32 + 1,
            total: placed.def.stages.len() as u32,
            round: self.round(placed.lane.as_deref()),
            lane: placed.lane.clone(),
        };
        let opened = self.open_stage(Open {
            role_id: target.role_id.clone(),
            chain,
            cwd: placed.tab.cwd.clone(),
            window_id: placed.tab.window_id.clone(),
            preferred_tab: None,
            values,
            handoff_plan: plan,
            tagging: Tagging::Advance { text },
        });
        match opened {
            Ok(tab_id) => Ok(UserOutcome {
                tab_id: Some(tab_id),
                ..UserOutcome::default()
            }),
            Err(err) => {
                self.release(&key);
                Err(err)
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn user_send_back(
        &mut self,
        source_tab_id: &str,
        target_role_id: &str,
        text: &str,
        verdict: Option<String>,
        values: Option<HashMap<String, String>>,
        handoff_plan: Option<String>,
        force: bool,
    ) -> Result<UserOutcome, String> {
        let placed = self.place_tab(source_tab_id).ok_or("That tab is not on this run.")?;
        if text.trim().is_empty() {
            return Err("There are no findings to send back.".into());
        }
        let target = placed
            .def
            .stages
            .iter()
            .take(placed.index)
            .find(|stage| stage.role_id == target_role_id)
            .cloned()
            .ok_or_else(|| format!("{target_role_id} is not an earlier stage than {}.", placed.stage.title))?;
        let key = match self.claim_for_you(&placed, "back", force) {
            Ok(key) => key,
            Err(outcome) => return Ok(outcome),
        };
        let verdict = verdict
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| placed.revise().to_string());
        match self.send_back(&placed, &target, &verdict, text, values, handoff_plan, None, None) {
            Ok(tab_id) => Ok(UserOutcome {
                tab_id: Some(tab_id),
                ..UserOutcome::default()
            }),
            Err(err) => {
                self.release(&key);
                Err(err)
            }
        }
    }

    fn user_approve(&mut self, lane: Option<&str>) -> Result<UserOutcome, String> {
        let result = {
            let mut store = lock(self.host.store());
            approve(&mut store, &self.run_id, lane)?
        };
        self.changed();
        let mut started = Vec::new();
        let mut failed = Vec::new();
        for id in &result.unblocked {
            match self.start_lane(id) {
                Ok(Some(_)) => started.push(id.clone()),
                Ok(None) => {}
                Err(err) => failed.push(format!("{id}: {err}")),
            }
        }
        if !failed.is_empty() {
            return Err(format!("Marked approved, but did not start {}", failed.join("; ")));
        }
        Ok(UserOutcome {
            complete: result.complete,
            started,
            ..UserOutcome::default()
        })
    }

    /// Continue after a restart: the run runs again, then each current
    /// stage terminal's finished turn is decided as if it had just ended
    /// (one decided before the quit is ignored by `decide`).
    fn user_continue(&mut self) -> Result<UserOutcome, String> {
        let tabs = {
            let mut store = lock(self.host.store());
            crate::commands::run_recovery::continue_after_restart(&mut store, &self.run_id)?
        };
        self.changed();
        let runs = self.host.runs_root();
        for tab_id in tabs {
            let tag = {
                let store = lock(self.host.store());
                store.tab_by_id(&tab_id).and_then(|tab| tab.bridge.clone())
            };
            let Some(turn) = tag.and_then(|tag| read_stage_turn(&runs, &tag, &tab_id)) else {
                continue;
            };
            self.on_turn(turn, true);
        }
        Ok(UserOutcome::default())
    }

    /// Take a stage over (V5, D28). Its `mode` file says `takeover`, so its
    /// bridge stops enforcing a result and its Watch view takes keystrokes;
    /// its turns are no longer decided. When it was all the run was waiting
    /// on, the run waits for you (`taken_over`).
    fn user_take_over(&mut self, tab_id: &str) -> Result<UserOutcome, String> {
        let (placed, tag) = self.bridged_tab(tab_id)?;
        if !set_stage_mode(&self.host.runs_root(), &tag, tab_id, StageMode::Takeover)? {
            return Err(format!("{} no longer holds its stage.", placed.tab.label));
        }
        {
            let mut store = lock(self.host.store());
            let run = store.pipeline_run_by_id_mut(&self.run_id).ok_or("the run is gone")?;
            if !run.taken_over.iter().any(|id| id == tab_id) {
                run.taken_over.push(tab_id.to_string());
            }
            let summary = format!("You took over {}. Autopilot leaves it alone until you hand it back.", placed.stage.title);
            run.log("note", Some(&placed.stage.id), Some(&placed.tab.role_id), summary, None);
            let all_yours = crate::pipelines::recovery::current_stage_tabs(&placed.def, run)
                .iter()
                .all(|stage| run.taken_over.contains(&stage.tab_id));
            if run.status == RunStatus::Running && all_yours {
                run.set_waiting(
                    StopReason::TakenOver,
                    format!("You took over {}. Hand it back to let autopilot carry on.", placed.stage.title),
                );
            }
            store.save()?;
        }
        self.changed();
        Ok(UserOutcome::default())
    }

    /// Hand a stage back (D28): enforcement and decisions are on again
    /// (its `mode` follows the run's autopilot), the run carries on when it
    /// waited only for that, and a turn that already has a result is
    /// decided at once. A stage not taken over is left as it is.
    fn user_hand_back(&mut self, tab_id: &str) -> Result<UserOutcome, String> {
        let (placed, tag) = self.bridged_tab(tab_id)?;
        let enabled = {
            let store = lock(self.host.store());
            let run = store.pipeline_run_by_id(&self.run_id).ok_or("the run is gone")?;
            if !run.taken_over.iter().any(|id| id == tab_id) {
                return Ok(UserOutcome::default());
            }
            run.autopilot.as_ref().is_some_and(|a| a.enabled)
        };
        let mode = if enabled { StageMode::Autopilot } else { StageMode::Manual };
        set_stage_mode(&self.host.runs_root(), &tag, tab_id, mode)?;
        let turn = read_stage_turn(&self.host.runs_root(), &tag, tab_id).filter(|turn| turn.result.is_some());
        let (status, round, decided, others) = {
            let mut store = lock(self.host.store());
            let run = store.pipeline_run_by_id_mut(&self.run_id).ok_or("the run is gone")?;
            run.taken_over.retain(|id| id != tab_id);
            let summary = format!("You handed {} back to autopilot.", placed.stage.title);
            run.log("note", Some(&placed.stage.id), Some(&placed.tab.role_id), summary, None);
            let current = crate::pipelines::recovery::current_stage_tabs(&placed.def, run);
            let still_yours = current.iter().any(|stage| run.taken_over.contains(&stage.tab_id));
            // The current stages' finished turns, decided again below: one
            // whose decision waited on this stage (D28) is carried out now.
            let mut others = Vec::new();
            if run.status == RunStatus::Waiting && run.stop_reason == Some(StopReason::TakenOver) && !still_yours {
                run.set_running();
                others = current.into_iter().map(|stage| stage.tab_id).filter(|id| id != tab_id).collect();
            }
            // A turn decided before you took over is not decided (or checked) again.
            let decided = turn.as_ref().is_some_and(|turn| {
                let key = format!("{}|bridge|{}", turn.tab_id, turn.turn);
                run.autopilot.as_ref().is_some_and(|a| a.decided.contains(&key))
            });
            let state = (run.status, run.round_for(placed.lane.as_deref()), decided, others);
            store.save()?;
            state
        };
        self.changed();
        if !enabled || status == RunStatus::Complete {
            return Ok(UserOutcome::default());
        }
        if let Some(turn) = turn.filter(|_| !decided) {
            self.handled.insert(turn.tab_id.clone(), turn.turn.clone());
            self.take_up(&placed, turn, round, status);
        }
        let runs = self.host.runs_root();
        for other in others {
            let tag = {
                let store = lock(self.host.store());
                store.tab_by_id(&other).and_then(|tab| tab.bridge.clone())
            };
            // A turn decided already is skipped by `on_turn`.
            if let Some(turn) = tag.and_then(|tag| read_stage_turn(&runs, &tag, &other)) {
                self.on_turn(turn, true);
            }
        }
        Ok(UserOutcome::default())
    }

    /// `tab_id` on this run, with the stage it reports for.
    fn bridged_tab(&self, tab_id: &str) -> Result<(Placed, BridgeTag), String> {
        let placed = self.place_tab(tab_id).ok_or("That tab is not on this run.")?;
        let tag = placed
            .tab
            .bridge
            .clone()
            .ok_or_else(|| format!("{} does not report through the pipeline bridge.", placed.tab.label))?;
        Ok((placed, tag))
    }

    /// A stage terminal exited. While autopilot waits on that stage's turn,
    /// nothing would ever come: stop and say so. A stage you took over is
    /// yours to end.
    fn on_exit(&mut self, tab_id: &str, code: Option<i32>) {
        let Some(placed) = self.place_tab(tab_id) else {
            return;
        };
        if self.taken_over(tab_id) {
            return;
        }
        let current = {
            let store = lock(self.host.store());
            let Some(run) = store.pipeline_run_by_id(&self.run_id) else {
                return;
            };
            let on = run.status == RunStatus::Running && run.autopilot.as_ref().is_some_and(|a| a.enabled);
            on && crate::pipelines::recovery::current_stage_tabs(&placed.def, run)
                .iter()
                .any(|stage| stage.tab_id == tab_id)
        };
        let Some(tag) = placed.tab.bridge.as_ref() else {
            return;
        };
        let finished = read_stage_turn(&self.host.runs_root(), tag, tab_id).is_some();
        if !current || finished {
            return;
        }
        let code = code.map(|c| format!(" (exit code {c})")).unwrap_or_default();
        let summary = format!(
            "{} exited{code} before it finished its turn. Restart it, then carry on by hand.",
            placed.tab.label
        );
        self.stop_run(Some(&placed.stage.id), Some(tab_id), &summary, None);
    }
}

// ---- Pure helpers ----

/// The word a reviewer stage's "changes required" reads as (the ledger,
/// loop-backs and hand-offs use it): a plan reviewer revises, every other
/// reviewer requests changes. By stage kind (H4, `stageBehaviour` in
/// `src/pipeline/defs.ts`), so a copied role behaves like its original.
pub(super) fn revise_word(def: &PipelineDef, stage: &StageDef) -> &'static str {
    if reviews_plan(def, stage) {
        "REQUIRES REVISION"
    } else {
        "REQUEST CHANGES"
    }
}

/// A reviewer stage that reviews a plan: the stage it reviews (its loop-back
/// target, else the stage before it) is a Planner.
pub(super) fn reviews_plan(def: &PipelineDef, stage: &StageDef) -> bool {
    if stage.kind() != StageKind::Reviewer {
        return false;
    }
    let reviewed = match &stage.loop_back {
        Some(back) => def.stage(&back.to),
        None => def.stage_index(&stage.id).and_then(|i| i.checked_sub(1)).and_then(|i| def.stages.get(i)),
    };
    reviewed.is_some_and(|s| s.kind() == StageKind::Planner)
}

/// The pipeline's first Implementer stage (by kind): where fan-out lanes start.
pub(super) fn implementer_stage(def: &PipelineDef) -> Option<&StageDef> {
    def.stages.iter().find(|s| s.kind() == StageKind::Implementer)
}

/// A `submit_result` verdict in the words the ledger and `decide` use.
pub(super) fn bridge_verdict(verdict: Option<&str>, revise: &str) -> Option<String> {
    match verdict? {
        "APPROVED" => Some("APPROVED".into()),
        "APPROVED_WITH_CHANGES" => Some("APPROVED WITH CHANGES".into()),
        "CHANGES_REQUIRED" => Some(revise.into()),
        _ => None,
    }
}

/// A reviewer's accepted result (verdict and findings), if this turn has one.
fn review(turn: &BridgeTurn) -> Option<&Value> {
    let result = (turn.outcome == TurnOutcome::Result).then_some(turn.result.as_ref()).flatten()?;
    result.get("verdict").is_some().then_some(result)
}

/// The report a bridged stage's turn is decided on (`bridgeTurnReport` before V3).
pub(super) fn turn_report(stage: &StageDef, turn: &BridgeTurn, usage: Option<u8>, lane: Option<String>, revise: &str) -> TurnReport {
    let result = (turn.outcome == TurnOutcome::Result).then_some(turn.result.as_ref()).flatten();
    let review = review(turn);
    let findings = review
        .and_then(|r| r.get("findings"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|f| FindingReport {
                    severity: f.get("severity").and_then(Value::as_str).unwrap_or_default().to_string(),
                    summary: f.get("summary").and_then(Value::as_str).unwrap_or_default().to_string(),
                })
                .collect()
        })
        .unwrap_or_default();
    TurnReport {
        stage_id: stage.id.clone(),
        verdict: bridge_verdict(review.and_then(|r| r.get("verdict")).and_then(Value::as_str), revise),
        findings,
        findings_known: result.is_some(),
        missing_sections: Vec::new(),
        usage_percent: usage,
        chat: false,
        lane,
        round: None,
        turn: None,
        rate_limit: None,
        no_result: result.is_none(),
        blocked: blocked(turn),
    }
}

/// Why a bridged Implementer is blocked (`submit_result` `blocked`, V2b):
/// the run waits for you with that reason (`checkpoint`) and runs no checks.
pub(super) fn blocked(turn: &BridgeTurn) -> Option<String> {
    let result = (turn.outcome == TurnOutcome::Result).then_some(turn.result.as_ref()).flatten()?;
    result.get("prs")?;
    result
        .get("blocked")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|why| !why.is_empty())
        .map(str::to_string)
}

/// The findings a loop-back sends, numbered (`bridgeFindingsText` before V3).
pub(super) fn findings_text(findings: &[Value]) -> String {
    findings
        .iter()
        .enumerate()
        .map(|(i, f)| {
            let text = |key: &str| f.get(key).and_then(Value::as_str).unwrap_or_default();
            let file = Some(text("file")).filter(|f| !f.is_empty()).map(|f| format!(" {f}:")).unwrap_or_default();
            format!("{}. [{}]{file} {}", i + 1, text("severity"), text("summary"))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// A resume the D24 / hooks-off gate refused: the run is manual now and its
/// Timeline note says what to do, so this is no failure to carry out.
pub(super) const MANUAL_NOW: &str =
    "Claude Code can no longer use the pipeline bridge here, so this run is manual now. Send it back yourself.";

/// The prompt a loop-back resumes the earlier stage with (`loopBackMessage`):
/// where the round's findings file is (V4), the findings, and what to do. A
/// Planner (by its stage kind) is asked for a revised plan, any other stage
/// for fixes on its pull requests.
pub(super) fn loop_back_message(
    to_planner: bool,
    reviewer_name: &str,
    findings: &str,
    round: u32,
    file: Option<&std::path::Path>,
) -> String {
    let ask = if to_planner { PLANNER_ASK } else { IMPLEMENTER_ASK };
    let saved = file.map(|path| format!(", saved in {}", path.display())).unwrap_or_default();
    format!("Review findings from the {reviewer_name} (round {round}){saved}:\n\n{}\n\n{ask}", findings.trim())
}

/// The Claude session `tab`'s terminal runs, when one is saved.
fn session_of(tab: &TabRecord) -> Option<String> {
    tab.sessions
        .claude_terminal_session_id
        .clone()
        .filter(|id| !id.trim().is_empty())
}

/// The pull requests a turn reported: an Implementer's `prs[]`, else every
/// GitHub pull-request link in its last message.
pub(super) fn pr_urls(turn: &BridgeTurn) -> Vec<String> {
    let reported: Vec<String> = turn
        .result
        .as_ref()
        .filter(|_| turn.outcome == TurnOutcome::Result)
        .and_then(|r| r.get("prs"))
        .and_then(Value::as_array)
        .map(|prs| prs.iter().filter_map(|p| p.get("url").and_then(Value::as_str)).map(str::to_string).collect())
        .unwrap_or_default();
    if !reported.is_empty() {
        return reported;
    }
    github_pr_urls(&turn.last_assistant_message)
}

/// Every distinct `https://github.com/<owner>/<repo>/pull/<n>` in `text`.
pub(super) fn github_pr_urls(text: &str) -> Vec<String> {
    const START: &str = "https://github.com/";
    let mut out: Vec<String> = Vec::new();
    let mut rest = text;
    while let Some(at) = rest.find(START) {
        let tail = &rest[at + START.len()..];
        let parts: Vec<&str> = tail.splitn(4, '/').collect();
        let ok_part = |p: &str| !p.is_empty() && p.chars().all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c));
        if parts.len() >= 4 && ok_part(parts[0]) && ok_part(parts[1]) && parts[2] == "pull" {
            let digits: String = parts[3].chars().take_while(char::is_ascii_digit).collect();
            if !digits.is_empty() {
                let url = format!("{START}{}/{}/pull/{digits}", parts[0], parts[1]);
                if !out.contains(&url) {
                    out.push(url);
                }
            }
        }
        rest = tail;
    }
    out
}

/// The lane's line from `tasks.json`, for its Implementer's context.
fn lane_note(run_dir: Option<&std::path::Path>, lane: &str) -> Option<String> {
    let tasks: crate::bridge::RunTasks = read_json(&run_dir?.join(TASKS_FILE))?;
    let task = tasks.tasks.iter().find(|t| t.id == lane)?;
    Some(format!(
        "This run ships as several pull requests. Implement only {} ({}): {}",
        task.id.to_uppercase(),
        task.title,
        task.summary
    ))
}

/// The tab you took over that carrying `decision` out would act on (D28):
/// the stage a round goes back to, or the turn's own stage for a retry or a
/// re-ask. As (tab id, stage id, stage title).
fn taken_over_target(def: &PipelineDef, run: &PipelineRun, placed: &Placed, decision: &Decision) -> Option<(String, String, String)> {
    let target = match decision.action.as_str() {
        "loopBack" => {
            let stage = def.stage(decision.stage_id.as_deref()?)?;
            let tab_ids = match placed.lane.as_deref().and_then(|id| run.lane(id)) {
                Some(lane) => &lane.tab_ids,
                None => &run.tab_ids,
            };
            (tab_ids.get(&stage.role_id)?.clone(), stage.id.clone(), stage.title.clone())
        }
        "retry" | "reask" => (placed.tab.id.clone(), placed.stage.id.clone(), placed.stage.title.clone()),
        _ => return None,
    };
    run.taken_over.contains(&target.0).then_some(target)
}
