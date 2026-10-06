import { useEffect, useState } from "react";
import {
  getRole,
  type ApprovalModeStatus,
  type CliDetectResult,
  type DiagnosticsStatus,
  type ModelList,
  type ModelSettings,
  type Role,
  type RoleSummary,
  type TerminalSettings,
  type UiSettings,
} from "../bridge";
import { normalizeTheme, THEMES } from "../theme";
import { DevToolsPanel } from "../DevToolsPanel";
import { shortcutRows, type Platform } from "../keymap";
import { DEFAULT_MODEL_ID } from "../models";
import { ModelPicker } from "./ModelPicker";
import type { NotificationSettings } from "../notify/agentNotify";
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
  terminalSettings: TerminalSettings | null;
  onTerminalSettings: (next: TerminalSettings) => void;
  modelList?: ModelList | null;
  modelSettings?: ModelSettings | null;
  onModelSettings?: (next: ModelSettings) => void;
  onRefreshModels?: () => void;
  modelsRefreshing?: boolean;
  approvalMode: ApprovalModeStatus | null;
  notificationSettings?: NotificationSettings | null;
  onNotificationSettings?: (next: NotificationSettings) => void;
  onTestNotification?: () => void;
  uiSettings?: UiSettings | null;
  onUiSettings?: (patch: Partial<UiSettings>) => void;
  onClose: () => void;
};

const RUN_MODES: { id: string; label: string }[] = [
  { id: "default", label: "Default" },
  { id: "yolo", label: "Run Everything" },
  { id: "auto-review", label: "Auto-review" },
  { id: "plan", label: "Plan" },
  { id: "ask", label: "Ask" },
];

export function SettingsPage({
  roles,
  cli,
  cliError,
  platform,
  diagnostics,
  captureOn,
  showDevTools,
  onToggleCapture,
  terminalSettings,
  onTerminalSettings,
  modelList = null,
  modelSettings = null,
  onModelSettings,
  onRefreshModels,
  modelsRefreshing = false,
  approvalMode,
  notificationSettings = null,
  onNotificationSettings,
  onTestNotification,
  uiSettings = null,
  onUiSettings,
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
        <h3>Permissions</h3>
        <p className="hint">
          DCTerminal follows your global Cursor CLI approval setting. It never
          writes <code>~/.cursor/cli-config.json</code> and does not override{" "}
          <code>approvalMode</code>.
        </p>
        {approvalMode?.kind === "unrestricted" && (
          <p className="error">
            Cursor CLI is set to Run Everything, so role permission rules are
            off. Change it in Cursor CLI settings to enable them.
          </p>
        )}
        {approvalMode?.kind === "allowlist" && (
          <p className="hint">
            Under allowlist, file creates and edits are not routed through
            DCTerminal. Only shell, delete, fetch, and MCP prompts reach role
            policy.
          </p>
        )}
        {approvalMode?.approvalMode && (
          <p className="hint">
            Current <code>approvalMode</code>:{" "}
            <code>{approvalMode.approvalMode}</code>
            {approvalMode.configPath ? (
              <>
                {" "}
                (<code>{approvalMode.configPath}</code>)
              </>
            ) : null}
          </p>
        )}
        {!approvalMode?.approvalMode && (
          <p className="hint">
            Cursor CLI approval mode could not be determined (missing or
            unreadable config). No warning is shown in the session UI.
          </p>
        )}
      </section>

      <section className="settings-section" aria-label="Notifications">
        <h3>Notifications</h3>
        {(() => {
          const current = notificationSettings;
          const update = (patch: Partial<NotificationSettings>) => {
            if (!current) return;
            onNotificationSettings?.({ ...current, ...patch });
          };
          const unavailable = !current || !onNotificationSettings;
          return (
            <>
              <label className="field-label diagnostics-toggle">
                <input
                  type="checkbox"
                  checked={current?.enabled ?? false}
                  disabled={unavailable}
                  onChange={(event) => update({ enabled: event.target.checked })}
                />
                Notify when an agent finishes, needs permission, or asks a question
              </label>
              <label className="field-label diagnostics-toggle settings-sub-toggle">
                <input
                  type="checkbox"
                  checked={current?.system ?? false}
                  disabled={unavailable || !current?.enabled}
                  onChange={(event) => update({ system: event.target.checked })}
                />
                System notifications while DCTerminal is in the background
              </label>
              <label className="field-label diagnostics-toggle settings-sub-toggle">
                <input
                  type="checkbox"
                  checked={current?.toastWhenFocused ?? false}
                  disabled={unavailable || !current?.enabled}
                  onChange={(event) => update({ toastWhenFocused: event.target.checked })}
                />
                In-app toasts for other tabs while DCTerminal is focused
              </label>
              <p className="hint">
                The tab you are looking at stays quiet while the window is focused. When
                DCTerminal is not the focused window, events from every tab raise a system
                notification and a toast that waits for you. Covers chat tabs; terminal tabs
                are not tracked yet.
              </p>
              <div className="button-row">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={onTestNotification}
                  disabled={!onTestNotification || !current?.enabled}
                >
                  Send test notification
                </button>
              </div>
            </>
          );
        })()}
      </section>

      <section className="settings-section">
        <h3>Terminal</h3>
        <label className="field-label">
          Theme
          <select
            className="text-input"
            value={normalizeTheme(uiSettings?.theme)}
            disabled={!onUiSettings}
            onChange={(event) => onUiSettings?.({ theme: event.target.value })}
          >
            {THEMES.map((theme) => (
              <option key={theme.id} value={theme.id}>
                {theme.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field-label">
          Shell program
          <input
            className="text-input"
            value={terminalSettings?.shell ?? ""}
            placeholder="Blank uses pwsh, then PowerShell, or $SHELL"
            disabled={!terminalSettings}
            onChange={(event) => {
              if (!terminalSettings) return;
              onTerminalSettings({ ...terminalSettings, shell: event.target.value });
            }}
          />
        </label>
        <label className="field-label">
          Font size
          <input
            className="text-input"
            type="number"
            min={8}
            max={32}
            value={terminalSettings?.fontSize ?? 14}
            disabled={!terminalSettings}
            onChange={(event) => {
              if (!terminalSettings) return;
              const fontSize = Number(event.target.value);
              if (!Number.isFinite(fontSize)) return;
              onTerminalSettings({ ...terminalSettings, fontSize });
            }}
          />
        </label>
        {detail && terminalSettings && (
          <label className="field-label">
            {detail.name} terminal run mode
            <select
              className="text-input"
              value={terminalSettings.roleRunMode[detail.id] ?? "default"}
              onChange={(event) => {
                onTerminalSettings({
                  ...terminalSettings,
                  roleRunMode: {
                    ...terminalSettings.roleRunMode,
                    [detail.id]: event.target.value,
                  },
                });
              }}
            >
              {RUN_MODES.map((mode) => (
                <option key={mode.id} value={mode.id}>
                  {mode.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <p className="hint">
          Run mode replaces only the role&apos;s mode flag. --approve-mcps and --trust stay on
          every role terminal. Default keeps the role&apos;s own flags. A plain Terminal tab
          that runs agent takes no extra flags. There is no CLI flag that denies writes while
          still allowing the shell, so PR Reviewer keeps the CLI&apos;s own approval prompts.
        </p>
      </section>

      <section className="settings-section" aria-label="Models">
        <h3>Models</h3>
        {(() => {
          const models = modelList?.models ?? [];
          const current = modelSettings ?? { defaultModel: DEFAULT_MODEL_ID, roleModels: {} };
          const roleRows = [
            ...roles.map((role) => ({ id: role.id, name: role.name })),
            { id: "cursor-cli", name: "Cursor CLI tabs" },
          ];
          return (
            <>
              <p className="hint">
                New tabs use the role&apos;s model, or the default model when the role has none.
                Each tab can override this from its header.
              </p>
              <div className="settings-model-row">
                <span className="settings-model-name">Default model</span>
                <ModelPicker
                  models={models}
                  value={current.defaultModel}
                  ariaLabel="Default model"
                  disabled={!onModelSettings}
                  onChange={(model) =>
                    onModelSettings?.({ ...current, defaultModel: model ?? DEFAULT_MODEL_ID })
                  }
                />
              </div>
              {roleRows.map((row) => (
                <div className="settings-model-row" key={row.id}>
                  <span className="settings-model-name">{row.name}</span>
                  <ModelPicker
                    models={models}
                    value={current.roleModels[row.id] ?? null}
                    inherited={{ model: current.defaultModel, label: "Default model" }}
                    ariaLabel={`Model for ${row.name}`}
                    disabled={!onModelSettings}
                    onChange={(model) => {
                      const roleModels = { ...current.roleModels };
                      if (model === null) delete roleModels[row.id];
                      else roleModels[row.id] = model;
                      onModelSettings?.({ ...current, roleModels });
                    }}
                  />
                </div>
              ))}
              <div className="button-row">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={onRefreshModels}
                  disabled={!onRefreshModels || modelsRefreshing}
                >
                  {modelsRefreshing ? "Refreshing…" : "Refresh model list"}
                </button>
                <span className="hint">
                  {models.length} models
                  {modelList?.source === "cli"
                    ? " from agent --list-models"
                    : modelList?.source === "cache"
                      ? " (cached list)"
                      : modelList?.source === "fallback"
                        ? " (built-in list; agent --list-models was not available)"
                        : ""}
                </span>
              </div>
              {modelList?.error && <p className="hint">{modelList.error}</p>}
            </>
          );
        })()}
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
            <li key={`${row.action}-${row.keys}`}>
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
