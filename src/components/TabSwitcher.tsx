import { useMemo, useState } from "react";

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
};

export function TabSwitcher({
  tabs,
  onSelect,
  onClose,
  title = "Go to tab",
  placeholder = "Go to tab by name or folder",
}: Props) {
  const [query, setQuery] = useState("");
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tabs;
    return tabs.filter((tab) =>
      `${tab.label} ${tab.cwd} ${tab.phase}`.toLowerCase().includes(q),
    );
  }, [tabs, query]);

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
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && matches[0]) {
              event.preventDefault();
              onSelect(matches[0].id);
            }
          }}
        />
        <ul className="palette-list">
          {matches.map((tab) => (
            <li key={tab.id}>
              <button type="button" className="palette-item" onClick={() => onSelect(tab.id)}>
                <span>{tab.label}</span>
                <span className="hint">
                  {tab.phase} · {tab.cwd}
                </span>
              </button>
            </li>
          ))}
          {matches.length === 0 && <li className="hint">No tabs match</li>}
        </ul>
      </div>
    </div>
  );
}
