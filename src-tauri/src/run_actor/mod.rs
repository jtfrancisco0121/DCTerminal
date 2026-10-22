//! The run actor (pipeline v2 V3, decisions D16, D18, D20): the one owner of
//! an engine-2 run. One thread per active run receives every message about
//! it, one at a time, and is the only thing that acts on it:
//!
//! - a finished turn the bridge dropped in the run's inbox (`watch`),
//! - your buttons on the run (Send, Send back, Approve, Continue, and Take
//!   over / Hand back of a stage, V5),
//! - the results of the gates it started, and
//! - a stage terminal that exited.
//!
//! It records each finished turn, runs the stage's gates on a thread of its
//! own (never inside the Stop hook, D16), asks `pipelines::autopilot::decide`
//! what to do, and does it: opens the next stage's terminal with a prompt it
//! builds from the role template and the run folder's files (`prompts`),
//! sends a round back or a failed check's output to the stage that must act,
//! starts lanes that were waiting, or stops and tells you why.
//!
//! Sending to a stage resumes it (V4, D17): its `claude` is stopped
//! (SIGTERM, SIGKILL after 10 s) and `claude --resume <session>` starts in
//! the same terminal with the same flags and a short prompt, pointing at
//! the round's `findings-<stage>-r<N>.json` or carrying the check's output.
//! The tab and its view stay. Only a stage with no saved session gets a
//! paste, which clears the input box first (D40).
//! Handling one message at a time, plus the decided-turn list on the run,
//! replaced the frontend's claims (removed with the v1 autopilot in V6):
//! your Send and autopilot's hand-off can no longer race, because both are
//! messages here. An engine-1 run is manual only, so nothing races there.
//! The run's hand-off records (`claims`) still say who made a hand-off, so
//! a Send after autopilot made the same one warns once.
//!
//! A stage you took over (V5, D28) is yours: its `mode` file says
//! `takeover`, so its bridge enforces no result and its terminal takes your
//! keystrokes; its turns are recorded but not decided, and its exit or a
//! stall there does not stop the run. Hand back puts it on autopilot again
//! and decides at once a current turn that already has a result.
//!
//! The actor reaches the app through [`Host`]: the store, the role
//! templates, starting and pasting into terminals, running gates, usage and
//! the events the frontend listens to. `app_host` is the app's; the tests
//! give their own (a recording host, and `fake_claude` terminals in
//! `tests/fake_claude.rs`).
//!
//! A thread exits when its run completes, when its run is gone, or after
//! [`IDLE_EXIT`] with nothing to do; the next message starts a new one. A
//! panic while handling a message stops the run (`stopped`, reason
//! `carry_out_failed`) and ends the thread; the stage terminals keep
//! running, so you can carry on by hand (plan "Risks": actor thread panics).

mod actor;
pub(crate) mod app_host;
pub(crate) mod prompts;
#[cfg(test)]
mod tests;

use crate::bridge::{BridgeTurn, StageMode};
use crate::pipelines::{GateDef, GateResult};
use crate::roles::Role;
use crate::store::{StateStore, StopReason};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// A run's thread exits after this long with no message and no gate running.
pub const IDLE_EXIT: Duration = Duration::from_secs(10 * 60);
/// How long a button waits for its run's actor to answer.
pub const USER_REPLY_TIMEOUT: Duration = Duration::from_secs(120);

/// One message to a run's actor.
#[derive(Debug)]
pub enum ActorMsg {
    /// A bridged stage finished a turn (the Stop hook's inbox event).
    Turn(BridgeTurn),
    /// A button on the run. `reply` hears what came of it.
    User {
        action: UserAction,
        reply: Option<Sender<Result<UserOutcome, String>>>,
    },
    /// The gates the actor started for a stage's turn finished.
    GatesDone {
        turn: BridgeTurn,
        /// The run's (or lane's) round when the turn was taken up.
        round: u32,
        results: Vec<GateResult>,
    },
    /// A stage terminal's program exited.
    Exited { tab_id: String, code: Option<i32> },
}

/// Your buttons on an engine-2 run (D18).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum UserAction {
    /// Hand `source_tab_id`'s turn on to the next stage (`target_role_id`).
    /// `values` and `handoff_plan` are the hand-off form as you left it
    /// (D20); left out, the actor fills it from the run folder. `force`
    /// makes a hand-off autopilot already made.
    #[serde(rename = "send", rename_all = "camelCase")]
    Send {
        source_tab_id: String,
        target_role_id: String,
        #[serde(default)]
        values: Option<HashMap<String, String>>,
        #[serde(default)]
        handoff_plan: Option<String>,
        /// The text recorded as this hand-off on the run (the form's plan).
        #[serde(default)]
        handoff_text: Option<String>,
        #[serde(default)]
        force: bool,
    },
    /// Send `source_tab_id`'s (a reviewer's) round back to the earlier stage
    /// `target_role_id`: `text` goes into that stage's terminal while it
    /// runs, else a new terminal opens with `values` (or values the actor
    /// fills in).
    #[serde(rename = "sendBack", rename_all = "camelCase")]
    SendBack {
        source_tab_id: String,
        target_role_id: String,
        text: String,
        #[serde(default)]
        verdict: Option<String>,
        #[serde(default)]
        values: Option<HashMap<String, String>>,
        #[serde(default)]
        handoff_plan: Option<String>,
        #[serde(default)]
        force: bool,
    },
    /// Mark a lane approved (or, with no lane, the run complete), then start
    /// the lanes that unblocks.
    #[serde(rename = "approve", rename_all = "camelCase")]
    Approve {
        #[serde(default)]
        lane: Option<String>,
    },
    /// Continue after a restart: run again and decide the turns the current
    /// stage finished while the app was closed.
    #[serde(rename = "continue")]
    Continue,
    /// Take the stage terminal `tab_id` over (V5, D28): you drive it now.
    /// Its bridge stops enforcing a result and the actor stops deciding its
    /// turns; you can type into its Watch view.
    #[serde(rename = "takeOver", rename_all = "camelCase")]
    TakeOver { tab_id: String },
    /// Hand a stage you took over back to autopilot: enforcement and
    /// decisions are on again, and a turn that already has a result is
    /// decided at once.
    #[serde(rename = "handBack", rename_all = "camelCase")]
    HandBack { tab_id: String },
    /// What your Send from `source_tab_id` to the next stage would carry,
    /// built from the run folder's files (D20), for the hand-off form to
    /// show before you send. Changes nothing.
    #[serde(rename = "prefill", rename_all = "camelCase")]
    Prefill { source_tab_id: String, target_role_id: String },
    /// Record a hand-off on (or, `back`, a send-back) from `source_tab_id`
    /// that you make yourself outside the actor (to a Chat tab), as your
    /// Send records it: a warning when autopilot made it already (`force`
    /// records it anyway), and autopilot leaves that turn to you.
    #[serde(rename = "recordHandoff", rename_all = "camelCase")]
    RecordHandoff {
        source_tab_id: String,
        #[serde(default)]
        back: bool,
        #[serde(default)]
        force: bool,
    },
    /// Drop the record `RecordHandoff` made, when that hand-off failed.
    #[serde(rename = "releaseHandoff", rename_all = "camelCase")]
    ReleaseHandoff {
        source_tab_id: String,
        #[serde(default)]
        back: bool,
    },
    /// **Continue** at a checkpoint story (L3) in `lane` (`None`: the run's
    /// own Implementer): `story` is done with your `note`, which goes on to
    /// the next story; `add` holds stories to add after it, one title per
    /// line. The stage's session is resumed with the next story.
    #[serde(rename = "storyContinue", rename_all = "camelCase")]
    ContinueStory {
        #[serde(default)]
        lane: Option<String>,
        story: String,
        #[serde(default)]
        note: Option<String>,
        #[serde(default)]
        add: Option<String>,
    },
    /// **Resend story** (L3): the run stopped mid-loop in `lane`; the
    /// current story is sent to the Implementer's session again, and the
    /// run runs.
    #[serde(rename = "storyResend", rename_all = "camelCase")]
    ResendStory {
        #[serde(default)]
        lane: Option<String>,
    },
    /// Your answer to the `verify` gate the run waits on (L2), for
    /// `stage_id` in `lane`: **Mark verified** (`verified`) passes it and the
    /// run goes on as after a passed gate; **Failed** sends `note` back to
    /// that stage as a round, counted toward its gate retries.
    #[serde(rename = "verify", rename_all = "camelCase")]
    Verify {
        stage_id: String,
        #[serde(default)]
        lane: Option<String>,
        verified: bool,
        #[serde(default)]
        note: Option<String>,
    },
}

/// A hand-off form filled from the run folder (`UserAction::Prefill`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prefill {
    /// The next stage's form values (no `cwd`).
    pub values: HashMap<String, String>,
    /// The text recorded as the hand-off on the run.
    pub handoff_text: String,
}

/// What a button did.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserOutcome {
    /// The terminal it opened or sent into.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    /// Nothing was done: autopilot made this hand-off already. Pressing the
    /// button again with `force` makes it anyway.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
    /// Approve: the run is complete now.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub complete: bool,
    /// Approve: lanes it started.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub started: Vec<String>,
    /// Prefill: the form from the run folder (boxed: most outcomes carry none).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prefill: Option<Box<Prefill>>,
}

/// A stage terminal the actor wants started. The host turns it into the
/// real command (`claude` with the account, model and permission mode the
/// role is set to) and starts it with no view attached.
#[derive(Debug, Clone, PartialEq)]
pub struct StageLaunch {
    pub run_id: String,
    pub tab_id: String,
    pub role_id: String,
    pub cwd: PathBuf,
    /// The startup prompt: the merged role template.
    pub prompt: String,
    /// The Claude session id the terminal is pinned to (`--session-id`).
    pub session_id: String,
    /// The bridge flags (`bridge::launch::launch_flags`): its args go before
    /// the prompt and its hooks join the launch's one `--settings`. `None`
    /// when the D24 gate sent the run to engine 1.
    pub bridge: Option<crate::bridge::launch::BridgeFlags>,
}

/// What the actor needs from the app. Every method is quick except
/// `run_gate`, which the actor calls on a thread of its own.
pub trait Host: Send + Sync + 'static {
    fn store(&self) -> &Mutex<StateStore>;
    /// `<app data>/runs`.
    fn runs_root(&self) -> PathBuf;
    /// The executable the bridge runs as (`dcterminal`).
    fn bridge_program(&self) -> Option<PathBuf>;
    fn role(&self, role_id: &str) -> Option<Role>;
    /// D24 and hooks-off for a stage the actor is about to open bridged
    /// (`stage_key` of `run_id`, in `cwd`): true to launch it bridged. An
    /// engine-1 outcome switches the run for good, with its notice.
    fn bridge_gate(&self, run_id: &str, stage_key: &str, cwd: &Path) -> Result<bool, String>;
    /// Start a stage terminal (see [`StageLaunch`]).
    fn spawn_stage(&self, launch: &StageLaunch) -> Result<(), String>;
    /// Resume a stage terminal's session (V4, D17): stop its program
    /// (SIGTERM, then SIGKILL after 10 s), then start `claude --resume
    /// <session_id>` in the same terminal with the same flags and `prompt`
    /// as its next turn. A view on the terminal stays on it. Blocking.
    fn resume_stage(&self, launch: &StageLaunch) -> Result<(), String>;
    /// Paste `text` into a running terminal and press Enter.
    fn paste(&self, tab_id: &str, text: &str) -> Result<(), String>;
    /// The terminal's program is running.
    fn terminal_live(&self, tab_id: &str) -> bool;
    fn run_gate(&self, gate: &GateDef, folder: &Path, pr_urls: &[String]) -> GateResult;
    /// The highest Claude usage window of the run's account, in percent, when known.
    fn usage_percent(&self, run_id: &str) -> Option<u8>;
    /// The usage-limit error in the stage terminal's session log for its
    /// latest turn (H5), if Claude refused it. Read with no store lock held.
    fn rate_limit(&self, tab_id: &str) -> Option<String>;
    /// The run changed: open overviews refetch it.
    fn run_changed(&self, run_id: &str);
    /// The actor opened a terminal tab: the frontend lists it.
    fn tab_opened(&self, run_id: &str, tab_id: &str);
    /// Autopilot stopped the run: tell you (toast and notification).
    fn stopped(&self, run_id: &str, tab_id: Option<&str>, reason: StopReason, summary: &str);
    /// Something you should hear about (the run is complete).
    fn notice(&self, run_id: &str, title: &str, body: &str);
    /// Settings › Repos now (L1): a Planner's prompt lists them, the run
    /// folder's `repos.json` gets them, and a lane is started only while its
    /// repo is still there. None by default (a host with no settings).
    fn repos(&self) -> Vec<crate::store::RepoEntry> {
        Vec::new()
    }
}

type Senders = HashMap<String, Sender<ActorMsg>>;

/// Every running actor, by run id. Cheap to clone.
pub struct RunActors<H: Host> {
    host: Arc<H>,
    senders: Arc<Mutex<Senders>>,
    idle: Duration,
}

impl<H: Host> Clone for RunActors<H> {
    fn clone(&self) -> Self {
        Self {
            host: self.host.clone(),
            senders: self.senders.clone(),
            idle: self.idle,
        }
    }
}

impl<H: Host> RunActors<H> {
    pub fn new(host: Arc<H>) -> Self {
        Self::with_idle(host, IDLE_EXIT)
    }

    /// [`new`](Self::new) with another idle limit (tests).
    pub fn with_idle(host: Arc<H>, idle: Duration) -> Self {
        Self {
            host,
            senders: Arc::new(Mutex::new(HashMap::new())),
            idle,
        }
    }

    pub fn host(&self) -> &Arc<H> {
        &self.host
    }

    /// Hand `msg` to `run_id`'s actor, starting one when none runs.
    pub fn send(&self, run_id: &str, msg: ActorMsg) {
        let mut senders = lock(&self.senders);
        let msg = match senders.get(run_id) {
            Some(tx) => match tx.send(msg) {
                Ok(()) => return,
                // The thread ended (a panic): a new one takes the message.
                Err(err) => err.0,
            },
            None => msg,
        };
        let (tx, rx) = channel();
        let _ = tx.send(msg);
        senders.insert(run_id.to_string(), tx.clone());
        drop(senders);
        self.start(run_id.to_string(), tx, rx);
    }

    /// A button: send it and wait for the answer.
    pub fn ask(&self, run_id: &str, action: UserAction, timeout: Duration) -> Result<UserOutcome, String> {
        let (reply, answer) = channel();
        self.send(run_id, ActorMsg::User { action, reply: Some(reply) });
        match answer.recv_timeout(timeout) {
            Ok(result) => result,
            Err(RecvTimeoutError::Timeout) => Err("Autopilot is still busy with this run. Try again in a moment.".into()),
            Err(RecvTimeoutError::Disconnected) => Err("Autopilot stopped while handling that. See the run's timeline.".into()),
        }
    }

    /// Whether `run_id` has a thread now.
    pub fn running(&self, run_id: &str) -> bool {
        lock(&self.senders).contains_key(run_id)
    }

    fn start(&self, run_id: String, tx: Sender<ActorMsg>, rx: Receiver<ActorMsg>) {
        let actors = self.clone();
        let name = format!("run-actor-{run_id}");
        let started = std::thread::Builder::new()
            .name(name)
            .spawn(move || actors.run_thread(run_id, tx, rx));
        if let Err(err) = started {
            eprintln!("DCTerminal: could not start the run actor: {err}");
        }
    }

    fn run_thread(&self, run_id: String, tx: Sender<ActorMsg>, rx: Receiver<ActorMsg>) {
        let mut actor = actor::Actor::new(run_id.clone(), self.host.clone(), tx);
        loop {
            let msg = match rx.recv_timeout(self.idle) {
                Ok(msg) => msg,
                Err(RecvTimeoutError::Disconnected) => return,
                Err(RecvTimeoutError::Timeout) => {
                    if actor.busy() {
                        continue;
                    }
                    // Under the lock, so a message sent meanwhile is not lost.
                    let mut senders = lock(&self.senders);
                    match rx.try_recv() {
                        Ok(msg) => {
                            drop(senders);
                            msg
                        }
                        Err(_) => {
                            senders.remove(&run_id);
                            return;
                        }
                    }
                }
            };
            let handled = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| actor.handle(msg)));
            let done = match handled {
                Ok(done) => done,
                Err(panic) => {
                    let what = panic_text(panic.as_ref());
                    stop_after_panic(self.host.as_ref(), &run_id, &what);
                    // What came in meanwhile goes to a fresh thread.
                    let waiting: Vec<ActorMsg> = {
                        let mut senders = lock(&self.senders);
                        senders.remove(&run_id);
                        rx.try_iter().collect()
                    };
                    for msg in waiting {
                        self.send(&run_id, msg);
                    }
                    return;
                }
            };
            if done {
                let mut senders = lock(&self.senders);
                // Drain what came in meanwhile first: each still gets an answer.
                while let Ok(msg) = rx.try_recv() {
                    drop(senders);
                    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| actor.handle(msg)));
                    senders = lock(&self.senders);
                }
                senders.remove(&run_id);
                return;
            }
        }
    }
}

/// A poisoned lock still guards good data here: every writer below saves
/// whole values. Never let one panic take the app's store down with it.
pub(crate) fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn panic_text(panic: &(dyn std::any::Any + Send)) -> String {
    panic
        .downcast_ref::<&str>()
        .map(|s| s.to_string())
        .or_else(|| panic.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "an unexpected error".to_string())
}

/// The actor panicked: the run stops (`stopped`, `carry_out_failed`) and
/// its stages stop enforcing a result, so you can finish by hand.
fn stop_after_panic<H: Host>(host: &H, run_id: &str, what: &str) {
    let summary = format!("Autopilot stopped after an internal error ({what}). The stages keep running; carry on by hand.");
    // A panic while the store was locked poisons it; the data is whole, so
    // the rest of the app keeps using it.
    host.store().clear_poison();
    let changed = {
        let mut store = lock(host.store());
        match store.pipeline_run_by_id_mut(run_id) {
            Some(run) => {
                run.set_stopped(StopReason::CarryOutFailed);
                run.log("stop", None, None, summary.clone(), None);
                if let Err(err) = store.save() {
                    eprintln!("DCTerminal: run {run_id}: could not save the stop: {err}");
                }
                true
            }
            None => false,
        }
    };
    eprintln!("DCTerminal: run actor for {run_id} panicked: {what}");
    if !changed {
        return;
    }
    if let Err(err) = crate::bridge::launch::set_run_mode_to(&host.runs_root(), run_id, StageMode::Manual) {
        eprintln!("DCTerminal: run {run_id}: bridge mode not updated: {err}");
    }
    host.run_changed(run_id);
    host.stopped(run_id, None, StopReason::CarryOutFailed, &summary);
}
