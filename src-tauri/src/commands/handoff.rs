//! Save and reload Planner hand-offs from app data.

use crate::commands::chain_events::{notify_chain, set_tab_chain_and_notify, ChainEvents};
use crate::store::{ChainRef, HandoffRecord, HandoffStore, NewHandoff, StateStore};
use serde::{Deserialize, Serialize};
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
    check_len(
        "warning",
        input.warning.as_deref().unwrap_or(""),
        MAX_TEXT_CHARS,
    )?;
    check_len("scope", &input.scope, MAX_ID_CHARS)?;
    check_len("folder", &input.cwd, MAX_CWD_CHARS)?;
    if let Some(field) = input.plan_field.as_deref() {
        if !valid_token(field) {
            return Err(format!("Hand-off plan field is not valid: {field:?}"));
        }
    }
    if let Some(chain) = &input.chain {
        let kind_ok = crate::pipelines::find(&chain.kind).is_some();
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
    let record = store.insert_keeping(
        NewHandoff {
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
        },
        &live_tabs,
    )?;
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

/// A reviewer's round going back to an earlier stage (`chain_loop_back`).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopBackInput {
    pub chain_id: String,
    pub reviewer_role_id: String,
    #[serde(default)]
    pub verdict: Option<String>,
    /// The fanned-out pull request whose round goes back, if any.
    #[serde(default)]
    pub lane: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffAttachInput {
    pub id: String,
    pub tab_id: String,
    /// The chain step the new tab takes (`advanceChain`).
    #[serde(default)]
    pub chain: Option<ChainRef>,
    /// Or: this hand-off sends a reviewer's round back.
    #[serde(default)]
    pub loop_back: Option<LoopBackInput>,
    /// What the hand-off sent, for the chain's run.
    #[serde(default)]
    pub handoff_text: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffAttached {
    pub record: HandoffRecord,
    /// The chain the tab now carries, if any.
    pub chain: Option<ChainRef>,
}

/// Bind a saved hand-off to the tab it opened and record that tab's chain
/// step (or the loop-back round) in one call, so the two cannot be left
/// half done by a failure between two frontend calls. The hand-off id is
/// checked first; nothing is written when it is unknown.
pub fn attach_handoff(
    events: &dyn ChainEvents,
    state: &Mutex<StateStore>,
    handoffs: &Mutex<HandoffStore>,
    input: HandoffAttachInput,
) -> Result<HandoffAttached, String> {
    if !handoffs
        .lock()
        .map_err(|e| e.to_string())?
        .contains(&input.id)
    {
        return Err(format!("unknown hand-off: {}", input.id));
    }
    let text = input.handoff_text.as_deref();
    let chain = {
        let mut store = state.lock().map_err(|e| e.to_string())?;
        if store.tab_by_id(&input.tab_id).is_none() {
            return Err(format!("unknown tab: {}", input.tab_id));
        }
        if let Some(back) = &input.loop_back {
            let chain = store.chain_loop_back_in(
                back.chain_id.trim(),
                back.lane.as_deref(),
                &back.reviewer_role_id,
                &input.tab_id,
                back.verdict.as_deref(),
                text,
            )?;
            notify_chain(events, Some(&chain));
            Some(chain)
        } else if let Some(chain) = input.chain.clone() {
            set_tab_chain_and_notify(events, &mut store, &input.tab_id, Some(chain.clone()), text)?;
            Some(chain)
        } else {
            None
        }
    };
    let record = handoffs
        .lock()
        .map_err(|e| e.to_string())?
        .bind_target(&input.id, &input.tab_id)?;
    notify_chain(events, record.chain.as_ref());
    Ok(HandoffAttached { record, chain })
}

#[tauri::command]
pub fn handoff_attach(
    app: tauri::AppHandle,
    input: HandoffAttachInput,
    state: State<Mutex<StateStore>>,
    handoffs: State<Mutex<HandoffStore>>,
) -> Result<HandoffAttached, String> {
    attach_handoff(&app, &state, &handoffs, input)
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
                lane: None,
            }),
        }
    }

    mod attach {
        use super::super::{attach_handoff, HandoffAttachInput, LoopBackInput};
        use crate::commands::chain_events::ChainEvents;
        use crate::roles::Role;
        use crate::store::{
            AppStateFile, ChainRef, HandoffStore, NewHandoff, StateStore, MAIN_WINDOW_ID,
        };
        use std::cell::RefCell;
        use std::collections::HashSet;
        use std::sync::Mutex;

        #[derive(Default)]
        struct Recorded(RefCell<Vec<String>>);
        impl ChainEvents for Recorded {
            fn chain_run_updated(&self, chain_id: &str) {
                self.0.borrow_mut().push(chain_id.to_string());
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

        fn chain(step: u32) -> ChainRef {
            ChainRef {
                chain_id: "ee_1".into(),
                kind: "eagle1".into(),
                step,
                total: 4,
                round: 1,
                lane: None,
            }
        }

        fn stores(
            name: &str,
        ) -> (
            crate::test_support::TempDir,
            Mutex<StateStore>,
            Mutex<HandoffStore>,
        ) {
            let dir = crate::test_support::TempDir::new(name);
            let state = StateStore {
                path: dir.path().join("state.json"),
                data: AppStateFile::default(),
                new_tab_provider: crate::provider::ProviderId::DEFAULT,
                draft_window: MAIN_WINDOW_ID.to_string(),
            };
            let handoffs = HandoffStore::open(dir.path()).unwrap();
            (dir, Mutex::new(state), Mutex::new(handoffs))
        }

        fn save(handoffs: &Mutex<HandoffStore>, source: &str, target_role: &str) -> String {
            handoffs
                .lock()
                .unwrap()
                .insert_keeping(
                    NewHandoff {
                        source_tab_id: source.into(),
                        source_role_id: "role_planner".into(),
                        source_label: "Planner".into(),
                        target_role_id: target_role.into(),
                        title: "Login".into(),
                        cwd: "/tmp/p".into(),
                        scope: "plan_mode".into(),
                        plan_text: "# Plan".into(),
                        truncated: false,
                        warning: None,
                        plan_field: None,
                        chain: Some(chain(2)),
                    },
                    &HashSet::new(),
                )
                .unwrap()
                .id
        }

        #[test]
        fn binds_the_tab_and_records_its_chain_step_together() {
            let (_dir, state, handoffs) = stores("attach_step");
            let events = Recorded::default();
            let (planner, reviewer) = {
                let mut s = state.lock().unwrap();
                let planner = s
                    .create_draft_tab(&role("role_planner"), "/tmp/p", true, None)
                    .unwrap();
                s.set_tab_chain(&planner, Some(chain(1)), None).unwrap();
                let reviewer = s
                    .create_draft_tab(&role("role_plan_reviewer"), "/tmp/p", true, None)
                    .unwrap();
                (planner, reviewer)
            };
            let id = save(&handoffs, &planner, "role_plan_reviewer");
            let attached = attach_handoff(
                &events,
                &state,
                &handoffs,
                HandoffAttachInput {
                    id: id.clone(),
                    tab_id: reviewer.clone(),
                    chain: Some(chain(2)),
                    loop_back: None,
                    handoff_text: Some("# Plan".into()),
                },
            )
            .unwrap();
            assert_eq!(
                attached.record.target_tab_id.as_deref(),
                Some(reviewer.as_str())
            );
            assert_eq!(attached.chain.unwrap().step, 2);
            let s = state.lock().unwrap();
            assert_eq!(
                s.tab_by_id(&reviewer).unwrap().chain.as_ref().unwrap().step,
                2
            );
            let run = s.pipeline_run_by_id("ee_1").unwrap();
            assert_eq!(run.tab_ids.get("role_plan_reviewer"), Some(&reviewer));
            assert_eq!(run.handoffs["role_plan_reviewer"].text, "# Plan");
            assert!(!events.0.borrow().is_empty());
        }

        #[test]
        fn an_unknown_hand_off_changes_nothing() {
            let (_dir, state, handoffs) = stores("attach_unknown");
            let events = Recorded::default();
            let reviewer = state
                .lock()
                .unwrap()
                .create_draft_tab(&role("role_plan_reviewer"), "/tmp/p", true, None)
                .unwrap();
            let err = attach_handoff(
                &events,
                &state,
                &handoffs,
                HandoffAttachInput {
                    id: "handoff_missing".into(),
                    tab_id: reviewer.clone(),
                    chain: Some(chain(2)),
                    loop_back: None,
                    handoff_text: None,
                },
            )
            .unwrap_err();
            assert!(err.contains("unknown hand-off"), "{err}");
            let s = state.lock().unwrap();
            assert!(s.tab_by_id(&reviewer).unwrap().chain.is_none());
            assert!(s.pipeline_run_by_id("ee_1").is_none());
            assert!(events.0.borrow().is_empty());
        }

        #[test]
        fn a_loop_back_records_the_verdict_and_next_round() {
            let (_dir, state, handoffs) = stores("attach_loop");
            let events = Recorded::default();
            let (planner, reviewer, again) = {
                let mut s = state.lock().unwrap();
                let planner = s
                    .create_draft_tab(&role("role_planner"), "/tmp/p", true, None)
                    .unwrap();
                s.set_tab_chain(&planner, Some(chain(1)), None).unwrap();
                let reviewer = s
                    .create_draft_tab(&role("role_plan_reviewer"), "/tmp/p", true, None)
                    .unwrap();
                s.set_tab_chain(&reviewer, Some(chain(2)), None).unwrap();
                let again = s
                    .create_draft_tab(&role("role_planner"), "/tmp/p", true, None)
                    .unwrap();
                (planner, reviewer, again)
            };
            let _ = planner;
            let id = save(&handoffs, &reviewer, "role_planner");
            let attached = attach_handoff(
                &events,
                &state,
                &handoffs,
                HandoffAttachInput {
                    id,
                    tab_id: again.clone(),
                    chain: None,
                    loop_back: Some(LoopBackInput {
                        chain_id: "ee_1".into(),
                        reviewer_role_id: "role_plan_reviewer".into(),
                        verdict: Some("REQUIRES REVISION".into()),
                        lane: None,
                    }),
                    handoff_text: Some("findings".into()),
                },
            )
            .unwrap();
            let chain = attached.chain.unwrap();
            assert_eq!((chain.step, chain.round), (1, 2));
            let s = state.lock().unwrap();
            let run = s.pipeline_run_by_id("ee_1").unwrap();
            assert_eq!(run.round, 2);
            assert_eq!(
                run.verdicts[0].verdict.as_deref(),
                Some("REQUIRES REVISION")
            );
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
            (
                |i| i.source_label = "l".repeat(5_000),
                "source label is too long",
            ),
            (|i| i.cwd = "c".repeat(10_000), "folder is too long"),
            (|i| i.scope = "s".repeat(500), "scope is too long"),
            (
                |i| i.warning = Some("w".repeat(5_000)),
                "warning is too long",
            ),
            (|i| i.plan_field = Some("plan field!".into()), "plan field"),
            (
                |i| i.chain.as_mut().unwrap().kind = "eagle9".into(),
                "chain is not valid",
            ),
            (|i| i.chain.as_mut().unwrap().step = 0, "chain is not valid"),
            (|i| i.chain.as_mut().unwrap().step = 5, "chain is not valid"),
            (
                |i| i.chain.as_mut().unwrap().chain_id = "ee 1".into(),
                "chain is not valid",
            ),
        ];
        for (break_it, reason) in cases {
            let mut bad = input();
            break_it(&mut bad);
            let err = validate_handoff_input(&bad).unwrap_err();
            assert!(
                err.to_lowercase().contains(reason),
                "{reason:?} not in {err:?}"
            );
        }
    }
}
