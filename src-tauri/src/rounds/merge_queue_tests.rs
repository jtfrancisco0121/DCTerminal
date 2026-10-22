//! R3: the merge queue's order and its next-to-merge rule, on a round
//! shaped like a real one (backend 1 → 2 → 4 → 3, engine 5 → 2 → 3,
//! desktop 4 → 6 → 7, web 4 → 7) with GitHub's answers mocked.

use super::merge_queue::{evaluate, fetch_states, order, parse_pr_state, parse_pr_url, run_prs, PrState, QueuePr, Slot, HOME_REPO};
use crate::bridge::round::{PlanStatus, Round, RoundPlan, RoundWave};
use crate::github::runner::{GhApi, GhResponse};
use serde_json::json;
use std::collections::{BTreeMap, HashMap};

fn plan(id: &str, wave: Option<u32>, status: PlanStatus, repos: &[&str]) -> RoundPlan {
    RoundPlan {
        id: id.into(),
        title: format!("Title of {id}"),
        tickets: vec![format!("QA-{id}")],
        repos: repos.iter().map(|r| r.to_string()).collect(),
        status,
        reason: (status != PlanStatus::Active).then(|| "Later.".to_string()),
        wave,
        summary: "Fix it.".into(),
    }
}

fn ids(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

/// Plans 1 and 5 in wave 1, 2 and 4 in wave 2, 3 (parked) and 6 in wave 3,
/// 7 in wave 4, 8 deferred.
fn round() -> Round {
    use PlanStatus::*;
    Round {
        plans: vec![
            plan("plan1", Some(1), Active, &["backend"]),
            plan("plan2", Some(2), Active, &["backend", "engine"]),
            plan("plan3", Some(3), Parked, &["backend", "engine"]),
            plan("plan4", Some(2), Active, &["backend", "desktop", "web"]),
            plan("plan5", Some(1), Active, &["engine"]),
            plan("plan6", Some(3), Active, &["desktop"]),
            plan("plan7", Some(4), Active, &["desktop", "web"]),
            plan("plan8", None, Deferred, &["gateway"]),
        ],
        waves: (1..=4).map(|n| RoundWave { n, why: format!("Wave {n}") }).collect(),
        merge_order: BTreeMap::from([
            ("backend".to_string(), ids(&["plan1", "plan2", "plan4", "plan3"])),
            ("engine".to_string(), ids(&["plan5", "plan2", "plan3"])),
            ("desktop".to_string(), ids(&["plan4", "plan6", "plan7"])),
            ("web".to_string(), ids(&["plan4", "plan7"])),
        ]),
        excluded: Vec::new(),
    }
}

fn pr(plan_id: &str, repo: &str, lane: Option<&str>, depends_on: &[&str], number: u32) -> QueuePr {
    QueuePr {
        plan_id: plan_id.into(),
        repo: repo.into(),
        lane: lane.map(str::to_string),
        depends_on: ids(depends_on),
        url: format!("https://github.com/acme/{repo}/pull/{number}"),
        title: format!("{plan_id} in {repo}"),
        branch: format!("{plan_id}-{repo}"),
    }
}

/// Every active plan's pull requests: one per repo, plan 6 in two lanes
/// where pr1 builds on pr2. Plan 3 is parked and has none.
fn prs() -> Vec<QueuePr> {
    vec![
        pr("plan1", "backend", None, &[], 11),
        pr("plan2", "backend", Some("pr1"), &[], 12),
        pr("plan2", "engine", Some("pr2"), &["pr1"], 21),
        pr("plan4", "backend", Some("pr1"), &[], 14),
        pr("plan4", "desktop", Some("pr2"), &["pr1"], 31),
        pr("plan4", "web", Some("pr3"), &["pr1"], 41),
        pr("plan5", "engine", None, &[], 25),
        pr("plan6", "desktop", Some("pr1"), &["pr2"], 36),
        pr("plan6", "desktop", Some("pr2"), &[], 35),
        pr("plan7", "desktop", Some("pr1"), &[], 37),
        pr("plan7", "web", Some("pr2"), &[], 47),
    ]
}

/// Each repo's order as `plan` or `plan#n` (`plan?` for no pull request yet).
fn shown(round: &Round, prs: &[QueuePr]) -> BTreeMap<String, Vec<String>> {
    order(round, prs)
        .into_iter()
        .map(|(repo, slots)| {
            let names = slots
                .into_iter()
                .map(|slot| match slot {
                    Slot::Pr(i) => format!("{}#{}", prs[i].plan_id, parse_pr_url(&prs[i].url).unwrap().1),
                    Slot::Missing { plan_id, parked } => format!("{plan_id}{}", if parked { "(parked)" } else { "?" }),
                })
                .collect();
            (repo, names)
        })
        .collect()
}

#[test]
fn each_repo_merges_in_the_rounds_order_then_by_depends_on() {
    let order = shown(&round(), &prs());
    assert_eq!(order["backend"], ["plan1#11", "plan2#12", "plan4#14", "plan3(parked)"]);
    assert_eq!(order["engine"], ["plan5#25", "plan2#21", "plan3(parked)"]);
    // Plan 6's pr1 builds on its pr2, so pr2 (#35) merges first.
    assert_eq!(order["desktop"], ["plan4#31", "plan6#35", "plan6#36", "plan7#37"]);
    assert_eq!(order["web"], ["plan4#41", "plan7#47"]);
    assert_eq!(order.len(), 4, "the deferred plan's repo has no queue");
}

#[test]
fn plans_the_merge_order_leaves_out_follow_by_wave() {
    let mut round = round();
    round.merge_order.get_mut("desktop").unwrap().retain(|id| id != "plan6");
    let mut extra = prs();
    let mut home = pr("plan5", HOME_REPO, None, &[], 99);
    home.url = url("app", 99);
    extra.push(home);
    let order = shown(&round, &extra);
    assert_eq!(order["desktop"], ["plan4#31", "plan7#37", "plan6#35", "plan6#36"]);
    assert_eq!(order[HOME_REPO], ["plan5#99"]);
}

fn open(base: &str, head: &str) -> Result<PrState, String> {
    Ok(PrState { state: "open".into(), draft: false, base: base.into(), head: head.into(), mergeable_state: Some("clean".into()) })
}

fn with(state: &str, draft: bool, mergeable: Option<&str>, head: &str) -> Result<PrState, String> {
    Ok(PrState {
        state: state.into(),
        draft,
        base: "staging".into(),
        head: head.into(),
        mergeable_state: mergeable.map(str::to_string),
    })
}

fn url(repo: &str, n: u32) -> String {
    format!("https://github.com/acme/{repo}/pull/{n}")
}

#[test]
fn the_next_pull_request_per_repo_is_the_first_not_merged_and_only_one_at_a_time() {
    let prs = prs();
    let mut states: HashMap<String, Result<PrState, String>> =
        prs.iter().map(|p| (p.url.clone(), open("staging", &p.branch))).collect();
    // backend: plan 1 merged; plan 2 is behind staging.
    states.insert(url("backend", 11), with("merged", false, None, "plan1-backend"));
    states.insert(url("backend", 12), with("open", false, Some("behind"), "plan2-backend"));
    // engine: plan 5 is still a draft.
    states.insert(url("engine", 25), with("open", true, Some("draft"), "plan5-engine"));
    // desktop: plan 4 conflicts with staging.
    states.insert(url("desktop", 31), with("open", false, Some("dirty"), "plan4-desktop"));
    // web: plan 4's state could not be read.
    states.insert(url("web", 41), Err("gh: not signed in".into()));
    let queues = evaluate(&round(), &prs, &states);
    let queue = |repo: &str| queues.iter().find(|q| q.repo == repo).unwrap();
    for q in &queues {
        assert!(q.entries.iter().filter(|e| e.next).count() <= 1, "{}: never two merges at once", q.repo);
    }
    let backend = queue("backend");
    assert_eq!(backend.entries[0].state, "merged");
    assert!(backend.entries[1].next);
    assert!(backend.entries[1].warnings[0].contains("rebase it on staging"), "{:?}", backend.entries[1].warnings);
    assert_eq!(backend.entries[2].waits_for.as_deref(), Some("plan2 #12"));
    assert!(!backend.entries[2].next);
    assert_eq!((backend.entries[3].state.as_str(), backend.entries[3].next), ("parked", false));

    let engine = queue("engine");
    assert!(engine.entries[0].next);
    assert_eq!(engine.entries[0].state, "draft");
    assert!(engine.entries[0].warnings.iter().any(|w| w.contains("still a draft")));
    assert_eq!(engine.entries[1].waits_for.as_deref(), Some("plan5 #25"));

    let desktop = queue("desktop");
    assert!(desktop.entries[0].next);
    assert!(desktop.entries[0].warnings[0].contains("conflicts with staging"));
    assert!(desktop.entries[1..].iter().all(|e| !e.next && e.waits_for.as_deref() == Some("plan4 #31")));

    // A pull request whose state is unknown is not suggested, and holds the rest.
    let web = queue("web");
    assert_eq!(web.entries[0].state, "unknown");
    assert!(web.entries.iter().all(|e| !e.next));
    assert!(web.entries[0].warnings[0].contains("not signed in"));
    assert_eq!(web.entries[1].waits_for.as_deref(), Some("plan4 #41"));

    // Once plan 2 merges in backend, plan 4 is next there.
    states.insert(url("backend", 12), with("merged", false, None, "plan2-backend"));
    let queues = evaluate(&round(), &prs, &states);
    let backend = queues.iter().find(|q| q.repo == "backend").unwrap();
    assert_eq!(backend.entries.iter().position(|e| e.next), Some(2));
}

#[test]
fn a_plan_with_no_pull_request_yet_holds_its_repo_and_a_closed_one_does_not() {
    let mut prs = prs();
    prs.retain(|p| p.url != url("web", 41));
    let mut states: HashMap<String, Result<PrState, String>> =
        prs.iter().map(|p| (p.url.clone(), open("staging", &p.branch))).collect();
    let queues = evaluate(&round(), &prs, &states);
    let web = queues.iter().find(|q| q.repo == "web").unwrap();
    assert_eq!(web.entries[0].state, "missing");
    assert!(!web.entries[1].next);
    assert_eq!(web.entries[1].waits_for.as_deref(), Some("plan4's pull request, which it has not opened yet"));
    // A closed pull request (not merged) is passed over.
    states.insert(url("backend", 11), with("closed", false, None, "plan1-backend"));
    let queues = evaluate(&round(), &prs, &states);
    let backend = queues.iter().find(|q| q.repo == "backend").unwrap();
    assert_eq!((backend.entries[0].state.as_str(), backend.entries[1].next), ("closed", true));
}

#[test]
fn a_pull_request_based_on_a_merged_branch_must_be_retargeted() {
    let prs = vec![pr("plan1", "backend", Some("pr1"), &[], 11), pr("plan1", "backend", Some("pr2"), &["pr1"], 12)];
    let round = Round {
        plans: vec![plan("plan1", Some(1), PlanStatus::Active, &["backend"])],
        waves: vec![RoundWave { n: 1, why: "Only".into() }],
        merge_order: BTreeMap::from([("backend".to_string(), ids(&["plan1"]))]),
        excluded: Vec::new(),
    };
    let states = HashMap::from([
        (url("backend", 11), with("merged", false, None, "plan1-backend-pr1")),
        (url("backend", 12), open("plan1-backend-pr1", "plan1-backend-pr2")),
    ]);
    let queues = evaluate(&round, &prs, &states);
    let entry = &queues[0].entries[1];
    assert!(entry.next);
    assert!(entry.warnings[0].contains("Its base branch plan1-backend-pr1 was merged: retarget it"), "{:?}", entry.warnings);
}

/// `gh api` answers by endpoint; anything else is "no reply".
struct FakeGh(HashMap<String, (u16, String)>);

impl GhApi for FakeGh {
    fn get(&self, endpoint: &str, _etag: Option<&str>) -> Result<GhResponse, String> {
        match self.0.get(endpoint) {
            Some((status, body)) => Ok(GhResponse { status: *status, body: body.clone(), ..GhResponse::default() }),
            None => Err("gh: could not connect".into()),
        }
    }
}

#[test]
fn gh_states_are_read_from_the_pull_request_endpoint() {
    let body = json!({ "state": "closed", "merged": true, "draft": false, "base": { "ref": "staging" }, "head": { "ref": "fix/a" },
                       "mergeable_state": "unknown" })
    .to_string();
    let open = json!({ "state": "open", "merged": false, "draft": true, "base": { "ref": "staging" }, "head": { "ref": "fix/b" },
                       "mergeable_state": "behind" })
    .to_string();
    let gh = FakeGh(HashMap::from([
        ("repos/acme/backend/pulls/1".to_string(), (200, body)),
        ("repos/acme/backend/pulls/2".to_string(), (200, open)),
        ("repos/acme/backend/pulls/3".to_string(), (404, "{}".to_string())),
    ]));
    let urls = vec![url("backend", 1), url("backend", 2), url("backend", 3), url("backend", 4), "https://example.com/x".to_string()];
    let states = fetch_states(&gh, urls);
    let merged = states[&url("backend", 1)].as_ref().unwrap();
    assert_eq!((merged.state.as_str(), merged.head.as_str()), ("merged", "fix/a"));
    let draft = states[&url("backend", 2)].as_ref().unwrap();
    assert_eq!((draft.state.as_str(), draft.draft, draft.mergeable_state.as_deref()), ("open", true, Some("behind")));
    assert!(states[&url("backend", 3)].as_ref().unwrap_err().contains("does not find it"));
    assert!(states[&url("backend", 4)].as_ref().unwrap_err().contains("could not connect"));
    assert!(states["https://example.com/x"].as_ref().unwrap_err().contains("not a GitHub pull request link"));
    assert_eq!(parse_pr_url("https://github.com/acme/web/pull/47#discussion"), Some(("acme/web".to_string(), 47)));
    assert_eq!(parse_pr_url("https://github.com/acme/web/issues/47"), None);
    assert_eq!(parse_pr_url("https://github.com/../web/pull/1"), None);
    assert!(parse_pr_state("not json").is_none());
}

#[test]
fn a_plan_runs_pull_requests_come_from_its_prs_files_with_each_lanes_repo() {
    let dir = crate::test_support::TempDir::new("merge_queue_run_prs");
    let tasks = json!({ "schema": 1, "runId": "ee_1", "stageKey": "planner", "turn": "t", "at": "now", "tasks": [
        { "id": "pr1", "title": "API", "dependsOn": [], "manual": false, "summary": "x", "repo": "backend" },
        { "id": "pr2", "title": "Client", "dependsOn": ["pr1"], "manual": false, "summary": "y", "repo": "web" }
    ] });
    std::fs::write(dir.join("tasks.json"), tasks.to_string()).unwrap();
    let prs_file = |lane: &str, n: u32, repo: &str| {
        json!({ "schema": 1, "runId": "ee_1", "stageKey": format!("implementer@{lane}"), "lane": lane, "turn": "t", "at": "now",
                "result": { "prs": [{ "url": url(repo, n), "branch": format!("b{n}"), "title": format!("T{n}") }], "summary": "s" } })
    };
    std::fs::write(dir.join("prs-pr1.json"), prs_file("pr1", 5, "backend").to_string()).unwrap();
    std::fs::write(dir.join("prs-pr2.json"), prs_file("pr2", 6, "web").to_string()).unwrap();
    let found = run_prs(dir.path(), "plan2", &ids(&["backend", "web"]));
    let summary: Vec<(String, Option<String>, Vec<String>)> = found.iter().map(|p| (p.repo.clone(), p.lane.clone(), p.depends_on.clone())).collect();
    assert_eq!(
        summary,
        [("backend".to_string(), Some("pr1".to_string()), vec![]), ("web".to_string(), Some("pr2".to_string()), vec!["pr1".to_string()])]
    );
    // A run with no lanes: its one task's repo, else the plan's one repo.
    let solo = crate::test_support::TempDir::new("merge_queue_run_prs_solo");
    let file = json!({ "schema": 1, "runId": "ee_2", "stageKey": "implementer", "turn": "t", "at": "now",
                       "result": { "prs": [{ "url": url("engine", 9), "branch": "b", "title": "T" }], "summary": "s" } });
    std::fs::write(solo.join("prs.json"), file.to_string()).unwrap();
    let found = run_prs(solo.path(), "plan5", &ids(&["engine"]));
    assert_eq!((found[0].repo.as_str(), found[0].lane.as_deref()), ("engine", None));
    assert_eq!(run_prs(solo.path(), "plan9", &ids(&["a", "b"]))[0].repo, HOME_REPO);
}
