import { Dialog } from "./Dialog";

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
    <Dialog
      title="Session logs"
      className="log-drawer"
      onClose={onClose}
      footer={
        <button type="button" className="secondary-button" disabled={busy} onClick={onRefresh}>
          {busy ? "Refreshing…" : "Refresh"}
        </button>
      }
    >
      {logPath && <p className="hint">App log: {logPath}</p>}
      <section className="log-drawer-section">
        <h3>Agent stderr</h3>
        <pre className="mono-snippet log-drawer-pre">{stderr || "(no stderr captured yet)"}</pre>
      </section>
      <section className="log-drawer-section">
        <h3>App log (tail)</h3>
        <pre className="mono-snippet log-drawer-pre">{appLog || "(empty)"}</pre>
      </section>
    </Dialog>
  );
}
