//! QA rounds (Track R2): a round runs one pipeline run per active plan of a
//! Triage run's approved `round.json` (decision E6), starting them wave by
//! wave with a cap on runs at once and **Commit up to wave N**.
//!
//! - `types`: the round as `state.json` lists it.
//! - `schedule`: the pure rules (a plan's state from its run, what starts next, why a plan waits).
//! - `files`: `rounds/<roundId>/` and the files a plan run's folder gets.
//! - `runner`: the one owner of round state (a thread taking one message at a time).
//! - `merge_queue` (R3): each repo's pull requests in merge order, read-only.

pub mod files;
pub mod merge_queue;
#[cfg(test)]
mod merge_queue_tests;
pub mod runner;
pub mod schedule;
pub mod types;
#[cfg(test)]
mod tests;

pub use runner::{view, RoundAction, RoundMsg, RoundRunner, RoundView};
pub use types::QaRound;

/// The app's round runner.
pub type AppRounds = RoundRunner<crate::run_actor::app_host::AppHost>;

/// Every run change reaches the round runner (R2): the app's
/// `chain-run-updated` calls this, so an actor's stop or completion and
/// your buttons on a plan run all bring its round up to date. Only queues
/// a message: it may be called with the store locked.
pub fn notify_run_changed<R: tauri::Runtime>(app: &tauri::AppHandle<R>, run_id: &str) {
    use tauri::Manager;
    if let Some(rounds) = app.try_state::<AppRounds>() {
        rounds.run_changed(run_id);
    }
}
