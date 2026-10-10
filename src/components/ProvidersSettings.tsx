import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { LoginStatus, ProviderReport, ProvidersSettings } from "../bridge";
import { nativeDialogPath } from "../projectsView";
import {
  accountLabel,
  claudeLoginHint,
  configSourceLabel,
  PROVIDERS,
} from "../provider/descriptor";
import {
  claudeAccounts,
  PROVIDER_IDS,
  withClaudeAccounts,
  type ClaudeAccount,
  type ProviderId,
} from "../provider/types";
import type { ProvidersState } from "../provider/useProviders";

type Props = {
  providers: ProvidersState;
};

function DetectRows({ report, label }: { report: ProviderReport | null; label: string }) {
  if (!report) return <p className="hint">Checking {label}…</p>;
  const { status } = report;
  if (!status.found) {
    return <p className="error">{status.error ?? `${label} was not found.`}</p>;
  }
  return (
    <dl className="settings-paths">
      <dt>{label}</dt>
      <dd>
        {status.version ? `${status.version} · ` : ""}
        <code>{status.path}</code>
      </dd>
    </dl>
  );
}

function LoginText({ login }: { login: LoginStatus | null | undefined }) {
  if (!login) return null;
  if (login.state === "loggedIn") {
    const account = login.account || login.organization;
    return (
      <p className="ok">
        {account ? `Signed in as ${account}` : "Signed in"}
        {login.method ? ` (${login.method})` : ""}
      </p>
    );
  }
  if (login.state === "noCli") return null;
  if (login.state === "noConfigDir") {
    return <p className="error">Not checked: the config folder does not exist.</p>;
  }
  if (login.state === "loggedOut") {
    return <p className="error">Not signed in{login.detail ? `: ${login.detail}` : "."}</p>;
  }
  return (
    <p className="hint">
      Could not tell whether it is signed in{login.detail ? `: ${login.detail}` : "."}
    </p>
  );
}

function LoginLine({ report }: { report: ProviderReport | null }) {
  return <LoginText login={report?.login} />;
}

/** Settings > Providers (Claude-first plan, Task 2.5). */
export function ProvidersSettingsSection({ providers }: Props) {
  const { view, claude, cursor, accountLogins, checking, error, refresh, save } = providers;
  const [drafts, setDrafts] = useState<Record<string, { name: string; folder: string }>>({});

  const accounts = view ? claudeAccounts(view.settings.claude) : [];
  useEffect(() => {
    const next: Record<string, { name: string; folder: string }> = {};
    for (const account of accounts) {
      next[account.id] = { name: account.name, folder: account.configDir ?? "" };
    }
    setDrafts(next);
    // Re-sync when the saved account list changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.settings.claude.accounts, view?.settings.claude.configDir]);

  if (!view) {
    return (
      <section className="settings-section" aria-label="Providers">
        <h3>Providers</h3>
        {error ? <p className="error">{error}</p> : <p className="hint">Loading…</p>}
      </section>
    );
  }

  const settings = view.settings;
  const dir = view.claudeConfigDir;
  const update = (patch: Partial<ProvidersSettings>) => void save({ ...settings, ...patch });
  const writeAccounts = (next: ClaudeAccount[]) => {
    update({ claude: withClaudeAccounts(settings.claude, next) });
  };
  const saveAccount = (index: number, patch: Partial<ClaudeAccount>) => {
    const next = accounts.map((account, i) => (i === index ? { ...account, ...patch } : account));
    if (index === 0 && patch.configDir && next[0].name === "Claude") {
      next[0] = { ...next[0], name: "Personal" };
    }
    const current = accounts[index];
    const saved = next[index];
    if (
      current &&
      saved.name === current.name &&
      (saved.configDir ?? null) === (current.configDir ?? null)
    ) {
      return;
    }
    writeAccounts(next);
  };

  return (
    <section className="settings-section" aria-label="Providers">
      <h3>Providers</h3>
      <div className="field-label">
        Default provider for new tabs
        <div className="role-choices" role="radiogroup" aria-label="Default provider">
          {PROVIDER_IDS.map((id: ProviderId) => (
            <button
              key={id}
              type="button"
              role="radio"
              className="role-choice"
              aria-checked={settings.default === id}
              aria-pressed={settings.default === id}
              onClick={() => update({ default: id })}
            >
              {PROVIDERS[id].label}
            </button>
          ))}
        </div>
      </div>
      <p className="hint">All tabs run with full permissions.</p>

      <div className="settings-subsection" aria-label="Claude Code">
        <h4>Claude Code</h4>
        <DetectRows report={claude} label="Claude Code" />
        {claude?.status.found && (
          <dl className="settings-paths">
            <dt>Chat adapter</dt>
            <dd>
              {claude.status.adapterFound ? (
                <code>{claude.status.adapterPath}</code>
              ) : (
                <>
                  Not found. Install it with{" "}
                  <code>{claude.adapterInstall ?? "npm install -g --omit=optional @agentclientprotocol/claude-agent-acp@0.88.0"}</code>
                </>
              )}
            </dd>
          </dl>
        )}
        {accounts.map((account, index) => {
          const resolved = view.claudeAccounts?.find((item) => item.id === account.id);
          const shown = index === 0 ? dir : resolved?.config;
          const envLocked = index === 0 && dir.source === "env";
          const draft = drafts[account.id] ?? { name: account.name, folder: account.configDir ?? "" };
          const login =
            accountLogins.find((item) => item.id === account.id)?.login ??
            (index === 0 ? claude?.login : undefined);
          const folderLabel = index === 0 ? "Claude config folder" : `Config folder for ${account.name}`;
          const browse = async () => {
            const picked = nativeDialogPath(
              await open({
                directory: true,
                multiple: false,
                defaultPath: shown?.path || undefined,
              }),
            );
            if (!picked) return;
            setDrafts((prev) => ({ ...prev, [account.id]: { ...draft, folder: picked } }));
            saveAccount(index, { configDir: picked });
          };
          return (
            <div key={account.id} data-testid={`claude-account-${account.id}`}>
              <label className="field-label">
                Account name
                <input
                  type="text"
                  aria-label={index === 0 ? "Account name" : `Account name for ${account.name}`}
                  value={draft.name}
                  onChange={(event) =>
                    setDrafts((prev) => ({
                      ...prev,
                      [account.id]: { ...draft, name: event.target.value },
                    }))
                  }
                  onBlur={() => saveAccount(index, { name: draft.name.trim() })}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") saveAccount(index, { name: event.currentTarget.value.trim() });
                  }}
                />
              </label>
              <label className="field-label">
                {folderLabel}
                <div className="settings-folder-row">
                  <input
                    type="text"
                    aria-label={folderLabel}
                    placeholder="~/.claude"
                    value={envLocked ? (view.claudeConfigDirEnv ?? shown?.path ?? "") : draft.folder}
                    readOnly={envLocked}
                    onChange={(event) =>
                      setDrafts((prev) => ({
                        ...prev,
                        [account.id]: { ...draft, folder: event.target.value },
                      }))
                    }
                    onBlur={(event) => !envLocked && saveAccount(index, { configDir: event.target.value.trim() || null })}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !envLocked) {
                        saveAccount(index, { configDir: event.currentTarget.value.trim() || null });
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={envLocked}
                    onClick={() => void browse().catch(() => {})}
                  >
                    Browse…
                  </button>
                </div>
              </label>
              {shown && (
                <p className="hint" data-testid={index === 0 ? "claude-config-source" : undefined}>
                  Using <code>{shown.display}</code>
                  {index === 0 ? ` (${configSourceLabel(dir, view.claudeConfigDirEnv)})` : ""}.
                  {index === 0
                    ? " DCT_CLAUDE_CONFIG_DIR overrides this account only. "
                    : " "}
                  DCTerminal only reads the folder.
                </p>
              )}
              {shown && !shown.exists && <p className="error">Folder not found: {shown.path}</p>}
              {index === 0 ? <LoginLine report={claude} /> : <LoginText login={login} />}
              {index === 0 && claude?.status.found && dir.exists && !accountLabel(claude.login) && (
                <p className="hint">{claudeLoginHint(dir)} Then Check again.</p>
              )}
            </div>
          );
        })}
        <button
          type="button"
          className="secondary-button"
          onClick={() => {
            const id = `acct-${Date.now()}`;
            const name = accounts.some((account) => account.name === "Company")
              ? `Account ${accounts.length + 1}`
              : "Company";
            writeAccounts([...accounts, { id, name, configDir: "~/.claude" }]);
          }}
        >
          Add account
        </button>
        {accounts.length > 1 &&
          accounts.slice(1).map((account) => (
            <button
              key={`remove-${account.id}`}
              type="button"
              className="secondary-button"
              onClick={() => writeAccounts(accounts.filter((item) => item.id !== account.id))}
            >
              Remove {account.name}
            </button>
          ))}
        {claude?.login.apiKeyEnv && (
          <p className="hint">ANTHROPIC_API_KEY is set in this environment.</p>
        )}
      </div>

      <div className="settings-subsection" aria-label="Cursor CLI">
        <h4>Cursor CLI (optional)</h4>
        <DetectRows report={cursor} label="Cursor CLI" />
        <LoginLine report={cursor} />
      </div>

      <div className="settings-toolbar">
        <button
          type="button"
          className="secondary-button"
          disabled={checking}
          onClick={() => void refresh()}
        >
          {checking ? "Checking…" : "Check again"}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </section>
  );
}
