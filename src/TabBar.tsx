import type { TabSummary } from "./bridge";

type Props = {
  tabs: TabSummary[];
  activeTabId: string | null;
  /** Disables switching/closing tabs (e.g. while a live session is open). */
  disableSwitch?: boolean;
  /** Disables + New tab (e.g. while a command is in flight). */
  disableNew?: boolean;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onNew: () => void;
};

export function TabBar({
  tabs,
  activeTabId,
  disableSwitch = false,
  disableNew = false,
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
                disabled={disableSwitch}
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
                  disabled={disableSwitch}
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
        disabled={disableNew}
        title={
          disableSwitch && !disableNew
            ? "Creates a draft tab — stop the session to switch to it"
            : undefined
        }
      >
        + New tab
      </button>
    </div>
  );
}
