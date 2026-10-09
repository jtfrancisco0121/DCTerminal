import type { CursorHistoryEntry } from "../cursorHistory";
import {
  canOpenInCursorCli,
  canResumeInApp,
  formatHistoryTime,
  HISTORY_HINT,
  HISTORY_TOOLTIP,
  historyOpenLabel,
  historySourceLabel,
  OPEN_IN_CURSOR_CLI_TITLE,
  presentHistoryTitle,
  RESUME_ACP_TITLE,
} from "../cursorHistory";

type Props = {
  entries: CursorHistoryEntry[];
  error: string | null;
  busy: boolean;
  title?: string;
  /** Folder the list was read from, shown under the title. */
  readFrom?: string | null;
  onResume: (entry: CursorHistoryEntry) => void;
  onOpenCli: (entry: CursorHistoryEntry) => void;
};

export function CursorHistoryList({
  entries,
  error,
  busy,
  title = "Cursor CLI history",
  readFrom = null,
  onResume,
  onOpenCli,
}: Props) {
  return (
    <section className="history-list" aria-label={title}>
      <h3 title={HISTORY_TOOLTIP}>{title}</h3>
      <p className="hint">
        {HISTORY_HINT}
        {readFrom ? ` Read from ${readFrom}.` : ""}
      </p>
      {error && <p className="error">{error}</p>}
      {entries.length === 0 && !error && (
        <p className="hint">No saved sessions for this folder.</p>
      )}
      <ul>
        {entries.map((entry) => {
          const when = formatHistoryTime(entry.updatedAt);
          return (
            <li key={`${entry.source}-${entry.id}`} className="history-row">
              <div className="history-row-text">
                <span className="history-title">{presentHistoryTitle(entry)}</span>
                <span className="hint">
                  {historySourceLabel(entry.source)}
                  {when ? (
                    <>
                      {" · "}
                      <time dateTime={entry.updatedAt ?? undefined}>{when}</time>
                    </>
                  ) : null}
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
                    {historyOpenLabel(entry.source)}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
