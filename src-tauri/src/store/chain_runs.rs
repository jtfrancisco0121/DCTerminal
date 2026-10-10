//! One `PipelineRun` per Eagle-Eye chain (run id = chain id). Tagging a tab
//! with a chain records that stage's tab, and the hand-off text, on the run.
//! The overview reads it. Nothing here starts a session.

use crate::store::state_types::{
    pipeline_stages, run_kind_for_chain, window_matches, ChainRef, PipelineRun, StageHandoff,
    StageVerdict,
};
use crate::store::StateStore;
use chrono::{DateTime, Utc};
use std::collections::{HashMap, HashSet};

/// Runs kept at startup besides those that still have a tab.
pub const KEEP_RECENT_RUNS: usize = 50;

/// "Title\n\nRequest" from a step-1 form. Planner uses `request`,
/// Implementer uses `description`.
fn request_from_answers(answers: &HashMap<String, String>) -> Option<String> {
    let pick = |key: &str| {
        answers
            .get(key)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    };
    let body = pick("request").or_else(|| pick("description"));
    match (pick("title"), body) {
        (Some(title), Some(body)) => Some(format!("{title}\n\n{body}")),
        (title, body) => body.or(title),
    }
}

fn recency(run: &PipelineRun) -> i64 {
    run.updated_at
        .as_deref()
        .unwrap_or(&run.created_at)
        .parse::<DateTime<Utc>>()
        .map(|at| at.timestamp_millis())
        .unwrap_or(0)
}

impl StateStore {
    /// The run for a chain, if one was recorded.
    pub fn chain_run_id(&self, chain_id: &str) -> Option<String> {
        self.data
            .pipeline_runs
            .iter()
            .find(|run| run.id == chain_id || run.chain_id.as_deref() == Some(chain_id))
            .map(|run| run.id.clone())
    }

    /// Put `tab_id` on its chain's run at the chain's step (creating the
    /// run at any step, so chains from before runs existed still get one).
    /// Does not save; the caller does.
    pub(crate) fn record_chain_step(
        &mut self,
        tab_id: &str,
        chain: &ChainRef,
        handoff_text: Option<&str>,
    ) {
        let Some(kind) = run_kind_for_chain(&chain.kind) else {
            return;
        };
        let stages = pipeline_stages(kind);
        let Some(index) = (chain.step as usize).checked_sub(1) else {
            return;
        };
        let Some(&(stage_id, role_id)) = stages.get(index) else {
            return;
        };
        let cwd = self
            .tab_by_id(tab_id)
            .map(|tab| tab.cwd.clone())
            .unwrap_or_default();
        let now = Utc::now().to_rfc3339();
        let run_id = match self.chain_run_id(&chain.chain_id) {
            Some(id) => id,
            None => {
                self.data.pipeline_runs.push(PipelineRun {
                    id: chain.chain_id.clone(),
                    kind: kind.to_string(),
                    cwd,
                    stage: stage_id.to_string(),
                    overview_tab_id: String::new(),
                    tab_ids: HashMap::new(),
                    candidate_plan: None,
                    approved_plan: None,
                    original_request: None,
                    created_at: now.clone(),
                    chain_id: Some(chain.chain_id.clone()),
                    handoffs: HashMap::new(),
                    updated_at: None,
                    round: chain.round.max(1),
                    verdicts: Vec::new(),
                });
                chain.chain_id.clone()
            }
        };
        let Some(run) = self.pipeline_run_by_id_mut(&run_id) else {
            return;
        };
        run.tab_ids.insert(role_id.to_string(), tab_id.to_string());
        let current = stages.iter().position(|(id, _)| *id == run.stage);
        if current.is_none_or(|at| index >= at) {
            run.stage = stage_id.to_string();
        }
        if let Some(text) = handoff_text.map(str::trim).filter(|text| !text.is_empty()) {
            run.handoffs.insert(
                role_id.to_string(),
                StageHandoff {
                    text: text.to_string(),
                    at: now.clone(),
                },
            );
        }
        run.updated_at = Some(now);
        if run.original_request.is_none() {
            let request = self.chain_original_request(&run_id);
            if let Some(run) = self.pipeline_run_by_id_mut(&run_id) {
                run.original_request = request;
            }
        }
    }

    /// A reviewer sends its round back to an earlier stage (`target_tab_id`,
    /// reused or newly opened). Records the reviewer's verdict for the round
    /// ending, starts the next round on every tab of the chain, and tags the
    /// target with its stage. Returns the target's chain. Saves.
    pub fn chain_loop_back(
        &mut self,
        chain_id: &str,
        reviewer_role_id: &str,
        target_tab_id: &str,
        verdict: Option<&str>,
        handoff_text: Option<&str>,
    ) -> Result<ChainRef, String> {
        let target_role = self
            .tab_by_id(target_tab_id)
            .map(|tab| tab.role_id.clone())
            .ok_or_else(|| format!("unknown tab: {target_tab_id}"))?;
        let run_id = self.ensure_chain_run(chain_id)?;
        let run = self
            .pipeline_run_by_id_mut(&run_id)
            .ok_or_else(|| format!("unknown pipeline run: {run_id}"))?;
        let stages = pipeline_stages(&run.kind);
        let position = |role: &str| stages.iter().position(|(_, id)| *id == role);
        let (Some(target), Some(reviewer)) = (position(&target_role), position(reviewer_role_id))
        else {
            return Err("That hand-off is not a loop-back on this chain.".to_string());
        };
        if target >= reviewer {
            return Err("That hand-off is not a loop-back on this chain.".to_string());
        }
        let now = Utc::now().to_rfc3339();
        let ending = run.round.max(1);
        run.verdicts.push(StageVerdict {
            role_id: reviewer_role_id.to_string(),
            round: ending,
            verdict: verdict.map(str::trim).filter(|v| !v.is_empty()).map(str::to_string),
            at: now,
        });
        run.round = ending + 1;
        run.stage = stages[target].0.to_string();
        let (kind, total) = if run.kind == "execute" {
            ("eagle2", 2)
        } else {
            ("eagle1", 4)
        };
        let chain = ChainRef {
            chain_id: chain_id.to_string(),
            kind: kind.to_string(),
            step: target as u32 + 1,
            total,
            round: run.round,
        };
        for tab in self.data.tabs.iter_mut() {
            if let Some(tagged) = tab.chain.as_mut().filter(|c| c.chain_id == chain_id) {
                tagged.round = chain.round;
            }
        }
        if let Some(tab) = self.data.tabs.iter_mut().find(|t| t.id == target_tab_id) {
            tab.chain = Some(chain.clone());
        }
        self.record_chain_step(target_tab_id, &chain, handoff_text);
        self.save()?;
        Ok(chain)
    }

    /// The step-1 tab's request, read from its form (open or closed tab).
    pub fn chain_original_request(&self, run_id: &str) -> Option<String> {
        let run = self.pipeline_run_by_id(run_id)?;
        if let Some(request) = run.original_request.as_ref() {
            return Some(request.clone());
        }
        request_from_answers(self.chain_first_answers(run_id)?)
    }

    /// The step-1 form's task type. Stages whose form has no such field
    /// (Plan Reviewer) do not pass it on, so later stages read it here.
    pub fn chain_task_type(&self, run_id: &str) -> Option<String> {
        self.chain_first_answers(run_id)?
            .get("taskType")
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    }

    /// Form answers of the run's step-1 tab (open or closed tab).
    fn chain_first_answers(&self, run_id: &str) -> Option<&HashMap<String, String>> {
        let run = self.pipeline_run_by_id(run_id)?;
        let (_, first_role) = pipeline_stages(&run.kind).first()?;
        let tab_id = run.tab_ids.get(*first_role)?;
        self.tab_by_id(tab_id).map(|tab| &tab.answers).or_else(|| {
            self.data
                .closed_tabs
                .iter()
                .find(|tab| &tab.id == tab_id)
                .map(|tab| &tab.answers)
        })
    }

    /// Chain (or pipeline run) whose overview lists `tab_id`.
    pub fn overview_run_for_tab(&self, tab_id: &str) -> Option<String> {
        if let Some(chain) = self.tab_by_id(tab_id).and_then(|tab| tab.chain.as_ref()) {
            return Some(chain.chain_id.clone());
        }
        self.data
            .pipeline_runs
            .iter()
            .find(|run| run.tab_ids.values().any(|id| id == tab_id))
            .map(|run| run.id.clone())
    }

    /// Run for `chain_id`, rebuilt from the tabs on that chain when none
    /// was recorded yet.
    pub fn ensure_chain_run(&mut self, chain_id: &str) -> Result<String, String> {
        if let Some(id) = self.chain_run_id(chain_id) {
            return Ok(id);
        }
        let mut tagged: Vec<(String, ChainRef)> = self
            .data
            .tabs
            .iter()
            .filter_map(|tab| {
                tab.chain
                    .as_ref()
                    .filter(|chain| chain.chain_id == chain_id)
                    .map(|chain| (tab.id.clone(), chain.clone()))
            })
            .collect();
        tagged.sort_by_key(|(_, chain)| chain.step);
        for (tab_id, chain) in &tagged {
            self.record_chain_step(tab_id, chain, None);
        }
        self.chain_run_id(chain_id)
            .ok_or_else(|| "No open tab is on this Eagle-Eye chain.".to_string())
    }

    /// Show the chain's overview tab in the current window, opening one
    /// when it has none here. Returns the overview tab id.
    pub fn open_chain_overview(&mut self, chain_id: &str) -> Result<String, String> {
        let run_id = self.ensure_chain_run(chain_id)?;
        let (existing, cwd, kind) = {
            let run = self
                .pipeline_run_by_id(&run_id)
                .ok_or_else(|| format!("unknown pipeline run: {run_id}"))?;
            (run.overview_tab_id.clone(), run.cwd.clone(), run.kind.clone())
        };
        let window = self.focus_window().to_string();
        let reusable = self
            .tab_by_id(&existing)
            .is_some_and(|tab| window_matches(&tab.window_id, &window));
        if reusable {
            self.set_active_tab(&existing)?;
            return Ok(existing);
        }
        let title = if kind == "execute" {
            "Eagle-Eye 2 · overview"
        } else {
            "Eagle-Eye 1 · overview"
        };
        let tab_id = self.create_pipeline_overview_tab(&cwd, &run_id, title)?;
        if let Some(run) = self.pipeline_run_by_id_mut(&run_id) {
            run.overview_tab_id = tab_id.clone();
        }
        self.save()?;
        Ok(tab_id)
    }

    /// Keep runs that still have a tab (open or closed) plus the
    /// `KEEP_RECENT_RUNS` most recent. True when something was dropped.
    pub fn prune_pipeline_runs(&mut self) -> bool {
        let tab_ids: HashSet<&str> = self
            .data
            .tabs
            .iter()
            .map(|tab| tab.id.as_str())
            .chain(self.data.closed_tabs.iter().map(|tab| tab.id.as_str()))
            .collect();
        // A tab can still be on a run that no longer lists it (a loop-back
        // put a newer tab in its stage slot), or point at it as its overview.
        let referenced: HashSet<&str> = self
            .data
            .tabs
            .iter()
            .flat_map(|tab| {
                [
                    tab.chain.as_ref().map(|chain| chain.chain_id.as_str()),
                    tab.pipeline_run_id.as_deref(),
                ]
            })
            .chain(self.data.closed_tabs.iter().flat_map(|tab| {
                [
                    tab.chain.as_ref().map(|chain| chain.chain_id.as_str()),
                    tab.pipeline_run_id.as_deref(),
                ]
            }))
            .flatten()
            .collect();
        let mut order: Vec<(usize, i64)> = self
            .data
            .pipeline_runs
            .iter()
            .enumerate()
            .map(|(i, run)| (i, recency(run)))
            .collect();
        order.sort_by_key(|entry| std::cmp::Reverse(entry.1));
        let recent: HashSet<usize> = order
            .iter()
            .take(KEEP_RECENT_RUNS)
            .map(|(i, _)| *i)
            .collect();
        let keep: Vec<bool> = self
            .data
            .pipeline_runs
            .iter()
            .enumerate()
            .map(|(i, run)| {
                recent.contains(&i)
                    || referenced.contains(run.id.as_str())
                    || run
                        .chain_id
                        .as_deref()
                        .is_some_and(|id| referenced.contains(id))
                    || tab_ids.contains(run.overview_tab_id.as_str())
                    || run.tab_ids.values().any(|id| tab_ids.contains(id.as_str()))
            })
            .collect();
        let before = self.data.pipeline_runs.len();
        let mut flags = keep.into_iter();
        self.data
            .pipeline_runs
            .retain(|_| flags.next().unwrap_or(true));
        self.data.pipeline_runs.len() != before
    }
}

#[cfg(test)]
mod tests {
    use super::KEEP_RECENT_RUNS;
    use crate::roles::Role;
    use crate::store::state_types::{AppStateFile, ChainRef, PipelineRun, MAIN_WINDOW_ID};
    use crate::store::StateStore;
    use chrono::{Duration, Utc};
    use std::collections::HashMap;
    use std::path::PathBuf;

    fn temp_path(name: &str) -> PathBuf {
        let dir = crate::test_support::test_root().join(format!(
            "dct_chain_runs_{name}_{}",
            Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("state.json")
    }

    fn store(name: &str) -> StateStore {
        StateStore {
            path: temp_path(name),
            data: AppStateFile::default(),
            new_tab_provider: crate::provider::ProviderId::DEFAULT,
            draft_window: MAIN_WINDOW_ID.to_string(),
        }
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

    fn chain(id: &str, kind: &str, step: u32) -> ChainRef {
        ChainRef {
            chain_id: id.to_string(),
            kind: kind.to_string(),
            step,
            total: if kind == "eagle1" { 4 } else { 2 },
            round: 1,
        }
    }

    fn old_run(id: &str, tab: &str, days_ago: i64) -> PipelineRun {
        PipelineRun {
            id: id.to_string(),
            kind: "full".to_string(),
            cwd: "/tmp/p".to_string(),
            stage: "planner".to_string(),
            overview_tab_id: String::new(),
            tab_ids: HashMap::from([("role_planner".to_string(), tab.to_string())]),
            candidate_plan: None,
            approved_plan: None,
            original_request: None,
            created_at: (Utc::now() - Duration::days(days_ago)).to_rfc3339(),
            chain_id: None,
            handoffs: HashMap::new(),
            updated_at: None,
            round: 1,
            verdicts: Vec::new(),
        }
    }

    #[test]
    fn starting_a_chain_creates_a_run_keyed_by_chain_id() {
        let mut store = store("start");
        let planner = store
            .create_draft_tab(&role("role_planner"), "/tmp/p", true, None)
            .unwrap();
        if let Some(tab) = store.data.tabs.iter_mut().find(|t| t.id == planner) {
            tab.answers.insert("title".into(), "Fix login".into());
            tab.answers.insert("request".into(), "Users get logged out".into());
            tab.answers.insert("taskType".into(), "Bug".into());
        }
        store
            .set_tab_chain(&planner, Some(chain("ee_1", "eagle1", 1)), None)
            .unwrap();
        let run = store.pipeline_run_by_id("ee_1").unwrap();
        assert_eq!(run.kind, "full");
        assert_eq!(run.chain_id.as_deref(), Some("ee_1"));
        assert_eq!(run.stage, "planner");
        assert_eq!(run.tab_ids.get("role_planner"), Some(&planner));
        assert_eq!(
            run.original_request.as_deref(),
            Some("Fix login\n\nUsers get logged out")
        );
        assert_eq!(store.chain_task_type("ee_1").as_deref(), Some("Bug"));
        assert_eq!(store.overview_run_for_tab(&planner).as_deref(), Some("ee_1"));

        let implementer = store
            .create_draft_tab(&role("role_implementer"), "/tmp/p", true, None)
            .unwrap();
        store
            .set_tab_chain(&implementer, Some(chain("ee_2", "eagle2", 1)), None)
            .unwrap();
        assert_eq!(store.pipeline_run_by_id("ee_2").unwrap().kind, "execute");
        // Tagging the same tab again reuses the run.
        store
            .set_tab_chain(&planner, Some(chain("ee_1", "eagle1", 1)), None)
            .unwrap();
        assert_eq!(store.data.pipeline_runs.len(), 2);
    }

    #[test]
    fn hand_offs_record_tab_and_text_through_the_pr_reviewer_stage() {
        let mut store = store("handoff");
        let ids: Vec<String> = [
            "role_planner",
            "role_plan_reviewer",
            "role_implementer",
            "role_pr_reviewer",
        ]
        .iter()
        .map(|id| store.create_draft_tab(&role(id), "/tmp/p", true, None).unwrap())
        .collect();
        store
            .set_tab_chain(&ids[0], Some(chain("ee_9", "eagle1", 1)), None)
            .unwrap();
        for (i, text) in ["the plan", "reviewed plan", "the report"].iter().enumerate() {
            store
                .set_tab_chain(
                    &ids[i + 1],
                    Some(chain("ee_9", "eagle1", i as u32 + 2)),
                    Some(text),
                )
                .unwrap();
        }
        let run = store.pipeline_run_by_id("ee_9").unwrap();
        assert_eq!(run.stage, "pr_reviewer");
        assert_eq!(run.tab_ids.len(), 4);
        assert_eq!(run.tab_ids.get("role_pr_reviewer"), Some(&ids[3]));
        assert_eq!(run.handoffs["role_plan_reviewer"].text, "the plan");
        assert_eq!(run.handoffs["role_pr_reviewer"].text, "the report");
        assert!(!run.handoffs.contains_key("role_planner"));
        // Saved to disk too.
        let loaded = StateStore::open_path(store.path.clone()).unwrap();
        assert_eq!(
            loaded.pipeline_run_by_id("ee_9").unwrap().handoffs.len(),
            3
        );
    }

    #[test]
    fn loop_backs_bump_the_round_and_keep_each_verdict() {
        let mut store = store("loop_back");
        let ids: Vec<String> = [
            "role_planner",
            "role_plan_reviewer",
            "role_implementer",
            "role_pr_reviewer",
        ]
        .iter()
        .map(|id| store.create_draft_tab(&role(id), "/tmp/p", true, None).unwrap())
        .collect();
        for (i, id) in ids.iter().enumerate().take(2) {
            store
                .set_tab_chain(id, Some(chain("ee_5", "eagle1", i as u32 + 1)), None)
                .unwrap();
        }
        assert_eq!(store.pipeline_run_by_id("ee_5").unwrap().round, 1);

        // Plan Reviewer → the same Planner tab.
        let back = store
            .chain_loop_back("ee_5", "role_plan_reviewer", &ids[0], Some("REQUIRES REVISION"), Some("fix it"))
            .unwrap();
        assert_eq!((back.step, back.round), (1, 2));
        let run = store.pipeline_run_by_id("ee_5").unwrap();
        assert_eq!((run.round, run.stage.as_str()), (2, "planner"));
        assert_eq!(run.handoffs["role_planner"].text, "fix it");
        assert_eq!(run.verdicts.len(), 1);
        assert_eq!(run.verdicts[0].role_id, "role_plan_reviewer");
        assert_eq!((run.verdicts[0].round, run.verdicts[0].verdict.as_deref()), (1, Some("REQUIRES REVISION")));
        // Every tab on the chain moves to round 2.
        assert!(store.data.tabs[..2].iter().all(|t| t.chain.as_ref().unwrap().round == 2));

        // Later stages, then PR Reviewer → a new Implementer tab (the old one is gone).
        for (i, id) in ids.iter().enumerate().skip(1) {
            let mut next = chain("ee_5", "eagle1", i as u32 + 1);
            next.round = 2;
            store.set_tab_chain(id, Some(next), None).unwrap();
        }
        let fresh = store
            .create_draft_tab(&role("role_implementer"), "/tmp/p", true, None)
            .unwrap();
        let back = store
            .chain_loop_back("ee_5", "role_pr_reviewer", &fresh, None, None)
            .unwrap();
        assert_eq!((back.step, back.round, back.total), (3, 3, 4));
        let run = store.pipeline_run_by_id("ee_5").unwrap();
        assert_eq!(run.round, 3);
        assert_eq!(run.stage, "implementer");
        assert_eq!(run.tab_ids.get("role_implementer"), Some(&fresh));
        assert_eq!(run.verdicts[1].round, 2);
        assert!(run.verdicts[1].verdict.is_none());
        assert_eq!(store.tab_by_id(&fresh).unwrap().chain, Some(back));

        // Only reviewer → earlier stage counts as a loop-back.
        assert!(store
            .chain_loop_back("ee_5", "role_planner", &ids[3], None, None)
            .is_err());
        // Saved, and round 1 stays off the wire.
        let loaded = StateStore::open_path(store.path.clone()).unwrap();
        assert_eq!(loaded.pipeline_run_by_id("ee_5").unwrap().verdicts.len(), 2);
        let json = serde_json::to_string(&chain("ee_5", "eagle1", 1)).unwrap();
        assert!(!json.contains("round"));
    }

    #[test]
    fn overview_tab_is_created_once_and_rebuilt_for_untracked_chains() {
        let mut store = store("overview");
        let implementer = store
            .create_draft_tab(&role("role_implementer"), "/tmp/p", true, None)
            .unwrap();
        // A chain tagged before runs existed: no run on file.
        store.data.tabs[0].chain = Some(chain("ee_old", "eagle2", 1));
        let overview = store.open_chain_overview("ee_old").unwrap();
        let tab = store.tab_by_id(&overview).unwrap();
        assert_eq!(tab.kind, "pipeline_overview");
        assert_eq!(tab.pipeline_run_id.as_deref(), Some("ee_old"));
        let run = store.pipeline_run_by_id("ee_old").unwrap();
        assert_eq!(run.overview_tab_id, overview);
        assert_eq!(run.tab_ids.get("role_implementer"), Some(&implementer));
        assert_eq!(store.open_chain_overview("ee_old").unwrap(), overview);
        assert!(store.open_chain_overview("ee_missing").is_err());
    }

    #[test]
    fn prune_keeps_runs_with_tabs_and_the_most_recent() {
        let mut store = store("prune");
        let live = store
            .create_draft_tab(&role("role_planner"), "/tmp/p", true, None)
            .unwrap();
        store.data.pipeline_runs.push(old_run("ancient_live", &live, 400));
        for i in 0..KEEP_RECENT_RUNS + 5 {
            store
                .data
                .pipeline_runs
                .push(old_run(&format!("run_{i}"), "gone", i as i64 + 1));
        }
        assert!(store.prune_pipeline_runs());
        assert_eq!(store.data.pipeline_runs.len(), KEEP_RECENT_RUNS + 1);
        assert!(store.pipeline_run_by_id("ancient_live").is_some());
        assert!(store.pipeline_run_by_id("run_0").is_some());
        assert!(store.pipeline_run_by_id(&format!("run_{}", KEEP_RECENT_RUNS + 4)).is_none());
        assert!(!store.prune_pipeline_runs());
    }

    /// A Planner and Plan Reviewer on `ee_p`, reviewed once (round 2, one
    /// verdict), the Planner running with an ACP session. Saved.
    fn reviewed_chain(name: &str) -> (StateStore, String, String) {
        let mut store = store(name);
        let planner = store
            .create_draft_tab(&role("role_planner"), "/tmp/p", true, None)
            .unwrap();
        let reviewer = store
            .create_draft_tab(&role("role_plan_reviewer"), "/tmp/p", true, None)
            .unwrap();
        store
            .set_tab_chain(&planner, Some(chain("ee_p", "eagle1", 1)), None)
            .unwrap();
        store
            .set_tab_chain(&reviewer, Some(chain("ee_p", "eagle1", 2)), Some("the plan"))
            .unwrap();
        store
            .chain_loop_back("ee_p", "role_plan_reviewer", &planner, Some("REVISE"), Some("fix"))
            .unwrap();
        store
            .promote_tab_to_running(
                Some(&planner),
                &role("role_planner"),
                &HashMap::from([("cwd".to_string(), "/tmp/p".to_string())]),
                "/tmp/p",
                "prompt",
                crate::store::TabSessionRef {
                    acp_session_id: "sess-planner".into(),
                    mode_id: "plan".into(),
                    injection_pending: false,
                    injected_at: None,
                },
                crate::provider::ProviderId::Claude,
            )
            .unwrap();
        (store, planner, reviewer)
    }

    fn assert_chain_intact(store: &StateStore, planner: &str, reviewer: &str) {
        let tab = store.tab_by_id(planner).expect("planner tab");
        let tag = tab.chain.as_ref().expect("chain tag");
        assert_eq!((tag.chain_id.as_str(), tag.step, tag.round), ("ee_p", 1, 2));
        // Continue (session/load) needs the ACP session id after a restart.
        assert_eq!(
            tab.session.as_ref().map(|s| s.acp_session_id.as_str()),
            Some("sess-planner")
        );
        assert_eq!(store.tab_by_id(reviewer).unwrap().chain.as_ref().unwrap().round, 2);
        let run = store.pipeline_run_by_id("ee_p").expect("run");
        assert_eq!(run.round, 2);
        assert_eq!(run.verdicts.len(), 1);
        assert_eq!(run.verdicts[0].verdict.as_deref(), Some("REVISE"));
        assert_eq!(run.handoffs["role_plan_reviewer"].text, "the plan");
    }

    #[test]
    fn chain_tags_rounds_and_verdicts_survive_restart_corruption_and_a_lost_file() {
        let (mut store, planner, reviewer) = reviewed_chain("persist");
        let path = store.path.clone();

        // App restart: running tabs become idle, the chain and session stay.
        let mut reopened = StateStore::open_path(path.clone()).unwrap();
        reopened.reconcile_stale_running_tabs().unwrap();
        assert_eq!(reopened.tab_by_id(&planner).unwrap().phase, "awaitingInput");
        assert_chain_intact(&reopened, &planner, &reviewer);

        // One more save so state.json.bak holds the reviewed chain too.
        store.save().unwrap();
        std::fs::write(&path, b"{\"schemaVersion\": 1, \"tabs\": [").unwrap();
        let recovered = StateStore::open_path(path.clone()).unwrap();
        assert_chain_intact(&recovered, &planner, &reviewer);

        // The damaged file was moved aside. Quitting before any save must
        // not leave the next start with an empty state.
        assert!(!path.exists());
        let again = StateStore::open_path(path.clone()).unwrap();
        assert_chain_intact(&again, &planner, &reviewer);

        // A save interrupted after the new copy was written but before it
        // was renamed in: the finished `.tmp` is the newest state.
        let mut newer = again;
        newer.set_tab_label(&planner, "Renamed").unwrap();
        std::fs::rename(&path, path.with_extension("json.tmp")).unwrap();
        let from_tmp = StateStore::open_path(path.clone()).unwrap();
        assert_eq!(from_tmp.tab_by_id(&planner).unwrap().label, "Renamed");
        assert_chain_intact(&from_tmp, &planner, &reviewer);
    }

    #[test]
    fn closing_chained_tabs_keeps_the_run_and_a_reopened_overview_still_renders() {
        let (mut store, planner, reviewer) = reviewed_chain("close");
        let overview = store.open_chain_overview("ee_p").unwrap();
        store.close_tab(&reviewer).unwrap();
        store.close_tab(&overview).unwrap();
        let run = store.pipeline_run_by_id("ee_p").expect("run kept");
        assert_eq!(run.tab_ids.get("role_plan_reviewer"), Some(&reviewer));
        assert!(store.tab_by_id(&planner).is_some());

        let reopened = store.reopen_closed_id(Some(&overview), None).unwrap();
        assert_eq!(reopened.kind, "pipeline_overview");
        assert_eq!(reopened.pipeline_run_id.as_deref(), Some("ee_p"));
        let reviewer_back = store.reopen_closed_id(Some(&reviewer), None).unwrap();
        assert_eq!(reviewer_back.chain.as_ref().map(|c| c.round), Some(2));

        // After a restart too.
        store.close_tab(&overview).unwrap();
        let mut loaded = StateStore::open_path(store.path.clone()).unwrap();
        let again = loaded.reopen_closed_id(Some(&overview), None).unwrap();
        assert_eq!(again.pipeline_run_id.as_deref(), Some("ee_p"));
    }

    #[test]
    fn prune_never_drops_a_run_a_tab_still_points_at() {
        let mut store = store("prune_refs");
        // Only a chain tag points at this run (its stage slot moved on to a
        // tab that has since gone).
        let tagged = store
            .create_draft_tab(&role("role_planner"), "/tmp/p", true, None)
            .unwrap();
        store.data.tabs[0].chain = Some(chain("ee_tagged", "eagle1", 1));
        let mut by_tag = old_run("ee_tagged", "tab_gone", 500);
        by_tag.chain_id = Some("ee_tagged".into());
        store.data.pipeline_runs.push(by_tag);
        // Only a closed overview tab points at this one.
        store.data.pipeline_runs.push(old_run("run_overview", "tab_gone2", 500));
        let overview = store
            .create_pipeline_overview_tab("/tmp/p", "run_overview", "Pipeline · Plan")
            .unwrap();
        store.close_tab(&overview).unwrap();
        for i in 0..KEEP_RECENT_RUNS + 3 {
            store
                .data
                .pipeline_runs
                .push(old_run(&format!("run_{i}"), "gone", i as i64 + 1));
        }
        assert!(store.prune_pipeline_runs());
        assert!(store.pipeline_run_by_id("ee_tagged").is_some(), "tab {tagged} is on it");
        assert!(store.pipeline_run_by_id("run_overview").is_some());
        assert_eq!(store.data.pipeline_runs.len(), KEEP_RECENT_RUNS + 2);
    }

    #[test]
    fn legacy_state_without_chain_fields_still_loads() {
        let path = temp_path("legacy");
        let legacy = r##"{
          "schemaVersion": 1,
          "activeTabId": null,
          "tabs": [],
          "migrations": { "claudeFirst": true, "windows": true },
          "pipelineRuns": [{
            "id": "run_a",
            "kind": "full",
            "cwd": "/tmp/p",
            "stage": "planner",
            "overviewTabId": "tab_x",
            "tabIds": { "role_planner": "tab_y" },
            "createdAt": "2026-01-01T00:00:00+00:00"
          }]
        }"##;
        std::fs::write(&path, legacy).unwrap();
        let store = StateStore::open_path(path).unwrap();
        let run = store.pipeline_run_by_id("run_a").unwrap();
        assert!(run.chain_id.is_none());
        assert!(run.handoffs.is_empty());
        assert!(run.updated_at.is_none());
        assert_eq!(run.round, 1);
        assert!(run.verdicts.is_empty());
        assert_eq!(run.overview_tab_id, "tab_x");
        let tag: ChainRef =
            serde_json::from_str(r#"{"chainId":"ee_1","kind":"eagle1","step":2,"total":4}"#).unwrap();
        assert_eq!(tag.round, 1);
    }
}
