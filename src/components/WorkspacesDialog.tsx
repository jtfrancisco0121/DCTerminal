import { useEffect, useRef, useState } from "react";
import type { WorkspaceList } from "../bridge";

type Props = {
  /** null while loading. */
  list: WorkspaceList | null;
  loadError?: string | null;
  /** Tabs that "Save" would capture. */
  openTabCount: number;
  /** Focus the name field (palette "Save tabs as workspace…"). */
  focusSave?: boolean;
  /** Rejects with a message the dialog shows. */
  onSave: (name: string, replace: boolean) => Promise<void>;
  onOpen: (id: string, replace: boolean) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onClose: () => void;
};

function when(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** F7: save the open tabs as a named workspace, or open a saved one. */
export function WorkspacesDialog({
  list,
  loadError = null,
  openTabCount,
  focusSave = false,
  onSave,
  onOpen,
  onDelete,
  onClose,
}: Props) {
  const [name, setName] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const workspaces = list?.workspaces ?? [];
  const selected = workspaces.find((w) => w.id === selectedId) ?? workspaces[0] ?? null;
  const clash = workspaces.find((w) => w.name.toLowerCase() === name.trim().toLowerCase()) ?? null;

  // Focus once, when the list first arrives; later refreshes keep focus.
  const focusedRef = useRef(false);
  useEffect(() => {
    if (focusedRef.current) return;
    if (focusSave || workspaces.length === 0) nameRef.current?.focus();
    else listRef.current?.focus();
    if (list) focusedRef.current = true;
  }, [focusSave, list, workspaces.length]);

  const run = async (job: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await job();
    } catch (err: unknown) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed || openTabCount === 0) return;
    if (clash && !window.confirm(`Replace the saved workspace “${clash.name}” with the tabs open now?`)) {
      return;
    }
    void run(async () => {
      await onSave(trimmed, !!clash);
      setName("");
    });
  };

  const tabsWord = (n: number) => `${n} tab${n === 1 ? "" : "s"}`;

  return (
    <div className="overlay-backdrop" role="presentation" onClick={onClose}>
      <div
        className="overlay-panel workspaces-dialog"
        role="dialog"
        aria-label="Workspaces"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <h3>Workspaces</h3>
        <div className="workspaces-save">
          <input
            ref={nameRef}
            className="text-input"
            aria-label="Workspace name"
            placeholder="Name for the tabs open now"
            maxLength={80}
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                save();
              }
            }}
          />
          <button
            type="button"
            className="primary-button"
            disabled={busy || !name.trim() || openTabCount === 0}
            onClick={save}
          >
            {clash ? `Replace “${clash.name}”` : `Save ${tabsWord(openTabCount)}`}
          </button>
        </div>
        {loadError && <p className="error">{loadError}</p>}
        {error && <p className="error">{error}</p>}
        {list && workspaces.length === 0 ? (
          <p className="hint">
            No saved workspaces yet. Name the tabs open now and save them; each tab's title,
            folder, and role come back when you open the workspace.
          </p>
        ) : !list && !loadError ? (
          <p className="hint">Loading…</p>
        ) : (
          <div className="workspaces-body">
            <ul
              ref={listRef}
              className="workspaces-list"
              role="listbox"
              aria-label="Saved workspaces"
              tabIndex={0}
              onKeyDown={(event) => {
                if (!selected) return;
                const at = workspaces.indexOf(selected);
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const next = workspaces[at + (event.key === "ArrowDown" ? 1 : -1)];
                  if (next) setSelectedId(next.id);
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  void run(() => onOpen(selected.id, false));
                }
              }}
            >
              {workspaces.map((w) => (
                <li
                  key={w.id}
                  role="option"
                  aria-selected={w === selected}
                  className={w === selected ? "workspaces-item active" : "workspaces-item"}
                  onClick={() => setSelectedId(w.id)}
                  onDoubleClick={() => void run(() => onOpen(w.id, false))}
                >
                  <span className="workspaces-name">{w.name}</span>
                  <span className="hint">
                    {tabsWord(w.tabs.length)} · {when(w.savedAt)}
                  </span>
                </li>
              ))}
            </ul>
            {selected && (
              <div className="workspaces-detail">
                <ol className="workspaces-tabs" aria-label={`Tabs in ${selected.name}`}>
                  {selected.tabs.map((t, i) => (
                    <li key={i} className={i === selected.activeIndex ? "active" : undefined}>
                      <span
                        className="workspaces-dot"
                        style={t.color ? { background: t.color } : undefined}
                        aria-hidden
                      />
                      <span className="workspaces-tab-label">{t.label}</span>
                      <span className="hint">
                        {t.kind === "terminal"
                          ? `Terminal${t.terminalLaunch === "role" ? ` · ${t.roleSnapshot.name}` : ""}`
                          : t.roleSnapshot.name}
                      </span>
                      <code className="workspaces-folder">{t.cwd || "(no folder)"}</code>
                    </li>
                  ))}
                </ol>
                <div className="workspaces-actions">
                  <button
                    type="button"
                    className="primary-button"
                    disabled={busy}
                    onClick={() => void run(() => onOpen(selected.id, false))}
                    title="Add these tabs next to the ones open now"
                  >
                    Open
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busy}
                    onClick={() => void run(() => onOpen(selected.id, true))}
                    title="Close the tabs open now (they stay in Reopen closed tab) and open these"
                  >
                    Replace open tabs
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busy}
                    onClick={() => {
                      if (!window.confirm(`Delete the workspace “${selected.name}”?`)) return;
                      void run(() => onDelete(selected.id));
                    }}
                  >
                    Delete
                  </button>
                </div>
                <p className="hint">
                  Chat tabs open as drafts; nothing starts until you press Start. Terminal tabs
                  start their shell when you show them.
                </p>
              </div>
            )}
          </div>
        )}
        {list && (
          <p className="hint workspaces-path">
            Stored in DCTerminal's app data: <code>{list.path}</code>
          </p>
        )}
      </div>
    </div>
  );
}
