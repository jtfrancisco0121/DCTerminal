import type { CursorHistoryEntry } from "../cursorHistory";
import {
  canOpenInCursorCli,
  canResumeInApp,
  historySourceLabel,
  OPEN_IN_CURSOR_CLI_TITLE,
  RESUME_ACP_TITLE,
} from "../cursorHistory";

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
        ACP sessions for this folder resume here with session/load. CLI chats, saved
        under chats/, can open in Cursor CLI with agent --resume. ACP sessions cannot:
        on CLI 2026.10.01 that command exited 1 and agent ls did not list the ACP id.
        DCTerminal only reads the Cursor home folder.
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
              {canResumeInApp(entry.source) && (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => onResume(entry)}
                  title={RESUME_ACP_TITLE}
                >
                  Resume
                </button>
              )}
              {canOpenInCursorCli(entry.source) && (
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => onOpenCli(entry)}
                  title={OPEN_IN_CURSOR_CLI_TITLE}
                >
                  Open in Cursor CLI
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
