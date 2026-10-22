//! W1: a run whose start folder is a workspace of repos (not a git repo,
//! with repos as its child folders). A one-task plan's Implementer opens in
//! a worktree of the task's repo through a one-lane fan-out; a plan across
//! two repos fans out with each lane in its own repo, checked by its
//! detected check.

use super::*;
use crate::bridge::PlannedTask;

fn git(dir: &Path, args: &[&str]) {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "init.defaultBranch=main"])
        .args(args)
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

/// A repo at `path` with `file` committed.
fn repo_at(path: &Path, file: &str) {
    std::fs::create_dir_all(path.join(file).parent().unwrap()).unwrap();
    std::fs::write(path.join(file), "module x\n").unwrap();
    git(path, &["init", "-q"]);
    git(path, &["add", "."]);
    git(path, &["commit", "-q", "-m", "init"]);
}

/// The Eagle-Eye 1 fixture, its folder made a workspace: `repo-a` (a Go
/// module at its root) and `repo-b` (Go code in `server/`).
fn workspace_fixture(tag: &str) -> Fixture {
    let fx = Fixture::new(tag);
    repo_at(&fx.work.join("repo-a"), "go.mod");
    repo_at(&fx.work.join("repo-b"), "server/go.mod");
    fx.run(|run| assert_eq!(Path::new(&run.cwd), fx.work.path(), "the run starts in the workspace"));
    let found = fx.host.run_repos(fx.work.path());
    assert!(found.workspace);
    let names: Vec<&str> = found.repos.iter().map(|r| r.name.as_str()).collect();
    assert_eq!(names, ["repo-a", "repo-b"]);
    fx
}

fn task(id: &str, repo: &str) -> PlannedTask {
    PlannedTask {
        id: id.into(),
        title: format!("Change {repo}"),
        depends_on: vec![],
        manual: false,
        summary: format!("The {repo} part."),
        repo: Some(repo.into()),
        stories: vec![],
    }
}

/// Planner (with `tasks`) → Plan Reviewer approves → the checkpoint before
/// the Implementer. The Plan Reviewer's tab.
fn to_checkpoint(fx: &mut Fixture, tasks: Vec<PlannedTask>) -> String {
    let ids: Vec<Value> = tasks.iter().map(|t| json!({ "id": t.id })).collect();
    let dir = fx.stage_dir(&fx.planner);
    let file = RunTasks { schema: 1, run_id: RUN.into(), stage_key: "planner".into(), turn: "p-1".into(), at: "now".into(), tasks };
    dir.write_plan("# Plan\n1. Change the repos.", &file).unwrap();
    let planner = fx.planner.clone();
    let turn = fx.end_turn(&planner, "p-1", Some(json!({ "schema": 1, "tasks": ids })), "Plan received.");
    fx.actor.handle(ActorMsg::Turn(turn));
    let reviewer = fx.launches().last().expect("plan reviewer opened").tab_id.clone();
    let turn = fx.end_turn(&reviewer, "r-1", review("APPROVED", json!([])), "Approved.");
    fx.actor.handle(ActorMsg::Turn(turn));
    fx.run(|run| assert_eq!(run.stop_reason, Some(StopReason::Checkpoint), "{:?}", run.events.last()));
    reviewer
}

fn send_to_implementer(fx: &mut Fixture, reviewer: &str) -> Result<UserOutcome, String> {
    fx.user(UserAction::Send {
        source_tab_id: reviewer.to_string(),
        target_role_id: "role_implementer".into(),
        values: None,
        handoff_plan: None,
        handoff_text: None,
        force: false,
    })
}

fn prs(url: &str) -> Option<Value> {
    Some(json!({ "schema": 1, "prs": [{ "url": url, "branch": "fix", "title": "Fix" }], "summary": "Done." }))
}

/// The commands the gate runner ran, with the folder each ran in.
fn ran_commands(fx: &Fixture) -> Vec<(String, PathBuf)> {
    fx.host
        .ran_gates
        .lock()
        .unwrap()
        .iter()
        .filter_map(|(gate, folder)| match gate {
            GateDef::Command { run, .. } => Some((run.clone(), folder.clone())),
            _ => None,
        })
        .collect()
}

fn same(a: &Path, b: &Path) -> bool {
    a.canonicalize().unwrap() == b.canonicalize().unwrap()
}

#[test]
fn a_one_task_plan_in_a_workspace_runs_its_implementer_in_a_worktree_of_its_repo() {
    let mut fx = workspace_fixture("w1_one_task");
    let reviewer = to_checkpoint(&mut fx, vec![task("pr1", "repo-b")]);
    // The Planner and its reviewer were told the run's folder is a workspace.
    let file: Value = serde_json::from_str(&std::fs::read_to_string(fx.run_file("repos.json")).unwrap()).unwrap();
    assert_eq!(file["workspace"], json!(true));
    assert_eq!(file["repos"][1]["name"], "repo-b");

    let implementer = send_to_implementer(&mut fx, &reviewer).unwrap().tab_id.expect("the Implementer opened");
    let launch = fx.launches().last().cloned().unwrap();
    assert_eq!(launch.role_id, "role_implementer");
    let worktrees = fx.work.join("repo-b-worktrees");
    assert!(same(launch.cwd.parent().unwrap(), &worktrees), "in a worktree of repo-b: {}", launch.cwd.display());
    assert!(launch.cwd.join("server/go.mod").is_file(), "the worktree holds repo-b's files");
    assert!(!same(&launch.cwd, fx.work.path()), "never in the folder of repos");
    let tab = fx.tab(&implementer);
    assert_eq!(tab.chain.as_ref().and_then(|c| c.lane.as_deref()), Some("pr1"));
    let worktree = tab.worktree.clone().expect("the tab knows its worktree, for removal later");
    assert_eq!(worktree.branch, format!("{RUN}-pr1"));
    fx.run(|run| {
        assert_eq!(run.lanes.len(), 1);
        let lane = &run.lanes[0];
        assert_eq!((lane.id.as_str(), lane.repo.as_deref(), lane.status.as_str()), ("pr1", Some("repo-b"), "active"));
        assert_eq!(lane.tab_ids.get("role_implementer"), Some(&implementer));
        assert_eq!(run.fan_out_stage.as_deref(), Some("implementer"));
    });

    // Its turn is checked by repo-b's detected check, in the worktree.
    let turn = fx.end_turn(&implementer, "i-1", prs("https://github.com/acme/repo-b/pull/3"), "Opened it.");
    fx.actor.handle(ActorMsg::Turn(turn));
    fx.finish_gates();
    let ran = ran_commands(&fx);
    assert_eq!(ran.len(), 1, "{ran:?}");
    assert_eq!(ran[0].0, "cd server && go test ./...");
    assert!(same(&ran[0].1, &launch.cwd));
    fx.run(|run| {
        let results = &run.gates["implementer@pr1"].results;
        assert_eq!(results[0].label, "repo-b check: cd server && go test ./...");
    });
}

#[test]
fn a_plan_across_two_repos_in_a_workspace_fans_out_with_each_lane_checked_in_its_repo() {
    let mut fx = workspace_fixture("w1_two_tasks");
    let reviewer = to_checkpoint(&mut fx, vec![task("pr1", "repo-a"), task("pr2", "repo-b")]);
    // Send would run one Implementer in the folder of repos: refused, pointing at fan-out.
    let err = send_to_implementer(&mut fx, &reviewer).unwrap_err();
    assert!(err.contains("fan out the plan's 2 pull requests from the chain overview"), "{err}");
    assert_eq!(fx.launches().iter().filter(|l| l.role_id == "role_implementer").count(), 0);
    fx.run(|run| assert!(run.claims.iter().all(|c| c.by != "you"), "the hand-on claim was given back: {:?}", run.claims));

    // The overview's fan-out (fanOut.ts): one worktree per lane in its repo,
    // lanes recorded with their repos from the run's repos.
    let repos = fx.host.run_repos(fx.work.path()).repos;
    let mut lane_tabs = Vec::new();
    {
        let lanes: Vec<crate::commands::pipeline::LaneInput> = ["pr1:repo-a", "pr2:repo-b"]
            .iter()
            .map(|pair| {
                let (id, repo) = pair.split_once(':').unwrap();
                crate::commands::pipeline::LaneInput { id: id.into(), title: id.to_uppercase(), depends_on: vec![], repo: Some(repo.into()) }
            })
            .collect();
        let lanes = crate::commands::pipeline::lanes_in_repos(lanes, &repos).unwrap();
        let mut store = fx.host.store.lock().unwrap();
        crate::commands::pipeline::fan_out(&mut store, RUN, "implementer", lanes).unwrap();
    }
    for (lane, repo) in [("pr1", "repo-a"), ("pr2", "repo-b")] {
        let folder = crate::store::repos_settings::find_repo(&repos, repo).unwrap().folder.clone();
        let made = crate::worktree::add_worktree(Path::new(&folder), &format!("{RUN}-{lane}"), true, None).unwrap();
        lane_tabs.push((lane, PathBuf::from(&made.path), lane_tab(&fx, lane, made)));
    }
    for (lane, cwd, tab) in &lane_tabs {
        let turn = fx.end_turn(tab, "i-1", prs(&format!("https://github.com/acme/x/pull/{}", lane.len())), "Opened it.");
        fx.actor.handle(ActorMsg::Turn(turn));
        fx.finish_gates();
        let ran = ran_commands(&fx);
        let (command, folder) = ran.last().unwrap();
        assert!(same(folder, cwd), "{lane} is checked in its own worktree");
        let expected = if *lane == "pr1" { "go test ./..." } else { "cd server && go test ./..." };
        assert_eq!(command, expected);
    }
    fx.run(|run| {
        assert_eq!(run.gates["implementer@pr1"].results[0].label, "repo-a check: go test ./...");
        assert_eq!(run.gates["implementer@pr2"].results[0].label, "repo-b check: cd server && go test ./...");
    });
}

/// A lane's bridged Implementer tab in its worktree, as fan-out leaves it.
fn lane_tab(fx: &Fixture, lane: &str, made: crate::worktree::WorktreeRef) -> String {
    let mut store = fx.host.store.lock().unwrap();
    let role = fx.host.roles.iter().find(|r| r.id == "role_implementer").unwrap();
    let tab = store.create_worktree_tab(role, made).unwrap();
    // The lane's hand-off, attached as fan-out attaches it: your send passes the checkpoint.
    store.set_tab_chain(&tab, Some(chain(3, Some(lane))), Some("The approved plan, for this lane.")).unwrap();
    let stage_key = crate::pipelines::autopilot::stage_key("implementer", Some(lane));
    let plan = BridgePlan {
        run_id: RUN.into(),
        stage_id: "implementer".into(),
        role_id: "role_implementer".into(),
        lane: Some(lane.into()),
        stage_key: stage_key.clone(),
        kind: ResultKind::Implementer,
        autopilot: true,
    };
    prepare_stage(&fx.host.runs, &plan, &tab).unwrap();
    store.set_tab_bridge(&tab, Some(BridgeTag { run_id: RUN.into(), stage: stage_key })).unwrap();
    let n = if lane == "pr1" { 1 } else { 2 };
    store.remember_claude_terminal_session(&tab, &format!("5f0c2a31-1b2c-4d3e-8f40-0000000009{n:02}")).unwrap();
    store.save().unwrap();
    fx.host.live.lock().unwrap().insert(tab.clone());
    tab
}

#[test]
fn a_run_in_a_repo_folder_opens_its_implementer_where_it_always_did() {
    let mut fx = Fixture::new("w1_repo_folder");
    git(fx.work.path(), &["init", "-q"]);
    assert!(!fx.host.run_repos(fx.work.path()).workspace);
    let implementer = to_implementer(&mut fx);
    let launch = fx.launches().last().cloned().unwrap();
    assert!(same(&launch.cwd, fx.work.path()), "{}", launch.cwd.display());
    assert!(fx.tab(&implementer).chain.as_ref().unwrap().lane.is_none(), "no lane");
    fx.run(|run| assert!(run.lanes.is_empty()));
    let file: Value = serde_json::from_str(&std::fs::read_to_string(fx.run_file("repos.json")).unwrap()).unwrap();
    assert!(file.get("workspace").is_none(), "{file}");
}
