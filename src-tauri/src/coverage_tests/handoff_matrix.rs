//! The hand-off matrix (`src/handoff/matrix.test.ts`) writes `handoff_matrix.json`:
//! the form values each hand-off gives its target role, for the shipped roles
//! and for saved variants (legacy keys, renamed labels, custom fields). Every
//! case goes through `merge_role_prompt` and, for a terminal, through
//! `handoff_terminal_prompt`, the way `role_terminal_start` does.

use crate::pty::launch::handoff_terminal_prompt;
use crate::roles::{Role, RolesFile};
use crate::template::merge_role_prompt;
use crate::test_support::TempDir;
use serde::Deserialize;
use std::collections::HashMap;

const SEED: &str = include_str!("../../../seed/roles.seed.json");
const MATRIX: &str = include_str!("handoff_matrix.json");

#[derive(Deserialize)]
struct Matrix {
    roles: HashMap<String, SavedRole>,
    cases: Vec<Case>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedRole {
    #[serde(flatten)]
    role: Role,
    /// The seed role whose template this saved role kept.
    template_from: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    name: String,
    role: String,
    values: HashMap<String, String>,
    handoff_plan: Option<String>,
    errors: Vec<String>,
    marker: String,
    marker_count: usize,
}

fn role_for(seed: &RolesFile, matrix: &Matrix, id: &str) -> Role {
    let from_seed = |id: &str| {
        seed.roles
            .iter()
            .find(|role| role.id == id)
            .cloned()
            .unwrap_or_else(|| panic!("seed role {id}"))
    };
    match matrix.roles.get(id) {
        Some(saved) => {
            let mut role = saved.role.clone();
            if let Some(from) = &saved.template_from {
                role.template_text = from_seed(from).template_text;
            }
            role
        }
        None => from_seed(id),
    }
}

#[test]
fn every_handoff_fill_merges_cleanly_and_carries_the_plan_once() {
    let seed: RolesFile = serde_json::from_str(SEED).expect("seed roles");
    let matrix: Matrix = serde_json::from_str(MATRIX).expect("handoff_matrix.json");
    assert!(matrix.cases.len() > 60, "{} cases", matrix.cases.len());
    let folder = TempDir::new("handoff_matrix");
    let mut failures = Vec::new();
    for case in &matrix.cases {
        let role = role_for(&seed, &matrix, &case.role);
        let mut values = case.values.clone();
        values.insert("cwd".into(), folder.path().display().to_string());
        let result = merge_role_prompt(&role, &values);
        let mut keys: Vec<String> = result.errors.iter().map(|err| err.key.clone()).collect();
        keys.sort();
        if keys != case.errors {
            failures.push(format!(
                "{}: errors {:?}, the hand-off dialog said {:?}",
                case.name, result.errors, case.errors
            ));
            continue;
        }
        let Some(merged) = result.merged else {
            continue;
        };
        let prompt = match &case.handoff_plan {
            Some(plan) => handoff_terminal_prompt(&merged.text, plan),
            None => merged.text.clone(),
        };
        if prompt.contains("{{") {
            failures.push(format!("{}: placeholder left in the prompt", case.name));
        }
        let seen = prompt.matches(case.marker.as_str()).count();
        if seen != case.marker_count {
            failures.push(format!(
                "{}: plan line {:?} appears {seen} times, expected {}",
                case.name, case.marker, case.marker_count
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn a_template_token_no_field_fills_stops_the_start_with_a_named_error() {
    let seed: RolesFile = serde_json::from_str(SEED).expect("seed roles");
    let matrix: Matrix = serde_json::from_str(MATRIX).expect("handoff_matrix.json");
    let case = matrix
        .cases
        .iter()
        .find(|case| case.errors == ["ticket"])
        .expect("a case whose template uses {{ticket}}");
    let role = role_for(&seed, &matrix, &case.role);
    let folder = TempDir::new("handoff_ghost");
    let mut values = case.values.clone();
    values.insert("cwd".into(), folder.path().display().to_string());
    let result = merge_role_prompt(&role, &values);
    assert!(result.merged.is_none());
    assert_eq!(result.errors.len(), 1);
    assert_eq!(result.errors[0].message, "Unresolved placeholder: ticket");
}
