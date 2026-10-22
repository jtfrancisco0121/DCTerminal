//! W1: the run's repos, and one-task plans in a workspace folder.
//!
//! A run started in a workspace (a folder of repos that is not a git repo
//! itself) has no home repo, so its Implementer never runs in the run's own
//! folder. A plan of two or more pull requests fans out from the chain
//! overview, as before. A plan with one pull request goes through the same
//! fan-out path with one lane: when the Implementer opens with no lane, the
//! actor makes a worktree for the task in its repo, records the lane (with
//! its repo, so its check is the repo's) and opens the Implementer there.

use super::{lock, Actor, Host, Placed};
use crate::commands::pipeline::{fan_out_lanes, LaneInput};
use crate::store::ChainRef;
use crate::pipelines::{StageDef, StageKind};
use crate::workspace_repos::WorkspaceRepos;
use std::path::Path;

/// Where an Implementer with no lane opens in a workspace run.
pub(super) struct WorkspaceLane {
    pub lane: String,
    /// The worktree made in the task's repo.
    pub cwd: String,
    /// The worktree's draft tab, which the Implementer opens in.
    pub tab_id: String,
}

/// A git branch name for a lane's worktree, as the frontend's `laneBranch`:
/// `ee_1760…-pr1`.
pub(super) fn lane_branch(run_id: &str, lane_id: &str) -> String {
    let mut out = String::new();
    let mut gap = false;
    for c in format!("{run_id}-{lane_id}").chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '-') {
            out.push(c);
            gap = false;
        } else if !gap {
            out.push('-');
            gap = true;
        }
    }
    out.trim_start_matches('-').to_string()
}

impl<H: Host> Actor<H> {
    /// The run's repos: Settings › Repos, merged with the repos of its start
    /// folder when that is a workspace. The store lock is held only to copy
    /// the folder out.
    pub(super) fn run_repos(&self) -> WorkspaceRepos {
        let cwd = {
            let store = lock(self.host.store());
            store.pipeline_run_by_id(&self.run_id).map(|run| run.cwd.clone()).unwrap_or_default()
        };
        self.host.run_repos(Path::new(cwd.trim()))
    }

    /// Where `target`, the stage after `placed`, opens: `placed`'s lane,
    /// chain and folder, or (W1) a one-task plan's lane and worktree in a
    /// workspace run. As (chain, folder, the tab to open in).
    pub(super) fn in_workspace_lane(
        &mut self,
        placed: &Placed,
        target: &StageDef,
        chain: ChainRef,
    ) -> Result<(ChainRef, String, Option<String>), String> {
        if placed.lane.is_some() {
            return Ok((chain, placed.tab.cwd.clone(), None));
        }
        Ok(match self.workspace_lane(target, &placed.tab.window_id)? {
            Some(found) => (ChainRef { lane: Some(found.lane), ..chain }, found.cwd, Some(found.tab_id)),
            None => (chain, placed.tab.cwd.clone(), None),
        })
    }

    /// `target`, an Implementer about to open with no lane: `Ok(None)` when
    /// the run's folder is not a workspace (it opens where it always did).
    /// In a workspace, a plan with one pull request gets its lane and a
    /// worktree in its repo; any other plan is an error, so the Implementer
    /// never runs in the folder of repos.
    pub(super) fn workspace_lane(&mut self, target: &StageDef, window_id: &str) -> Result<Option<WorkspaceLane>, String> {
        if target.kind() != StageKind::Implementer {
            return Ok(None);
        }
        // A one-lane run whose Implementer did not start last time (its
        // worktree tab is there): that lane and tab again.
        let (cwd, lanes, again) = {
            let store = lock(self.host.store());
            let run = store.pipeline_run_by_id(&self.run_id).ok_or("the run is gone")?;
            let again = match run.lanes.as_slice() {
                [lane] => lane
                    .tab_ids
                    .get(&target.role_id)
                    .and_then(|id| store.tab_by_id(id))
                    .filter(|tab| tab.worktree.is_some())
                    .map(|tab| WorkspaceLane {
                        lane: lane.id.clone(),
                        cwd: tab.cwd.clone(),
                        tab_id: tab.id.clone(),
                    }),
                _ => None,
            };
            (run.cwd.clone(), run.lanes.len(), again)
        };
        let repos = self.host.run_repos(Path::new(cwd.trim()));
        if !repos.workspace {
            return Ok(None);
        }
        if lanes > 0 {
            return Ok(again);
        }
        let tasks = crate::bridge::folder::run_dir(&self.host.runs_root(), &self.run_id)
            .and_then(|dir| crate::bridge::folder::read_tasks(&dir))
            .map(|file| file.tasks)
            .unwrap_or_default();
        let prs: Vec<_> = tasks.iter().filter(|task| !task.manual).collect();
        let task = match prs.as_slice() {
            [task] => *task,
            [] => {
                return Err(format!(
                    "{cwd} is a workspace of repos, not a git repo, and the plan has no pull request naming its repo, \
                     so there is no repo to make the Implementer's worktree in. Send the plan back to the Planner."
                ))
            }
            many => {
                return Err(format!(
                    "{cwd} is a workspace of repos, not a git repo: fan out the plan's {} pull requests from the chain overview, \
                     so each one gets a worktree in its own repo.",
                    many.len()
                ))
            }
        };
        let name = task
            .repo
            .as_deref()
            .ok_or_else(|| format!("{} names no repo, and {cwd} is a workspace of repos: send the plan back to the Planner.", task.id.to_uppercase()))?;
        let repo = crate::store::repos_settings::find_repo(&repos.repos, name)
            .cloned()
            .ok_or_else(|| format!("{} is in the repo \"{name}\", which is not in {cwd} or Settings › Repos.", task.id.to_uppercase()))?;
        let role = self.host.role(&target.role_id).ok_or_else(|| format!("unknown role {}", target.role_id))?;
        // `git worktree add` runs with no lock held.
        let made = crate::worktree::add_worktree(Path::new(&repo.folder), &lane_branch(&self.run_id, &task.id), true, None)
            .map_err(|err| format!("could not make a worktree for {} in {}: {err}", task.id.to_uppercase(), repo.name))?;
        let lane = LaneInput {
            id: task.id.clone(),
            title: format!("{} — {}", task.id.to_uppercase(), task.title),
            depends_on: Vec::new(),
            repo: Some(repo.name.clone()),
        };
        let tab_id = {
            let mut store = lock(self.host.store());
            fan_out_lanes(&mut store, &self.run_id, &target.id, vec![lane], 1)
                .map_err(|err| format!("{err} The worktree {} is left for you to remove.", made.path))?;
            store.bind_window(Some(window_id));
            let tab_id = store.create_worktree_tab(&role, made.clone())?;
            // The lane's tab, as fan-out records it; the hand-on tags it too.
            if let Some(lane) = store.pipeline_run_by_id_mut(&self.run_id).and_then(|run| run.lane_mut(&task.id)) {
                lane.tab_ids.insert(target.role_id.clone(), tab_id.clone());
            }
            store.save()?;
            tab_id
        };
        self.changed();
        Ok(Some(WorkspaceLane {
            lane: task.id.clone(),
            cwd: made.path,
            tab_id,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::lane_branch;

    #[test]
    fn a_lane_branch_is_the_run_and_lane_ids_made_safe() {
        assert_eq!(lane_branch("ee_1760000000100", "pr1"), "ee_1760000000100-pr1");
        assert_eq!(lane_branch("--a b", "c::d"), "a-b-c-d");
    }
}
