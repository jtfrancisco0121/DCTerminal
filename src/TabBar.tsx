import type { TabSummary } from "./bridge";

type Props = {
  tabs: TabSummary[];
  activeTabId: string | null;
  roleColors?: Record<string, string>;
  /** Disables switching/closing tabs (e.g. while a live session is open). */
  disableSwitch?: boolean;
  /** Disables + New tab (e.g. while a command is in flight). */
  disableNew?: boolean;
  attentionTabIds?: string[];
  canReopen?: boolean;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onNew: () => void;
  onReopen?: () => void;
  onColor?: (tabId: string, color: string) => void;
  settingsOpen?: boolean;
  onSettings?: () => void;
};

const CHIP_COLORS = ["#58a6ff", "#3fb950", "#d29922", "#f0883e", "#bc8cff", "#f85149", "#8b949e"];

export function TabBar({
  tabs,
  activeTabId,
  roleColors = {},
  disableSwitch = false,
  disableNew = false,
  attentionTabIds = [],
  canReopen = false,
  onSelect,
  onClose,
  onNew,
  onReopen,
  onColor,
  settingsOpen = false,
  onSettings,
}: Props) {
  return (
    <div className="tab-bar">
      <div className="tab-list" role="tablist">
        {tabs.map((t) => {
          const active = t.id === activeTabId;
          const needsAttention = attentionTabIds.includes(t.id);
          const color = t.color || roleColors[t.roleId] || "#8b949e";
          return (
            <div
              key={t.id}
              className={`tab-chip${active ? " tab-chip-active" : ""}${needsAttention ? " tab-chip-attention" : ""}`}
              style={{ boxShadow: `inset 0 3px 0 ${color}` }}
            >
              <button
                type="button"
                className="tab-chip-label"
                role="tab"
                aria-selected={active}
                onClick={() => onSelect(t.id)}
                disabled={disableSwitch}
                title={`${t.label} · ${t.phase}`}
              >
                <span
                  className={`tab-phase tab-phase-${t.phase}`}
                  aria-hidden
                  style={{ background: color }}
                />
                {t.label}
                {t.terminalLaunch === "role" && <span className="tab-badge">Terminal</span>}
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
                      {choice}
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
                  t.phase === "running"
                    ? `Stop and close ${t.label}`
                    : `Close ${t.label}`
                }
                title={
                  t.phase === "running"
                    ? "Stops this tab's agent and closes the tab"
                    : undefined
                }
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
      {canReopen && onReopen && (
        <button
          type="button"
          className="secondary-button"
          onClick={onReopen}
          disabled={disableNew}
          title="Reopen the most recently closed tab (F6)"
        >
          Reopen
        </button>
      )}
      <button
        type="button"
        className="secondary-button tab-new"
        onClick={onNew}
        disabled={disableNew}
        title="Open another tab. Other sessions keep running."
      >
        + New tab
      </button>
      {onSettings && (
        <button
          type="button"
          className={`secondary-button tab-gear${settingsOpen ? " tab-gear-active" : ""}`}
          onClick={onSettings}
          aria-label="Settings"
          aria-pressed={settingsOpen}
          title="Settings (Ctrl+,)"
        >
          <svg className="tab-gear-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
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
