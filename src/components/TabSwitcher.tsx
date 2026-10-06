import { useCallback, useEffect, useMemo, useState } from "react";
import { folderName, searchTabs } from "../tabSearch";
import { tabStatusLabel, type TabStatus } from "../tabStatus";

type TabItem = {
  id: string;
  label: string;
  cwd: string;
  phase: string;
};

type Props = {
  tabs: TabItem[];
  onSelect: (tabId: string) => void;
  onClose: () => void;
  title?: string;
  placeholder?: string;
  activeTabId?: string | null;
  statuses?: Record<string, TabStatus>;
};

const NO_STATUSES: Record<string, TabStatus> = {};

export function TabSwitcher({
  tabs,
  onSelect,
  onClose,
  title = "Go to tab",
  placeholder = "Go to tab by name or folder",
  activeTabId = null,
  statuses = NO_STATUSES,
}: Props) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const statusText = useCallback(
    (tab: TabItem) => {
      const status = statuses[tab.id];
      return status ? tabStatusLabel(status) : "";
    },
    [statuses],
  );
  const matches = useMemo(() => searchTabs(tabs, query, statusText), [tabs, query, statusText]);

  useEffect(() => {
    setIndex(0);
  }, [query]);

  const selected = Math.min(index, Math.max(matches.length - 1, 0));

  return (
    <div className="overlay-backdrop" role="presentation" onClick={onClose}>
      <div
        className="overlay-panel overlay-panel-palette"
        role="dialog"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <input
          className="text-input"
          autoFocus
          placeholder={placeholder}
          value={query}
          aria-label={title}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setIndex(Math.min(selected + 1, Math.max(matches.length - 1, 0)));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setIndex(Math.max(selected - 1, 0));
            } else if (event.key === "Enter" && matches[selected]) {
              event.preventDefault();
              onSelect(matches[selected].id);
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onClose();
            }
          }}
        />
        <ul className="palette-list" role="listbox" aria-label="Tabs">
          {matches.map((tab, i) => {
            const status = statusText(tab);
            const folder = folderName(tab.cwd);
            return (
              <li key={tab.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === selected}
                  className={i === selected ? "palette-item palette-item-active" : "palette-item"}
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => onSelect(tab.id)}
                >
                  <span>
                    {tab.label}
                    {tab.id === activeTabId && <span className="hint"> · current</span>}
                    {status && <span className="tab-switcher-status"> · {status}</span>}
                  </span>
                  <span className="hint" title={tab.cwd}>
                    {folder ? `${folder} · ${tab.cwd}` : tab.phase}
                  </span>
                </button>
              </li>
            );
          })}
          {matches.length === 0 && <li className="hint">No tabs match</li>}
        </ul>
      </div>
    </div>
  );
}
