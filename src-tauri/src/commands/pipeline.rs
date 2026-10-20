use crate::commands::chain_events::ChainEvents;
use crate::store::{PipelineRun, RunEvent, StateStore};
use serde::Serialize;
use std::sync::Mutex;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineRunView {
    pub run: PipelineRun,
    /// Step-1 form task type, for stages whose source form has none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_type: Option<String>,
}

#[tauri::command]
pub fn get_pipeline_run(
    run_id: String,
    store: State<Mutex<StateStore>>,
) -> Result<PipelineRunView, String> {
    let store = store.lock().map_err(|e| e.to_string())?;
    let mut run = store
        .pipeline_run_by_id(run_id.trim())
        .cloned()
        .ok_or_else(|| format!("unknown pipeline run: {run_id}"))?;
    // A chain's Planner form may have been filled after the run was made.
    if run.original_request.is_none() {
        run.original_request = store.chain_original_request(&run.id);
    }
    let task_type = store.chain_task_type(&run.id);
    Ok(PipelineRunView { run, task_type })
}

#[tauri::command]
pub fn pipeline_promote_plan(
    app: tauri::AppHandle,
    run_id: String,
    approved_plan: String,
    store: State<Mutex<StateStore>>,
) -> Result<(), String> {
    let mut store = store.lock().map_err(|e| e.to_string())?;
    store.pipeline_promote_plan(run_id.trim(), &approved_plan)?;
    app.chain_run_updated(run_id.trim());
    Ok(())
}

#[tauri::command]
pub fn pipeline_set_candidate_plan(
    app: tauri::AppHandle,
    run_id: String,
    candidate_plan: String,
    store: State<Mutex<StateStore>>,
) -> Result<(), String> {
    let mut store = store.lock().map_err(|e| e.to_string())?;
    store.pipeline_set_candidate_plan(run_id.trim(), &candidate_plan)?;
    app.chain_run_updated(run_id.trim());
    Ok(())
}

// ---- Pipeline definitions, gates and autopilot (ADR-014) ----

use crate::pipelines::autopilot::{decide, Decision, TurnReport};
use crate::pipelines::{GateDef, GateResult, PipelineDef};
use crate::store::{PipelineStore, StageGates, StopReason};
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

/// Built-in pipelines, then the user's own.
#[tauri::command]
pub fn pipeline_defs_list() -> Vec<PipelineDef> {
    crate::pipelines::all()
}

/// Replace the user's pipelines (Settings › Pipelines). Returns every pipeline.
#[tauri::command]
pub fn pipeline_defs_save(
    pipelines: Vec<PipelineDef>,
    store: State<Mutex<PipelineStore>>,
) -> Result<Vec<PipelineDef>, String> {
    let mut store = store.lock().map_err(|e| e.to_string())?;
    store.save(pipelines)?;
    Ok(crate::pipelines::all())
}

/// The gates a stage of `run_id` runs, its folder, and the run's round.
fn stage_gates(
    store: &StateStore,
    run_id: &str,
    stage_id: &str,
    cwd: Option<&str>,
) -> Result<(Vec<GateDef>, PathBuf, u32), String> {
    let run = store
        .pipeline_run_by_id(run_id)
        .ok_or_else(|| format!("unknown pipeline run: {run_id}"))?;
    let def = crate::pipelines::find_enabled(&run.kind)?;
    let stage = def
        .stage(stage_id)
        .ok_or_else(|| format!("{} has no stage \"{stage_id}\"", def.name))?;
    let folder = cwd
        .map(str::trim)
        .filter(|cwd| !cwd.is_empty())
        .unwrap_or(&run.cwd);
    Ok((stage.gates.clone(), PathBuf::from(folder), run.round.max(1)))
}

/// Run a stage's gates now (Run checks, or autopilot after the stage's
/// turn) and keep the results on the run. `cwd` is the stage tab's folder
/// (a worktree), else the run's. `pr_urls` are the pull requests the stage
/// reported. No store lock is held while the commands run. `round` is the
/// round the checks are for (autopilot): when another round started while
/// they ran, the results are returned but not kept.
#[tauri::command]
pub async fn pipeline_run_gates(
    app: tauri::AppHandle,
    run_id: String,
    stage_id: String,
    lane: Option<String>,
    cwd: Option<String>,
    pr_urls: Vec<String>,
    round: Option<u32>,
) -> Result<Vec<GateResult>, String> {
    use tauri::Manager;
    let run_id = run_id.trim().to_string();
    let (gates, folder, _) = {
        let state = app.state::<Mutex<StateStore>>();
        let store = state.lock().map_err(|e| e.to_string())?;
        stage_gates(&store, &run_id, &stage_id, cwd.as_deref())?
    };
    // Checks can run for many minutes: the blocking pool, never a runtime worker.
    let results: Vec<GateResult> = tauri::async_runtime::spawn_blocking(move || {
        gates
            .iter()
            .map(|gate| match gate {
                GateDef::Command { run, timeout_secs, optional } => GateResult {
                    // `decide` stops on an `auto` gate with nothing to run unless it is optional.
                    optional: *optional,
                    ..crate::pipelines::run_command_gate(&folder, run, timeout_secs.map(Duration::from_secs))
                },
                GateDef::PullRequest => crate::pipelines::run_pull_request_gate(&folder, &pr_urls),
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())?;
    let state = app.state::<Mutex<StateStore>>();
    let mut store = state.lock().map_err(|e| e.to_string())?;
    let run = store
        .pipeline_run_by_id_mut(&run_id)
        .ok_or_else(|| format!("unknown pipeline run: {run_id}"))?;
    let lane = lane.filter(|id| run.lane(id).is_some());
    if round.is_some_and(|asked| asked != run.round_for(lane.as_deref())) {
        return Ok(results);
    }
    let lane_tag = lane
        .as_deref()
        .and_then(|id| run.lane(id))
        .map(|l| format!("{}: ", l.title))
        .unwrap_or_default();
    for result in &results {
        run.log_in_lane(
            "gate",
            Some(&stage_id),
            None,
            lane.as_deref(),
            format!("{lane_tag}{}: {}", result.label, result.summary),
            (!result.output.is_empty()).then(|| result.output.clone()),
            Some(result.status.clone()),
        );
    }
    // The round as it is now: a loop-back may have started while the checks ran.
    let round = run.round_for(lane.as_deref());
    run.gates.insert(
        crate::pipelines::autopilot::stage_key(&stage_id, lane.as_deref()),
        StageGates {
            round,
            at: chrono::Utc::now().to_rfc3339(),
            results: results.clone(),
        },
    );
    store.save()?;
    app.chain_run_updated(&run_id);
    Ok(results)
}

/// Turn autopilot on (the run is `running`) or off (`stopped`, paused by
/// you) for one run. Either clears what it was waiting for; checkpoints
/// already passed stay passed; a complete run stays complete. Returns
/// whether anything changed (and was saved).
pub fn set_autopilot(store: &mut StateStore, run_id: &str, enabled: bool) -> Result<bool, String> {
    let run = store
        .pipeline_run_by_id_mut(run_id)
        .ok_or_else(|| format!("unknown pipeline run: {run_id}"))?;
    if run.autopilot.as_ref().is_some_and(|a| a.enabled == enabled) {
        return Ok(false);
    }
    if enabled && run.manual_only {
        return Err(
            "This run is manual from now on: it was switched from the pipeline bridge to engine 1 mid-run, so autopilot cannot be turned back on. Hand each stage on yourself, or start a new run."
                .to_string(),
        );
    }
    run.set_autopilot_enabled(enabled);
    // Off is a stop too: the ledger line carries its code.
    run.log_outcome(
        "autopilot",
        None,
        None,
        if enabled { "Autopilot on" } else { "Autopilot off" },
        None,
        (!enabled).then(|| StopReason::PausedByYou.as_str().to_string()),
    );
    store.save()?;
    Ok(true)
}

#[tauri::command]
pub fn pipeline_set_autopilot(
    app: tauri::AppHandle,
    run_id: String,
    enabled: bool,
    store: State<Mutex<StateStore>>,
) -> Result<(), String> {
    let run_id = run_id.trim().to_string();
    let changed = {
        let mut store = store.lock().map_err(|e| e.to_string())?;
        set_autopilot(&mut store, &run_id, enabled)?
    };
    if changed {
        app.chain_run_updated(&run_id);
    }
    // Bridged stages enforce a result only on autopilot (D13): from their
    // next stop. Written after the store lock is dropped (a folder walk).
    let runs = crate::bridge::launch::runs_root(&crate::data_dir::app_data_dir(&app).path);
    if let Err(err) = crate::bridge::launch::set_run_mode(&runs, &run_id, enabled) {
        eprintln!("DCTerminal: run {run_id}: bridge mode not updated: {err}");
    }
    Ok(())
}

/// A bridged terminal's latest finished turn (its verdict and findings from
/// `submit_result`), read from the run folder. `None` for a tab that is not
/// bridged, or while its turn runs. Continue uses it after a restart.
#[tauri::command]
pub fn pipeline_bridge_turn(
    app: tauri::AppHandle,
    tab_id: String,
    store: State<Mutex<StateStore>>,
) -> Result<Option<crate::bridge::BridgeTurn>, String> {
    let tab_id = tab_id.trim().to_string();
    let tag = {
        let store = store.lock().map_err(|e| e.to_string())?;
        store.tab_by_id(&tab_id).and_then(|tab| tab.bridge.clone())
    };
    let Some(tag) = tag else {
        return Ok(None);
    };
    let runs = crate::bridge::launch::runs_root(&crate::data_dir::app_data_dir(&app).path);
    Ok(crate::bridge::launch::read_stage_turn(&runs, &tag, &tab_id))
}

/// After a stage's turn: what autopilot does next (`decide`). Recorded in
/// the run's ledger; the frontend carries it out.
#[tauri::command]
pub fn pipeline_decide(
    app: tauri::AppHandle,
    run_id: String,
    report: TurnReport,
    store: State<Mutex<StateStore>>,
) -> Result<Decision, String> {
    let run_id = run_id.trim().to_string();
    let mut store = store.lock().map_err(|e| e.to_string())?;
    let run = store
        .pipeline_run_by_id_mut(&run_id)
        .ok_or_else(|| format!("unknown pipeline run: {run_id}"))?;
    let decision = match crate::pipelines::find_enabled(&run.kind) {
        Ok(def) => decide(&def, run, &report),
        // Unknown or disabled: a loud stop with the reason, never a guess.
        Err(why) => crate::pipelines::autopilot::stop_for_pipeline(run, why),
    };
    store.save()?;
    app.chain_run_updated(&run_id);
    Ok(decision)
}

/// Before you hand a chain tab's turn on (`advance`) or send it back
/// (`back`): claim it, so autopilot does not make the same hand-off, and
/// hear about one autopilot (or you) made already. `turn` is the source
/// tab's turn (`tab|session|prompt`). `None` off a chain run.
#[tauri::command]
pub fn pipeline_claim_handoff(
    source_tab_id: String,
    kind: String,
    turn: Option<String>,
    force: bool,
    store: State<Mutex<StateStore>>,
) -> Result<Option<crate::store::ClaimOutcome>, String> {
    let mut store = store.lock().map_err(|e| e.to_string())?;
    store.claim_handoff(source_tab_id.trim(), kind.trim(), turn.as_deref(), "you", force)
}

/// Drop a claim whose hand-off did not happen (it failed, or was cancelled).
#[tauri::command]
pub fn pipeline_release_handoff(
    run_id: String,
    key: String,
    store: State<Mutex<StateStore>>,
) -> Result<(), String> {
    let mut store = store.lock().map_err(|e| e.to_string())?;
    store.release_handoff_claim(run_id.trim(), key.trim())
}

/// A line the frontend adds to the ledger, e.g. why autopilot could not
/// carry out a decision. `stop` also puts the run in `waiting` with
/// `reason` (by default `carry_out_failed`: the frontend stops when it
/// cannot carry a decision out); with autopilot off it only logs the line
/// and the run stays `stopped`.
pub fn note(
    store: &mut StateStore,
    run_id: &str,
    stage_id: Option<&str>,
    summary: &str,
    detail: Option<String>,
    stop: bool,
    reason: Option<StopReason>,
) -> Result<(), String> {
    let summary: String = summary.trim().chars().take(500).collect();
    if summary.is_empty() {
        return Err("empty note".into());
    }
    let run = store
        .pipeline_run_by_id_mut(run_id)
        .ok_or_else(|| format!("unknown pipeline run: {run_id}"))?;
    if stop {
        run.stop_for(reason.unwrap_or(StopReason::CarryOutFailed), stage_id, None, summary, detail);
    } else {
        run.log("note", stage_id, None, summary, detail);
    }
    store.save()
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn pipeline_note(
    app: tauri::AppHandle,
    run_id: String,
    stage_id: Option<String>,
    summary: String,
    detail: Option<String>,
    stop: bool,
    reason: Option<StopReason>,
    store: State<Mutex<StateStore>>,
) -> Result<(), String> {
    let run_id = run_id.trim().to_string();
    let mut store = store.lock().map_err(|e| e.to_string())?;
    note(&mut store, &run_id, stage_id.as_deref(), &summary, detail, stop, reason)?;
    app.chain_run_updated(&run_id);
    Ok(())
}

/// Records that a stage's terminal finished a turn, so the run lanes can
/// draw where each turn ended. `verdict` is a reviewer's verdict, if its
/// reply had one. Unknown stages are refused; a lane that is not on the run
/// is ignored.
///
/// Back-and-forth in one turn coalesces: when the newest event is already
/// this stage's (and role's, and lane's) `turn` of this round, it moves to
/// now, keeping its verdict unless a new one came, instead of adding a line.
/// Returns whether the ledger changed (and was saved); a repeat within a
/// second that changes nothing else is dropped.
pub fn turn_finished(
    store: &mut StateStore,
    run_id: &str,
    stage_id: &str,
    role_id: &str,
    lane: Option<&str>,
    verdict: Option<&str>,
) -> Result<bool, String> {
    let run = store
        .pipeline_run_by_id_mut(run_id)
        .ok_or_else(|| format!("unknown pipeline run: {run_id}"))?;
    let title = crate::pipelines::find(&run.kind)
        .and_then(|def| def.stage(stage_id).map(|stage| stage.title.clone()))
        .ok_or_else(|| format!("unknown stage: {stage_id}"))?;
    let lane = lane.filter(|id| run.lane(id).is_some());
    let lane_tag = lane
        .and_then(|id| run.lane(id))
        .map(|l| format!("{}: ", l.title))
        .unwrap_or_default();
    let summary_for = |verdict: Option<&str>| match verdict {
        Some(verdict) => format!("{lane_tag}{title} finished its turn ({verdict})"),
        None => format!("{lane_tag}{title} finished its turn"),
    };
    let verdict = verdict.map(str::trim).filter(|v| !v.is_empty()).map(str::to_string);
    let round = run.round.max(1);
    let same_turn = run.events.last().is_some_and(|last| {
        last.kind == "turn"
            && last.stage_id.as_deref() == Some(stage_id)
            && last.role_id.as_deref() == Some(role_id)
            && last.round == round
            && event_lane(run, last) == lane
    });
    if !same_turn {
        let summary = summary_for(verdict.as_deref());
        run.log_in_lane("turn", Some(stage_id), Some(role_id), lane, summary, None, verdict);
        store.save()?;
        return Ok(true);
    }
    let now = chrono::Utc::now();
    let last = run.events.last_mut().expect("checked above");
    let outcome = verdict.or_else(|| last.outcome.clone());
    let summary = summary_for(outcome.as_deref());
    let recent = last
        .at
        .parse::<chrono::DateTime<chrono::Utc>>()
        .is_ok_and(|at| (now - at).num_milliseconds() < 1_000);
    if recent && last.outcome == outcome && last.summary == summary {
        return Ok(false);
    }
    last.at = now.to_rfc3339();
    last.outcome = outcome;
    last.summary = summary;
    store.save()?;
    Ok(true)
}

/// The lane an event is about: its `lane_id`, or on events saved before
/// that existed, the lane its "PR title: " prefix names.
fn event_lane<'a>(run: &'a PipelineRun, event: &'a RunEvent) -> Option<&'a str> {
    if let Some(id) = event.lane_id.as_deref() {
        return Some(id);
    }
    run.lanes
        .iter()
        .find(|l| !l.title.is_empty() && event.summary.starts_with(&format!("{}: ", l.title)))
        .map(|l| l.id.as_str())
}

#[tauri::command]
pub fn pipeline_turn_finished(
    app: tauri::AppHandle,
    run_id: String,
    stage_id: String,
    role_id: String,
    lane: Option<String>,
    verdict: Option<String>,
    store: State<Mutex<StateStore>>,
) -> Result<(), String> {
    let run_id = run_id.trim().to_string();
    let mut store = store.lock().map_err(|e| e.to_string())?;
    let changed = turn_finished(
        &mut store,
        &run_id,
        stage_id.trim(),
        role_id.trim(),
        lane.as_deref(),
        verdict.as_deref(),
    )?;
    if changed {
        app.chain_run_updated(&run_id);
    }
    Ok(())
}

/// One pull request of a fan-out, from the plan's pull-request list.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaneInput {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub depends_on: Vec<String>,
}

/// Split a run into one lane per pull request at `stage_id` (the
/// Implementer's). Lanes with no dependency start as active, the others
/// wait for theirs. The frontend then opens each lane's tabs. Refused once
/// the run has lanes, or for a dependency that is not a lane.
pub fn fan_out(store: &mut StateStore, run_id: &str, stage_id: &str, lanes: Vec<LaneInput>) -> Result<(), String> {
    let run = store
        .pipeline_run_by_id_mut(run_id)
        .ok_or_else(|| format!("unknown pipeline run: {run_id}"))?;
    if !run.lanes.is_empty() {
        return Err("This run already fanned out.".into());
    }
    let def = crate::pipelines::find_enabled(&run.kind)?;
    if def.stage(stage_id).is_none() {
        return Err(format!("{} has no stage \"{stage_id}\"", def.name));
    }
    if lanes.len() < 2 || lanes.len() > 8 {
        return Err("Fan out needs 2 to 8 pull requests.".into());
    }
    let ids: std::collections::HashSet<&str> = lanes.iter().map(|l| l.id.as_str()).collect();
    if ids.len() != lanes.len() {
        return Err("Two pull requests share an id.".into());
    }
    for lane in &lanes {
        let ok_id = !lane.id.is_empty()
            && lane.id.len() <= 16
            && lane.id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
        if !ok_id || lane.title.trim().is_empty() {
            return Err(format!("Pull request \"{}\" needs an id and a title.", lane.id));
        }
        if let Some(missing) = lane.depends_on.iter().find(|d| !ids.contains(d.as_str()) || *d == &lane.id) {
            return Err(format!("{} depends on \"{missing}\", which is not another pull request here.", lane.title));
        }
    }
    // Every lane must be reachable: no dependency cycle.
    let mut done: std::collections::HashSet<String> = std::collections::HashSet::new();
    loop {
        let ready: Vec<String> = lanes
            .iter()
            .filter(|l| !done.contains(&l.id) && l.depends_on.iter().all(|d| done.contains(d)))
            .map(|l| l.id.clone())
            .collect();
        if ready.is_empty() {
            break;
        }
        done.extend(ready);
    }
    if done.len() != lanes.len() {
        return Err("The pull requests depend on each other in a cycle, so none of them could start.".into());
    }
    let round = 1;
    run.lanes = lanes
        .into_iter()
        .map(|lane| crate::store::RunLane {
            status: if lane.depends_on.is_empty() { "active" } else { "waiting" }.to_string(),
            id: lane.id,
            title: lane.title.trim().to_string(),
            depends_on: lane.depends_on,
            stage: stage_id.to_string(),
            round,
            tab_ids: HashMap::new(),
            handoffs: HashMap::new(),
            verdicts: Vec::new(),
        })
        .collect();
    run.fan_out_stage = Some(stage_id.to_string());
    run.stage = stage_id.to_string();
    let titles: Vec<String> = run.lanes.iter().map(|l| l.title.clone()).collect();
    run.log(
        "note",
        Some(stage_id),
        None,
        format!("Fanned out into {} pull requests", titles.len()),
        Some(titles.join("\n")),
    );
    store.save()
}

#[tauri::command]
pub fn pipeline_fan_out(
    app: tauri::AppHandle,
    run_id: String,
    stage_id: String,
    lanes: Vec<LaneInput>,
    store: State<Mutex<StateStore>>,
) -> Result<(), String> {
    let run_id = run_id.trim().to_string();
    let mut store = store.lock().map_err(|e| e.to_string())?;
    fan_out(&mut store, &run_id, &stage_id, lanes)?;
    app.chain_run_updated(&run_id);
    Ok(())
}

/// Mark a lane `waiting`, `active` (its Implementer started) or `approved`.
pub fn set_lane_status(store: &mut StateStore, run_id: &str, lane: &str, status: &str) -> Result<(), String> {
    if !matches!(status, "waiting" | "active" | "approved") {
        return Err(format!("not a lane status: {status}"));
    }
    let run = store
        .pipeline_run_by_id_mut(run_id)
        .ok_or_else(|| format!("unknown pipeline run: {run_id}"))?;
    let title = {
        let l = run.lane_mut(lane).ok_or_else(|| format!("unknown lane: {lane}"))?;
        if l.status == status {
            return Ok(());
        }
        l.status = status.to_string();
        l.title.clone()
    };
    run.log_in_lane("note", None, None, Some(lane), format!("{title}: {status}"), None, None);
    store.save()
}

#[tauri::command]
pub fn pipeline_lane_status(
    app: tauri::AppHandle,
    run_id: String,
    lane: String,
    status: String,
    store: State<Mutex<StateStore>>,
) -> Result<(), String> {
    let run_id = run_id.trim().to_string();
    let mut store = store.lock().map_err(|e| e.to_string())?;
    set_lane_status(&mut store, &run_id, lane.trim(), status.trim())?;
    app.chain_run_updated(&run_id);
    Ok(())
}

/// What a manual approval did: the run is complete, or these waiting lanes
/// can start now.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ApproveResult {
    pub complete: bool,
    pub unblocked: Vec<String>,
}

/// Approve a lane (or, with no lane, the run) by hand, e.g. when its last
/// reviewer approved it but listed findings. Clears what autopilot was
/// waiting for and completes the run once every lane is approved.
pub fn approve(store: &mut StateStore, run_id: &str, lane: Option<&str>) -> Result<ApproveResult, String> {
    let run = store
        .pipeline_run_by_id_mut(run_id)
        .ok_or_else(|| format!("unknown pipeline run: {run_id}"))?;
    let summary = match lane {
        Some(lane) => {
            let l = run.lane_mut(lane).ok_or_else(|| format!("unknown lane: {lane}"))?;
            if l.status == "approved" {
                // Already approved (e.g. by autopilot): nothing to log again.
                return Ok(ApproveResult { complete: false, unblocked: Vec::new() });
            }
            l.status = "approved".to_string();
            format!("{}: approved by you", l.title)
        }
        None if !run.lanes.is_empty() => {
            return Err("This run has pull requests: mark each one approved instead.".into());
        }
        None => {
            if let Some(def) = crate::pipelines::find(&run.kind) {
                let at_last = def.stages.last().is_some_and(|last| last.id == run.stage);
                if !at_last {
                    let title = def
                        .stages
                        .iter()
                        .find(|s| s.id == run.stage)
                        .map_or(run.stage.as_str(), |s| s.title.as_str());
                    return Err(format!("Mark complete is for the last stage; this run is at {title}."));
                }
            }
            "Approved by you".to_string()
        }
    };
    run.log_in_lane("note", None, None, lane, summary, None, None);
    let complete = run.lanes.iter().all(|l| l.status == "approved");
    if complete {
        run.set_complete();
        run.log("complete", None, None, "Complete: approved by you.", None);
    } else {
        run.resume_after_you();
    }
    let unblocked = if complete { Vec::new() } else { run.unblocked_lanes() };
    store.save()?;
    Ok(ApproveResult { complete, unblocked })
}

#[tauri::command]
pub fn pipeline_approve(
    app: tauri::AppHandle,
    run_id: String,
    lane: Option<String>,
    store: State<Mutex<StateStore>>,
) -> Result<ApproveResult, String> {
    let run_id = run_id.trim().to_string();
    let mut store = store.lock().map_err(|e| e.to_string())?;
    let lane = lane.as_deref().map(str::trim).filter(|l| !l.is_empty());
    let result = approve(&mut store, &run_id, lane)?;
    app.chain_run_updated(&run_id);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::{approve, decide, fan_out, note, set_autopilot, set_lane_status, turn_finished, ApproveResult, LaneInput, TurnReport};
    use crate::store::{RunStatus, StopReason};
    use crate::roles::Role;
    use crate::store::{AppStateFile, ChainRef, StateStore, MAIN_WINDOW_ID};

    fn store(name: &str) -> (crate::test_support::TempDir, StateStore) {
        let dir = crate::test_support::TempDir::new(name);
        let store = StateStore {
            path: dir.path().join("state.json"),
            data: AppStateFile::default(),
            new_tab_provider: crate::provider::ProviderId::DEFAULT,
            draft_window: MAIN_WINDOW_ID.to_string(),
        };
        (dir, store)
    }

    fn role(id: &str) -> Role {
        Role {
            id: id.to_string(),
            name: id.to_string(),
            template_text: String::new(),
            template_version: 1,
            template_hash: String::new(),
            schema_template_hash: String::new(),
            default_mode: "agent".to_string(),
            injection: "send_on_start".to_string(),
            color: "#fff".to_string(),
            is_built_in: true,
            fields: vec![],
            updated_at: None,
            handoff_targets: None,
        }
    }

    fn chain(step: u32, lane: Option<&str>) -> ChainRef {
        ChainRef {
            chain_id: "ee_f".into(),
            kind: "eagle1".into(),
            step,
            total: 4,
            round: 1,
            lane: lane.map(str::to_string),
        }
    }

    fn lanes() -> Vec<LaneInput> {
        vec![
            LaneInput { id: "pr1".into(), title: "PR1 — API".into(), depends_on: vec![] },
            LaneInput { id: "pr2".into(), title: "PR2 — UI".into(), depends_on: vec!["pr1".into()] },
        ]
    }

    #[test]
    fn a_fan_out_makes_lanes_that_record_their_own_tabs_and_rounds() {
        let (_dir, mut store) = store("fan_out");
        let planner = store.create_draft_tab(&role("role_planner"), "/tmp/p", true, None).unwrap();
        store.set_tab_chain(&planner, Some(chain(1, None)), None).unwrap();
        fan_out(&mut store, "ee_f", "implementer", lanes()).unwrap();
        let run = store.pipeline_run_by_id("ee_f").unwrap();
        assert_eq!(run.lane("pr1").unwrap().status, "active");
        assert_eq!(run.lane("pr2").unwrap().status, "waiting");
        assert_eq!(run.fan_out_stage.as_deref(), Some("implementer"));
        assert!(fan_out(&mut store, "ee_f", "implementer", lanes()).is_err(), "only once");

        let impl1 = store.create_draft_tab(&role("role_implementer"), "/tmp/wt1", true, None).unwrap();
        store.set_tab_chain(&impl1, Some(chain(3, Some("pr1"))), Some("plan for PR1")).unwrap();
        let review1 = store.create_draft_tab(&role("role_pr_reviewer"), "/tmp/wt1", true, None).unwrap();
        store.set_tab_chain(&review1, Some(chain(4, Some("pr1"))), Some("summary")).unwrap();
        let run = store.pipeline_run_by_id("ee_f").unwrap();
        let lane = run.lane("pr1").unwrap();
        assert_eq!(lane.tab_ids.get("role_implementer"), Some(&impl1));
        assert_eq!(lane.stage, "pr_reviewer");
        assert!(!run.tab_ids.contains_key("role_implementer"), "lane tabs stay in the lane");
        assert!(run.events.last().unwrap().summary.starts_with("PR1 — API: Handed to PR Reviewer"));
        let impl2 = store.create_draft_tab(&role("role_implementer"), "/tmp/wt2", true, None).unwrap();
        store.set_tab_chain(&impl2, Some(chain(3, Some("pr2"))), Some("plan for PR2")).unwrap();
        let run = store.pipeline_run_by_id("ee_f").unwrap();
        assert_eq!(run.lane("pr2").unwrap().status, "waiting", "tagging does not start a lane");
        set_lane_status(&mut store, "ee_f", "pr2", "active").unwrap();
        assert_eq!(store.pipeline_run_by_id("ee_f").unwrap().lane("pr2").unwrap().status, "active");
        assert!(set_lane_status(&mut store, "ee_f", "pr2", "done").is_err());

        let chain = store
            .chain_loop_back_in("ee_f", Some("pr1"), "role_pr_reviewer", &impl1, Some("REQUEST CHANGES"), Some("fix"))
            .unwrap();
        assert_eq!((chain.step, chain.round, chain.lane.as_deref()), (3, 2, Some("pr1")));
        let run = store.pipeline_run_by_id("ee_f").unwrap();
        assert_eq!(run.lane("pr1").unwrap().round, 2);
        assert_eq!(run.round, 1, "the run's own round is untouched");
        assert_eq!(run.lane("pr1").unwrap().verdicts.len(), 1);
        assert!(run.verdicts.is_empty());
        assert_eq!(store.tab_by_id(&review1).unwrap().chain.as_ref().unwrap().round, 2);
        assert_eq!(store.tab_by_id(&planner).unwrap().chain.as_ref().unwrap().round, 1);
    }

    #[test]
    fn a_fan_out_refuses_bad_lanes() {
        let (_dir, mut store) = store("fan_out_bad");
        let planner = store.create_draft_tab(&role("role_planner"), "/tmp/p", true, None).unwrap();
        store.set_tab_chain(&planner, Some(chain(1, None)), None).unwrap();
        let one = vec![LaneInput { id: "pr1".into(), title: "PR1".into(), depends_on: vec![] }];
        assert!(fan_out(&mut store, "ee_f", "implementer", one).unwrap_err().contains("2 to 8"));
        let mut bad = lanes();
        bad[1].depends_on = vec!["pr9".into()];
        assert!(fan_out(&mut store, "ee_f", "implementer", bad).unwrap_err().contains("pr9"));
        assert!(fan_out(&mut store, "ee_f", "nowhere", lanes()).is_err());
        assert!(store.pipeline_run_by_id("ee_f").unwrap().lanes.is_empty());
    }

    #[test]
    fn a_fan_out_refuses_a_dependency_cycle() {
        let (_dir, mut store) = store("fan_out_cycle");
        let planner = store.create_draft_tab(&role("role_planner"), "/tmp/p", true, None).unwrap();
        store.set_tab_chain(&planner, Some(chain(1, None)), None).unwrap();
        let mut cycle = lanes();
        cycle[0].depends_on = vec!["pr2".into()];
        assert!(fan_out(&mut store, "ee_f", "implementer", cycle).unwrap_err().contains("cycle"));
        let run = store.pipeline_run_by_id("ee_f").unwrap();
        assert!(run.lanes.is_empty());
        assert!(run.fan_out_stage.is_none());
    }

    fn waiting_on(store: &mut StateStore, why: &str) {
        let run = store.pipeline_run_by_id_mut("ee_f").unwrap();
        run.set_autopilot_enabled(true);
        run.set_waiting(StopReason::BlockingFindings, why);
    }

    #[test]
    fn approving_a_lane_by_hand_unblocks_its_dependents_then_completes_the_run() {
        let (_dir, mut store) = store("approve_lanes");
        let planner = store.create_draft_tab(&role("role_planner"), "/tmp/p", true, None).unwrap();
        store.set_tab_chain(&planner, Some(chain(1, None)), None).unwrap();
        fan_out(&mut store, "ee_f", "implementer", lanes()).unwrap();
        waiting_on(&mut store, "PR Reviewer said APPROVED but lists 1 finding(s)");

        let first = approve(&mut store, "ee_f", Some("pr1")).unwrap();
        assert_eq!(first, ApproveResult { complete: false, unblocked: vec!["pr2".into()] });
        let run = store.pipeline_run_by_id("ee_f").unwrap();
        assert_eq!(run.lane("pr1").unwrap().status, "approved");
        assert!(run.autopilot.as_ref().unwrap().waiting.is_none(), "no longer waiting");
        assert_eq!((run.status, run.stop_reason), (RunStatus::Running, None), "autopilot carries on");
        let last = run.events.last().unwrap();
        assert_eq!((last.kind.as_str(), last.summary.as_str()), ("note", "PR1 — API: approved by you"));

        assert_eq!(
            approve(&mut store, "ee_f", Some("pr1")).unwrap(),
            ApproveResult { complete: false, unblocked: vec![] },
            "approving twice does nothing"
        );
        set_lane_status(&mut store, "ee_f", "pr2", "active").unwrap();
        let done = approve(&mut store, "ee_f", Some("pr2")).unwrap();
        assert_eq!(done, ApproveResult { complete: true, unblocked: vec![] });
        let run = store.pipeline_run_by_id("ee_f").unwrap();
        assert_eq!(run.status, RunStatus::Complete);
        let last = run.events.last().unwrap();
        assert_eq!((last.kind.as_str(), last.summary.as_str()), ("complete", "Complete: approved by you."));
        assert!(approve(&mut store, "ee_f", Some("pr9")).is_err());
        assert!(approve(&mut store, "ee_f", None).is_err(), "a fanned-out run is approved per lane");
    }

    #[test]
    fn sending_an_approved_lane_back_by_hand_makes_it_active_again() {
        let (_dir, mut store) = store("approved_send_back");
        let planner = store.create_draft_tab(&role("role_planner"), "/tmp/p", true, None).unwrap();
        store.set_tab_chain(&planner, Some(chain(1, None)), None).unwrap();
        fan_out(&mut store, "ee_f", "implementer", lanes()).unwrap();
        let impl1 = store.create_draft_tab(&role("role_implementer"), "/tmp/wt1", true, None).unwrap();
        store.set_tab_chain(&impl1, Some(chain(3, Some("pr1"))), Some("plan")).unwrap();
        let review1 = store.create_draft_tab(&role("role_pr_reviewer"), "/tmp/wt1", true, None).unwrap();
        store.set_tab_chain(&review1, Some(chain(4, Some("pr1"))), Some("summary")).unwrap();
        approve(&mut store, "ee_f", Some("pr1")).unwrap();
        assert_eq!(store.pipeline_run_by_id("ee_f").unwrap().lane("pr1").unwrap().status, "approved");

        store
            .chain_loop_back_in("ee_f", Some("pr1"), "role_pr_reviewer", &impl1, Some("REQUEST CHANGES"), Some("fix"))
            .unwrap();
        let run = store.pipeline_run_by_id("ee_f").unwrap();
        assert_eq!(run.lane("pr1").unwrap().status, "active", "autopilot follows its turns again");
        assert_eq!(run.lane("pr2").unwrap().status, "waiting", "other lanes untouched");
    }

    /// A fanned-out run with both lanes approved by hand (complete); returns
    /// PR1's Implementer tab.
    fn completed_lane_run(name: &str, autopilot: bool) -> (crate::test_support::TempDir, StateStore, String) {
        let (dir, mut store) = store(name);
        let planner = store.create_draft_tab(&role("role_planner"), "/tmp/p", true, None).unwrap();
        store.set_tab_chain(&planner, Some(chain(1, None)), None).unwrap();
        fan_out(&mut store, "ee_f", "implementer", lanes()).unwrap();
        let impl1 = store.create_draft_tab(&role("role_implementer"), "/tmp/wt1", true, None).unwrap();
        store.set_tab_chain(&impl1, Some(chain(3, Some("pr1"))), Some("plan")).unwrap();
        let review1 = store.create_draft_tab(&role("role_pr_reviewer"), "/tmp/wt1", true, None).unwrap();
        store.set_tab_chain(&review1, Some(chain(4, Some("pr1"))), Some("summary")).unwrap();
        set_autopilot(&mut store, "ee_f", autopilot).unwrap();
        approve(&mut store, "ee_f", Some("pr1")).unwrap();
        set_lane_status(&mut store, "ee_f", "pr2", "active").unwrap();
        approve(&mut store, "ee_f", Some("pr2")).unwrap();
        assert_eq!(store.pipeline_run_by_id("ee_f").unwrap().status, RunStatus::Complete);
        (dir, store, impl1)
    }

    #[test]
    fn your_send_back_after_completion_reopens_the_run_as_the_migration_does() {
        let (_dir, mut store, impl1) = completed_lane_run("reopen_on", true);
        let def = crate::pipelines::find("eagle1").unwrap();
        // A late turn with no send-back from you is still ignored.
        let late = TurnReport {
            stage_id: "pr_reviewer".into(),
            verdict: Some("APPROVED".into()),
            lane: Some("pr2".into()),
            turn: Some("rev2|s|late".into()),
            ..TurnReport::default()
        };
        assert_eq!(decide(&def, store.pipeline_run_by_id_mut("ee_f").unwrap(), &late).action, "ignore");

        store
            .chain_loop_back_in("ee_f", Some("pr1"), "role_pr_reviewer", &impl1, Some("REQUEST CHANGES"), Some("fix"))
            .unwrap();
        let run = store.pipeline_run_by_id("ee_f").unwrap();
        assert_eq!((run.status, run.stop_reason), (RunStatus::Running, None), "in play again, autopilot on");
        assert_eq!(run.migrated_status(), (run.status, run.stop_reason), "live rule and migration agree");
        // The Implementer's next turn in the reopened lane is decided.
        let next = TurnReport {
            stage_id: "implementer".into(),
            lane: Some("pr1".into()),
            turn: Some("impl1|s|next".into()),
            ..TurnReport::default()
        };
        let d = decide(&def, store.pipeline_run_by_id_mut("ee_f").unwrap(), &next);
        assert!(!matches!(d.action.as_str(), "ignore" | "skip"), "{} {}", d.action, d.reason);

        // With autopilot turned off, the reopened run is stopped, paused by you,
        // as it was before it completed and as the migration reads it.
        let (_dir, mut store, impl1) = completed_lane_run("reopen_off", false);
        store
            .chain_loop_back_in("ee_f", Some("pr1"), "role_pr_reviewer", &impl1, Some("REQUEST CHANGES"), Some("fix"))
            .unwrap();
        let run = store.pipeline_run_by_id("ee_f").unwrap();
        assert_eq!((run.status, run.stop_reason), (RunStatus::Stopped, Some(StopReason::PausedByYou)));
        assert_eq!(run.migrated_status(), (run.status, run.stop_reason), "live rule and migration agree");
    }

    #[test]
    fn a_run_without_lanes_sent_back_or_handed_on_after_completion_is_reopened() {
        let (_dir, mut store) = store("reopen_run");
        let planner = store.create_draft_tab(&role("role_planner"), "/tmp/p", true, None).unwrap();
        store.set_tab_chain(&planner, Some(chain(1, None)), None).unwrap();
        let reviewer = store.create_draft_tab(&role("role_pr_reviewer"), "/tmp/p", true, None).unwrap();
        store.set_tab_chain(&reviewer, Some(chain(4, None)), Some("summary")).unwrap();
        set_autopilot(&mut store, "ee_f", true).unwrap();
        approve(&mut store, "ee_f", None).unwrap();
        assert_eq!(store.pipeline_run_by_id("ee_f").unwrap().status, RunStatus::Complete);
        store
            .chain_loop_back("ee_f", "role_pr_reviewer", &planner, Some("REQUEST CHANGES"), Some("again"))
            .unwrap();
        let run = store.pipeline_run_by_id("ee_f").unwrap();
        assert_eq!((run.status, run.stop_reason), (RunStatus::Running, None));
        assert_eq!(run.migrated_status(), (run.status, run.stop_reason));

        // A hand-off you make on a complete run reopens it the same way.
        let run = store.pipeline_run_by_id_mut("ee_f").unwrap();
        run.set_complete();
        run.log("complete", None, None, "Complete.", None);
        store.set_tab_chain(&reviewer, Some(chain(4, None)), Some("summary v2")).unwrap();
        let run = store.pipeline_run_by_id("ee_f").unwrap();
        assert_eq!((run.status, run.stop_reason), (RunStatus::Running, None));
        assert_eq!(run.migrated_status(), (run.status, run.stop_reason));
    }

    #[test]
    fn mark_complete_is_refused_before_the_last_stage() {
        let (_dir, mut store) = store("approve_early");
        let planner = store.create_draft_tab(&role("role_planner"), "/tmp/p", true, None).unwrap();
        store.set_tab_chain(&planner, Some(chain(1, None)), None).unwrap();
        waiting_on(&mut store, "waiting");
        let before = store.pipeline_run_by_id("ee_f").unwrap().clone();
        let err = approve(&mut store, "ee_f", None).unwrap_err();
        assert_eq!(err, "Mark complete is for the last stage; this run is at Planner.");
        assert_eq!(store.pipeline_run_by_id("ee_f").unwrap(), &before, "nothing logged or changed");
    }

    #[test]
    fn approving_a_run_without_lanes_completes_it() {
        let (_dir, mut store) = store("approve_run");
        let planner = store.create_draft_tab(&role("role_planner"), "/tmp/p", true, None).unwrap();
        store.set_tab_chain(&planner, Some(chain(1, None)), None).unwrap();
        let reviewer = store.create_draft_tab(&role("role_pr_reviewer"), "/tmp/p", true, None).unwrap();
        store.set_tab_chain(&reviewer, Some(chain(4, None)), Some("summary")).unwrap();
        assert_eq!(store.pipeline_run_by_id("ee_f").unwrap().stage, "pr_reviewer");
        waiting_on(&mut store, "Send it back, or press Mark complete in the chain overview.");
        let done = approve(&mut store, "ee_f", None).unwrap();
        assert_eq!(done, ApproveResult { complete: true, unblocked: vec![] });
        let run = store.pipeline_run_by_id("ee_f").unwrap();
        assert!(run.autopilot.as_ref().unwrap().waiting.is_none());
        assert_eq!((run.status, run.stop_reason), (RunStatus::Complete, None));
        let kinds: Vec<(&str, &str)> = run
            .events
            .iter()
            .rev()
            .take(2)
            .map(|e| (e.kind.as_str(), e.summary.as_str()))
            .collect();
        assert_eq!(kinds, vec![("complete", "Complete: approved by you."), ("note", "Approved by you")]);
    }

    #[test]
    fn a_finished_turn_is_recorded_with_its_verdict_and_lane() {
        let (_dir, mut store) = store("turn_finished");
        let planner = store.create_draft_tab(&role("role_planner"), "/tmp/p", true, None).unwrap();
        store.set_tab_chain(&planner, Some(chain(1, None)), None).unwrap();
        turn_finished(&mut store, "ee_f", "planner", "role_planner", None, None).unwrap();
        turn_finished(&mut store, "ee_f", "plan_reviewer", "role_plan_reviewer", None, Some(" APPROVED ")).unwrap();
        let run = store.pipeline_run_by_id("ee_f").unwrap();
        let events: Vec<_> = run.events.iter().filter(|e| e.kind == "turn").collect();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].stage_id.as_deref(), Some("planner"));
        assert_eq!(events[0].outcome, None);
        assert_eq!(events[0].summary, "Planner finished its turn");
        assert_eq!(events[1].role_id.as_deref(), Some("role_plan_reviewer"));
        assert_eq!(events[1].outcome.as_deref(), Some("APPROVED"));
        assert!(events[1].summary.ends_with("finished its turn (APPROVED)"));

        fan_out(&mut store, "ee_f", "implementer", lanes()).unwrap();
        turn_finished(&mut store, "ee_f", "implementer", "role_implementer", Some("pr1"), None).unwrap();
        let last = store.pipeline_run_by_id("ee_f").unwrap().events.last().cloned().unwrap();
        assert!(last.summary.starts_with("PR1 — API: "), "{}", last.summary);
        // A lane the run does not have only loses its tag.
        turn_finished(&mut store, "ee_f", "implementer", "role_implementer", Some("pr9"), None).unwrap();
        let last = store.pipeline_run_by_id("ee_f").unwrap().events.last().cloned().unwrap();
        assert!(last.summary.starts_with("Implementer"), "{}", last.summary);
    }

    #[test]
    fn lane_events_carry_their_lane_id() {
        let (_dir, mut store) = store("lane_ids");
        let planner = store.create_draft_tab(&role("role_planner"), "/tmp/p", true, None).unwrap();
        store.set_tab_chain(&planner, Some(chain(1, None)), None).unwrap();
        // "PR1: Auth" starts with "PR1: ", so the text alone names the wrong lane.
        let lanes = vec![
            LaneInput { id: "pr1".into(), title: "PR1".into(), depends_on: vec![] },
            LaneInput { id: "pr1b".into(), title: "PR1: Auth".into(), depends_on: vec![] },
        ];
        fan_out(&mut store, "ee_f", "implementer", lanes).unwrap();
        let last_lane = |store: &StateStore| {
            store.pipeline_run_by_id("ee_f").unwrap().events.last().unwrap().lane_id.clone()
        };
        let impl1b = store.create_draft_tab(&role("role_implementer"), "/tmp/wt", true, None).unwrap();
        store.set_tab_chain(&impl1b, Some(chain(3, Some("pr1b"))), Some("plan")).unwrap();
        assert_eq!(last_lane(&store).as_deref(), Some("pr1b"), "handoff");
        store
            .chain_loop_back_in("ee_f", Some("pr1b"), "role_pr_reviewer", &impl1b, Some("REQUEST CHANGES"), Some("fix"))
            .unwrap();
        assert_eq!(last_lane(&store).as_deref(), Some("pr1b"), "loopBack");
        set_lane_status(&mut store, "ee_f", "pr1", "waiting").unwrap();
        assert_eq!(last_lane(&store).as_deref(), Some("pr1"), "lane status note");
        approve(&mut store, "ee_f", Some("pr1b")).unwrap();
        assert_eq!(last_lane(&store).as_deref(), Some("pr1b"), "approval note");

        // Turns of the two lanes keep their own lines, though one's text
        // starts with the other's title.
        store.pipeline_run_by_id_mut("ee_f").unwrap().round = 2;
        turn_finished(&mut store, "ee_f", "implementer", "role_implementer", Some("pr1b"), None).unwrap();
        assert_eq!(last_lane(&store).as_deref(), Some("pr1b"), "turn");
        turn_finished(&mut store, "ee_f", "implementer", "role_implementer", Some("pr1"), None).unwrap();
        let run = store.pipeline_run_by_id("ee_f").unwrap();
        let turns: Vec<_> = run.events.iter().filter(|e| e.kind == "turn").map(|e| e.lane_id.as_deref()).collect();
        assert_eq!(turns, vec![Some("pr1b"), Some("pr1")]);
        // Off a lane, no lane id is written.
        turn_finished(&mut store, "ee_f", "planner", "role_planner", None, None).unwrap();
        assert_eq!(last_lane(&store), None);
        let json = serde_json::to_string(store.pipeline_run_by_id("ee_f").unwrap().events.last().unwrap()).unwrap();
        assert!(!json.contains("laneId"), "{json}");
    }

    #[test]
    fn an_event_saved_before_lane_ids_still_loads() {
        let old = r#"{"at":"2026-10-01T00:00:00Z","kind":"turn","round":1,"summary":"PR1: Implementer finished its turn"}"#;
        let event: crate::store::RunEvent = serde_json::from_str(old).unwrap();
        assert_eq!(event.lane_id, None);
        let new = r#"{"at":"2026-10-01T00:00:00Z","kind":"turn","round":1,"summary":"x","laneId":"pr1"}"#;
        let event: crate::store::RunEvent = serde_json::from_str(new).unwrap();
        assert_eq!(event.lane_id.as_deref(), Some("pr1"));
    }

    #[test]
    fn back_and_forth_in_one_turn_updates_its_turn_line_in_place() {
        let (_dir, mut store) = store("turn_coalesce");
        let planner = store.create_draft_tab(&role("role_planner"), "/tmp/p", true, None).unwrap();
        store.set_tab_chain(&planner, Some(chain(1, None)), None).unwrap();
        let turns = |store: &StateStore| -> Vec<crate::store::RunEvent> {
            let run = store.pipeline_run_by_id("ee_f").unwrap();
            run.events.iter().filter(|e| e.kind == "turn").cloned().collect()
        };
        assert!(turn_finished(&mut store, "ee_f", "plan_reviewer", "role_plan_reviewer", None, Some("REQUEST CHANGES")).unwrap());
        let first_at = "2000-01-01T00:00:00+00:00";
        store.pipeline_run_by_id_mut("ee_f").unwrap().events.last_mut().unwrap().at = first_at.into();
        // Another reply in the same turn, without a verdict: moved, verdict kept.
        assert!(turn_finished(&mut store, "ee_f", "plan_reviewer", "role_plan_reviewer", None, None).unwrap());
        let now = turns(&store);
        assert_eq!(now.len(), 1);
        assert_ne!(now[0].at, first_at);
        assert_eq!(now[0].outcome.as_deref(), Some("REQUEST CHANGES"));
        assert!(now[0].summary.ends_with("(REQUEST CHANGES)"), "{}", now[0].summary);
        // A repeat right away changes nothing: not saved, not emitted.
        assert!(!turn_finished(&mut store, "ee_f", "plan_reviewer", "role_plan_reviewer", None, None).unwrap());
        // A new verdict replaces the old one.
        assert!(turn_finished(&mut store, "ee_f", "plan_reviewer", "role_plan_reviewer", None, Some("APPROVED")).unwrap());
        assert_eq!(turns(&store).len(), 1);
        assert_eq!(turns(&store)[0].outcome.as_deref(), Some("APPROVED"));
        // Another stage, another round or any event in between: a new line.
        turn_finished(&mut store, "ee_f", "planner", "role_planner", None, None).unwrap();
        assert_eq!(turns(&store).len(), 2);
        store.pipeline_run_by_id_mut("ee_f").unwrap().round = 2;
        turn_finished(&mut store, "ee_f", "planner", "role_planner", None, None).unwrap();
        assert_eq!(turns(&store).len(), 3);
        store.pipeline_run_by_id_mut("ee_f").unwrap().log("note", None, None, "hi", None);
        turn_finished(&mut store, "ee_f", "planner", "role_planner", None, None).unwrap();
        assert_eq!(turns(&store).len(), 4);
        // Lanes keep their own lines.
        fan_out(&mut store, "ee_f", "implementer", lanes()).unwrap();
        turn_finished(&mut store, "ee_f", "implementer", "role_implementer", Some("pr1"), None).unwrap();
        turn_finished(&mut store, "ee_f", "implementer", "role_implementer", Some("pr2"), None).unwrap();
        turn_finished(&mut store, "ee_f", "implementer", "role_implementer", Some("pr2"), None).unwrap();
        assert_eq!(turns(&store).len(), 6);
    }

    #[test]
    fn a_finished_turn_on_an_unknown_run_or_stage_is_refused() {
        let (_dir, mut store) = store("turn_finished_bad");
        assert!(turn_finished(&mut store, "nope", "planner", "role_planner", None, None).is_err());
        let planner = store.create_draft_tab(&role("role_planner"), "/tmp/p", true, None).unwrap();
        store.set_tab_chain(&planner, Some(chain(1, None)), None).unwrap();
        let before = store.pipeline_run_by_id("ee_f").unwrap().events.len();
        assert!(turn_finished(&mut store, "ee_f", "nowhere", "role_planner", None, None)
            .unwrap_err()
            .contains("unknown stage"));
        assert_eq!(store.pipeline_run_by_id("ee_f").unwrap().events.len(), before);
    }

    #[test]
    fn a_stop_note_puts_the_run_in_waiting_with_its_reason() {
        let (_dir, mut store) = store("note_stop");
        let planner = store.create_draft_tab(&role("role_planner"), "/tmp/p", true, None).unwrap();
        store.set_tab_chain(&planner, Some(chain(1, None)), None).unwrap();
        set_autopilot(&mut store, "ee_f", true).unwrap();
        note(&mut store, "ee_f", None, "Tab 2 is still working.", None, false, None).unwrap();
        assert_eq!(store.pipeline_run_by_id("ee_f").unwrap().status, RunStatus::Running, "a plain note");
        note(&mut store, "ee_f", Some("planner"), "Autopilot could not open plan_reviewer", None, true, None).unwrap();
        let run = store.pipeline_run_by_id("ee_f").unwrap();
        assert_eq!((run.status, run.stop_reason), (RunStatus::Waiting, Some(StopReason::CarryOutFailed)));
        assert_eq!(run.events.last().unwrap().kind, "stop");
        // The ledger line carries the code, for its plain-English line.
        assert_eq!(run.events.last().unwrap().outcome.as_deref(), Some("carry_out_failed"));
        note(&mut store, "ee_f", None, "Quiet for 30 minutes", None, true, Some(StopReason::Stalled)).unwrap();
        let run = store.pipeline_run_by_id("ee_f").unwrap();
        assert_eq!(run.stop_reason, Some(StopReason::Stalled));
        assert_eq!(run.events.last().unwrap().outcome.as_deref(), Some("stalled"));
        assert!(note(&mut store, "ee_f", None, "  ", None, true, None).is_err());
    }

    #[test]
    fn a_stop_note_with_autopilot_off_logs_the_line_and_leaves_the_run_stopped() {
        let (_dir, mut store) = store("note_stop_off");
        let planner = store.create_draft_tab(&role("role_planner"), "/tmp/p", true, None).unwrap();
        store.set_tab_chain(&planner, Some(chain(1, None)), None).unwrap();
        set_autopilot(&mut store, "ee_f", true).unwrap();
        // You turned autopilot off while it was opening a terminal; the hand-off then failed.
        set_autopilot(&mut store, "ee_f", false).unwrap();
        note(&mut store, "ee_f", Some("planner"), "Autopilot could not open plan_reviewer", None, true, None).unwrap();
        let run = store.pipeline_run_by_id("ee_f").unwrap();
        assert_eq!((run.status, run.stop_reason), (RunStatus::Stopped, Some(StopReason::PausedByYou)));
        assert!(run.autopilot.as_ref().unwrap().waiting.is_none(), "no waiting sentence while off");
        assert_eq!(run.events.last().unwrap().kind, "stop", "the line is still logged");
        // A manual run that never had autopilot stays stopped too.
        let (_dir2, mut manual) = self::store("note_stop_manual");
        let planner = manual.create_draft_tab(&role("role_planner"), "/tmp/p", true, None).unwrap();
        manual.set_tab_chain(&planner, Some(chain(1, None)), None).unwrap();
        note(&mut manual, "ee_f", None, "Autopilot stopped", None, true, None).unwrap();
        let run = manual.pipeline_run_by_id("ee_f").unwrap();
        assert_eq!((run.status, run.stop_reason), (RunStatus::Stopped, None));
    }

    #[test]
    fn turning_autopilot_off_stops_the_run_and_on_runs_it() {
        let (_dir, mut store) = store("autopilot_toggle");
        let planner = store.create_draft_tab(&role("role_planner"), "/tmp/p", true, None).unwrap();
        store.set_tab_chain(&planner, Some(chain(1, None)), None).unwrap();
        assert!(set_autopilot(&mut store, "ee_f", true).unwrap());
        assert!(!set_autopilot(&mut store, "ee_f", true).unwrap(), "already on: nothing to do");
        let run = store.pipeline_run_by_id("ee_f").unwrap();
        assert_eq!((run.status, run.stop_reason), (RunStatus::Running, None));
        waiting_on(&mut store, "waiting");
        assert!(set_autopilot(&mut store, "ee_f", false).unwrap());
        let run = store.pipeline_run_by_id("ee_f").unwrap();
        assert_eq!((run.status, run.stop_reason), (RunStatus::Stopped, Some(StopReason::PausedByYou)));
        assert!(run.autopilot.as_ref().unwrap().waiting.is_none());
        assert_eq!(run.events.last().unwrap().summary, "Autopilot off");
        assert_eq!(run.events.last().unwrap().outcome.as_deref(), Some("paused_by_you"));
    }

    #[test]
    fn promoting_a_plan_records_the_round_it_was_approved_in() {
        let (_dir, mut store) = store("promote_round");
        let planner = store.create_draft_tab(&role("role_planner"), "/tmp/p", true, None).unwrap();
        store.set_tab_chain(&planner, Some(chain(1, None)), None).unwrap();
        let implementer = store.create_draft_tab(&role("role_implementer"), "/tmp/p", true, None).unwrap();
        store.set_tab_chain(&implementer, Some(chain(3, None)), Some("plan")).unwrap();
        store.pipeline_run_by_id_mut("ee_f").unwrap().round = 2;
        store.pipeline_promote_plan("ee_f", "the plan").unwrap();
        let run = store.pipeline_run_by_id("ee_f").unwrap();
        let approved = run.events.last().unwrap();
        assert_eq!(approved.outcome.as_deref(), Some("planApproved"));
        assert_eq!(approved.round, 2);
        assert_eq!(run.approved_plan.as_deref(), Some("the plan"));
    }
}
