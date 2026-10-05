import type { TabSummary } from "./bridge";

type Props = {
  tabs: TabSummary[];
  activeTabId: string | null;
  disabled: boolean;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onNew: () => void;
};

export function TabBar({
  tabs,
  activeTabId,
  disabled,
  onSelect,
  onClose,
  onNew,
}: Props) {
  return (
    <div className="tab-bar">
      <div className="tab-list" role="tablist">
        {tabs.map((t) => {
          const active = t.id === activeTabId;
          return (
            <div
              key={t.id}
              className={`tab-chip${active ? " tab-chip-active" : ""}`}
              role="tab"
              aria-selected={active}
            >
              <button
                type="button"
                className="tab-chip-label"
                onClick={() => onSelect(t.id)}
                disabled={disabled}
                title={`${t.label} · ${t.phase}`}
              >
                <span
                  className={`tab-phase tab-phase-${t.phase}`}
                  aria-hidden
                />
                {t.label}
              </button>
              {t.phase !== "running" && (
                <button
                  type="button"
                  className="tab-chip-close"
                  onClick={() => onClose(t.id)}
                  disabled={disabled}
                  aria-label={`Close ${t.label}`}
                >
                  ×
                </button>
              )}
            </div>
          );
        })}
      </div>
      <button
        type="button"
        className="secondary-button tab-new"
        onClick={onNew}
        disabled={disabled}
      >
        + New tab
      </button>
    </div>
  );
}
