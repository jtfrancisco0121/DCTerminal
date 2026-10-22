//! The merge queue (R3): a round's pull requests per repo, in the order
//! they merge, read-only. You merge, as always (decision E10); this never
//! merges, rebases or pushes, and only reads GitHub through your `gh`.
//!
//! The order in a repo comes from `round.json`'s `mergeOrder` for that
//! repo, then the waves (plans the merge order leaves out, by wave and
//! number), then within a plan its lanes' `dependsOn`. Each pull request's
//! state comes from `gh api repos/{owner}/{repo}/pulls/{n}`: open, draft,
//! merged or closed, its base branch, and whether it is behind its base or
//! conflicts with it. The first pull request in a repo that has not merged
//! is the next to merge, and only once everything before it merged: one
//! merge per repo at a time.

use crate::bridge::folder::{prs_file_name, read_json, RunPrs, RunTasks, TASKS_FILE};
use crate::bridge::round::{PlanStatus, Round};
use crate::github::runner::GhApi;
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::path::Path;

/// The repo a pull request goes in when its task names none and its plan
/// has no single repo: the round's own folder.
pub const HOME_REPO: &str = "this folder";
/// `gh` calls at once, as the GitHub poller makes them.
const GH_WORKERS: usize = 4;

/// One pull request a plan's run reported.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueuePr {
    pub plan_id: String,
    pub repo: String,
    /// The lane (task id) it was built in; `None` for a run with no lanes.
    pub lane: Option<String>,
    /// The lanes it depends on (`dependsOn`).
    pub depends_on: Vec<String>,
    pub url: String,
    pub title: String,
    pub branch: String,
}

/// A place in a repo's queue.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Slot {
    /// A pull request (an index into the `prs` given).
    Pr(usize),
    /// A plan that touches the repo and has no pull request in it yet.
    Missing { plan_id: String, parked: bool },
}

fn plan_number(id: &str) -> u32 {
    id.trim_start_matches("plan").parse().unwrap_or(u32::MAX)
}

fn lane_number(lane: Option<&str>) -> u32 {
    lane.map(|l| l.trim_start_matches("pr").parse().unwrap_or(u32::MAX)).unwrap_or(0)
}

/// Each repo's slots in merge order: the round's `mergeOrder`, then the
/// waves, then each plan's lanes by `dependsOn`.
pub fn order(round: &Round, prs: &[QueuePr]) -> BTreeMap<String, Vec<Slot>> {
    let mut repos: Vec<String> = round.merge_order.keys().cloned().collect();
    for pr in prs {
        if !repos.contains(&pr.repo) {
            repos.push(pr.repo.clone());
        }
    }
    let mut out = BTreeMap::new();
    for repo in repos {
        // The plans in this repo, in merge order.
        let mut plans: Vec<String> = round.merge_order.get(&repo).cloned().unwrap_or_default();
        let mut rest: Vec<(Option<u32>, String)> = round
            .plans
            .iter()
            .filter(|plan| !plans.contains(&plan.id))
            .filter(|plan| {
                (plan.status != PlanStatus::Deferred && plan.repos.contains(&repo))
                    || prs.iter().any(|pr| pr.repo == repo && pr.plan_id == plan.id)
            })
            .map(|plan| (plan.wave, plan.id.clone()))
            .collect();
        // Pull requests of a plan the round does not list come last.
        for pr in prs.iter().filter(|pr| pr.repo == repo) {
            if !plans.contains(&pr.plan_id) && !rest.iter().any(|(_, id)| id == &pr.plan_id) {
                rest.push((None, pr.plan_id.clone()));
            }
        }
        rest.sort_by_key(|(wave, id)| (wave.unwrap_or(u32::MAX), plan_number(id)));
        plans.extend(rest.into_iter().map(|(_, id)| id));
        let mut slots = Vec::new();
        for plan_id in plans {
            let mine: Vec<usize> = (0..prs.len()).filter(|&i| prs[i].repo == repo && prs[i].plan_id == plan_id).collect();
            if mine.is_empty() {
                let status = round.plan(&plan_id).map(|p| p.status);
                if status != Some(PlanStatus::Deferred) {
                    slots.push(Slot::Missing { plan_id, parked: status == Some(PlanStatus::Parked) });
                }
                continue;
            }
            slots.extend(by_depends_on(prs, mine).into_iter().map(Slot::Pr));
        }
        out.insert(repo, slots);
    }
    out
}

/// A plan's pull requests in one repo: each after the lanes it depends on,
/// else by lane number. A circle (the bridge refuses one) keeps lane order.
fn by_depends_on(prs: &[QueuePr], mut left: Vec<usize>) -> Vec<usize> {
    left.sort_by_key(|&i| (lane_number(prs[i].lane.as_deref()), prs[i].url.clone()));
    let mut done: Vec<usize> = Vec::new();
    while !left.is_empty() {
        let ready = left.iter().position(|&i| {
            prs[i]
                .depends_on
                .iter()
                .all(|dep| !left.iter().any(|&j| j != i && prs[j].lane.as_deref() == Some(dep.as_str())))
        });
        let at = ready.unwrap_or(0);
        done.push(left.remove(at));
    }
    done
}

/// What GitHub says about a pull request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrState {
    /// `open`, `closed` or `merged`.
    pub state: String,
    pub draft: bool,
    /// The base branch it merges into.
    pub base: String,
    /// Its own branch.
    pub head: String,
    /// GitHub's `mergeable_state` (`clean`, `behind`, `dirty`, `blocked`, …), when it has worked it out.
    pub mergeable_state: Option<String>,
}

/// `https://github.com/{owner}/{repo}/pull/{n}` → (`owner/repo`, n).
pub fn parse_pr_url(url: &str) -> Option<(String, u64)> {
    let rest = url.trim().strip_prefix("https://github.com/")?;
    let parts: Vec<&str> = rest.split('/').collect();
    if parts.len() < 4 || parts[2] != "pull" {
        return None;
    }
    let valid = |s: &str| {
        !s.is_empty() && !s.chars().all(|c| c == '.') && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    };
    if !valid(parts[0]) || !valid(parts[1]) {
        return None;
    }
    let number = parts[3].split(['#', '?']).next()?.parse().ok()?;
    Some((format!("{}/{}", parts[0], parts[1]), number))
}

/// Reads a `repos/{owner}/{repo}/pulls/{n}` body.
pub fn parse_pr_state(body: &str) -> Option<PrState> {
    let pr: Value = serde_json::from_str(body).ok()?;
    let text = |path: &[&str]| {
        let mut at = &pr;
        for key in path {
            at = &at[*key];
        }
        at.as_str().unwrap_or_default().to_string()
    };
    let merged = pr["merged"] == true || pr["merged_at"].as_str().is_some();
    let state = if merged { "merged".to_string() } else { text(&["state"]) };
    if state.is_empty() {
        return None;
    }
    Some(PrState {
        state,
        draft: pr["draft"] == true,
        base: text(&["base", "ref"]),
        head: text(&["head", "ref"]),
        mergeable_state: pr["mergeable_state"].as_str().map(str::to_string).filter(|s| !s.is_empty()),
    })
}

/// `work` over `items` on up to `workers` threads, results in order.
fn in_parallel<T: Send, R: Send>(items: Vec<T>, workers: usize, work: impl Fn(T) -> R + Sync) -> Vec<R> {
    let count = items.len();
    let queue = std::sync::Mutex::new(items.into_iter().enumerate().collect::<std::collections::VecDeque<_>>());
    let done = std::sync::Mutex::new(Vec::with_capacity(count));
    std::thread::scope(|scope| {
        for _ in 0..workers.min(count).max(1) {
            scope.spawn(|| loop {
                let next = queue.lock().map(|mut q| q.pop_front()).unwrap_or(None);
                let Some((index, item)) = next else { break };
                let result = work(item);
                if let Ok(mut done) = done.lock() {
                    done.push((index, result));
                }
            });
        }
    });
    let mut done = done.into_inner().unwrap_or_default();
    done.sort_by_key(|(index, _)| *index);
    done.into_iter().map(|(_, result)| result).collect()
}

/// Each pull request's state through `gh`, at most [`GH_WORKERS`] calls at once.
pub fn fetch_states(api: &dyn GhApi, urls: Vec<String>) -> HashMap<String, Result<PrState, String>> {
    let results = in_parallel(urls.clone(), GH_WORKERS, |url| {
        let Some((repo, number)) = parse_pr_url(&url) else {
            return Err("not a GitHub pull request link".to_string());
        };
        match api.get(&format!("repos/{repo}/pulls/{number}"), None) {
            Ok(reply) if reply.status == 200 => parse_pr_state(&reply.body).ok_or_else(|| "GitHub's answer could not be read".to_string()),
            Ok(reply) if reply.status == 404 => Err("GitHub does not find it (deleted, or your gh login cannot see it)".to_string()),
            Ok(reply) => Err(format!("GitHub answered {}", reply.status_line())),
            Err(err) => Err(err),
        }
    });
    urls.into_iter().zip(results).collect()
}

/// One place in a repo's queue, as the view shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueEntry {
    pub plan_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wave: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lane: Option<String>,
    /// The pull request's link; none while its plan has none in this repo.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub number: Option<u64>,
    /// `open`, `draft`, `merged`, `closed`, `missing` (no pull request yet),
    /// `parked` (its plan is parked) or `unknown` (GitHub could not be read).
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
    /// The next pull request to merge in this repo.
    pub next: bool,
    pub warnings: Vec<String>,
    /// What it waits for before it is next.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub waits_for: Option<String>,
}

/// One repo's queue.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoQueue {
    pub repo: String,
    pub entries: Vec<QueueEntry>,
}

fn short(pr: &QueuePr, number: Option<u64>) -> String {
    match number {
        Some(n) => format!("{} #{n}", pr.plan_id),
        None => pr.plan_id.clone(),
    }
}

/// The queues with each pull request's state, the next to merge in each
/// repo, and the warnings. `states` maps a link to what `gh` said.
pub fn evaluate(round: &Round, prs: &[QueuePr], states: &HashMap<String, Result<PrState, String>>) -> Vec<RepoQueue> {
    let wave_of = |plan_id: &str| round.plan(plan_id).and_then(|p| p.wave);
    // Branches of the queue's pull requests that merged: a pull request based on one must be retargeted.
    let merged_heads: Vec<&str> = states
        .values()
        .filter_map(|s| s.as_ref().ok())
        .filter(|s| s.state == "merged")
        .map(|s| s.head.as_str())
        .collect();
    order(round, prs)
        .into_iter()
        .map(|(repo, slots)| {
            let mut entries = Vec::new();
            // What holds the rest of the repo: the first slot that has not merged.
            let mut holder: Option<String> = None;
            for slot in slots {
                match slot {
                    Slot::Missing { plan_id, parked } => {
                        let state = if parked { "parked" } else { "missing" };
                        let waits_for = holder.clone();
                        if !parked && holder.is_none() {
                            holder = Some(format!("{plan_id}'s pull request, which it has not opened yet"));
                        }
                        entries.push(QueueEntry {
                            wave: wave_of(&plan_id),
                            title: round.plan(&plan_id).map(|p| p.title.clone()).unwrap_or_default(),
                            plan_id,
                            lane: None,
                            url: None,
                            number: None,
                            state: state.to_string(),
                            base: None,
                            next: false,
                            warnings: Vec::new(),
                            waits_for,
                        });
                    }
                    Slot::Pr(index) => {
                        let pr = &prs[index];
                        let number = parse_pr_url(&pr.url).map(|(_, n)| n);
                        let mut warnings = Vec::new();
                        let (state, base) = match states.get(&pr.url) {
                            Some(Ok(gh)) => {
                                let state = if gh.state == "open" && gh.draft { "draft".to_string() } else { gh.state.clone() };
                                (state, Some(gh.base.clone()))
                            }
                            Some(Err(err)) => {
                                warnings.push(format!("Its state could not be read: {err}."));
                                ("unknown".to_string(), None)
                            }
                            None => ("unknown".to_string(), None),
                        };
                        let gh = states.get(&pr.url).and_then(|s| s.as_ref().ok());
                        let open = state == "open" || state == "draft";
                        if let Some(gh) = gh.filter(|_| open) {
                            if merged_heads.contains(&gh.base.as_str()) {
                                warnings.push(format!(
                                    "Its base branch {} was merged: retarget it to the branch that one merged into, then rebase.",
                                    gh.base
                                ));
                            }
                            match gh.mergeable_state.as_deref() {
                                Some("behind") => warnings.push(format!(
                                    "Its base ({}) has moved on since it was made: rebase it on {} before it merges.",
                                    gh.base, gh.base
                                )),
                                Some("dirty") => warnings.push(format!(
                                    "It conflicts with {}: rebase it on {} and fix the conflicts before it merges.",
                                    gh.base, gh.base
                                )),
                                _ => {}
                            }
                        }
                        let mut next = false;
                        let mut waits_for = None;
                        if open || state == "unknown" {
                            match &holder {
                                Some(first) => waits_for = Some(first.clone()),
                                None => {
                                    next = open;
                                    if state == "draft" {
                                        warnings.push("It is still a draft: mark it ready for review before it merges.".to_string());
                                    }
                                    holder = Some(short(pr, number));
                                }
                            }
                        }
                        entries.push(QueueEntry {
                            plan_id: pr.plan_id.clone(),
                            wave: wave_of(&pr.plan_id),
                            lane: pr.lane.clone(),
                            url: Some(pr.url.clone()),
                            title: pr.title.clone(),
                            number,
                            state,
                            base,
                            next,
                            warnings,
                            waits_for,
                        });
                    }
                }
            }
            RepoQueue { repo, entries }
        })
        .collect()
}

/// The pull requests a plan's run reported (`prs.json`, `prs-<lane>.json`),
/// each with the repo its lane was made in (`tasks.json`), else the plan's
/// one repo, else the round's own folder.
pub fn run_prs(run_dir: &Path, plan_id: &str, plan_repos: &[String]) -> Vec<QueuePr> {
    let tasks: Option<RunTasks> = read_json(&run_dir.join(TASKS_FILE));
    let task = |lane: Option<&str>| tasks.as_ref().and_then(|t| t.task_for(lane));
    let fallback = || match plan_repos {
        [only] => only.clone(),
        _ => HOME_REPO.to_string(),
    };
    let mut lanes: Vec<Option<String>> = vec![None];
    if let Some(tasks) = &tasks {
        lanes.extend(tasks.tasks.iter().map(|t| Some(t.id.clone())));
    }
    let mut out: Vec<QueuePr> = Vec::new();
    for lane in lanes {
        let Some(file) = read_json::<RunPrs>(&run_dir.join(prs_file_name(lane.as_deref()))) else {
            continue;
        };
        for item in file.result.get("prs").and_then(Value::as_array).into_iter().flatten() {
            let text = |key: &str| item.get(key).and_then(Value::as_str).unwrap_or_default().trim().to_string();
            let url = text("url");
            if url.is_empty() || out.iter().any(|pr| pr.url == url) {
                continue;
            }
            let lane = lane.clone().or_else(|| Some(text("lane")).filter(|l| !l.is_empty()));
            let owner = task(lane.as_deref());
            out.push(QueuePr {
                plan_id: plan_id.to_string(),
                repo: owner.and_then(|t| t.repo.clone()).unwrap_or_else(fallback),
                depends_on: owner.map(|t| t.depends_on.clone()).unwrap_or_default(),
                lane,
                title: text("title"),
                branch: text("branch"),
                url,
            });
        }
    }
    out
}

/// What the merge queue reads of a round: its id, the round's copy of
/// `round.json`, and each started plan's run folder and repos. Copied out
/// of the store; the run folders are read after (no lock held).
pub struct QueueInputs {
    pub round_id: String,
    pub round: Round,
    /// (plan id, run folder, the plan's repos).
    pub runs: Vec<(String, std::path::PathBuf, Vec<String>)>,
}

/// The inputs for the round `key` names (its id, its Triage run, or a plan run).
pub fn inputs(store: &crate::store::StateStore, runs_root: &Path, key: &str) -> Option<QueueInputs> {
    let key = key.trim();
    let round = store
        .data
        .rounds
        .iter()
        .find(|round| round.id == key || round.triage_run_id == key || round.plan_of_run(key).is_some())?;
    let dir = super::files::round_dir(&super::files::rounds_root(runs_root), &round.id)?;
    let copy = super::files::read_round_copy(&dir)?;
    let runs = round
        .plans
        .iter()
        .filter_map(|plan| {
            let run_id = plan.run_id.as_deref()?;
            let run_dir = crate::bridge::folder::run_dir(runs_root, run_id)?;
            let repos = copy.round.plan(&plan.plan_id).map(|p| p.repos.clone()).unwrap_or_default();
            Some((plan.plan_id.clone(), run_dir, repos))
        })
        .collect();
    Some(QueueInputs { round_id: round.id.clone(), round: copy.round, runs })
}

/// A round's merge queue, as its view shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeQueueView {
    pub round_id: String,
    pub repos: Vec<RepoQueue>,
    /// When GitHub was read (RFC 3339).
    pub checked_at: String,
}

/// Read every plan run's pull requests, ask GitHub (through `api`, or say
/// why it cannot be asked), and build the queues. Slow: no lock is held.
pub fn build(inputs: QueueInputs, api: Result<&dyn GhApi, String>) -> MergeQueueView {
    let prs: Vec<QueuePr> = inputs.runs.iter().flat_map(|(plan_id, dir, repos)| run_prs(dir, plan_id, repos)).collect();
    let urls: Vec<String> = prs.iter().map(|pr| pr.url.clone()).collect();
    let states = match api {
        Ok(api) => fetch_states(api, urls),
        Err(why) => urls.into_iter().map(|url| (url, Err(why.clone()))).collect(),
    };
    MergeQueueView {
        round_id: inputs.round_id,
        repos: evaluate(&inputs.round, &prs, &states),
        checked_at: chrono::Utc::now().to_rfc3339(),
    }
}
