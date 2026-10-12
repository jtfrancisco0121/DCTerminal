import { useEffect, useRef, useState } from "react";
import { Dialog } from "./Dialog";
import { errorText } from "./InlineNotice";
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
  const loadRef = useRef(load);
  loadRef.current = load;

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
          setError(errorText(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [folder]);

  return (
    <Dialog
      title="Chat history"
      className="chat-history-dialog"
      onClose={onClose}
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
    </Dialog>
  );
}
