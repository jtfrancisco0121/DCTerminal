import { useEffect, useRef, useState } from "react";
import type { CursorHistoryEntry } from "../cursorHistory";
import { CursorHistoryList } from "./CursorHistoryList";

type Props = {
  /** The active tab's folder; empty when the tab has none yet. */
  folder: string;
  load: (folder: string) => Promise<CursorHistoryEntry[]>;
  busy: boolean;
  onResume: (entry: CursorHistoryEntry) => void;
  onOpenCli: (entry: CursorHistoryEntry) => void;
  onClose: () => void;
};

/** F9: the folder's Cursor CLI chat history, opened from the palette. */
export function ChatHistoryDialog({ folder, load, busy, onResume, onOpenCli, onClose }: Props) {
  const [entries, setEntries] = useState<CursorHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!folder) return;
    let cancelled = false;
    setEntries(null);
    setError(null);
    loadRef
      .current(folder)
      .then((rows) => {
        if (!cancelled) setEntries(rows);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setEntries([]);
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [folder]);

  return (
    <div className="overlay-backdrop" role="presentation" onClick={onClose}>
      <div
        ref={panelRef}
        tabIndex={-1}
        className="overlay-panel chat-history-dialog"
        role="dialog"
        aria-label="Chat history"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
      >
        {folder ? (
          <>
            <p className="hint">
              Folder: <code>{folder}</code>
            </p>
            {entries === null ? (
              <p className="hint">Loading…</p>
            ) : (
              <CursorHistoryList
                entries={entries}
                error={error}
                busy={busy}
                onResume={onResume}
                onOpenCli={onOpenCli}
              />
            )}
          </>
        ) : (
          <p className="hint">Pick a folder for this tab first, then open chat history again.</p>
        )}
        <div className="button-row">
          <button type="button" className="secondary-button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
