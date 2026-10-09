import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { ProviderReport, ProvidersSettings } from "../bridge";
import { nativeDialogPath } from "../projectsView";
import {
  accountLabel,
  claudeLoginHint,
  configSourceLabel,
  PROVIDERS,
} from "../provider/descriptor";
import { PROVIDER_IDS, type ProviderId } from "../provider/types";
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

function LoginLine({ report }: { report: ProviderReport | null }) {
  const login = report?.login;
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

/** Settings > Providers (Claude-first plan, Task 2.5). */
export function ProvidersSettingsSection({ providers }: Props) {
  const { view, claude, cursor, checking, error, refresh, save } = providers;
  const [folder, setFolder] = useState("");

  const savedFolder = view?.settings.claude.configDir ?? "";
  useEffect(() => {
    setFolder(savedFolder);
  }, [savedFolder]);

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
  const envLocked = dir.source === "env";
  const update = (patch: Partial<ProvidersSettings>) => void save({ ...settings, ...patch });
  const saveFolder = (value: string) => {
    const next = value.trim();
    if (next === savedFolder) return;
    update({ claude: { ...settings.claude, configDir: next || null } });
  };
  const browse = async () => {
    const picked = nativeDialogPath(
      await open({ directory: true, multiple: false, defaultPath: dir.path }),
    );
    if (!picked) return;
    setFolder(picked);
    saveFolder(picked);
  };
  const claudeSignedIn = !!accountLabel(claude?.login);

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
        <label className="field-label">
          Claude config folder
          <div className="settings-folder-row">
            <input
              type="text"
              aria-label="Claude config folder"
              placeholder="~/.claude"
              value={envLocked ? (view.claudeConfigDirEnv ?? dir.path) : folder}
              readOnly={envLocked}
              onChange={(event) => setFolder(event.target.value)}
              onBlur={(event) => !envLocked && saveFolder(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !envLocked) saveFolder(event.currentTarget.value);
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
        <p className="hint" data-testid="claude-config-source">
          Using <code>{dir.display}</code> ({configSourceLabel(dir, view.claudeConfigDirEnv)}).
          Every Claude process gets it as <code>CLAUDE_CONFIG_DIR</code>; DCTerminal only reads it.
        </p>
        {!dir.exists && <p className="error">Folder not found: {dir.path}</p>}
        <LoginLine report={claude} />
        {claude?.status.found && dir.exists && !claudeSignedIn && (
          <p className="hint">{claudeLoginHint(dir)} Then Check again.</p>
        )}
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
