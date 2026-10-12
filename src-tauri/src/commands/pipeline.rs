use crate::commands::chain_events::ChainEvents;
use crate::store::{PipelineRun, StateStore};
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
use crate::store::{PipelineStore, RunAutopilot, StageGates};
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
    let def = crate::pipelines::find(&run.kind)
        .ok_or_else(|| format!("unknown pipeline: {}", run.kind))?;
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
/// reported. No store lock is held while the commands run.
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)] // Tauri injects each managed state as its own argument.
pub fn pipeline_run_gates(
    app: tauri::AppHandle,
    run_id: String,
    stage_id: String,
    lane: Option<String>,
    cwd: Option<String>,
    pr_urls: Vec<String>,
    store: State<Mutex<StateStore>>,
) -> Result<Vec<GateResult>, String> {
    let run_id = run_id.trim().to_string();
    let (gates, folder, _) = {
        let store = store.lock().map_err(|e| e.to_string())?;
        stage_gates(&store, &run_id, &stage_id, cwd.as_deref())?
    };
    let results: Vec<GateResult> = gates
        .iter()
        .map(|gate| match gate {
            GateDef::Command { run, timeout_secs } => crate::pipelines::run_command_gate(
                &folder,
                run,
                timeout_secs.map(Duration::from_secs),
            ),
            GateDef::PullRequest => crate::pipelines::run_pull_request_gate(&folder, &pr_urls),
        })
        .collect();
    let mut store = store.lock().map_err(|e| e.to_string())?;
    let run = store
        .pipeline_run_by_id_mut(&run_id)
        .ok_or_else(|| format!("unknown pipeline run: {run_id}"))?;
    let lane = lane.filter(|id| run.lane(id).is_some());
    let lane_tag = lane
        .as_deref()
        .and_then(|id| run.lane(id))
        .map(|l| format!("{}: ", l.title))
        .unwrap_or_default();
    for result in &results {
        run.log(
            "gate",
            Some(&stage_id),
            None,
            format!("{lane_tag}{}: {}", result.label, result.summary),
            (!result.output.is_empty()).then(|| result.output.clone()),
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

/// Turn autopilot on or off for one run. Turning it on clears what it was
/// waiting for; checkpoints already passed stay passed.
#[tauri::command]
pub fn pipeline_set_autopilot(
    app: tauri::AppHandle,
    run_id: String,
    enabled: bool,
    store: State<Mutex<StateStore>>,
) -> Result<(), String> {
    let run_id = run_id.trim().to_string();
    let mut store = store.lock().map_err(|e| e.to_string())?;
    let run = store
        .pipeline_run_by_id_mut(&run_id)
        .ok_or_else(|| format!("unknown pipeline run: {run_id}"))?;
    let autopilot = run.autopilot.get_or_insert_with(RunAutopilot::default);
    if autopilot.enabled == enabled {
        return Ok(());
    }
    autopilot.enabled = enabled;
    autopilot.waiting = None;
    run.log(
        "autopilot",
        None,
        None,
        if enabled { "Autopilot on" } else { "Autopilot off" },
        None,
    );
    store.save()?;
    app.chain_run_updated(&run_id);
    Ok(())
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
    let def = crate::pipelines::find(&run.kind)
        .ok_or_else(|| format!("unknown pipeline: {}", run.kind))?;
    let decision = decide(&def, run, &report);
    store.save()?;
    app.chain_run_updated(&run_id);
    Ok(decision)
}

/// A line the frontend adds to the ledger, e.g. why autopilot could not
/// carry out a decision. `stop` also marks autopilot as waiting for you.
#[tauri::command]
pub fn pipeline_note(
    app: tauri::AppHandle,
    run_id: String,
    stage_id: Option<String>,
    summary: String,
    detail: Option<String>,
    stop: bool,
    store: State<Mutex<StateStore>>,
) -> Result<(), String> {
    let run_id = run_id.trim().to_string();
    let summary: String = summary.trim().chars().take(500).collect();
    if summary.is_empty() {
        return Err("empty note".into());
    }
    let mut store = store.lock().map_err(|e| e.to_string())?;
    let run = store
        .pipeline_run_by_id_mut(&run_id)
        .ok_or_else(|| format!("unknown pipeline run: {run_id}"))?;
    if stop {
        run.autopilot.get_or_insert_with(RunAutopilot::default).waiting = Some(summary.clone());
    }
    run.log(
        if stop { "stop" } else { "note" },
        stage_id.as_deref(),
        None,
        summary,
        detail,
    );
    store.save()?;
    app.chain_run_updated(&run_id);
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
    let def = crate::pipelines::find(&run.kind)
        .ok_or_else(|| format!("unknown pipeline: {}", run.kind))?;
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
    run.log("note", None, None, format!("{title}: {status}"), None);
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

#[cfg(test)]
mod tests {
    use super::{fan_out, set_lane_status, LaneInput};
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
}
