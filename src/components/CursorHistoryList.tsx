import type { CursorHistoryEntry } from "../cursorHistory";
import { historySourceLabel } from "../cursorHistory";

type Props = {
  entries: CursorHistoryEntry[];
  error: string | null;
  busy: boolean;
  onResume: (entry: CursorHistoryEntry) => void;
  onOpenCli: (entry: CursorHistoryEntry) => void;
};

export function CursorHistoryList({ entries, error, busy, onResume, onOpenCli }: Props) {
  return (
    <section className="history-list" aria-label="Cursor CLI history">
      <h3>Cursor CLI history</h3>
      <p className="hint">
        Previous ACP sessions and CLI chats for this folder. Read from the Cursor home
        folder. DCTerminal does not write there.
      </p>
      {error && <p className="error">{error}</p>}
      {entries.length === 0 && !error && (
        <p className="hint">No saved sessions for this folder.</p>
      )}
      <ul>
        {entries.map((entry) => (
          <li key={`${entry.source}-${entry.id}`} className="history-row">
            <div className="history-row-text">
              <span className="history-title">{entry.title}</span>
              <span className="hint">
                {historySourceLabel(entry.source)}
                {entry.updatedAt ? ` · ${entry.updatedAt}` : ""}
              </span>
            </div>
            <div className="history-row-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => onResume(entry)}
              >
                Resume
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => onOpenCli(entry)}
                title="Open Windows Terminal or PowerShell running agent --resume"
              >
                Open in Cursor CLI
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
