import { Fragment, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { localShortcutLabel } from "./keymap";
import type { TabSummary } from "./bridge";
import { chainLabel } from "./handoff/chains";
import { tabStatusLabel, type TabStatus } from "./tabStatus";

type Props = {
  tabs: TabSummary[];
  activeTabId: string | null;
  roleColors?: Record<string, string>;
  /** Disables switching/closing tabs (e.g. while a live session is open). */
  disableSwitch?: boolean;
  /** Disables + New tab (e.g. while a command is in flight). */
  disableNew?: boolean;
  /** F2 chip status: busy pulse, unseen dot, needs-you flag. */
  statuses?: Record<string, TabStatus>;
  canReopen?: boolean;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onNew: () => void;
  /** Opens another window on a Claude account. */
  onNewWindow?: () => void;
  newWindowTitle?: string;
  /** F3: open the "New tab in worktree…" dialog. */
  onNewWorktree?: () => void;
  /** Grid view: show several tabs at once. */
  onToggleGrid?: () => void;
  gridOpen?: boolean;
  onReopen?: () => void;
  onColor?: (tabId: string, color: string) => void;
  settingsOpen?: boolean;
  onSettings?: () => void;
  /** Tab whose chip shows the rename field. */
  renamingTabId?: string | null;
  onRenameStart?: (tabId: string) => void;
  onRename?: (tabId: string, label: string) => void;
  onRenameEnd?: () => void;
  /** U1: role names and each tab's model for the chip's hover details. */
  roleNames?: Record<string, string>;
  modelFor?: (tab: TabSummary) => string | null;
  /** Provider line for the chip's hover details (agent tabs only). */
  providerFor?: (tab: TabSummary) => string | null;
  /** Tabs whose turn has ended (R19: a chain chip shows a check mark). */
  doneTabIds?: readonly string[];
};

const PHASE_TEXT: Record<string, string> = {
  draft: "Not started",
  running: "Running",
  stopped: "Stopped",
};

/** U1: everything the slim chip leaves out, one fact per line. */
export function tabTooltip(
  tab: TabSummary,
  opts: {
    roleName?: string;
    model?: string | null;
    /** Provider line, e.g. Claude with the full config folder and account. */
    provider?: string | null;
    statusText?: string;
    canRename?: boolean;
    chain?: string | null;
  },
): string {
  const lines = [tab.label];
  if (opts.chain) lines.push(opts.chain);
  if (opts.roleName) lines.push(`Role: ${opts.roleName}`);
  if (opts.provider) lines.push(`Provider: ${opts.provider}`);
  if (tab.cwd) lines.push(`Folder: ${tab.cwd}`);
  if (tab.worktreeBranch) lines.push(`Branch: ${tab.worktreeBranch}`);
  if (opts.model) lines.push(`Model: ${opts.model}`);
  lines.push(`Status: ${opts.statusText || PHASE_TEXT[tab.phase] || tab.phase}`);
  if (opts.canRename) lines.push("Double-click to rename");
  return lines.join("\n");
}

/** Group title for a run of chain tabs: the task name from "Role · Task", else the chain name. */
export function chainGroupTitle(tab: TabSummary): string {
  const chain = tab.chain;
  if (!chain) return "";
  const task = tab.label.split(" · ").slice(1).join(" · ").trim();
  if (task) return task;
  return chain.kind === "eagle2" ? "Eagle-Eye 2" : "Eagle-Eye 1";
}

/** R19: the one badge a chain chip shows: done, needs you / exited, working. */
export function chainBadge(opts: {
  exited: boolean;
  needsYou: boolean;
  busy: boolean;
  done: boolean;
}): { glyph: string; tone: "done" | "needs" | "busy" } | null {
  if (opts.exited || opts.needsYou) return { glyph: "!", tone: "needs" };
  if (opts.busy) return { glyph: "●", tone: "busy" };
  if (opts.done) return { glyph: "✓", tone: "done" };
  return null;
}

function RenameField({
  label,
  onCommit,
  onEnd,
}: {
  label: string;
  onCommit: (label: string) => void;
  onEnd: () => void;
}) {
  const [value, setValue] = useState(label);
  const doneRef = useRef(false);
  const finish = (commit: boolean) => {
    if (doneRef.current) return;
    doneRef.current = true;
    const next = value.trim();
    if (commit && next && next !== label) onCommit(next);
    onEnd();
  };
  return (
    <input
      className="tab-rename-input"
      aria-label={`Rename ${label}`}
      autoFocus
      maxLength={80}
      value={value}
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          finish(true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          finish(false);
        }
      }}
    />
  );
}

/** Tab chip and role colors (Settings > Roles uses the same choices). */
export const CHIP_COLORS = [
  "#58a6ff",
  "#3fb950",
  "#d29922",
  "#f0883e",
  "#bc8cff",
  "#f85149",
  "#8b949e",
];

/** Names for the colour menu, so it does not read out hex codes. */
export const CHIP_COLOR_NAMES: Record<string, string> = {
  "#58a6ff": "Blue",
  "#3fb950": "Green",
  "#d29922": "Yellow",
  "#f0883e": "Orange",
  "#bc8cff": "Purple",
  "#f85149": "Red",
  "#8b949e": "Gray",
};

/** Text for a phase, since the dot's colour and shape alone are not enough. */
export function phaseText(phase: string): string {
  return PHASE_TEXT[phase] || phase;
}

/** "Label (Ctrl+K)", or just the label when the command has no shortcut. */
function withShortcut(label: string, id: string): string {
  const keys = localShortcutLabel(id);
  return keys ? `${label} (${keys})` : label;
}

/** Left and right arrows move between the tabs, like a tablist. */
function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
  const step =
    event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : event.key === "Home" ? "first" : event.key === "End" ? "last" : 0;
  if (!step) return;
  const list = event.currentTarget.closest(".tab-list");
  const labels = Array.from(list?.querySelectorAll<HTMLButtonElement>(".tab-chip-label") ?? []).filter(
    (el) => !el.disabled,
  );
  const at = labels.indexOf(event.currentTarget);
  const next =
    step === "first" ? labels[0] : step === "last" ? labels[labels.length - 1] : labels[at + step];
  if (!next) return;
  event.preventDefault();
  next.focus();
}

export function TabBar({
  tabs,
  activeTabId,
  roleColors = {},
  disableSwitch = false,
  disableNew = false,
  statuses = {},
  canReopen = false,
  onSelect,
  onClose,
  onNew,
  onNewWindow,
  newWindowTitle,
  onNewWorktree,
  onToggleGrid,
  gridOpen = false,
  onReopen,
  onColor,
  settingsOpen = false,
  onSettings,
  renamingTabId = null,
  onRenameStart,
  onRename,
  onRenameEnd,
  roleNames = {},
  modelFor,
  providerFor,
  doneTabIds = [],
}: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  // The strip scrolls instead of squeezing every tab; keep the active one in view.
  useEffect(() => {
    const active = listRef.current?.querySelector(".tab-chip-active");
    if (active && typeof active.scrollIntoView === "function") {
      active.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [activeTabId, tabs.length]);
  return (
    <div className="tab-bar">
      <div className="tab-list" role="tablist" aria-label="Open tabs" ref={listRef}>
        {tabs.map((t, index) => {
          const chainId = t.chain?.chainId ?? null;
          const startsChainRun = !!chainId && tabs[index - 1]?.chain?.chainId !== chainId;
          const active = t.id === activeTabId;
          const status = statuses[t.id];
          const exited = typeof status?.exitCode === "number";
          const needsYou = exited ? null : (status?.needsYou ?? null);
          const busy = !exited && !needsYou && !!status?.busy;
          const unseen = !exited && !needsYou && !busy && !!status?.unseen;
          const statusText = status ? tabStatusLabel(status) : "";
          const color = t.color || roleColors[t.roleId] || "#8b949e";
          const chipClass = [
            "tab-chip",
            active ? "tab-chip-active" : "",
            exited ? "tab-chip-error tab-chip-attention" : "",
            needsYou ? "tab-chip-needs tab-chip-attention" : "",
            busy ? "tab-chip-busy" : "",
            unseen ? "tab-chip-unseen" : "",
            chainId ? "tab-chip-chain" : "",
          ]
            .filter(Boolean)
            .join(" ");
          const chainHead = startsChainRun ? (
            <span
              className="tab-chain-label"
              title={t.chain ? `${chainLabel(t.chain)}` : undefined}
            >
              {chainGroupTitle(t)} ▸
            </span>
          ) : null;
          const badge = chainId
            ? chainBadge({
                exited,
                needsYou: !!needsYou,
                busy,
                done: doneTabIds.includes(t.id),
              })
            : null;
          const chainRole = chainId ? (roleNames[t.roleId] ?? t.label) : null;
          if (renamingTabId === t.id) {
            return (
              <Fragment key={t.id}>
                {chainHead}
                <div className={chipClass} style={{ "--chip-color": color } as CSSProperties}>
                  <RenameField
                    label={t.label}
                    onCommit={(label) => onRename?.(t.id, label)}
                    onEnd={() => onRenameEnd?.()}
                  />
                </div>
              </Fragment>
            );
          }
          return (
            <Fragment key={t.id}>
              {chainHead}
              <div
                className={chipClass}
                style={{ "--chip-color": color } as CSSProperties}
                data-status={
                  exited
                    ? "exited"
                    : needsYou
                      ? "needs"
                      : busy
                        ? "busy"
                        : unseen
                          ? "unseen"
                          : "idle"
                }
              >
                <button
                  type="button"
                  className="tab-chip-label"
                  role="tab"
                  aria-selected={active}
                  onClick={() => onSelect(t.id)}
                  onDoubleClick={() => onRenameStart?.(t.id)}
                  disabled={disableSwitch}
                  onKeyDown={onTabKeyDown}
                  aria-description={statusText ? undefined : phaseText(t.phase)}
                  title={tabTooltip(t, {
                    roleName:
                      t.kind === "terminal" && t.terminalLaunch !== "role"
                        ? undefined
                        : roleNames[t.roleId],
                    model: modelFor?.(t) ?? null,
                    provider: providerFor?.(t) ?? null,
                    statusText,
                    canRename: !!onRenameStart,
                    chain: t.chain ? chainLabel(t.chain) : null,
                  })}
                >
                  <span
                    className={`tab-phase tab-phase-${t.phase}`}
                    aria-hidden
                    style={{ background: color }}
                  />
                  <span className="tab-chip-text">{chainRole ?? t.label}</span>
                  {badge && (
                    <span className={`tab-chain-badge tab-chain-badge-${badge.tone}`} aria-hidden>
                      {badge.glyph}
                    </span>
                  )}
                  {!chainId && exited && (
                    <span className="tab-needs-flag tab-error-flag" aria-hidden>
                      ×
                    </span>
                  )}
                  {!chainId && needsYou && (
                    <span className="tab-needs-flag" aria-hidden>
                      !
                    </span>
                  )}
                  {!chainId && unseen && <span className="tab-unseen-dot" aria-hidden />}
                  {statusText && <span className="sr-only">, {statusText}</span>}
                  {!chainId && t.worktreeBranch && (
                    <span className="tab-badge tab-branch" title={t.worktreePath ?? undefined}>
                      ⎇ {t.worktreeBranch}
                    </span>
                  )}
                  {!chainId && t.terminalLaunch === "role" && (
                    <span
                      className="tab-icon"
                      role="img"
                      aria-label="Role terminal"
                      title="Role terminal"
                    >
                      ›_
                    </span>
                  )}
                </button>
                {onColor && (
                  <select
                    className="tab-color-select"
                    aria-label={`Color for ${t.label}`}
                    value={color}
                    onChange={(event) => onColor(t.id, event.target.value)}
                    disabled={disableSwitch}
                  >
                    {CHIP_COLORS.map((choice) => (
                      <option key={choice} value={choice}>
                        {CHIP_COLOR_NAMES[choice] ?? choice}
                      </option>
                    ))}
                  </select>
                )}
                <button
                  type="button"
                  className="tab-chip-close"
                  onClick={() => onClose(t.id)}
                  disabled={disableSwitch}
                  aria-label={
                    t.phase === "running" ? `Stop and close ${t.label}` : `Close ${t.label}`
                  }
                  title={
                    t.phase === "running" ? "Stops this tab's agent and closes the tab" : undefined
                  }
                >
                  ×
                </button>
              </div>
            </Fragment>
          );
        })}
      </div>
      {canReopen && onReopen && (
        <button
          type="button"
          className="secondary-button icon-button tab-bar-icon"
          onClick={onReopen}
          disabled={disableNew}
          aria-label="Reopen closed tab"
          title={withShortcut("Reopen the most recently closed tab", "reopenClosedTab")}
        >
          ↺
        </button>
      )}
      <button
        type="button"
        className="secondary-button icon-button tab-new tab-bar-icon"
        onClick={onNew}
        disabled={disableNew}
        aria-label="New tab"
        title={`${withShortcut("New tab", "newTab")}. Other sessions keep running.`}
      >
        +
      </button>
      {onNewWindow && (
        <button
          type="button"
          className="secondary-button icon-button tab-new tab-bar-icon"
          onClick={onNewWindow}
          disabled={disableNew}
          aria-label="New window"
          title={newWindowTitle ?? "New window for another Claude account"}
        >
          ⧉
        </button>
      )}
      {onToggleGrid && (
        <button
          type="button"
          className={`secondary-button icon-button tab-new tab-bar-icon${gridOpen ? " tab-bar-icon-active" : ""}`}
          onClick={onToggleGrid}
          aria-label={gridOpen ? "Close grid view" : "Grid view"}
          aria-pressed={!!gridOpen}
          title={
            gridOpen
              ? "Close grid view. Every tab keeps running."
              : "Grid view: show up to six tabs at once, each live in its own cell"
          }
        >
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
            <path
              fill="currentColor"
              d="M1.5 1.5h5.5v5.5h-5.5zM9 1.5h5.5v5.5H9zM1.5 9h5.5v5.5h-5.5zM9 9h5.5v5.5H9z"
            />
          </svg>
        </button>
      )}
      {onNewWorktree && (
        <button
          type="button"
          className="secondary-button icon-button tab-new tab-bar-icon"
          onClick={onNewWorktree}
          disabled={disableNew}
          aria-label="New tab in worktree…"
          title="New tab in worktree: create a git worktree in a sibling folder and open a tab there"
        >
          ⎇
        </button>
      )}
      {onSettings && (
        <button
          type="button"
          className={`secondary-button tab-gear${settingsOpen ? " tab-gear-active" : ""}`}
          onClick={onSettings}
          aria-label="Settings"
          aria-pressed={settingsOpen}
          title={withShortcut("Settings", "settings")}
        >
          <svg
            className="tab-gear-icon"
            viewBox="0 0 16 16"
            width="16"
            height="16"
            aria-hidden="true"
          >
            <path
              fill="currentColor"
              d="M9.1 1.5h-2.2l-.35 1.55a4.7 4.7 0 0 0-1.15.67L3.9 2.9 2.35 4.45l.82 1.5a4.7 4.7 0 0 0-.67 1.15L1 7.45v2.2l1.5.35c.12.42.32.8.57 1.15l-.82 1.5 1.55 1.55.82-.82c.35.25.73.45 1.15.57L6.9 14.5h2.2l.35-1.5c.42-.12.8-.32 1.15-.57l1.5.82 1.55-1.55-.82-1.5c.25-.35.45-.73.57-1.15l1.5-.35v-2.2l-1.5-.35a4.7 4.7 0 0 0-.57-1.15l.82-1.5L12.1 2.9l-1.5.82a4.7 4.7 0 0 0-1.15-.67L9.1 1.5zM8 6.1A1.9 1.9 0 1 1 6.1 8 1.9 1.9 0 0 1 8 6.1z"
            />
          </svg>
        </button>
      )}
    </div>
  );
}
