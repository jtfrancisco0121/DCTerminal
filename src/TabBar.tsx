import type { TabSummary } from "./bridge";

type Props = {
  tabs: TabSummary[];
  activeTabId: string | null;
  /** Disables switching/closing tabs (e.g. while a live session is open). */
  disableSwitch?: boolean;
  /** Disables + New tab (e.g. while a command is in flight). */
  disableNew?: boolean;
  attentionTabIds?: string[];
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onNew: () => void;
};

export function TabBar({
  tabs,
  activeTabId,
  disableSwitch = false,
  disableNew = false,
  attentionTabIds = [],
  onSelect,
  onClose,
  onNew,
}: Props) {
  return (
    <div className="tab-bar">
      <div className="tab-list" role="tablist">
        {tabs.map((t) => {
          const active = t.id === activeTabId;
          const needsAttention = attentionTabIds.includes(t.id);
          return (
            <div
              key={t.id}
              className={`tab-chip${active ? " tab-chip-active" : ""}${needsAttention ? " tab-chip-attention" : ""}`}
              role="tab"
              aria-selected={active}
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
                />
                {t.label}
              </button>
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
