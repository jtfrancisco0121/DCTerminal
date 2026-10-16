import { useCallback, useEffect, useRef, useState, type InputHTMLAttributes } from "react";
import {
  getClaudeUsage,
  type UsageSnapshot,
  type ApprovalModeStatus,
  type CliDetectResult,
  type DiagnosticsStatus,
  type ModelList,
  type ModelSettings,
  type ProviderModelSettings,
  type RoleSummary,
  type TerminalSettings,
  type UiSettings,
} from "../bridge";
import { normalizeTheme, THEME_CHOICES } from "../theme";
import { DevToolsPanel } from "../DevToolsPanel";
import { shortcutRows, type Platform } from "../keymap";
import { CLAUDE_DEFAULT_MODEL_ID, CLAUDE_EFFORT_LEVELS, DEFAULT_MODEL_ID } from "../models";
import type { ProviderId } from "../provider/types";
import { ModelPicker } from "./ModelPicker";
import { ProvidersSettingsSection } from "./ProvidersSettings";
import { StorageRow } from "./StorageRow";
import type { ProvidersState } from "../provider/useProviders";
import type { NotificationSettings } from "../notify/agentNotify";
import { formatReset, formatSeen, isStale, limitTone } from "../usage/limits";
import { APP_VERSION } from "../workspaceView";
import { errorText } from "./InlineNotice";
import { RoleEditor } from "./RoleEditor";
import { PipelinesSettings } from "./PipelinesSettings";
import { useConfirm } from "./confirm";

type Props = {
  roles: RoleSummary[];
  cli: CliDetectResult | null;
  cliError: string | null;
  platform: Platform;
  diagnostics: DiagnosticsStatus | null;
  captureOn: boolean;
  showDevTools: boolean;
  onToggleCapture: (enabled: boolean) => void | Promise<unknown>;
  terminalSettings: TerminalSettings | null;
  /** A returned promise reports the save: Saved, or the error. */
  onTerminalSettings: (next: TerminalSettings) => void | Promise<unknown>;
  modelList?: ModelList | null;
  claudeModelList?: ModelList | null;
  modelSettings?: ProviderModelSettings | null;
  onModelSettings?: (provider: ProviderId, next: ModelSettings) => void | Promise<unknown>;
  onRefreshModels?: () => void;
  modelsRefreshing?: boolean;
  approvalMode: ApprovalModeStatus | null;
  notificationSettings?: NotificationSettings | null;
  onNotificationSettings?: (next: NotificationSettings) => void | Promise<unknown>;
  onTestNotification?: () => void;
  uiSettings?: UiSettings | null;
  onUiSettings?: (patch: Partial<UiSettings>) => void | Promise<unknown>;
  /** U6: category shown first (Roles when omitted). */
  initialCategory?: SettingsCategory;
  /** Settings > Providers data (shared with the status bar). */
  providers?: ProvidersState | null;
  onRefreshRoles?: () => Promise<void>;
  /** Your own pipelines were saved. */
  onPipelinesChanged?: () => void;
  /** Reports whether Settings holds edits that leaving would discard. */
  onUnsavedChange?: (dirty: boolean) => void;
  onClose: () => void;
};

/** U6: left-hand menu, in display order. */
export const SETTINGS_CATEGORIES = [
  "Roles",
  "Pipelines",
  "Providers",
  "Models",
  "Appearance",
  "Terminal",
  "Permissions",
  "Usage",
  "Notifications",
  "Shortcuts",
  "Data",
] as const;

export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number];

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
  onToggleCapture: toggleCapture,
  terminalSettings,
  onTerminalSettings: saveTerminalSettings,
  modelList = null,
  claudeModelList = null,
  modelSettings = null,
  onModelSettings: saveModelSettings,
  onRefreshModels,
  modelsRefreshing = false,
  approvalMode,
  notificationSettings = null,
  onNotificationSettings: saveNotificationSettings,
  onTestNotification,
  uiSettings = null,
  onUiSettings: saveUiSettings,
  initialCategory = "Roles",
  providers = null,
  onRefreshRoles,
  onPipelinesChanged,
  onUnsavedChange,
  onClose,
}: Props) {
  const confirm = useConfirm();
  const { marker, track } = useSaveMarker();
  // Every setting goes through track(): one Saving / Saved / error marker.
  const onToggleCapture = (enabled: boolean) => track(toggleCapture(enabled));
  const onTerminalSettings = (next: TerminalSettings) => track(saveTerminalSettings(next));
  const onModelSettings = saveModelSettings
    ? (provider: ProviderId, next: ModelSettings) => track(saveModelSettings(provider, next))
    : undefined;
  const onNotificationSettings = saveNotificationSettings
    ? (next: NotificationSettings) => track(saveNotificationSettings(next))
    : undefined;
  const onUiSettings = saveUiSettings
    ? (patch: Partial<UiSettings>) => track(saveUiSettings(patch))
    : undefined;
  const [rolesDirty, setRolesDirty] = useState(false);
  const [pipelinesDirty, setPipelinesDirty] = useState(false);
  const unsaved = rolesDirty || pipelinesDirty;
  // Names what would be lost: role edits, pipeline edits, or both.
  const unsavedMessage =
    rolesDirty && pipelinesDirty
      ? "Your role and pipeline edits are not saved. Leaving discards them."
      : pipelinesDirty
        ? "Your pipeline edits are not saved. Leaving discards them."
        : "Your role edits are not saved. Leaving discards them.";
  useEffect(() => {
    onUnsavedChange?.(unsaved);
    return () => onUnsavedChange?.(false);
  }, [unsaved, onUnsavedChange]);
  const close = async () => {
    if (
      unsaved &&
      !(await confirm({
        title: "Leave Settings?",
        message: unsavedMessage,
        confirmLabel: "Discard and leave",
        danger: true,
      }))
    ) {
      return;
    }
    onClose();
  };
  const [category, setCategory] = useState<SettingsCategory>(initialCategory);
  const [usage, setUsage] = useState<UsageSnapshot | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const rows = shortcutRows(platform);

  useEffect(() => {
    if (category !== "Usage") return;
    let cancelled = false;
    getClaudeUsage()
      .then((snap) => {
        if (!cancelled) setUsage(snap);
      })
      .catch((err: unknown) => {
        if (!cancelled) setUsageError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [category]);

  return (
    <div className="settings-page">
      <header className="settings-header">
        <h2>Settings</h2>
        {marker}
        <button type="button" className="secondary-button" onClick={() => void close()}>
          Close
        </button>
      </header>

      <div className="settings-body">
        <nav className="settings-nav" aria-label="Settings categories">
          {SETTINGS_CATEGORIES.map((name) => (
            <button
              key={name}
              type="button"
              className="settings-nav-item"
              aria-current={category === name ? "page" : undefined}
              onClick={() => {
                if (name === category) return;
                if (!unsaved) {
                  setCategory(name);
                  return;
                }
                void confirm({
                  title: pipelinesDirty && !rolesDirty
                    ? "Leave the pipeline editor?"
                    : "Leave the role editor?",
                  message: unsavedMessage,
                  confirmLabel: "Discard and leave",
                  danger: true,
                }).then((ok) => {
                  if (ok) setCategory(name);
                });
              }}
            >
              {name}
            </button>
          ))}
        </nav>
        <div className="settings-content">
          {category === "Roles" && <RoleEditor roles={roles} onRefreshRoles={onRefreshRoles} onDirtyChange={setRolesDirty} />}
          {category === "Pipelines" && <PipelinesSettings onSaved={onPipelinesChanged} onDirtyChange={setPipelinesDirty} />}
          {category === "Providers" &&
            (providers ? (
              <ProvidersSettingsSection providers={providers} />
            ) : (
              <section className="settings-section" aria-label="Providers">
                <h3>Providers</h3>
                <p className="hint">Unavailable until the app shell is running.</p>
              </section>
            ))}
          {category === "Models" && (
            <section className="settings-section" aria-label="Models">
              <h3>Models</h3>
              <p className="hint">
                New tabs use the role&apos;s model, or the default when the role has none. Each tab
                can override this from its header. Claude and Cursor keep separate defaults.
              </p>
              <ModelSettingsBlock
                title="Claude"
                models={claudeModelList?.models ?? []}
                sourceNote={claudeModelSource(claudeModelList)}
                error={claudeModelList?.error}
                current={
                  modelSettings?.claude ?? {
                    defaultModel: CLAUDE_DEFAULT_MODEL_ID,
                    roleModels: {},
                  }
                }
                fallbackId={CLAUDE_DEFAULT_MODEL_ID}
                effortLevels={CLAUDE_EFFORT_LEVELS}
                roleRows={[
                  ...roles.map((role) => ({ id: role.id, name: role.name })),
                  { id: "claude-cli", name: "Claude Code tabs" },
                ]}
                disabled={!onModelSettings}
                onChange={(next) => onModelSettings?.("claude", next)}
              />
              <ModelSettingsBlock
                title="Cursor"
                models={modelList?.models ?? []}
                sourceNote={cursorModelSource(modelList)}
                error={modelList?.error}
                current={
                  modelSettings?.cursor ?? { defaultModel: DEFAULT_MODEL_ID, roleModels: {} }
                }
                fallbackId={DEFAULT_MODEL_ID}
                roleRows={[
                  ...roles.map((role) => ({ id: role.id, name: role.name })),
                  { id: "cursor-cli", name: "Cursor CLI tabs" },
                ]}
                disabled={!onModelSettings}
                onChange={(next) => onModelSettings?.("cursor", next)}
                refresh={
                  onRefreshModels
                    ? { busy: !!modelsRefreshing, onClick: onRefreshModels }
                    : null
                }
              />
            </section>
          )}
          {category === "Appearance" && (
            <section className="settings-section" aria-label="Appearance">
              <h3>Appearance</h3>
              <label className="field-label settings-inline-field">
                Theme
                <select
                  className="text-input"
                  value={normalizeTheme(uiSettings?.theme)}
                  disabled={!onUiSettings}
                  onChange={(event) => onUiSettings?.({ theme: event.target.value })}
                >
                  {THEME_CHOICES.map((theme) => (
                    <option key={theme.id} value={theme.id}>
                      {theme.label}
                    </option>
                  ))}
                </select>
              </label>
              <p className="hint">
                Match system follows your operating system&apos;s light or dark setting and
                changes with it.
              </p>
            </section>
          )}
          {category === "Terminal" && (
            <section className="settings-section" aria-label="Terminal">
              <h3>Terminal</h3>
              <label className="field-label settings-inline-field">
                Shell program
                <DebouncedInput
                  className="text-input"
                  value={terminalSettings?.shell ?? ""}
                  placeholder="Blank uses pwsh, then PowerShell, or $SHELL"
                  disabled={!terminalSettings}
                  onCommit={(shell) => {
                    if (terminalSettings) onTerminalSettings({ ...terminalSettings, shell });
                  }}
                />
              </label>
              <label className="field-label settings-inline-field">
                Font size
                <DebouncedInput
                  className="text-input"
                  type="number"
                  min={8}
                  max={32}
                  value={String(terminalSettings?.fontSize ?? 14)}
                  disabled={!terminalSettings}
                  onCommit={(text) => {
                    if (!terminalSettings) return;
                    const typed = Number(text);
                    if (text.trim() === "" || !Number.isFinite(typed)) return;
                    const fontSize = Math.min(32, Math.max(8, Math.round(typed)));
                    if (fontSize !== terminalSettings.fontSize) {
                      onTerminalSettings({ ...terminalSettings, fontSize });
                    }
                  }}
                />
              </label>
              <label className="field-label settings-inline-field">
                <span>
                  <input
                    type="checkbox"
                    checked={terminalSettings?.copyOnSelect ?? false}
                    disabled={!terminalSettings}
                    onChange={(event) => {
                      if (!terminalSettings) return;
                      onTerminalSettings({
                        ...terminalSettings,
                        copyOnSelect: event.target.checked,
                      });
                    }}
                  />{" "}
                  Copy on select
                </span>
                <span className="hint">
                  Copy terminal text to the clipboard as soon as you select it.
                </span>
              </label>
              {platform === "mac" && (
                <label className="field-label settings-inline-field">
                  <span>
                    <input
                      type="checkbox"
                      checked={terminalSettings?.optionAsMeta ?? true}
                      disabled={!terminalSettings}
                      onChange={(event) => {
                        if (!terminalSettings) return;
                        onTerminalSettings({
                          ...terminalSettings,
                          optionAsMeta: event.target.checked,
                        });
                      }}
                    />{" "}
                    Use Option as Meta
                  </span>
                  <span className="hint">
                    Option+P, Option+O and Option+Enter reach Claude Code instead of typing a
                    symbol. Turn off to type characters such as é with Option.
                  </span>
                </label>
              )}
              {roles.map((role) => (
                <label className="field-label settings-inline-field" key={role.id}>
                  {role.name} run mode
                  <select
                    className="text-input"
                    value={terminalSettings?.roleRunMode[role.id] ?? "default"}
                    disabled={!terminalSettings}
                    onChange={(event) => {
                      if (!terminalSettings) return;
                      onTerminalSettings({
                        ...terminalSettings,
                        roleRunMode: { ...terminalSettings.roleRunMode, [role.id]: event.target.value },
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
              ))}
              <p className="hint">
                Run mode replaces only the role&apos;s mode flag. --approve-mcps and --trust stay on
                every role terminal. Default keeps the role&apos;s own flags. A plain Terminal tab
                that runs agent takes no extra flags. There is no CLI flag that denies writes while
                still allowing the shell. On Cursor terminals, Default is --plan for the Planner and
                --yolo for every other role. Claude terminals ignore this override.
              </p>
            </section>
          )}
          {category === "Permissions" && (
            <section className="settings-section" aria-label="Permissions">
              <h3>Permissions</h3>
              <p className="hint">
                Every role runs with full permissions. Answers are allow-once, so
                nothing is written to a repo&apos;s settings. Claude: bypass, auto, or
                plan per role. Cursor chat is unrestricted; Cursor terminals use
                --plan for the Planner and --yolo otherwise.
              </p>
              {approvalMode?.kind === "allowlist" && (
                <p className="hint">
                  Cursor CLI allowlist still applies inside Cursor terminals.
                  Claude tabs do not use that file. File creates and edits are not
                  routed through DCTerminal.
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
              <div className="settings-subsection">
                <h4>Diagnostics</h4>
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
              </div>
            </section>
          )}
          {category === "Usage" && (
            <section className="settings-section" aria-label="Usage">
              <h3>Usage</h3>
              <p className="hint">
                Updated by Claude chat tabs; terminal tabs don&apos;t report usage.
              </p>
              {usageError && <p className="error">{usageError}</p>}
              {usage && usage.windows.length === 0 && (
                <p className="hint">Claude usage not reported yet.</p>
              )}
              {usage?.windows.map((window) => {
                // A reading from before the window reset (e.g. saved before a restart) no longer applies.
                const stale = isStale(window);
                const pct = stale ? null : window.utilization;
                const width = pct == null ? 0 : Math.max(0, Math.min(100, pct));
                const tone = limitTone(window);
                const reset = formatReset(window.resetsAt);
                return (
                  <div key={window.rateLimitType} className="usage-window">
                    <div className="usage-window-head">
                      <span>
                        {window.label}
                        {pct == null ? "" : ` ${Math.round(pct)}%`}
                      </span>
                      <span className="hint">
                        {stale
                          ? "reset since this reading"
                          : reset
                            ? `resets ${reset}`
                            : "reset time not reported"}
                        {window.seenAtMs ? ` · ${formatSeen(window.seenAtMs)}` : ""}
                      </span>
                    </div>
                    <div className="usage-meter" aria-hidden>
                      <span className={`usage-meter-fill usage-meter-${tone}`} style={{ width: `${width}%` }} />
                    </div>
                  </div>
                );
              })}
            </section>
          )}
          {category === "Notifications" && (
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
                      notification and a toast that waits for you. Covers chat and terminal tabs
                      when they finish off screen.
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
          )}
          {category === "Shortcuts" && (
            <section className="settings-section" aria-label="Shortcuts">
              <h3>Shortcuts</h3>
              <div className="settings-toolbar">
                <label className="field-label diagnostics-toggle">
                  <input
                    type="checkbox"
                    checked={uiSettings?.shortcutBar ?? false}
                    disabled={!onUiSettings}
                    onChange={(event) => onUiSettings?.({ shortcutBar: event.target.checked })}
                  />
                  Show shortcut bar in the status strip
                </label>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={!onUiSettings || !uiSettings?.tipsSeen.length}
                  onClick={() => onUiSettings?.({ tipsSeen: [] })}
                >
                  Show tips again
                </button>
              </div>
              <ul className="settings-shortcuts">
                {rows.map((row) => (
                  <li key={`${row.action}-${row.label}-${row.keys}`}>
                    <span>{row.label}</span>
                    <kbd>{row.keys}</kbd>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {category === "Data" && (
            <section className="settings-section" aria-label="Data">
              <h3>Data</h3>
              <dl className="settings-paths">
                <dt>App data</dt>
                <dd>{diagnostics?.appDataDir || "Unavailable until the app shell is running."}</dd>
                <dt>Transcripts</dt>
                <dd>{diagnostics?.transcriptsDir || "transcripts"}</dd>
                <dt>Permission log</dt>
                <dd>{diagnostics?.logPath || "logs/permission-payloads.jsonl"}</dd>
                <dt>Crash log</dt>
                <dd>{diagnostics?.crashLogPath || "logs/crash.log"}</dd>
              </dl>
              <StorageRow />
              <div className="settings-subsection">
                <h4>About</h4>
                <p>
                  DCTerminal {APP_VERSION}
                  {cli?.found && cli.version ? ` · Cursor CLI ${cli.version}` : ""}
                </p>
                <p className="hint">
                  Release notes and update checks: see <code>docs/RELEASE.md</code> in the repo.
                </p>
                {cli && !cli.found && (
                  <p className="error">
                    Cursor CLI was not found. Install it and run <code>agent login</code>.
                  </p>
                )}
                {cliError && <p className="error">{cliError}</p>}
              </div>
              {showDevTools && (
                <div className="settings-subsection">
                  <h4>Developer probes</h4>
                  <DevToolsPanel cli={cli} cliError={cliError} />
                </div>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function cursorModelSource(list: ModelList | null): string {
  if (!list) return "";
  if (list.source === "cli") return " from agent --list-models";
  if (list.source === "cache") return " (cached list)";
  if (list.source === "fallback") return " (built-in list; agent --list-models was not available)";
  return "";
}

function claudeModelSource(list: ModelList | null): string {
  if (!list) return "";
  if (list.source === "cache") return " from the last Claude chat";
  if (list.source === "fallback") return " (built-in aliases; a Claude chat updates this list)";
  return "";
}

function ModelSettingsBlock({
  title,
  models,
  sourceNote,
  error,
  current,
  fallbackId,
  roleRows,
  disabled,
  onChange,
  refresh = null,
  effortLevels = null,
}: {
  title: string;
  models: ModelList["models"];
  sourceNote: string;
  error?: string | null;
  current: ModelSettings;
  fallbackId: string;
  roleRows: { id: string; name: string }[];
  disabled: boolean;
  onChange: (next: ModelSettings) => void;
  refresh?: { busy: boolean; onClick: () => void } | null;
  /** Claude: a per-role reasoning effort next to each role's model. */
  effortLevels?: readonly string[] | null;
}) {
  return (
    <div className="settings-subsection">
      <h4>{title}</h4>
      <div className="settings-model-row">
        <span className="settings-model-name">Default model</span>
        <ModelPicker
          models={models}
          value={current.defaultModel}
          ariaLabel={`${title} default model`}
          disabled={disabled}
          onChange={(model) => onChange({ ...current, defaultModel: model ?? fallbackId })}
        />
      </div>
      {roleRows.map((row) => (
        <div className="settings-model-row" key={`${title}-${row.id}`}>
          <span className="settings-model-name">{row.name}</span>
          <ModelPicker
            models={models}
            value={current.roleModels[row.id] ?? null}
            inherited={{ model: current.defaultModel, label: "Default model" }}
            ariaLabel={`${title} model for ${row.name}`}
            disabled={disabled}
            onChange={(model) => {
              const roleModels = { ...current.roleModels };
              if (model === null) delete roleModels[row.id];
              else roleModels[row.id] = model;
              onChange({ ...current, roleModels });
            }}
          />
          {effortLevels && row.id.startsWith("role_") && (
            <select
              className="effort-select"
              aria-label={`${title} effort for ${row.name}`}
              title="Reasoning effort when this role starts a chat. Each chat can change it from its header."
              value={current.roleEffort?.[row.id] ?? ""}
              disabled={disabled}
              onChange={(event) => {
                const roleEffort = { ...(current.roleEffort ?? {}) };
                if (event.target.value) roleEffort[row.id] = event.target.value;
                else delete roleEffort[row.id];
                onChange({ ...current, roleEffort });
              }}
            >
              <option value="">Effort: default</option>
              {effortLevels.map((level) => (
                <option key={level} value={level}>
                  Effort: {level}
                </option>
              ))}
            </select>
          )}
        </div>
      ))}
      <div className="button-row">
        {refresh && (
          <button
            type="button"
            className="secondary-button"
            onClick={refresh.onClick}
            disabled={refresh.busy}
          >
            {refresh.busy ? "Refreshing…" : "Refresh Cursor model list"}
          </button>
        )}
        <span className="hint">
          {models.length} models{sourceNote}
        </span>
      </div>
      {error && <p className="hint">{error}</p>}
    </div>
  );
}

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

/**
 * One save model for the page. track() takes what a settings handler returned:
 * a promise (Saving, then Saved or the error) or nothing (saved at once).
 */
function useSaveMarker() {
  const [state, setState] = useState<SaveState>({ kind: "idle" });
  const pending = useRef(0);
  const track = useCallback((result: unknown) => {
    if (!result || typeof (result as Promise<unknown>).then !== "function") {
      setState({ kind: "saved" });
      return;
    }
    pending.current += 1;
    setState({ kind: "saving" });
    (result as Promise<unknown>).then(
      () => {
        pending.current -= 1;
        if (pending.current === 0) setState({ kind: "saved" });
      },
      (err: unknown) => {
        pending.current -= 1;
        setState({ kind: "error", message: errorText(err) });
      },
    );
  }, []);
  const marker =
    state.kind === "idle" ? null : state.kind === "error" ? (
      <span className="save-marker save-marker-error" role="alert">
        Not saved: {state.message}
      </span>
    ) : (
      <span className="save-marker" role="status">
        {state.kind === "saving" ? "Saving…" : "Saved"}
      </span>
    );
  return { marker, track };
}

/**
 * A text or number input that keeps its own draft and saves once typing
 * pauses, on blur, or when it goes away, not on every keystroke.
 */
function DebouncedInput({
  value,
  onCommit,
  delay = 600,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "onBlur"> & {
  value: string;
  onCommit: (value: string) => void;
  delay?: number;
}) {
  const [draft, setDraft] = useState(value);
  const dirty = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const latest = useRef({ draft, onCommit });
  latest.current = { draft, onCommit };

  useEffect(() => {
    if (!dirty.current) setDraft(value);
  }, [value]);

  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    if (!dirty.current) return;
    dirty.current = false;
    latest.current.onCommit(latest.current.draft);
  }, []);
  useEffect(() => flush, [flush]);

  return (
    <input
      {...rest}
      value={draft}
      onChange={(event) => {
        dirty.current = true;
        latest.current.draft = event.target.value;
        setDraft(event.target.value);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(flush, delay);
      }}
      onBlur={flush}
    />
  );
}
