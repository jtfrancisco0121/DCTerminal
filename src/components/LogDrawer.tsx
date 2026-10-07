type Props = {
  stderr: string;
  appLog: string;
  logPath: string | null;
  busy: boolean;
  onRefresh: () => void;
  onClose: () => void;
};

/** FR-080: agent stderr and app log tail for the active session tab. */
export function LogDrawer({ stderr, appLog, logPath, busy, onRefresh, onClose }: Props) {
  return (
    <div className="log-drawer-backdrop" role="presentation" onClick={onClose}>
      <div
        className="log-drawer panel"
        role="dialog"
        aria-label="Session logs"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="log-drawer-header">
          <h2>Session logs</h2>
          <div className="button-row">
            <button type="button" className="secondary-button" disabled={busy} onClick={onRefresh}>
              {busy ? "Refreshing…" : "Refresh"}
            </button>
            <button type="button" className="secondary-button" onClick={onClose}>
              Close
            </button>
          </div>
        </header>
        {logPath && <p className="hint">App log: {logPath}</p>}
        <section className="log-drawer-section">
          <h3>Agent stderr</h3>
          <pre className="mono-snippet log-drawer-pre">{stderr || "(no stderr captured yet)"}</pre>
        </section>
        <section className="log-drawer-section">
          <h3>App log (tail)</h3>
          <pre className="mono-snippet log-drawer-pre">{appLog || "(empty)"}</pre>
        </section>
      </div>
    </div>
  );
}
