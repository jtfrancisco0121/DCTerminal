import { useSyncExternalStore } from "react";
import { subscribeUiErrors, uiErrors, type UiError } from "../uiErrors";
import { Dialog } from "./Dialog";

type Props = {
  stderr: string;
  appLog: string;
  logPath: string | null;
  busy: boolean;
  onRefresh: () => void;
  onClose: () => void;
};

function uiErrorLine(entry: UiError): string {
  return `${new Date(entry.at).toLocaleTimeString()} ${entry.source}: ${entry.message}`;
}

/**
 * FR-080: agent stderr and app log tail for the active session tab, plus
 * the pane and view crashes and failed calls caught in this window (uiErrors.ts).
 */
export function LogDrawer({ stderr, appLog, logPath, busy, onRefresh, onClose }: Props) {
  const errors = useSyncExternalStore(subscribeUiErrors, uiErrors);
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
      <section className="log-drawer-section" aria-labelledby="log-drawer-ui-errors">
        <h3 id="log-drawer-ui-errors">Interface errors</h3>
        <pre className="mono-snippet log-drawer-pre">
          {errors.length ? errors.map(uiErrorLine).join("\n") : "(no interface errors)"}
        </pre>
      </section>
    </Dialog>
  );
}
