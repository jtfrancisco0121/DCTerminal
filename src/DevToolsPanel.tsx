import { useCallback, useState } from "react";
import {
  devSessionSend,
  devSessionStart,
  devSessionStop,
  probeAcp,
  probeAcpHandshake,
  type AcpHandshakeProbeResult,
  type AcpProbeResult,
  type CliDetectResult,
  type DevPromptResult,
  type DevSessionInfo,
} from "./bridge";

type Props = {
  cli: CliDetectResult | null;
  cliError: string | null;
};

/** Low-level ACP probes — not part of the product UI. */
export function DevToolsPanel({ cli, cliError }: Props) {
  const [probe, setProbe] = useState<AcpProbeResult | null>(null);
  const [handshake, setHandshake] = useState<AcpHandshakeProbeResult | null>(
    null,
  );
  const [probeBusy, setProbeBusy] = useState(false);
  const [handshakeBusy, setHandshakeBusy] = useState(false);
  const [devCwd, setDevCwd] = useState(
    "C:\\Users\\user\\Documents\\Projects\\DCTerminal",
  );
  const [devSession, setDevSession] = useState<DevSessionInfo | null>(null);
  const [devPrompt, setDevPrompt] = useState("Reply with exactly: DCTerminal OK");
  const [devResult, setDevResult] = useState<DevPromptResult | null>(null);
  const [devBusy, setDevBusy] = useState(false);

  const runProbe = useCallback(async () => {
    setProbeBusy(true);
    setProbe(null);
    try {
      setProbe(await probeAcp());
    } catch (err: unknown) {
      setProbe({
        success: false,
        agentPath: null,
        firstResponseLine: null,
        stderrTail: null,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setProbeBusy(false);
    }
  }, []);

  const runHandshake = useCallback(async () => {
    setHandshakeBusy(true);
    setHandshake(null);
    try {
      setHandshake(await probeAcpHandshake());
    } catch (err: unknown) {
      setHandshake({
        success: false,
        agentPath: null,
        sessionId: null,
        modeId: null,
        steps: [],
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setHandshakeBusy(false);
    }
  }, []);

  const startDevSession = useCallback(async () => {
    setDevBusy(true);
    setDevResult(null);
    try {
      setDevSession(await devSessionStart(devCwd, "agent"));
    } catch (err: unknown) {
      setDevSession(null);
    } finally {
      setDevBusy(false);
    }
  }, [devCwd]);

  const sendDevPrompt = useCallback(async () => {
    setDevBusy(true);
    try {
      await devSessionSend(devPrompt);
      setDevResult({
        stopReason: "dispatched",
        agentText: "",
        updateCount: 0,
      });
    } catch (err: unknown) {
      setDevResult({
        stopReason: err instanceof Error ? err.message : String(err),
        agentText: "",
        updateCount: 0,
      });
    } finally {
      setDevBusy(false);
    }
  }, [devPrompt]);

  const stopDevSession = useCallback(async () => {
    setDevBusy(true);
    try {
      await devSessionStop();
      setDevSession(null);
      setDevResult(null);
    } finally {
      setDevBusy(false);
    }
  }, []);

  return (
    <>
      <section className="status-card" aria-live="polite">
        <h2>Cursor CLI</h2>
        {cliError && <p className="error">Bridge error: {cliError}</p>}
        {cli && (
          <ul className="status-list">
            <li>
              <strong>Found:</strong> {cli.found ? "yes" : "no"}
            </li>
            {cli.path && (
              <li>
                <strong>Path:</strong> <code>{cli.path}</code>
              </li>
            )}
            {cli.version && (
              <li>
                <strong>Version:</strong> {cli.version}
              </li>
            )}
            {cli.error && (
              <li>
                <strong>Note:</strong> {cli.error}
              </li>
            )}
          </ul>
        )}
        {!cli && !cliError && <p>Checking…</p>}
      </section>

      <section className="status-card">
        <h2>Dev session (T1.2 / T1.3)</h2>
        <p className="hint">
          Low-level probe — use <strong>Start role session</strong> above for
          normal work.
        </p>
        <label className="field-label">
          Working folder
          <input
            className="text-input"
            value={devCwd}
            onChange={(e) => setDevCwd(e.target.value)}
            disabled={!!devSession || devBusy}
          />
        </label>
        <div className="button-row">
          <button
            type="button"
            className="primary-button"
            onClick={startDevSession}
            disabled={devBusy || !cli?.found || !!devSession}
          >
            Start session
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={stopDevSession}
            disabled={devBusy || !devSession}
          >
            Stop
          </button>
        </div>
        <label className="field-label">
          Prompt
          <textarea
            className="text-input prompt-area"
            value={devPrompt}
            onChange={(e) => setDevPrompt(e.target.value)}
            rows={2}
            disabled={!devSession || devBusy}
          />
        </label>
        <button
          type="button"
          className="primary-button"
          onClick={sendDevPrompt}
          disabled={!devSession || devBusy}
        >
          Send prompt
        </button>
        {devResult?.stopReason && (
          <p className="hint">Stop: {devResult.stopReason}</p>
        )}
      </section>

      <section className="status-card">
        <h2>ACP probes</h2>
        <div className="button-row">
          <button
            type="button"
            className="secondary-button"
            onClick={runProbe}
            disabled={probeBusy || handshakeBusy || !cli?.found}
          >
            Initialize only
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={runHandshake}
            disabled={probeBusy || handshakeBusy || !cli?.found}
          >
            Full handshake
          </button>
        </div>
        {handshake && (
          <p className="hint">
            Handshake: {handshake.success ? "ok" : "failed"}
            {handshake.error ? ` — ${handshake.error}` : ""}
          </p>
        )}
        {probe && !handshake && (
          <p className="hint">
            Initialize: {probe.success ? "ok" : "failed"}
          </p>
        )}
      </section>
    </>
  );
}
