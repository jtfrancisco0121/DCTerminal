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
              role="tab"
              aria-selected={active}
              style={{ boxShadow: `inset 0 3px 0 ${color}` }}
            >
              <button
                type="button"
                className="tab-chip-label"
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
    </div>
  );
}
