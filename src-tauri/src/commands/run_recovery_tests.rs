use super::*;
use crate::roles::Role;
use crate::store::{AppStateFile, ChainRef, MAIN_WINDOW_ID};
use crate::test_support::TempDir;
use serde_json::{json, Value};

const SID: &str = "7a1b2c3d-4e5f-4a6b-8c7d-0123456789ab";

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

fn record(kind: &str, at: &str, message: Value) -> Value {
    json!({
        "parentUuid": null, "isSidechain": false, "type": kind, "uuid": format!("u-{at}"),
        "timestamp": at, "cwd": "/tmp/project", "sessionId": SID, "version": "2.1.0",
        "message": message,
    })
}

fn prompt(at: &str) -> Value {
    let mut v = record("user", at, json!({ "role": "user", "content": "Implement the plan" }));
    v["permissionMode"] = json!("default");
    v
}

fn reply(at: &str) -> Value {
    record(
        "assistant",
        at,
        json!({ "id": "msg_1", "type": "message", "role": "assistant", "model": "test",
                "content": [{ "type": "text", "text": "Done." }], "stop_reason": "end_turn" }),
    )
}

/// A store whose Eagle-Eye 1 run `ee_r` is at the Implementer with
/// autopilot on, and whose Implementer tab writes `SID` under a temp config
/// folder (never a real account).
struct Fixture {
    dir: TempDir,
    store: Mutex<StateStore>,
    registry: Mutex<PtyRegistry>,
    readers: SessionLogReaders,
    tab: String,
}

impl Fixture {
    fn new(name: &str) -> Self {
        let dir = TempDir::new(name);
        let mut store = StateStore {
            path: dir.join("state.json"),
            data: AppStateFile::default(),
            new_tab_provider: crate::provider::ProviderId::DEFAULT,
            draft_window: MAIN_WINDOW_ID.to_string(),
        };
        let chain = |step: u32| ChainRef {
            chain_id: "ee_r".into(),
            kind: "eagle1".into(),
            step,
            total: 4,
            round: 1,
            lane: None,
        };
        let planner = store.create_draft_tab(&role("role_planner"), "/tmp/p", true, None).unwrap();
        store.set_tab_chain(&planner, Some(chain(1)), None).unwrap();
        let tab = store.create_draft_tab(&role("role_implementer"), "/tmp/p", true, None).unwrap();
        store.set_tab_chain(&tab, Some(chain(3)), Some("the plan")).unwrap();
        let config = dir.join("claude-config");
        assert!(config.starts_with(dir.path()), "pinned to the temp dir");
        store.remember_claude_config(&tab, &config.display().to_string()).unwrap();
        store.remember_claude_terminal_session(&tab, SID).unwrap();
        let run = store.pipeline_run_by_id_mut("ee_r").unwrap();
        run.set_autopilot_enabled(true);
        assert_eq!(run.stage, "implementer");
        Self {
            dir,
            store: Mutex::new(store),
            registry: Mutex::new(PtyRegistry::new()),
            readers: SessionLogReaders::new(),
            tab,
        }
    }

    fn write_log(&self, records: &[Value]) {
        let folder = self.dir.join("claude-config").join("projects").join("-tmp-p");
        std::fs::create_dir_all(&folder).unwrap();
        let body: String = records.iter().map(|r| format!("{r}\n")).collect();
        std::fs::write(folder.join(format!("{SID}.jsonl")), body).unwrap();
    }

    fn status(&self) -> (RunStatus, Option<StopReason>) {
        let store = self.store.lock().unwrap();
        let run = store.pipeline_run_by_id("ee_r").unwrap();
        (run.status, run.stop_reason)
    }

    fn reconcile(&self) -> RecoveryOutcome {
        reconcile_on_startup(&self.store, &self.registry, &self.readers).unwrap()
    }

    fn tick(&self, watch: &mut StallWatch, now: Instant, limit: Duration) -> RecoveryOutcome {
        watchdog_tick(&self.store, &self.registry, &self.readers, watch, now, &|_| limit).unwrap()
    }
}

#[test]
fn startup_puts_a_run_whose_stage_finished_while_closed_in_waiting_and_saves_it() {
    let fx = Fixture::new("recover_after_turn");
    fx.write_log(&[prompt("2026-10-19T10:00:00Z"), reply("2026-10-19T10:01:00Z")]);
    let outcome = fx.reconcile();
    assert_eq!(outcome.changed, vec!["ee_r".to_string()]);
    assert_eq!(outcome.stopped.len(), 1);
    let stop = &outcome.stopped[0];
    assert_eq!((stop.tab_id.as_str(), stop.reason), (fx.tab.as_str(), StopReason::AppRestarted));
    assert_eq!(fx.status(), (RunStatus::Waiting, Some(StopReason::AppRestarted)));
    // Saved: a reopen still waits.
    let again = StateStore::open_path(fx.dir.join("state.json")).unwrap();
    assert_eq!(again.pipeline_run_by_id("ee_r").unwrap().stop_reason, Some(StopReason::AppRestarted));
    // A second reconcile finds nothing running.
    assert_eq!(fx.reconcile(), RecoveryOutcome::default());
}

#[test]
fn startup_leaves_a_mid_turn_or_logless_run_running() {
    let fx = Fixture::new("recover_mid_turn");
    assert_eq!(fx.reconcile(), RecoveryOutcome::default(), "no log yet");
    fx.write_log(&[prompt("2026-10-19T10:00:00Z")]);
    let outcome = fx.reconcile();
    assert_eq!(outcome.changed, vec!["ee_r".to_string()], "the cut-off note is saved");
    assert!(outcome.stopped.is_empty());
    assert_eq!(fx.status(), (RunStatus::Running, None));
}

#[test]
fn continue_runs_the_run_again_and_names_the_tabs_to_decide() {
    let fx = Fixture::new("recover_continue");
    {
        let mut store = fx.store.lock().unwrap();
        assert!(continue_after_restart(&mut store, "ee_r").unwrap_err().contains("not waiting after a restart"));
    }
    fx.write_log(&[prompt("2026-10-19T10:00:00Z"), reply("2026-10-19T10:01:00Z")]);
    fx.reconcile();
    let mut store = fx.store.lock().unwrap();
    assert_eq!(continue_after_restart(&mut store, "ee_r").unwrap(), vec![fx.tab.clone()]);
    let run = store.pipeline_run_by_id("ee_r").unwrap();
    assert_eq!((run.status, run.stop_reason), (RunStatus::Running, None));
    assert!(run.autopilot.as_ref().unwrap().waiting.is_none());
    assert_eq!(run.events.last().unwrap().summary, "Continued by you after the restart");
    assert!(continue_after_restart(&mut store, "ee_r").is_err(), "once");
    assert!(continue_after_restart(&mut store, "nope").is_err());
}

#[test]
fn the_watchdog_stops_a_quiet_working_stage_with_stalled_once() {
    let fx = Fixture::new("watchdog_stall");
    fx.write_log(&[prompt("2026-10-19T10:00:00Z")]);
    let limit = Duration::from_secs(30 * 60);
    let t0 = Instant::now();
    let mut watch = StallWatch::new();
    assert_eq!(fx.tick(&mut watch, t0, limit), RecoveryOutcome::default());
    assert_eq!(fx.tick(&mut watch, t0 + Duration::from_secs(29 * 60), limit), RecoveryOutcome::default());
    let outcome = fx.tick(&mut watch, t0 + limit, limit);
    assert_eq!(outcome.changed, vec!["ee_r".to_string()]);
    assert_eq!(outcome.stopped[0].reason, StopReason::Stalled);
    assert!(outcome.stopped[0].summary.starts_with("Implementer has been quiet for 30 minutes"));
    assert_eq!(fx.status(), (RunStatus::Waiting, Some(StopReason::Stalled)));
    // Waiting now: nothing more is watched or stopped.
    assert_eq!(fx.tick(&mut watch, t0 + limit * 2, limit), RecoveryOutcome::default());
    assert!(watch.is_empty());
}

#[test]
fn log_growth_or_a_finished_turn_keeps_the_watchdog_quiet() {
    let fx = Fixture::new("watchdog_growth");
    fx.write_log(&[prompt("2026-10-19T10:00:00Z")]);
    let limit = Duration::from_secs(60);
    let t0 = Instant::now();
    let mut watch = StallWatch::new();
    fx.tick(&mut watch, t0, limit);
    let tool = record(
        "assistant",
        "2026-10-19T10:00:30Z",
        json!({ "id": "msg_2", "type": "message", "role": "assistant", "model": "test",
                "content": [{ "type": "tool_use", "id": "toolu_1", "name": "Bash", "input": { "command": "npm test" } }],
                "stop_reason": "tool_use" }),
    );
    fx.write_log(&[prompt("2026-10-19T10:00:00Z"), tool.clone()]);
    assert_eq!(fx.tick(&mut watch, t0 + Duration::from_secs(50), limit), RecoveryOutcome::default());
    assert_eq!(fx.tick(&mut watch, t0 + Duration::from_secs(100), limit), RecoveryOutcome::default(), "grew at 50 s");
    let result = record(
        "user",
        "2026-10-19T10:01:30Z",
        json!({ "role": "user", "content": [{ "tool_use_id": "toolu_1", "type": "tool_result", "content": "ok", "is_error": false }] }),
    );
    fx.write_log(&[prompt("2026-10-19T10:00:00Z"), tool, result, reply("2026-10-19T10:02:00Z")]);
    assert_eq!(fx.tick(&mut watch, t0 + Duration::from_secs(500), limit), RecoveryOutcome::default());
    assert!(watch.is_empty(), "a finished turn is not watched");
    assert_eq!(fx.status(), (RunStatus::Running, None));
}

#[test]
fn recovery_reads_logs_with_no_store_lock_held() {
    // Review rule (store/mod.rs): the reads happen between the two locks.
    let source = include_str!("run_recovery.rs");
    for name in ["fn reconcile_on_startup(", "fn watchdog_tick("] {
        let body = &source[source.find(name).unwrap()..];
        let body = &body[..body.find("\n}\n").unwrap()];
        let read = body.find("read_log(readers").expect("reads logs");
        let lock = body.find("store.lock()").expect("locks to write back");
        assert!(read < lock, "{name} reads logs under the store lock");
    }
}

fn stop(run_id: &str) -> AutopilotStopped {
    AutopilotStopped {
        run_id: run_id.into(),
        tab_id: "impl".into(),
        reason: StopReason::AppRestarted,
        summary: "Implementer finished while the app was closed".into(),
    }
}

#[test]
fn a_stop_found_before_the_frontend_listens_is_delivered_once_when_it_asks() {
    let stops = StartupStops::default();
    let mut emitted = Vec::new();
    // The startup reconcile runs before the webview has subscribed.
    stops.deliver(vec![stop("ee_1")], |s| emitted.push(s));
    assert!(emitted.is_empty(), "nobody is listening yet, so it is held");
    // The frontend has attached its listener and asks for what it missed.
    assert_eq!(stops.take(), vec![stop("ee_1")]);
    assert!(stops.take().is_empty(), "delivered once");
    // From then on, a stop is an event at once (a later stall, or a reloaded webview).
    stops.deliver(vec![stop("ee_2")], |s| emitted.push(s));
    assert_eq!(emitted, vec![stop("ee_2")]);
    assert!(stops.take().is_empty());
}
