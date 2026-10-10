//! Save and reload Planner hand-offs from app data.

use crate::commands::chain_events::notify_chain;
use crate::store::{HandoffRecord, HandoffStore, NewHandoff};
use serde::Deserialize;
use std::collections::HashSet;
use std::sync::Mutex;
use tauri::State;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffSaveInput {
    pub source_tab_id: String,
    pub source_role_id: String,
    pub source_label: String,
    pub target_role_id: String,
    pub title: String,
    pub cwd: String,
    pub scope: String,
    pub plan_text: String,
    pub truncated: bool,
    pub warning: Option<String>,
    pub plan_field: Option<String>,
    #[serde(default)]
    pub chain: Option<crate::store::ChainRef>,
}

const MAX_ID_CHARS: usize = 128;
const MAX_TEXT_CHARS: usize = 2_000;
const MAX_CWD_CHARS: usize = 4_096;
/// Far above `FILE_PLAN_CHARS`; anything larger is not a plan.
const MAX_PLAN_CHARS: usize = 32_000_000;

fn valid_token(id: &str) -> bool {
    !id.is_empty()
        && id.chars().count() <= MAX_ID_CHARS
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
}

fn check_len(name: &str, value: &str, max: usize) -> Result<(), String> {
    let chars = value.chars().count();
    if chars > max {
        return Err(format!(
            "Hand-off {name} is too long ({chars} characters, at most {max})."
        ));
    }
    Ok(())
}

/// Reject a hand-off the frontend should never send, with a reason a
/// person can act on. Nothing is written when this fails.
pub(crate) fn validate_handoff_input(input: &HandoffSaveInput) -> Result<(), String> {
    if input.plan_text.trim().is_empty() {
        return Err("There is no plan to send.".into());
    }
    check_len("plan", &input.plan_text, MAX_PLAN_CHARS)?;
    // The source tab can be empty (no tab selected), never malformed.
    if !input.source_tab_id.is_empty() && !valid_token(&input.source_tab_id) {
        return Err(format!(
            "Hand-off source tab id is not valid: {:?}",
            input.source_tab_id.chars().take(40).collect::<String>()
        ));
    }
    for (name, id) in [
        ("source role", &input.source_role_id),
        ("target role", &input.target_role_id),
    ] {
        if !valid_token(id) {
            return Err(format!(
                "Hand-off {name} id is not valid: {:?}",
                id.chars().take(40).collect::<String>()
            ));
        }
    }
    check_len("title", &input.title, MAX_TEXT_CHARS)?;
    check_len("source label", &input.source_label, MAX_TEXT_CHARS)?;
    check_len("warning", input.warning.as_deref().unwrap_or(""), MAX_TEXT_CHARS)?;
    check_len("scope", &input.scope, MAX_ID_CHARS)?;
    check_len("folder", &input.cwd, MAX_CWD_CHARS)?;
    if let Some(field) = input.plan_field.as_deref() {
        if !valid_token(field) {
            return Err(format!("Hand-off plan field is not valid: {field:?}"));
        }
    }
    if let Some(chain) = &input.chain {
        let kind_ok = matches!(chain.kind.as_str(), "eagle1" | "eagle2");
        if !valid_token(&chain.chain_id)
            || !kind_ok
            || chain.step == 0
            || chain.step > chain.total
            || chain.total > 16
        {
            return Err(format!(
                "Hand-off chain is not valid: {} step {} of {}.",
                chain.kind, chain.step, chain.total
            ));
        }
    }
    Ok(())
}

#[tauri::command]
pub fn handoff_save(
    app: tauri::AppHandle,
    input: HandoffSaveInput,
    store: State<Mutex<HandoffStore>>,
    state: State<Mutex<crate::store::StateStore>>,
) -> Result<HandoffRecord, String> {
    validate_handoff_input(&input)?;
    // Records bound to an open or reopenable tab survive the cap.
    let live_tabs: HashSet<String> = {
        let state = state.lock().map_err(|e| e.to_string())?;
        crate::commands::storage::known_tab_ids(&state)
            .into_iter()
            .collect()
    };
    let mut store = store.lock().map_err(|e| e.to_string())?;
    let record = store.insert_keeping(NewHandoff {
        source_tab_id: input.source_tab_id,
        source_role_id: input.source_role_id,
        source_label: input.source_label,
        target_role_id: input.target_role_id,
        title: input.title,
        cwd: input.cwd,
        scope: input.scope,
        plan_text: input.plan_text,
        truncated: input.truncated,
        warning: input.warning,
        plan_field: input.plan_field,
        chain: input.chain,
    }, &live_tabs)?;
    notify_chain(&app, record.chain.as_ref());
    Ok(record)
}

#[tauri::command]
pub fn handoff_bind_tab(
    app: tauri::AppHandle,
    id: String,
    tab_id: String,
    store: State<Mutex<HandoffStore>>,
) -> Result<HandoffRecord, String> {
    let mut store = store.lock().map_err(|e| e.to_string())?;
    let record = store.bind_target(&id, &tab_id)?;
    notify_chain(&app, record.chain.as_ref());
    Ok(record)
}

#[tauri::command]
pub fn handoff_list(store: State<Mutex<HandoffStore>>) -> Result<Vec<HandoffRecord>, String> {
    let store = store.lock().map_err(|e| e.to_string())?;
    Ok(store.list())
}

#[tauri::command]
pub fn handoff_get(id: String, store: State<Mutex<HandoffStore>>) -> Result<HandoffRecord, String> {
    let store = store.lock().map_err(|e| e.to_string())?;
    store
        .get(&id)?
        .ok_or_else(|| format!("unknown hand-off: {id}"))
}

#[cfg(test)]
mod tests {
    use super::{validate_handoff_input, HandoffSaveInput};
    use crate::store::ChainRef;

    fn input() -> HandoffSaveInput {
        HandoffSaveInput {
            source_tab_id: "tab_19a2b".into(),
            source_role_id: "role_planner".into(),
            source_label: "Planner · Login".into(),
            target_role_id: "role_plan_reviewer".into(),
            title: "Login 500".into(),
            cwd: "/Users/me/repo".into(),
            scope: "plan_mode".into(),
            plan_text: "# Plan".into(),
            truncated: false,
            warning: None,
            plan_field: Some("candidatePlan".into()),
            chain: Some(ChainRef {
                chain_id: "ee_1760000000000".into(),
                kind: "eagle1".into(),
                step: 2,
                total: 4,
                round: 1,
            }),
        }
    }

    #[test]
    fn a_normal_hand_off_passes_and_an_empty_source_tab_is_allowed() {
        assert_eq!(validate_handoff_input(&input()), Ok(()));
        let mut no_tab = input();
        no_tab.source_tab_id = String::new();
        no_tab.chain = None;
        no_tab.plan_field = None;
        assert_eq!(validate_handoff_input(&no_tab), Ok(()));
        // A large plan is fine (it spills to a sidecar file).
        let mut big = input();
        big.plan_text = "p".repeat(2_000_000);
        assert_eq!(validate_handoff_input(&big), Ok(()));
    }

    #[test]
    fn bad_hand_offs_are_rejected_with_a_reason() {
        type Breaker = fn(&mut HandoffSaveInput);
        let cases: Vec<(Breaker, &str)> = vec![
            (|i| i.plan_text = "   ".into(), "no plan"),
            (|i| i.target_role_id = String::new(), "target role id"),
            (|i| i.target_role_id = "../roles".into(), "target role id"),
            (|i| i.source_role_id = "x".repeat(200), "source role id"),
            (|i| i.source_tab_id = "tab/../../x".into(), "source tab id"),
            (|i| i.title = "t".repeat(5_000), "title is too long"),
            (|i| i.source_label = "l".repeat(5_000), "source label is too long"),
            (|i| i.cwd = "c".repeat(10_000), "folder is too long"),
            (|i| i.scope = "s".repeat(500), "scope is too long"),
            (|i| i.warning = Some("w".repeat(5_000)), "warning is too long"),
            (|i| i.plan_field = Some("plan field!".into()), "plan field"),
            (|i| i.chain.as_mut().unwrap().kind = "eagle9".into(), "chain is not valid"),
            (|i| i.chain.as_mut().unwrap().step = 0, "chain is not valid"),
            (|i| i.chain.as_mut().unwrap().step = 5, "chain is not valid"),
            (|i| i.chain.as_mut().unwrap().chain_id = "ee 1".into(), "chain is not valid"),
        ];
        for (break_it, reason) in cases {
            let mut bad = input();
            break_it(&mut bad);
            let err = validate_handoff_input(&bad).unwrap_err();
            assert!(err.to_lowercase().contains(reason), "{reason:?} not in {err:?}");
        }
    }
}
