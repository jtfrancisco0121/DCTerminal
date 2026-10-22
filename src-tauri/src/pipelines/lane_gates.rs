//! The gates a stage runs where it is (L2). In a lane whose repo has a
//! `check` in Settings › Repos, that command replaces the stage's command
//! gates (`cd server && go test ./...` for `backend`); its pull-request and
//! verify gates stay. A repo's `verify` steps join as one more verify gate.
//! Both apply only to stages that check the work, the ones with a command
//! gate (the Implementer, in Eagle-Eye), so a reviewer in that lane is
//! never given a check it did not have. A stage with no lane, a lane with
//! no repo, and a repo with neither text run the stage's gates as written.
//!
//! [`run_planned`] runs them in order and keeps every result; `verify`
//! gates never run: once every other gate passed, each adds a `waiting`
//! result with its steps, and `decide` waits for you on the first one.

use super::{GateDef, GateResult};
use crate::store::RepoEntry;

/// One gate as a stage runs it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedGate {
    pub gate: GateDef,
    /// The repo the gate comes from, when it is a repo's check or verify
    /// steps: its result is labelled `backend check: <command>`.
    pub repo: Option<String>,
}

impl PlannedGate {
    fn of_stage(gate: &GateDef) -> Self {
        Self {
            gate: gate.clone(),
            repo: None,
        }
    }
}

/// `stage_gates` as a stage in a lane made in `repo` runs them.
pub fn lane_gates(stage_gates: &[GateDef], repo: Option<&RepoEntry>) -> Vec<PlannedGate> {
    let checks_work = stage_gates.iter().any(|gate| matches!(gate, GateDef::Command { .. }));
    let Some(repo) = repo.filter(|_| checks_work) else {
        return stage_gates.iter().map(PlannedGate::of_stage).collect();
    };
    let check = repo.check.as_deref().map(str::trim).filter(|check| !check.is_empty());
    let mut planned = Vec::new();
    let mut replaced = false;
    for gate in stage_gates {
        match (gate, check) {
            // The first command gate becomes the repo's check, with its
            // timeout; the stage's other command gates are replaced too.
            (GateDef::Command { timeout_secs, .. }, Some(check)) => {
                if !replaced {
                    replaced = true;
                    planned.push(PlannedGate {
                        gate: GateDef::Command {
                            run: check.to_string(),
                            timeout_secs: *timeout_secs,
                            optional: false,
                        },
                        repo: Some(repo.name.clone()),
                    });
                }
            }
            _ => planned.push(PlannedGate::of_stage(gate)),
        }
    }
    if let Some(steps) = repo.verify.as_deref().map(str::trim).filter(|steps| !steps.is_empty()) {
        planned.push(PlannedGate {
            gate: GateDef::Verify { steps: steps.to_string() },
            repo: Some(repo.name.clone()),
        });
    }
    planned
}

/// The label of a verify gate's result: `verify`, or `backend verify`.
pub fn verify_label(repo: Option<&str>) -> String {
    match repo {
        Some(repo) => format!("{repo} verify"),
        None => "verify".to_string(),
    }
}

/// A verify gate waiting for you: its steps are the summary.
pub fn waiting_verify(label: String, steps: &str) -> GateResult {
    GateResult {
        kind: "verify".into(),
        label,
        status: "waiting".into(),
        summary: steps.trim().to_string(),
        output: String::new(),
        duration_ms: 0,
        optional: false,
    }
}

/// Run `planned` in order with `run_one` (the host's gate runner). Each
/// result carries its gate's `optional` flag and, for a repo's check, the
/// label `<repo> check: <what ran>`. Verify gates are not run: when every
/// other result passed (or was an optional skip), each adds a `waiting`
/// result; otherwise they are left out, as the run goes back to the stage
/// (or stops) for the failed gate first.
pub fn run_planned(planned: &[PlannedGate], mut run_one: impl FnMut(&GateDef) -> GateResult) -> Vec<GateResult> {
    let mut results: Vec<GateResult> = planned
        .iter()
        .filter(|planned| !matches!(planned.gate, GateDef::Verify { .. }))
        .map(|planned| {
            let optional = matches!(planned.gate, GateDef::Command { optional: true, .. });
            let result = run_one(&planned.gate);
            let label = match (&planned.repo, &planned.gate) {
                (Some(repo), GateDef::Command { .. }) => format!("{repo} check: {}", result.label),
                _ => result.label.clone(),
            };
            GateResult { optional, label, ..result }
        })
        .collect();
    let all_passed = results.iter().all(|result| !result.failed() && !result.no_check_found());
    if all_passed {
        for planned in planned {
            if let GateDef::Verify { steps } = &planned.gate {
                results.push(waiting_verify(verify_label(planned.repo.as_deref()), steps));
            }
        }
    }
    results
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command(run: &str, timeout_secs: Option<u64>) -> GateDef {
        GateDef::Command {
            run: run.into(),
            timeout_secs,
            optional: false,
        }
    }

    fn repo(check: Option<&str>, verify: Option<&str>) -> RepoEntry {
        RepoEntry {
            name: "backend".into(),
            folder: "/src/backend".into(),
            check: check.map(str::to_string),
            verify: verify.map(str::to_string),
        }
    }

    fn gates_of(planned: &[PlannedGate]) -> Vec<GateDef> {
        planned.iter().map(|p| p.gate.clone()).collect()
    }

    fn result(kind: &str, label: &str, status: &str) -> GateResult {
        GateResult {
            kind: kind.into(),
            label: label.into(),
            status: status.into(),
            summary: String::new(),
            output: String::new(),
            duration_ms: 0,
            optional: false,
        }
    }

    #[test]
    fn a_repos_check_replaces_the_stages_command_gates_and_keeps_the_rest() {
        let stage = vec![command("auto", Some(600)), GateDef::PullRequest, command("npm run lint", None)];
        let planned = lane_gates(&stage, Some(&repo(Some(" cd server && go test ./... "), None)));
        assert_eq!(
            gates_of(&planned),
            [command("cd server && go test ./...", Some(600)), GateDef::PullRequest],
            "one check, at the first command gate, with its timeout"
        );
        assert_eq!(planned[0].repo.as_deref(), Some("backend"));
        assert_eq!(planned[1].repo, None, "the pull-request gate is the stage's own");
        // An optional `auto` gate replaced by a real command is not optional.
        let optional = vec![GateDef::Command { run: "auto".into(), timeout_secs: None, optional: true }];
        let planned = lane_gates(&optional, Some(&repo(Some("go test ./..."), None)));
        assert_eq!(gates_of(&planned), [command("go test ./...", None)]);
    }

    #[test]
    fn a_repos_verify_steps_join_after_the_stages_gates() {
        let stage = vec![command("auto", None), GateDef::PullRequest];
        let planned = lane_gates(&stage, Some(&repo(None, Some(" Run qa128-ml on Windows. "))));
        assert_eq!(
            gates_of(&planned),
            [command("auto", None), GateDef::PullRequest, GateDef::Verify { steps: "Run qa128-ml on Windows.".into() }],
            "no check: the stage's command stays"
        );
        assert_eq!(planned[2].repo.as_deref(), Some("backend"));
    }

    #[test]
    fn stages_without_a_command_gate_lanes_without_a_repo_and_plain_repos_are_unchanged() {
        let both = repo(Some("go test ./..."), Some("Check it."));
        // A reviewer (no command gate) in that lane gets nothing new.
        assert!(lane_gates(&[], Some(&both)).is_empty());
        let pr_only = vec![GateDef::PullRequest];
        assert_eq!(gates_of(&lane_gates(&pr_only, Some(&both))), pr_only);
        let stage = vec![command("auto", None), GateDef::PullRequest];
        assert_eq!(gates_of(&lane_gates(&stage, None)), stage);
        assert_eq!(gates_of(&lane_gates(&stage, Some(&repo(None, None)))), stage);
        assert_eq!(gates_of(&lane_gates(&stage, Some(&repo(Some("  "), Some("\n"))))), stage, "blank texts are none");
        assert!(lane_gates(&stage, None).iter().all(|p| p.repo.is_none()));
    }

    #[test]
    fn verify_gates_wait_only_after_every_other_gate_passed() {
        let planned = lane_gates(
            &[command("auto", None), GateDef::PullRequest, GateDef::Verify { steps: "Pipeline steps.".into() }],
            Some(&repo(Some("go test ./..."), Some("Repo steps."))),
        );
        let mut ran = Vec::new();
        let results = run_planned(&planned, |gate| {
            ran.push(gate.clone());
            match gate {
                GateDef::Command { run, .. } => result("command", run, "passed"),
                _ => result("pullRequest", "gh pr view", "passed"),
            }
        });
        assert_eq!(ran, [command("go test ./...", None), GateDef::PullRequest], "verify gates never run");
        let labels: Vec<(&str, &str)> = results.iter().map(|r| (r.label.as_str(), r.status.as_str())).collect();
        assert_eq!(
            labels,
            [
                ("backend check: go test ./...", "passed"),
                ("gh pr view", "passed"),
                ("verify", "waiting"),
                ("backend verify", "waiting"),
            ]
        );
        assert_eq!(results[2].summary, "Pipeline steps.");
        assert_eq!(results[3].summary, "Repo steps.");
        assert!(results.iter().all(|r| !r.failed()), "a waiting verify is not a failure");

        // A failed check: the run goes back to the stage first, so nothing waits.
        let results = run_planned(&planned, |gate| match gate {
            GateDef::Command { run, .. } => result("command", run, "failed"),
            _ => result("pullRequest", "gh pr view", "passed"),
        });
        assert_eq!(results.len(), 2);
        assert!(results.iter().all(|r| r.kind != "verify"));
        // Nothing to run (`auto`, not optional) stops the run: nothing waits either.
        let stage_only = lane_gates(&[command("auto", None), GateDef::Verify { steps: "S.".into() }], None);
        let results = run_planned(&stage_only, |_| result("command", "auto", "skipped"));
        assert_eq!(results.len(), 1);
        // An optional skip is fine: the verify waits.
        let optional = lane_gates(
            &[GateDef::Command { run: "auto".into(), timeout_secs: None, optional: true }, GateDef::Verify { steps: "S.".into() }],
            None,
        );
        let results = run_planned(&optional, |_| result("command", "auto", "skipped"));
        assert!(results[0].optional);
        assert_eq!(results[1].status, "waiting");
    }
}
