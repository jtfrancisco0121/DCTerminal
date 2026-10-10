//! `chain-run-updated`: tells open chain overviews to refetch their run.
//! Sent after a command changes something an overview shows: a stage tab,
//! hand-off text, stage, plan, the step-1 request, or a stage tab's phase.

use crate::store::{ChainRef, StateStore};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};

pub const CHAIN_RUN_UPDATED_EVENT: &str = "chain-run-updated";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainRunUpdated {
    /// Run id; for an Eagle-Eye chain this is also its chain id.
    pub chain_id: String,
}

/// Where the event goes. `AppHandle` in the app; tests record the calls.
pub trait ChainEvents {
    fn chain_run_updated(&self, chain_id: &str);
}

impl<R: Runtime> ChainEvents for AppHandle<R> {
    fn chain_run_updated(&self, chain_id: &str) {
        let payload = ChainRunUpdated {
            chain_id: chain_id.to_string(),
        };
        let _ = self.emit(CHAIN_RUN_UPDATED_EVENT, payload);
    }
}

/// The overview that lists `tab_id`, if any, refetches.
pub fn notify_tab(events: &dyn ChainEvents, store: &StateStore, tab_id: &str) {
    if let Some(run_id) = store.overview_run_for_tab(tab_id) {
        events.chain_run_updated(&run_id);
    }
}

pub fn notify_chain(events: &dyn ChainEvents, chain: Option<&ChainRef>) {
    if let Some(chain) = chain {
        events.chain_run_updated(&chain.chain_id);
    }
}

/// `set_tab_chain`, then tell the chain it left (if any) and the one it joined.
pub fn set_tab_chain_and_notify(
    events: &dyn ChainEvents,
    store: &mut StateStore,
    tab_id: &str,
    chain: Option<ChainRef>,
    handoff_text: Option<&str>,
) -> Result<(), String> {
    let before = store.overview_run_for_tab(tab_id);
    store.set_tab_chain(tab_id, chain, handoff_text)?;
    let after = store.overview_run_for_tab(tab_id);
    if let Some(old) = before.filter(|old| after.as_ref() != Some(old)) {
        events.chain_run_updated(&old);
    }
    if let Some(run_id) = after {
        events.chain_run_updated(&run_id);
    }
    Ok(())
}

/// Only the step-1 form feeds the overview (its original request).
pub fn notify_form_sync(events: &dyn ChainEvents, store: &StateStore, tab_id: &str) {
    let first_step = store
        .tab_by_id(tab_id)
        .and_then(|tab| tab.chain.as_ref())
        .is_some_and(|chain| chain.step == 1);
    if first_step {
        notify_tab(events, store, tab_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::roles::Role;
    use crate::store::{AppStateFile, MAIN_WINDOW_ID};
    use chrono::Utc;
    use std::cell::RefCell;

    #[derive(Default)]
    struct Recorded(RefCell<Vec<String>>);

    impl ChainEvents for Recorded {
        fn chain_run_updated(&self, chain_id: &str) {
            self.0.borrow_mut().push(chain_id.to_string());
        }
    }

    impl Recorded {
        fn take(&self) -> Vec<String> {
            self.0.borrow_mut().drain(..).collect()
        }
    }

    fn store(name: &str) -> StateStore {
        let dir = std::env::temp_dir().join(format!(
            "dct_chain_events_{name}_{}",
            Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        StateStore {
            path: dir.join("state.json"),
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

    fn chain(id: &str, step: u32) -> ChainRef {
        serde_json::from_value(serde_json::json!({
            "chainId": id, "kind": "eagle1", "step": step, "total": 4
        }))
        .unwrap()
    }

    #[test]
    fn payload_is_camel_case_chain_id() {
        let payload = ChainRunUpdated {
            chain_id: "ee_1".into(),
        };
        assert_eq!(
            serde_json::to_value(&payload).unwrap(),
            serde_json::json!({ "chainId": "ee_1" })
        );
        assert_eq!(CHAIN_RUN_UPDATED_EVENT, "chain-run-updated");
    }

    #[test]
    fn tagging_and_clearing_a_chain_notify_that_chain() {
        let events = Recorded::default();
        let mut store = store("tag");
        let planner = store
            .create_draft_tab(&role("role_planner"), "/tmp/p", true, None)
            .unwrap();
        let reviewer = store
            .create_draft_tab(&role("role_plan_reviewer"), "/tmp/p", true, None)
            .unwrap();
        set_tab_chain_and_notify(&events, &mut store, &planner, Some(chain("ee_1", 1)), None)
            .unwrap();
        set_tab_chain_and_notify(
            &events,
            &mut store,
            &reviewer,
            Some(chain("ee_1", 2)),
            Some("the plan"),
        )
        .unwrap();
        assert_eq!(events.take(), vec!["ee_1", "ee_1"]);
        set_tab_chain_and_notify(&events, &mut store, &reviewer, None, None).unwrap();
        assert_eq!(events.take(), vec!["ee_1"]);
        // Moving a tab to another chain tells both overviews.
        let other = store
            .create_draft_tab(&role("role_planner"), "/tmp/p", true, None)
            .unwrap();
        set_tab_chain_and_notify(&events, &mut store, &other, Some(chain("ee_2", 1)), None)
            .unwrap();
        events.take();
        store.data.tabs.iter_mut().find(|t| t.id == other).unwrap().chain =
            Some(chain("ee_1", 1));
        set_tab_chain_and_notify(&events, &mut store, &other, Some(chain("ee_2", 1)), None)
            .unwrap();
        assert_eq!(events.take(), vec!["ee_1", "ee_2"]);
        // A failed tag sends nothing.
        assert!(set_tab_chain_and_notify(&events, &mut store, "nope", None, None).is_err());
        assert!(events.take().is_empty());
    }

    #[test]
    fn phase_and_form_changes_notify_only_chained_tabs() {
        let events = Recorded::default();
        let mut store = store("phase");
        let planner = store
            .create_draft_tab(&role("role_planner"), "/tmp/p", true, None)
            .unwrap();
        let reviewer = store
            .create_draft_tab(&role("role_plan_reviewer"), "/tmp/p", true, None)
            .unwrap();
        let loose = store
            .create_draft_tab(&role("role_planner"), "/tmp/p", true, None)
            .unwrap();
        store.set_tab_chain(&planner, Some(chain("ee_3", 1)), None).unwrap();
        store
            .set_tab_chain(&reviewer, Some(chain("ee_3", 2)), Some("plan"))
            .unwrap();
        store.mark_tab_awaiting_input(&reviewer, None).unwrap();
        notify_tab(&events, &store, &reviewer);
        notify_tab(&events, &store, &loose);
        assert_eq!(events.take(), vec!["ee_3"]);
        notify_form_sync(&events, &store, &planner);
        notify_form_sync(&events, &store, &reviewer);
        notify_form_sync(&events, &store, &loose);
        assert_eq!(events.take(), vec!["ee_3"]);
        notify_chain(&events, Some(&chain("ee_4", 2)));
        notify_chain(&events, None);
        assert_eq!(events.take(), vec!["ee_4"]);
    }

    #[test]
    fn palette_pipeline_tabs_notify_their_run() {
        let events = Recorded::default();
        let mut store = store("palette");
        let tab = store
            .create_draft_tab(&role("role_planner"), "/tmp/p", true, None)
            .unwrap();
        store.data.pipeline_runs.push(
            serde_json::from_value(serde_json::json!({
                "id": "run_a", "kind": "full", "cwd": "/tmp/p", "stage": "planner",
                "overviewTabId": "", "tabIds": { "role_planner": tab },
                "createdAt": Utc::now().to_rfc3339()
            }))
            .unwrap(),
        );
        notify_tab(&events, &store, &tab);
        assert_eq!(events.take(), vec!["run_a"]);
    }
}
