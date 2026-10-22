//! The round runner (R2): the one owner of every QA round's state. One
//! thread takes its messages one at a time: a run changed (from the
//! `chain-run-updated` the app sends for every run change, so an actor's
//! completion or stop and your buttons all arrive), your round buttons, and
//! the restart recovery. It brings the round's plan states up to date from
//! their runs (`schedule::sync`), then starts what the waves, the cap and
//! **Commit up to wave N** allow (`schedule::next_to_start`).
//!
//! Starting a plan run is what your form start of the pipeline's first
//! stage does, without a form: the stage's values come from the plan's
//! section of `round.json`, its run gets a `tickets.json` with only the
//! plan's tickets and a `round-plan.json`, and its terminal starts hidden,
//! bridged, with autopilot on. The store is locked only to read and to
//! write back, never across a start. A plan whose run fails to start, or
//! stops, stops no other plan.

use super::files::{
    plan_file, plan_tickets, read_round_copy, read_tickets_copy, read_triage, record_run, round_dir, rounds_root,
    write_plan_run_files, write_round_folder, ROUND_PLAN_FILE,
};
use super::schedule::{next_to_start, plan_checkpoint, sync, waiting_reason, PlanCheckpoint, DEFAULT_RUNS_AT_ONCE, MAX_RUNS_AT_ONCE};
use super::types::{PlanRunState, QaRound, RoundPlanRun};
use crate::bridge::folder::TICKETS_FILE;
use crate::bridge::round::{PlanStatus, RoundPlan, RunRound};
use crate::bridge::BridgeTag;
use crate::roles::{FieldType, Role};
use crate::run_actor::{lock, Host, StageLaunch};
use crate::store::{tab_label, ChainRef, RoleSnapshot, RunStatus, StateStore, StopReason, TerminalTabDraft};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// The pipeline a plan runs when you pick none.
pub const DEFAULT_PLAN_PIPELINE: &str = "eagle1";

/// One message to the round runner.
#[derive(Debug)]
pub enum RoundMsg {
    /// A run changed (any run; the runner picks out its plan runs).
    RunChanged(String),
    /// A round button. `reply` hears the round id, or why not.
    Action {
        action: RoundAction,
        reply: Option<Sender<Result<String, String>>>,
    },
    /// After a restart: every round is brought up to date with its runs.
    Recover,
}

/// Your buttons on a round.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum RoundAction {
    /// **Start round** on an approved Triage run.
    #[serde(rename = "start", rename_all = "camelCase")]
    Start {
        triage_run_id: String,
        #[serde(default)]
        pipeline: Option<String>,
        #[serde(default)]
        runs_at_once: Option<u32>,
        #[serde(default)]
        commit_up_to_wave: Option<u32>,
    },
    /// The cap on runs at once, and **Commit up to wave N**.
    #[serde(rename = "settings", rename_all = "camelCase")]
    Settings {
        round_id: String,
        #[serde(default)]
        runs_at_once: Option<u32>,
        #[serde(default)]
        commit_up_to_wave: Option<u32>,
    },
    /// **Unpark** a plan: it is in the round, in `wave` (its own when left out).
    #[serde(rename = "unpark", rename_all = "camelCase")]
    Unpark {
        round_id: String,
        plan_id: String,
        #[serde(default)]
        wave: Option<u32>,
    },
    /// **Retry** a plan whose run could not start.
    #[serde(rename = "retry", rename_all = "camelCase")]
    Retry { round_id: String, plan_id: String },
}

/// The round's core: what each message does. The tests drive it directly.
pub struct Rounds<H: Host> {
    host: Arc<H>,
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

impl<H: Host> Rounds<H> {
    pub fn new(host: Arc<H>) -> Self {
        Self { host }
    }

    pub fn handle(&self, msg: RoundMsg) {
        match msg {
            RoundMsg::RunChanged(run_id) => self.on_run_changed(&run_id),
            RoundMsg::Action { action, reply } => {
                let answer = self.on_action(action);
                if let Some(reply) = reply {
                    let _ = reply.send(answer);
                }
            }
            RoundMsg::Recover => self.recover(),
        }
    }

    fn notify(&self, triage_run_id: &str) {
        self.host.run_changed(triage_run_id);
    }

    /// Bring `round_id`'s plan states up to date; returns its Triage run when anything changed.
    fn sync_round(&self, store: &mut StateStore, round_id: &str) -> Option<String> {
        let data = &mut store.data;
        let runs = &data.pipeline_runs;
        let round = data.rounds.iter_mut().find(|round| round.id == round_id)?;
        if !sync(round, |id| runs.iter().find(|run| run.id == id)) {
            return None;
        }
        round.updated_at = Some(now());
        let triage = round.triage_run_id.clone();
        if let Err(err) = store.save() {
            eprintln!("DCTerminal: round {round_id}: not saved: {err}");
        }
        Some(triage)
    }

    fn on_run_changed(&self, run_id: &str) {
        let (round_id, changed) = {
            let mut store = lock(self.host.store());
            let Some(round_id) = store
                .data
                .rounds
                .iter()
                .find(|round| round.plan_of_run(run_id).is_some())
                .map(|round| round.id.clone())
            else {
                return;
            };
            let changed = self.sync_round(&mut store, &round_id);
            (round_id, changed)
        };
        if let Some(triage) = changed {
            self.notify(&triage);
        }
        self.advance(&round_id);
    }

    fn recover(&self) {
        let ids: Vec<String> = lock(self.host.store()).data.rounds.iter().map(|round| round.id.clone()).collect();
        for id in ids {
            let changed = {
                let mut store = lock(self.host.store());
                self.sync_round(&mut store, &id)
            };
            if let Some(triage) = changed {
                self.notify(&triage);
            }
            self.advance(&id);
        }
    }

    fn on_action(&self, action: RoundAction) -> Result<String, String> {
        match action {
            RoundAction::Start { triage_run_id, pipeline, runs_at_once, commit_up_to_wave } => {
                self.start_round(triage_run_id.trim(), pipeline, runs_at_once, commit_up_to_wave)
            }
            RoundAction::Settings { round_id, runs_at_once, commit_up_to_wave } => {
                self.change(&round_id, |round| {
                    if let Some(cap) = runs_at_once {
                        if !(1..=MAX_RUNS_AT_ONCE).contains(&cap) {
                            return Err(format!("Runs at once is 1 to {MAX_RUNS_AT_ONCE}."));
                        }
                        round.runs_at_once = cap;
                    }
                    if let Some(wave) = commit_up_to_wave {
                        if !(1..=round.waves).contains(&wave) {
                            return Err(format!("Commit up to wave is 1 to {}.", round.waves));
                        }
                        round.commit_up_to_wave = wave;
                    }
                    Ok(())
                })
            }
            RoundAction::Unpark { round_id, plan_id, wave } => self.change(&round_id, |round| {
                let waves = round.waves;
                let plan = round.plan_mut(&plan_id).ok_or_else(|| format!("{plan_id} is not a plan of this round."))?;
                if plan.state != PlanRunState::Parked {
                    return Err(format!("{plan_id} is not parked."));
                }
                let wave = wave.or(plan.wave).ok_or_else(|| format!("{plan_id} has no wave: pick the wave it goes in."))?;
                if !(1..=waves).contains(&wave) {
                    return Err(format!("The wave is 1 to {waves}."));
                }
                plan.wave = Some(wave);
                plan.state = PlanRunState::Ready;
                plan.note = Some("Unparked by you.".to_string());
                Ok(())
            }),
            RoundAction::Retry { round_id, plan_id } => self.change(&round_id, |round| {
                let plan = round.plan_mut(&plan_id).ok_or_else(|| format!("{plan_id} is not a plan of this round."))?;
                match (plan.state, plan.run_id.is_some()) {
                    (PlanRunState::Stopped, false) => {
                        plan.state = PlanRunState::Ready;
                        plan.note = None;
                        Ok(())
                    }
                    (PlanRunState::Stopped, true) => Err(format!(
                        "{plan_id}'s run is stopped: carry it on in its own overview (Resend story, Continue, Send, Mark complete)."
                    )),
                    _ => Err(format!("{plan_id} did not fail to start.")),
                }
            }),
        }
    }

    /// Apply `edit` to the round, save, and start what it allows now.
    fn change(&self, round_id: &str, edit: impl FnOnce(&mut QaRound) -> Result<(), String>) -> Result<String, String> {
        let triage = {
            let mut store = lock(self.host.store());
            let round = store
                .data
                .rounds
                .iter_mut()
                .find(|round| round.id == round_id.trim())
                .ok_or_else(|| format!("unknown round: {round_id}"))?;
            let before = round.clone();
            if let Err(err) = edit(round) {
                *round = before;
                return Err(err);
            }
            round.updated_at = Some(now());
            let triage = round.triage_run_id.clone();
            store.save()?;
            triage
        };
        self.notify(&triage);
        self.advance(round_id.trim());
        Ok(round_id.trim().to_string())
    }

    fn start_round(
        &self,
        triage_run_id: &str,
        pipeline: Option<String>,
        runs_at_once: Option<u32>,
        commit_up_to_wave: Option<u32>,
    ) -> Result<String, String> {
        let pipeline = pipeline.map(|p| p.trim().to_string()).filter(|p| !p.is_empty()).unwrap_or_else(|| DEFAULT_PLAN_PIPELINE.to_string());
        let (cwd, window_id, title) = {
            let store = lock(self.host.store());
            if let Some(round) = store.data.rounds.iter().find(|round| round.triage_run_id == triage_run_id) {
                return Ok(round.id.clone());
            }
            let run = store
                .pipeline_run_by_id(triage_run_id)
                .ok_or_else(|| format!("unknown pipeline run: {triage_run_id}"))?;
            let def = crate::pipelines::find(&run.kind).ok_or_else(|| format!("unknown pipeline: {}", run.kind))?;
            let first = def.stages.first().filter(|stage| stage.round).ok_or("This run is not a QA round's Triage.")?;
            if run.status != RunStatus::Complete {
                return Err("Approve the round first: Start round takes an approved round.".into());
            }
            let tab = run.tab_ids.get(&first.role_id).and_then(|id| store.tab_by_id(id));
            let title = tab
                .and_then(|tab| tab.answers.get("title").map(|t| t.trim().to_string()))
                .filter(|t| !t.is_empty())
                .unwrap_or_else(|| "QA round".to_string());
            (run.cwd.clone(), tab.map(|tab| tab.window_id.clone()), title)
        };
        let def = crate::pipelines::find_enabled(&pipeline)?;
        if crate::bridge::launch::engine_for(&def) < crate::bridge::launch::ENGINE_V2 {
            return Err(format!("{} runs on engine 1 (manual only), so a round cannot drive it.", def.name));
        }
        if def.stages.iter().any(|stage| stage.round) {
            return Err(format!("{} is a round's pipeline; pick one that builds a plan, such as Eagle-Eye 1.", def.name));
        }
        let runs_at_once = runs_at_once.unwrap_or(DEFAULT_RUNS_AT_ONCE);
        if !(1..=MAX_RUNS_AT_ONCE).contains(&runs_at_once) {
            return Err(format!("Runs at once is 1 to {MAX_RUNS_AT_ONCE}."));
        }
        let runs_root = self.host.runs_root();
        let triage_dir = crate::bridge::folder::run_dir(&runs_root, triage_run_id).ok_or("not a run id")?;
        let files = read_triage(&triage_dir)?;
        if files.round.run_id != triage_run_id {
            return Err("This run's round.json names another run.".into());
        }
        let waves = files.round.round.waves.len() as u32;
        if waves == 0 {
            return Err("The round has no waves, so nothing would start.".into());
        }
        let commit_up_to_wave = commit_up_to_wave.unwrap_or(1);
        if !(1..=waves).contains(&commit_up_to_wave) {
            return Err(format!("Commit up to wave is 1 to {waves}."));
        }
        let plans = files
            .round
            .round
            .plans
            .iter()
            .map(|plan| RoundPlanRun {
                plan_id: plan.id.clone(),
                title: plan.title.clone(),
                wave: plan.wave,
                state: match plan.status {
                    PlanStatus::Active => PlanRunState::Ready,
                    PlanStatus::Parked => PlanRunState::Parked,
                    PlanStatus::Deferred => PlanRunState::Deferred,
                },
                run_id: None,
                note: plan.reason.clone().filter(|_| plan.status != PlanStatus::Active),
            })
            .collect();
        let root = rounds_root(&runs_root);
        let id = {
            let store = lock(self.host.store());
            let mut ms = chrono::Utc::now().timestamp_millis();
            loop {
                let id = format!("round_{ms}");
                let taken = store.data.rounds.iter().any(|round| round.id == id) || root.join(&id).exists();
                if !taken {
                    break id;
                }
                ms += 1;
            }
        };
        let dir = round_dir(&root, &id).ok_or("not a round id")?;
        write_round_folder(&dir, &id, &files)?;
        let round = QaRound {
            id: id.clone(),
            triage_run_id: triage_run_id.to_string(),
            title,
            cwd,
            window_id,
            pipeline: def.id.clone(),
            runs_at_once,
            commit_up_to_wave,
            waves,
            plans,
            created_at: now(),
            updated_at: None,
        };
        {
            let mut store = lock(self.host.store());
            store.data.rounds.push(round);
            if let Some(run) = store.pipeline_run_by_id_mut(triage_run_id) {
                run.log("note", None, None, format!("Round started: each active plan runs {}, wave by wave.", def.name), None);
            }
            store.save()?;
        }
        self.notify(triage_run_id);
        self.advance(&id);
        Ok(id)
    }

    /// Start every plan the round allows now, one at a time. A plan whose
    /// start fails is `stopped` with why, and the next one is tried.
    fn advance(&self, round_id: &str) {
        let mut started_any = false;
        loop {
            let next = {
                let store = lock(self.host.store());
                store.data.rounds.iter().find(|round| round.id == round_id).and_then(|round| next_to_start(round).into_iter().next())
            };
            let Some(plan_id) = next else { break };
            started_any = true;
            if let Err(err) = self.start_plan(round_id, &plan_id) {
                let mut store = lock(self.host.store());
                if let Some(plan) = store.data.rounds.iter_mut().find(|r| r.id == round_id).and_then(|r| r.plan_mut(&plan_id)) {
                    plan.state = PlanRunState::Stopped;
                    plan.note = Some(format!("Could not start: {err}"));
                }
                if let Err(err) = store.save() {
                    eprintln!("DCTerminal: round {round_id}: not saved: {err}");
                }
            }
        }
        if started_any {
            let triage = lock(self.host.store()).data.rounds.iter().find(|r| r.id == round_id).map(|r| r.triage_run_id.clone());
            if let Some(triage) = triage {
                self.notify(&triage);
            }
        }
    }

    /// Start `plan_id`'s run: its first stage opens hidden with the plan's
    /// values, bridged, on autopilot.
    fn start_plan(&self, round_id: &str, plan_id: &str) -> Result<(), String> {
        let round = lock(self.host.store())
            .data
            .rounds
            .iter()
            .find(|round| round.id == round_id)
            .cloned()
            .ok_or("the round is gone")?;
        let def = crate::pipelines::find_enabled(&round.pipeline)?;
        let runs_root = self.host.runs_root();
        let dir = round_dir(&rounds_root(&runs_root), round_id).ok_or("not a round id")?;
        let copy = read_round_copy(&dir).ok_or_else(|| format!("the round's round.json is missing from {}", dir.display()))?;
        let plan = copy.round.plan(plan_id).cloned().ok_or_else(|| format!("{plan_id} is not in the round's round.json"))?;
        let first = def.stages.first().ok_or_else(|| format!("{} has no stages", def.name))?;
        let role = self.host.role(&first.role_id).ok_or_else(|| format!("unknown role {}", first.role_id))?;
        let cwd = crate::paths::validate_working_folder(&round.cwd).map_err(|err| err.message())?;
        let tickets = read_tickets_copy(&dir).map(|snapshot| plan_tickets(&snapshot, &plan));
        let run_id = {
            let store = lock(self.host.store());
            let mut ms = chrono::Utc::now().timestamp_millis();
            loop {
                let id = format!("ee_{ms}");
                let taken = store.pipeline_run_by_id(&id).is_some() || runs_root.join(&id).exists();
                if !taken {
                    break id;
                }
                ms += 1;
            }
        };
        let run_dir = crate::bridge::folder::run_dir(&runs_root, &run_id).ok_or("not a run id")?;
        let chain = ChainRef {
            chain_id: run_id.clone(),
            kind: def.id.clone(),
            step: 1,
            total: def.stages.len() as u32,
            round: 1,
            lane: None,
        };
        let mut bridge = crate::bridge::launch::plan_for_new_run(&def, &chain, &role.id)
            .ok_or_else(|| format!("{}'s first stage does not report through the pipeline bridge", def.name))?;
        bridge.autopilot = true;
        let file = plan_file(round_id, &dir, &copy, &plan);
        let values = plan_values(
            &role,
            &round,
            &copy,
            &plan,
            &cwd.display().to_string(),
            tickets.as_ref().map(|t| (t, run_dir.join(TICKETS_FILE))),
            &run_dir.join(ROUND_PLAN_FILE),
            &dir,
        );
        // W1: with the repos of the round's folder when it is a workspace.
        let repos = self.host.run_repos(&cwd);
        let instructions = crate::bridge::schema::stage_instructions_for(bridge.kind, &repos, None);
        let preview = crate::template::merge_role_prompt_with(&role, &values, &instructions);
        if !preview.errors.is_empty() {
            let problems: Vec<String> = preview.errors.iter().map(|e| e.message.clone()).collect();
            return Err(format!("the {} form is incomplete for this plan: {}", role.name, problems.join("; ")));
        }
        let merged = preview.merged.ok_or("the prompt merged to nothing")?;
        let prompt = crate::pty::launch::handoff_terminal_prompt(&merged.text, "");
        let session_id = crate::provider::new_claude_session_id();
        // The run, its tab and the plan's state in one save: a restart
        // never finds a run the round does not know, or the other way round.
        let tab_id = {
            let mut store = lock(self.host.store());
            store.bind_window(round.window_id.as_deref());
            let tab_id = store.save_terminal_tab(
                None,
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
            store.set_tab_chain(&tab_id, Some(chain), None)?;
            let run = store.pipeline_run_by_id_mut(&run_id).ok_or("the plan's run was not made")?;
            run.set_autopilot_enabled(true);
            run.log("note", None, None, format!("{plan_id} of the QA round \"{}\": {}", round.title, plan.title), None);
            store.remember_claude_terminal_session(&tab_id, &session_id)?;
            let state = store.data.rounds.iter_mut().find(|r| r.id == round_id).and_then(|r| r.plan_mut(plan_id)).ok_or("the plan is gone")?;
            state.state = PlanRunState::Running;
            state.run_id = Some(run_id.clone());
            state.note = None;
            store.save()?;
            tab_id
        };
        let launched = self.launch_plan_run(&bridge, &tab_id, &run_dir, &file, tickets.as_ref(), &dir, &cwd, &role, &prompt, &session_id, &repos);
        if let Err(err) = launched {
            // The run is there, stopped with why: the plan shows it, and no other plan stops.
            let mut store = lock(self.host.store());
            if let Some(run) = store.pipeline_run_by_id_mut(&run_id) {
                run.stop_for(StopReason::CarryOutFailed, Some(&bridge.stage_id), Some(&role.id), format!("The round could not start this plan: {err}"), None);
            }
            let _ = self.sync_round(&mut store, round_id);
            if let Err(err) = store.save() {
                eprintln!("DCTerminal: round {round_id}: not saved: {err}");
            }
            drop(store);
            self.host.run_changed(&run_id);
            return Ok(());
        }
        self.host.tab_opened(&run_id, &tab_id);
        self.host.run_changed(&run_id);
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn launch_plan_run(
        &self,
        bridge: &crate::bridge::BridgePlan,
        tab_id: &str,
        run_dir: &Path,
        file: &super::files::RoundPlanFile,
        tickets: Option<&crate::clickup::intake::TicketsSnapshot>,
        round_dir: &Path,
        cwd: &Path,
        role: &Role,
        prompt: &str,
        session_id: &str,
        repos: &crate::workspace_repos::WorkspaceRepos,
    ) -> Result<(), String> {
        let bridged = self.host.bridge_gate(&bridge.run_id, &bridge.stage_key, cwd)?;
        let runs_root = self.host.runs_root();
        write_plan_run_files(run_dir, file, tickets)?;
        record_run(round_dir, &file.plan.id, &bridge.run_id)?;
        let flags = if bridged {
            let program = self
                .host
                .bridge_program()
                .ok_or("DCTerminal could not find its own executable for the pipeline bridge.")?;
            let run_dir = crate::bridge::launch::prepare_stage(&runs_root, bridge, tab_id)?;
            crate::bridge::launch::write_workspace_repos(&run_dir, repos)?;
            let tag = BridgeTag { run_id: bridge.run_id.clone(), stage: bridge.stage_key.clone() };
            lock(self.host.store()).set_tab_bridge(tab_id, Some(tag))?;
            Some(crate::bridge::launch::launch_flags(bridge.kind, &program, &run_dir, &bridge.run_id, &bridge.stage_key, tab_id))
        } else {
            None
        };
        self.host.spawn_stage(&StageLaunch {
            run_id: bridge.run_id.clone(),
            tab_id: tab_id.to_string(),
            role_id: role.id.clone(),
            cwd: cwd.to_path_buf(),
            prompt: prompt.to_string(),
            session_id: session_id.to_string(),
            bridge: flags,
        })
    }
}

/// The first stage's form for a plan, filled from its section of the round
/// by field key (a copied role works as long as its keys are the usual ones).
#[allow(clippy::too_many_arguments)]
fn plan_values(
    role: &Role,
    round: &QaRound,
    copy: &RunRound,
    plan: &RoundPlan,
    cwd: &str,
    tickets: Option<(&crate::clickup::intake::TicketsSnapshot, std::path::PathBuf)>,
    plan_path: &Path,
    round_dir: &Path,
) -> HashMap<String, String> {
    use crate::run_actor::prompts::{CONTEXT_KEYS, PLAN_KEYS, REQUEST_KEYS};
    let wave = plan.wave.map(|n| {
        let why = copy.round.waves.iter().find(|w| w.n == n).map(|w| format!(": {}", w.why)).unwrap_or_default();
        format!("Wave {n} of {}{why}.", round.waves)
    });
    let order: Vec<String> = plan
        .repos
        .iter()
        .filter_map(|repo| copy.round.merge_order.get(repo).map(|ids| format!("{repo}: {}", ids.join(" → "))))
        .collect();
    let section = serde_json::to_string_pretty(plan).unwrap_or_default();
    let request = [
        format!("{} of the QA round \"{}\": {}", plan.id, round.title, plan.title),
        [
            wave.unwrap_or_default(),
            if plan.repos.is_empty() {
                "Repo: this folder.".to_string()
            } else {
                format!("Repos: {} (one pull request per repo).", plan.repos.join(", "))
            },
            format!("Tickets: {}.", plan.tickets.join(", ")),
            if order.is_empty() { String::new() } else { format!("Merge order: {}.", order.join("; ")) },
        ]
        .into_iter()
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n"),
        plan.summary.clone(),
        format!("The round's plan for it ({}):\n```json\n{section}\n```", plan_path.display()),
    ]
    .join("\n\n");
    let mut context = Vec::new();
    if let Some((snapshot, path)) = &tickets {
        context.push(crate::clickup::intake::snapshot_note(snapshot, &path.display().to_string()));
    }
    context.push(format!(
        "This run builds {} only; the round's other plans have runs of their own. The round document is {}.",
        plan.id,
        round_dir.join(crate::bridge::round::ROUND_MD_FILE).display()
    ));
    let context = context.join("\n\n");
    let mut values = HashMap::from([("cwd".to_string(), cwd.to_string())]);
    let mut request_done = false;
    let mut context_done = false;
    for field in &role.fields {
        let key = field.key.as_str();
        let value = match key {
            "title" => Some(format!("{}: {}", plan.id, plan.title)),
            "taskType" => {
                let options = field.options.clone().unwrap_or_default();
                let pick = options
                    .iter()
                    .find(|o| o.to_ascii_lowercase().contains("bug"))
                    .or_else(|| options.iter().find(|o| o.as_str() == "Other"))
                    .or_else(|| options.first())
                    .cloned();
                if field.field_type == FieldType::Select { pick } else { Some("Bug".to_string()) }
            }
            "expectedBehavior" => Some(format!(
                "Every ticket of {} is fixed and verified, with one draft pull request per repo, merged in the round's order.",
                plan.id
            )),
            "currentBehavior" => Some("As each ticket describes (see the tickets in the context).".to_string()),
            key if !request_done && REQUEST_KEYS.contains(&key) => {
                request_done = true;
                Some(request.clone())
            }
            key if PLAN_KEYS.contains(&key) => Some(request.clone()),
            key if !context_done && CONTEXT_KEYS.contains(&key) => {
                context_done = true;
                Some(context.clone())
            }
            _ => None,
        };
        if let Some(value) = value.filter(|v| !v.trim().is_empty()) {
            values.insert(key.to_string(), value);
        }
    }
    values
}

/// What the round view shows of one plan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanView {
    #[serde(flatten)]
    pub plan: RoundPlanRun,
    /// Why a ready plan has not started.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub waiting: Option<String>,
    /// Its tickets and repos (from the round's `round.json`).
    pub tickets: Vec<String>,
    pub repos: Vec<String>,
}

/// A round as its view shows it (R2).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoundView {
    pub round: QaRound,
    pub plans: Vec<PlanView>,
    /// **Approve all checkpoints**: every plan run waiting at its plan checkpoint.
    pub checkpoints: Vec<PlanCheckpoint>,
}

/// The round `key` names (its id, its Triage run, or one of its plan runs), as its view shows it.
pub fn view(store: &StateStore, rounds_root: &Path, key: &str) -> Option<RoundView> {
    let key = key.trim();
    let round = store
        .data
        .rounds
        .iter()
        .find(|round| round.id == key || round.triage_run_id == key || round.plan_of_run(key).is_some())?
        .clone();
    let copy = round_dir(rounds_root, &round.id).and_then(|dir| read_round_copy(&dir));
    let def = crate::pipelines::find(&round.pipeline);
    let plans = round
        .plans
        .iter()
        .map(|plan| {
            let section = copy.as_ref().and_then(|copy| copy.round.plan(&plan.plan_id));
            PlanView {
                plan: plan.clone(),
                waiting: waiting_reason(&round, plan),
                tickets: section.map(|p| p.tickets.clone()).unwrap_or_default(),
                repos: section.map(|p| p.repos.clone()).unwrap_or_default(),
            }
        })
        .collect();
    let checkpoints = round
        .plans
        .iter()
        .filter(|plan| plan.state == PlanRunState::Running)
        .filter_map(|plan| {
            let run = store.pipeline_run_by_id(plan.run_id.as_deref()?)?;
            plan_checkpoint(def.as_ref()?, run, &plan.plan_id)
        })
        .collect();
    Some(RoundView { round, plans, checkpoints })
}

/// The runner's thread and its mailbox. Cheap to share.
pub struct RoundRunner<H: Host> {
    core: Arc<Rounds<H>>,
    tx: Arc<Mutex<Option<Sender<RoundMsg>>>>,
}

impl<H: Host> Clone for RoundRunner<H> {
    fn clone(&self) -> Self {
        Self { core: self.core.clone(), tx: self.tx.clone() }
    }
}

impl<H: Host> RoundRunner<H> {
    pub fn new(host: Arc<H>) -> Self {
        Self { core: Arc::new(Rounds::new(host)), tx: Arc::new(Mutex::new(None)) }
    }

    /// Hand `msg` to the runner's thread, starting it when none runs.
    pub fn send(&self, msg: RoundMsg) {
        let mut tx = lock(&self.tx);
        let msg = match tx.as_ref() {
            Some(sender) => match sender.send(msg) {
                Ok(()) => return,
                Err(err) => err.0,
            },
            None => msg,
        };
        let (sender, rx) = channel();
        let _ = sender.send(msg);
        *tx = Some(sender);
        drop(tx);
        let core = self.core.clone();
        let spawned = std::thread::Builder::new().name("round-runner".into()).spawn(move || run_thread(core, rx));
        if let Err(err) = spawned {
            eprintln!("DCTerminal: could not start the round runner: {err}");
        }
    }

    /// A run changed: its round (if any) catches up.
    pub fn run_changed(&self, run_id: &str) {
        self.send(RoundMsg::RunChanged(run_id.to_string()));
    }

    /// A round button: send it and wait for the answer.
    pub fn ask(&self, action: RoundAction, timeout: Duration) -> Result<String, String> {
        let (reply, answer) = channel();
        self.send(RoundMsg::Action { action, reply: Some(reply) });
        match answer.recv_timeout(timeout) {
            Ok(result) => result,
            Err(RecvTimeoutError::Timeout) => Err("The round is still starting its runs. Try again in a moment.".into()),
            Err(RecvTimeoutError::Disconnected) => Err("The round runner stopped while handling that.".into()),
        }
    }
}

fn run_thread<H: Host>(core: Arc<Rounds<H>>, rx: Receiver<RoundMsg>) {
    while let Ok(msg) = rx.recv() {
        let handled = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| core.handle(msg)));
        if handled.is_err() {
            // A poisoned store still holds whole values (`run_actor::lock`).
            core.host.store().clear_poison();
            eprintln!("DCTerminal: the round runner hit an internal error; the round carries on with the next change.");
        }
    }
}
