//! GitHub monitor commands. `gh` runs on the blocking pool and never while a
//! store lock is held: each command copies what it needs out of the stores,
//! runs, then locks again to save.

use crate::github::{
    find_gh, push_commits, repo_status, run_cycle, runner::is_signed_out_message, CycleConfig,
    FeedResponse, GhApi, GhCli, GithubSync, PushCommits, PushRange, RepoStatus, Scope, Setup,
    SOURCE_ORG,
};
use crate::store::github_store::{GithubCache, GithubFilters, GithubStore};
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

const MAX_CLAIM_IDS: usize = 500;
const MAX_ID_LEN: usize = 400;

fn unix_now() -> i64 {
    chrono::Utc::now().timestamp()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubStatus {
    /// "ready", "missing", "signed_out", "scope" or "offline".
    pub state: String,
    /// What to do about it, when the state is not "ready".
    pub fix: Option<String>,
    pub login: Option<String>,
    pub scopes: Option<Vec<String>>,
    /// Reachability of the watched repos, from the polls so far.
    pub repos: Vec<RepoStatus>,
    pub filters: GithubFilters,
}

fn scope_of(store: &GithubStore) -> Scope {
    Scope {
        org: store.data.org.clone(),
        watched: store.data.watched.clone(),
        login: store.data.login.clone(),
    }
}

fn status_blocking(app: &AppHandle) -> Result<GithubStatus, String> {
    let (scope, filters) = {
        let store = app.state::<Mutex<GithubStore>>();
        let store = store.lock().map_err(|e| e.to_string())?;
        (scope_of(&store), store.data.filters.clone())
    };
    let repos = {
        let cache = app.state::<Mutex<GithubCache>>();
        let cache = cache.lock().map_err(|e| e.to_string())?;
        scope
            .watched
            .iter()
            .map(|name| repo_status(&cache.data, &scope.org, name, SOURCE_ORG))
            .collect::<Vec<_>>()
    };
    let mut status = GithubStatus {
        state: "ready".into(),
        fix: None,
        login: None,
        scopes: None,
        repos,
        filters,
    };
    let Some(gh) = find_gh() else {
        let setup = Setup::missing();
        status.state = setup.state;
        status.fix = Some(setup.fix);
        return Ok(status);
    };
    let setup = match GhCli::new(gh).get("user", None) {
        Ok(reply) if reply.status == 200 => {
            status.login = serde_json::from_str::<serde_json::Value>(&reply.body)
                .ok()
                .and_then(|user| user["login"].as_str().map(str::to_string));
            status.scopes = reply.scopes.clone();
            reply
                .scopes
                .filter(|scopes| !scopes.iter().any(|s| s == "repo"))
                .map(|_| Setup::scope())
        }
        Ok(reply) if reply.status == 401 => Some(Setup::signed_out()),
        Ok(reply) => Some(Setup::offline(&reply.status_line())),
        Err(message) if is_signed_out_message(&message) => Some(Setup::signed_out()),
        Err(message) => Some(Setup::offline(&message)),
    };
    if let Some(setup) = setup {
        status.state = setup.state;
        status.fix = Some(setup.fix);
    }
    Ok(status)
}

/// Whether gh is installed and signed in with the scopes it needs, and the
/// saved filters.
#[tauri::command]
pub async fn github_status(app: AppHandle) -> Result<GithubStatus, String> {
    tauri::async_runtime::spawn_blocking(move || status_blocking(&app))
        .await
        .map_err(|e| e.to_string())?
}

fn feed_blocking(app: &AppHandle) -> Result<FeedResponse, String> {
    let sync = app.state::<GithubSync>();
    sync.run(|| {
        let now = unix_now();
        let (cfg, mut cache) = {
            let store = app.state::<Mutex<GithubStore>>();
            let store = store.lock().map_err(|e| e.to_string())?;
            let cfg = CycleConfig {
                login: store.data.login.clone(),
                org: store.data.org.clone(),
                watched: store.data.watched.clone(),
                personal: store.data.personal.clone(),
                personal_refreshed_at: store.data.personal_refreshed_at,
            };
            let cache = app.state::<Mutex<GithubCache>>();
            let cache = cache.lock().map_err(|e| e.to_string())?;
            (cfg, cache.data.clone())
        };
        let Some(gh) = find_gh() else {
            return Ok(FeedResponse {
                setup: Some(Setup::missing()),
                poll_interval: 300,
                fetched_at: now,
                ..FeedResponse::default()
            });
        };
        let mut outcome = run_cycle(&GhCli::new(gh), &cfg, &mut cache, now);
        {
            let state = app.state::<Mutex<GithubCache>>();
            let mut state = state.lock().map_err(|e| e.to_string())?;
            if let Err(error) = state.commit(cache, outcome.cache_dirty) {
                outcome.response.errors.insert("cache".into(), error);
            }
        }
        if let Some(personal) = outcome.personal.take() {
            let state = app.state::<Mutex<GithubStore>>();
            let mut state = state.lock().map_err(|e| e.to_string())?;
            if let Err(error) = state.set_personal(personal, now) {
                outcome.response.errors.insert("store".into(), error);
            }
        }
        Ok(outcome.response)
    })
}

/// Polls whatever is due and returns the feed. Concurrent callers (several
/// windows) share one cycle.
#[tauri::command]
pub async fn github_feed(app: AppHandle) -> Result<FeedResponse, String> {
    tauri::async_runtime::spawn_blocking(move || feed_blocking(&app))
        .await
        .map_err(|e| e.to_string())?
}

/// The commits of one push, loaded when its row is expanded.
#[tauri::command]
pub async fn github_push_commits(
    app: AppHandle,
    repo: String,
    before: String,
    head: String,
) -> Result<PushCommits, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let scope = {
            let store = app.state::<Mutex<GithubStore>>();
            let store = store.lock().map_err(|e| e.to_string())?;
            let mut scope = scope_of(&store);
            // An owned repo can be newer than the cached list.
            scope.login = store.data.login.clone();
            scope
        };
        let gh = find_gh().ok_or_else(|| Setup::missing().fix)?;
        push_commits(&GhCli::new(gh), &scope, &repo, &PushRange { before, head })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Of `ids`, the ones nobody has been told about yet; all of them are marked
/// seen. The first call only sets the baseline and returns nothing.
#[tauri::command]
pub fn github_claim_notifications(
    ids: Vec<String>,
    store: State<Mutex<GithubStore>>,
) -> Result<Vec<String>, String> {
    if ids.len() > MAX_CLAIM_IDS || ids.iter().any(|id| id.len() > MAX_ID_LEN) {
        return Err("too many notifications to claim".into());
    }
    let mut store = store.lock().map_err(|e| e.to_string())?;
    store.claim_notifications(&ids)
}

/// Saves the chips, filters and the Show bots toggle.
#[tauri::command]
pub fn github_save_filters(
    filters: GithubFilters,
    store: State<Mutex<GithubStore>>,
) -> Result<GithubFilters, String> {
    let mut store = store.lock().map_err(|e| e.to_string())?;
    store.set_filters(filters)
}
