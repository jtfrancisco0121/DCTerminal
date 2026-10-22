//! Settings › Integrations › ClickUp. One token per Claude account, kept in
//! the OS keychain: the UI can set and clear it but never read it back, so
//! every reply carries only whether one is set, where it comes from and the
//! workspace it uses.
//!
//! Keychain and network calls run on the blocking pool and never while the
//! settings lock is held: each command copies what it needs, unlocks, does
//! the slow part, then locks again to save.

use crate::clickup::secret::{env_token, env_token_rejected, resolve};
use crate::clickup::{
    ClickUp, ClickUpToken, Clock, Gate, KeychainStore, SecretStore, SystemClock, Transport,
    UreqTransport,
};
use crate::store::settings_store::ClickUpWorkspace;
use crate::store::SettingsStore;
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

/// One Claude account's ClickUp setup. Never the token.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickUpAccountStatus {
    pub account_id: String,
    pub account_name: String,
    pub configured: bool,
    /// "keychain", "env" (`DCT_CLICKUP_TOKEN`, first account only) or "none".
    pub source: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_name: Option<String>,
    /// `DCT_CLICKUP_TOKEN` was set at startup but was not a token, so it is
    /// not used (first account only). Sent only when true.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub env_rejected: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickUpWorkspaceOption {
    pub id: String,
    pub name: String,
}

/// What Test found: the account's status (with the workspace it now uses)
/// and every workspace the token can see, to pick another.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClickUpTestResult {
    pub status: ClickUpAccountStatus,
    pub workspaces: Vec<ClickUpWorkspaceOption>,
}

/// What a command reads from settings for one account, copied out of the lock.
pub(crate) struct AccountCopy {
    pub id: String,
    pub name: String,
    first: bool,
    pub workspace: Option<ClickUpWorkspace>,
}

fn accounts_of(settings: &Mutex<SettingsStore>) -> Result<Vec<AccountCopy>, String> {
    let settings = settings.lock().map_err(|e| e.to_string())?;
    Ok(settings
        .providers()
        .claude
        .accounts
        .iter()
        .enumerate()
        .map(|(index, account)| AccountCopy {
            id: account.id.clone(),
            name: account.name.clone(),
            first: index == 0,
            workspace: settings.clickup_workspace(&account.id).cloned(),
        })
        .collect())
}

pub(crate) fn account_of(settings: &Mutex<SettingsStore>, account_id: &str) -> Result<AccountCopy, String> {
    accounts_of(settings)?
        .into_iter()
        .find(|account| account.id == account_id)
        .ok_or_else(|| "That Claude account no longer exists.".to_string())
}

/// The services a command uses, so tests swap in memory and recorded replies.
pub(crate) struct Deps<'a> {
    pub settings: &'a Mutex<SettingsStore>,
    pub secrets: &'a dyn SecretStore,
    /// `DCT_CLICKUP_TOKEN`, taken at startup.
    pub env: Option<ClickUpToken>,
    /// `DCT_CLICKUP_TOKEN` was set at startup but was not a token.
    pub env_rejected: bool,
    pub transport: &'a dyn Transport,
    pub gate: &'a Gate,
    pub clock: &'a dyn Clock,
}

impl Deps<'_> {
    /// `account`'s token (keychain, or the env override for the first
    /// account) and where it comes from.
    pub(crate) fn token(&self, account: &AccountCopy) -> Result<(Option<ClickUpToken>, &'static str), String> {
        let (token, source) = resolve(&account.id, account.first, self.env.clone(), self.secrets)?;
        Ok((token, source.as_str()))
    }

    fn status(&self, account: AccountCopy) -> Result<ClickUpAccountStatus, String> {
        let (token, source) = self.token(&account)?;
        Ok(ClickUpAccountStatus {
            configured: token.is_some(),
            source,
            env_rejected: account.first && self.env_rejected,
            workspace_id: account.workspace.as_ref().map(|w| w.team_id.clone()),
            workspace_name: account.workspace.map(|w| w.team_name),
            account_id: account.id,
            account_name: account.name,
        })
    }

    fn forget_workspace(&self, account_id: &str) -> Result<(), String> {
        let mut settings = self.settings.lock().map_err(|e| e.to_string())?;
        settings.set_clickup_workspace(account_id, None)
    }
}

/// Every Claude account's ClickUp setup, in account order.
pub(crate) fn statuses(deps: &Deps) -> Result<Vec<ClickUpAccountStatus>, String> {
    accounts_of(deps.settings)?
        .into_iter()
        .map(|account| deps.status(account))
        .collect()
}

/// Saves `raw` as `account_id`'s token. A new token may see other
/// workspaces, so the saved one is forgotten until Test picks again.
pub(crate) fn set_token(
    deps: &Deps,
    account_id: &str,
    raw: &str,
) -> Result<ClickUpAccountStatus, String> {
    let token = ClickUpToken::parse(raw)?;
    account_of(deps.settings, account_id)?;
    deps.secrets.set(account_id, &token)?;
    deps.forget_workspace(account_id)?;
    deps.status(account_of(deps.settings, account_id)?)
}

/// Removes `account_id`'s keychain token and its workspace. The env token
/// cannot be removed here; it stays in use until the app starts without it.
pub(crate) fn clear_token(deps: &Deps, account_id: &str) -> Result<ClickUpAccountStatus, String> {
    let account = account_of(deps.settings, account_id)?;
    deps.secrets.clear(account_id)?;
    if account.first && deps.env.is_some() {
        return deps.status(account);
    }
    deps.forget_workspace(account_id)?;
    deps.status(account_of(deps.settings, account_id)?)
}

/// Checks `account_id`'s token with `GET /team` and saves the workspace it
/// uses: `workspace_id` when given, else the one already saved, else the
/// first.
pub(crate) fn test_token(
    deps: &Deps,
    account_id: &str,
    workspace_id: Option<&str>,
) -> Result<ClickUpTestResult, String> {
    let account = account_of(deps.settings, account_id)?;
    let (token, _) = deps.token(&account)?;
    let token = token.ok_or_else(|| String::from(crate::clickup::ClickUpError::NoToken))?;
    let teams = ClickUp::with(deps.transport, &token, deps.gate, deps.clock).teams()?;
    let pick = |id: &str| teams.iter().find(|team| team.id == id);
    let chosen = match workspace_id {
        Some(id) => pick(id).ok_or("This token cannot see that ClickUp workspace.")?,
        None => account
            .workspace
            .as_ref()
            .and_then(|saved| pick(&saved.team_id))
            .or(teams.first())
            .ok_or("This token can see no ClickUp workspace.")?,
    };
    let workspace = ClickUpWorkspace {
        team_id: chosen.id.clone(),
        team_name: chosen.name.clone(),
    };
    {
        let mut settings = deps.settings.lock().map_err(|e| e.to_string())?;
        settings.set_clickup_workspace(account_id, Some(workspace))?;
    }
    Ok(ClickUpTestResult {
        status: deps.status(account_of(deps.settings, account_id)?)?,
        workspaces: teams
            .into_iter()
            .map(|team| ClickUpWorkspaceOption {
                id: team.id,
                name: team.name,
            })
            .collect(),
    })
}

/// Runs `work` on the blocking pool with the app's real keychain and HTTPS.
pub(crate) async fn with_deps<T: Send + 'static>(
    app: AppHandle,
    work: impl FnOnce(&Deps) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let settings = app.state::<Mutex<SettingsStore>>();
        let transport = UreqTransport::new();
        let deps = Deps {
            settings: settings.inner(),
            secrets: &KeychainStore,
            env: env_token(),
            env_rejected: env_token_rejected(),
            transport: &transport,
            gate: Gate::shared(),
            clock: &SystemClock,
        };
        work(&deps)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Every Claude account's ClickUp setup. Never a token.
#[tauri::command]
pub async fn clickup_status(app: AppHandle) -> Result<Vec<ClickUpAccountStatus>, String> {
    with_deps(app, statuses).await
}

/// Saves a ClickUp token for one Claude account in the system keychain.
#[tauri::command]
pub async fn clickup_token_set(
    app: AppHandle,
    account_id: String,
    token: String,
) -> Result<ClickUpAccountStatus, String> {
    with_deps(app, move |deps| set_token(deps, &account_id, &token)).await
}

/// Removes one Claude account's ClickUp token from the keychain.
#[tauri::command]
pub async fn clickup_token_clear(
    app: AppHandle,
    account_id: String,
) -> Result<ClickUpAccountStatus, String> {
    with_deps(app, move |deps| clear_token(deps, &account_id)).await
}

/// Checks one account's token against ClickUp and saves its workspace.
#[tauri::command]
pub async fn clickup_test(
    app: AppHandle,
    account_id: String,
    workspace_id: Option<String>,
) -> Result<ClickUpTestResult, String> {
    with_deps(app, move |deps| {
        test_token(deps, &account_id, workspace_id.as_deref())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clickup::client::tests::{fixture, ok, status, FakeClock, Recorded};
    use crate::clickup::secret::MemoryStore;
    use crate::store::settings_store::{ClaudeAccount, ProvidersSettings};
    use std::path::Path;

    /// Recognisable, so any copy of it anywhere is found.
    const TOKEN: &str = "pk_81234567_LEAKCHECKZ9Y8X7W6V5U4T3S2R1Q0";
    const OTHER: &str = "pk_99999999_PERSONALTOKENABCDEFGHIJKLMNOP";

    /// Settings with two Claude accounts, each folder inside the test dir.
    fn settings_in(dir: &Path) -> Mutex<SettingsStore> {
        let mut store = SettingsStore::open(dir).unwrap();
        let folder = |name: &str| Some(dir.join(name).to_string_lossy().into_owned());
        let mut providers = ProvidersSettings::default();
        providers.claude.config_dir = folder("claude-work");
        providers.claude.accounts = vec![
            ClaudeAccount {
                id: "default".into(),
                name: "Work".into(),
                config_dir: folder("claude-work"),
            },
            ClaudeAccount {
                id: "personal".into(),
                name: "Personal".into(),
                config_dir: folder("claude-personal"),
            },
        ];
        store.set_providers(providers).unwrap();
        for account in &store.providers().claude.accounts {
            let folder = account.config_dir.as_deref().unwrap();
            assert!(
                Path::new(folder).starts_with(dir),
                "{folder} is outside the test dir"
            );
        }
        Mutex::new(store)
    }

    fn deps<'a>(
        settings: &'a Mutex<SettingsStore>,
        secrets: &'a MemoryStore,
        transport: &'a Recorded,
        gate: &'a Gate,
        clock: &'a FakeClock,
    ) -> Deps<'a> {
        Deps {
            settings,
            secrets,
            env: None,
            env_rejected: false,
            transport,
            gate,
            clock,
        }
    }

    /// Every file under `dir`, read as text.
    fn files_under(dir: &Path) -> Vec<(String, String)> {
        let mut out = Vec::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(next) = stack.pop() {
            for entry in std::fs::read_dir(&next).unwrap().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else {
                    let bytes = std::fs::read(&path).unwrap();
                    out.push((
                        path.display().to_string(),
                        String::from_utf8_lossy(&bytes).into_owned(),
                    ));
                }
            }
        }
        out
    }

    #[test]
    fn the_token_appears_in_no_file_reply_or_error() {
        let dir = crate::test_support::temp_path("clickup_leak");
        let settings = settings_in(&dir);
        let secrets = MemoryStore::default();
        // The rejected reply echoes the token back, as a careless server might.
        let echo = Ok(crate::clickup::Reply {
            status: 401,
            body: format!("{{\"err\":\"Token invalid: {TOKEN}\"}}"),
            ..Default::default()
        });
        let api = Recorded::default()
            .on("/team", ok(fixture("teams.json")))
            .on("/team", ok(fixture("teams.json")))
            .on("/team", echo)
            .on("/team", Err(crate::clickup::NoReply::Offline))
            .on("/team", ok(fixture("teams.json")));
        let (gate, clock) = (Gate::new(), FakeClock::at(1_790_000_000));
        let deps = deps(&settings, &secrets, &api, &gate, &clock);

        let mut seen: Vec<String> = Vec::new();
        let saved = set_token(&deps, "default", &format!("  {TOKEN}\n")).unwrap();
        seen.push(serde_json::to_string(&saved).unwrap());
        seen.push(format!("{saved:?}"));
        let tested = test_token(&deps, "default", None).unwrap();
        assert_eq!(tested.status.workspace_name.as_deref(), Some("Koneksi QA"));
        seen.push(serde_json::to_string(&tested).unwrap());
        let picked = test_token(&deps, "default", Some("9087654321")).unwrap();
        assert_eq!(picked.status.workspace_name.as_deref(), Some("Sandbox"));
        seen.push(serde_json::to_string(&picked).unwrap());
        seen.push(serde_json::to_string(&statuses(&deps).unwrap()).unwrap());
        seen.push(test_token(&deps, "default", None).unwrap_err());
        seen.push(test_token(&deps, "default", None).unwrap_err());
        seen.push(test_token(&deps, "default", Some("nope")).unwrap_err());
        seen.push(set_token(&deps, "default", &format!("{TOKEN} extra")).unwrap_err());
        seen.push(set_token(&deps, "ghost", TOKEN).unwrap_err());
        // The other settings sections still save alongside.
        {
            let mut store = settings.lock().unwrap();
            let ui = store.ui().clone();
            store.set_ui(ui).unwrap();
            seen.push(format!("{:?}", store.data));
        }
        for text in &seen {
            assert!(!text.contains(TOKEN), "token in a reply or error: {text}");
        }
        for (path, text) in files_under(&dir) {
            assert!(!text.contains(TOKEN), "token in {path}");
        }
        // It did reach ClickUp, as the Authorization header and nowhere else.
        assert!(api
            .calls
            .lock()
            .unwrap()
            .iter()
            .all(|(path, auth)| auth == TOKEN && !path.contains(TOKEN)));
        assert_eq!(secrets.get("default").unwrap().unwrap().expose(), TOKEN);
    }

    #[test]
    fn one_accounts_token_is_never_used_for_another() {
        let dir = crate::test_support::temp_path("clickup_accounts");
        let settings = settings_in(&dir);
        let secrets = MemoryStore::default();
        let api = Recorded::default()
            .on("/team", ok(fixture("teams.json")))
            .on(
                "/team",
                ok(r#"{"teams":[{"id":"9055555555","name":"Home"}]}"#.into()),
            );
        let (gate, clock) = (Gate::new(), FakeClock::at(1_790_000_000));
        let deps = deps(&settings, &secrets, &api, &gate, &clock);

        set_token(&deps, "default", TOKEN).unwrap();
        let personal = statuses(&deps).unwrap().remove(1);
        assert_eq!(
            (personal.account_name.as_str(), personal.configured),
            ("Personal", false)
        );
        assert_eq!(
            test_token(&deps, "personal", None).unwrap_err(),
            "No ClickUp token yet. Add one under Settings › Integrations."
        );
        assert!(
            api.calls.lock().unwrap().is_empty(),
            "the work token was not tried for personal"
        );

        set_token(&deps, "personal", OTHER).unwrap();
        test_token(&deps, "default", None).unwrap();
        test_token(&deps, "personal", None).unwrap();
        let calls = api.calls.lock().unwrap().clone();
        assert_eq!(calls[0].1, TOKEN);
        assert_eq!(calls[1].1, OTHER);
        let all = statuses(&deps).unwrap();
        assert_eq!(all[0].workspace_name.as_deref(), Some("Koneksi QA"));
        assert_eq!(all[1].workspace_name.as_deref(), Some("Home"));

        // Removing one leaves the other, token and workspace.
        let cleared = clear_token(&deps, "default").unwrap();
        assert!(!cleared.configured);
        assert_eq!(cleared.workspace_id, None);
        let all = statuses(&deps).unwrap();
        assert!(all[1].configured);
        assert_eq!(all[1].workspace_id.as_deref(), Some("9055555555"));
        assert_eq!(secrets.get("personal").unwrap().unwrap().expose(), OTHER);
        assert_eq!(secrets.get("default").unwrap(), None);
    }

    #[test]
    fn the_env_token_is_for_the_first_account_and_cannot_be_removed() {
        let dir = crate::test_support::temp_path("clickup_env");
        let settings = settings_in(&dir);
        let secrets = MemoryStore::default();
        let api = Recorded::default().on("/team", ok(fixture("teams.json")));
        let (gate, clock) = (Gate::new(), FakeClock::at(1_790_000_000));
        let mut deps = deps(&settings, &secrets, &api, &gate, &clock);
        deps.env = ClickUpToken::parse(TOKEN).ok();

        let all = statuses(&deps).unwrap();
        assert_eq!((all[0].configured, all[0].source), (true, "env"));
        assert_eq!((all[1].configured, all[1].source), (false, "none"));
        test_token(&deps, "default", None).unwrap();
        let after = clear_token(&deps, "default").unwrap();
        assert_eq!(after.source, "env");
        assert_eq!(after.workspace_name.as_deref(), Some("Koneksi QA"));
    }

    #[test]
    fn an_env_value_that_is_not_a_token_is_reported_for_the_first_account() {
        let dir = crate::test_support::temp_path("clickup_env_rejected");
        let settings = settings_in(&dir);
        let secrets = MemoryStore::default();
        let api = Recorded::default();
        let (gate, clock) = (Gate::new(), FakeClock::at(1_790_000_000));
        let mut deps = deps(&settings, &secrets, &api, &gate, &clock);
        deps.env_rejected = true;

        let all = statuses(&deps).unwrap();
        assert_eq!(
            (all[0].configured, all[0].source, all[0].env_rejected),
            (false, "none", true)
        );
        assert!(!all[1].env_rejected);
        assert!(serde_json::to_string(&all[0])
            .unwrap()
            .contains("\"envRejected\":true"));
        assert!(!serde_json::to_string(&all[1])
            .unwrap()
            .contains("envRejected"));
        // A keychain token still works alongside the rejected env value.
        set_token(&deps, "default", TOKEN).unwrap();
        let first = statuses(&deps).unwrap().remove(0);
        assert_eq!((first.source, first.env_rejected), ("keychain", true));
    }

    #[test]
    fn a_rejected_token_says_where_to_fix_it_and_keeps_the_saved_workspace() {
        let dir = crate::test_support::temp_path("clickup_rejected");
        let settings = settings_in(&dir);
        let secrets = MemoryStore::default();
        let api = Recorded::default()
            .on("/team", ok(fixture("teams.json")))
            .on("/team", status(401));
        let (gate, clock) = (Gate::new(), FakeClock::at(1_790_000_000));
        let deps = deps(&settings, &secrets, &api, &gate, &clock);
        set_token(&deps, "default", TOKEN).unwrap();
        test_token(&deps, "default", None).unwrap();
        assert_eq!(
            test_token(&deps, "default", None).unwrap_err(),
            "ClickUp rejected the token. Check it under Settings › Integrations."
        );
        assert_eq!(
            statuses(&deps).unwrap()[0].workspace_id.as_deref(),
            Some("9012345678")
        );
    }
}
