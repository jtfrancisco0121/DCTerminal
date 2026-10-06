import { useEffect, useState } from "react";
import {
  getRole,
  type CliDetectResult,
  type DiagnosticsStatus,
  type Role,
  type RoleSummary,
} from "../bridge";
import { DevToolsPanel } from "../DevToolsPanel";
import { shortcutRows, type Platform } from "../keymap";
import { APP_VERSION, rolePermissionSummary } from "../workspaceView";

type Props = {
  roles: RoleSummary[];
  cli: CliDetectResult | null;
  cliError: string | null;
  platform: Platform;
  diagnostics: DiagnosticsStatus | null;
  captureOn: boolean;
  showDevTools: boolean;
  onToggleCapture: (enabled: boolean) => void;
  onClose: () => void;
};

export function SettingsPage({
  roles,
  cli,
  cliError,
  platform,
  diagnostics,
  captureOn,
  showDevTools,
  onToggleCapture,
  onClose,
}: Props) {
  const [selectedId, setSelectedId] = useState(roles[0]?.id ?? "");
  const [detail, setDetail] = useState<Role | null>(null);
  const rows = shortcutRows(platform);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    getRole(selectedId)
      .then((role) => {
        if (!cancelled) setDetail(role);
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  return (
    <div className="settings-page">
      <header className="settings-header">
        <h2>Settings</h2>
        <button type="button" className="secondary-button" onClick={onClose}>
          Close
        </button>
      </header>

      <section className="settings-section">
        <h3>Roles</h3>
        <ul className="settings-role-list">
          {roles.map((role) => (
            <li key={role.id}>
              <button
                type="button"
                className={
                  role.id === selectedId ? "settings-role settings-role-active" : "settings-role"
                }
                onClick={() => setSelectedId(role.id)}
              >
                <span className="role-dot" style={{ background: role.color }} aria-hidden />
                <span>{role.name}</span>
                <span className="hint">
                  {role.defaultMode} · {role.fieldCount} fields
                </span>
              </button>
            </li>
          ))}
        </ul>
        {detail && (
          <div className="settings-role-detail">
            <p>
              <strong>{detail.name}</strong> · {detail.defaultMode} · {detail.fields.length}{" "}
              fields
            </p>
            <p className="hint">{rolePermissionSummary(detail.id)}</p>
            <details>
              <summary>Prompt preview</summary>
              <pre className="mono-snippet settings-prompt">{detail.templateText}</pre>
            </details>
          </div>
        )}
      </section>

      <section className="settings-section">
        <h3>Diagnostics</h3>
        <label className="field-label diagnostics-toggle">
          <input
            type="checkbox"
            checked={captureOn}
            onChange={(event) => onToggleCapture(event.target.checked)}
          />
          Record permission payloads
        </label>
        <p className="hint">Off by default. File contents and secrets are redacted.</p>
        {diagnostics?.lastError && <p className="error">{diagnostics.lastError}</p>}
      </section>

      {showDevTools && (
        <section className="settings-section">
          <h3>Developer probes</h3>
          <DevToolsPanel cli={cli} cliError={cliError} />
        </section>
      )}

      <section className="settings-section">
        <h3>Keyboard shortcuts</h3>
        <ul className="settings-shortcuts">
          {rows.map((row) => (
            <li key={row.action}>
              <span>{row.label}</span>
              <kbd>{row.keys}</kbd>
            </li>
          ))}
        </ul>
      </section>

      <section className="settings-section">
        <h3>Data</h3>
        <dl className="settings-paths">
          <dt>App data</dt>
          <dd>{diagnostics?.appDataDir || "Unavailable until the app shell is running."}</dd>
          <dt>Transcripts</dt>
          <dd>{diagnostics?.transcriptsDir || "transcripts"}</dd>
          <dt>Permission log</dt>
          <dd>{diagnostics?.logPath || "logs/permission-payloads.jsonl"}</dd>
        </dl>
      </section>

      <section className="settings-section">
        <h3>About</h3>
        <p>
          DCTerminal {APP_VERSION}
          {cli?.found && cli.version ? ` · Cursor CLI ${cli.version}` : ""}
        </p>
        {cli && !cli.found && (
          <p className="error">
            Cursor CLI was not found. Install it and run <code>agent login</code>.
          </p>
        )}
        {cliError && <p className="error">{cliError}</p>}
      </section>
    </div>
  );
}
