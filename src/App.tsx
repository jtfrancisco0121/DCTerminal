import { useCallback, useEffect, useState } from "react";
import {
  detectCli,
  devSessionSend,
  devSessionStart,
  devSessionStop,
  listRoles,
  probeAcp,
  probeAcpHandshake,
  type AcpHandshakeProbeResult,
  type AcpProbeResult,
  type CliDetectResult,
  type DevPromptResult,
  type DevSessionInfo,
  type RoleSummary,
} from "./bridge";
import { StartupForm } from "./StartupForm";
import "./App.css";

function App() {
  const [cli, setCli] = useState<CliDetectResult | null>(null);
  const [cliError, setCliError] = useState<string | null>(null);
  const [probe, setProbe] = useState<AcpProbeResult | null>(null);
  const [handshake, setHandshake] = useState<AcpHandshakeProbeResult | null>(
    null,
  );
  const [probeBusy, setProbeBusy] = useState(false);
  const [handshakeBusy, setHandshakeBusy] = useState(false);
  const [roles, setRoles] = useState<RoleSummary[]>([]);
  const [devCwd, setDevCwd] = useState(
    "C:\\Users\\user\\Documents\\Projects\\DCTerminal",
  );
  const [devSession, setDevSession] = useState<DevSessionInfo | null>(null);
  const [devPrompt, setDevPrompt] = useState("Reply with exactly: DCTerminal OK");
  const [devResult, setDevResult] = useState<DevPromptResult | null>(null);
  const [devBusy, setDevBusy] = useState(false);

  useEffect(() => {
    detectCli()
      .then(setCli)
      .catch((err: unknown) => {
        setCliError(err instanceof Error ? err.message : String(err));
      });
    listRoles()
      .then(setRoles)
      .catch(() => setRoles([]));
  }, []);

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

  const startDevSession = useCallback(async () => {
    setDevBusy(true);
    setDevResult(null);
    try {
      setDevSession(await devSessionStart(devCwd, "agent"));
    } catch (err: unknown) {
      setDevSession(null);
      setDevResult({
        stopReason: null,
        agentText: "",
        updateCount: 0,
        ...(err instanceof Error ? { stopReason: err.message } : {}),
      });
    } finally {
      setDevBusy(false);
    }
  }, [devCwd]);

  const sendDevPrompt = useCallback(async () => {
    setDevBusy(true);
    try {
      await devSessionSend(devPrompt);
      setDevResult({
        stopReason: "dispatched (listen for updates)",
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

  return (
    <main className="container">
      <header className="app-header">
        <h1>DCTerminal</h1>
        <p className="tagline">
          Role-aware tabs on top of the Cursor CLI (ACP). Phase 2 — startup
          form and role sessions.
        </p>
      </header>

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
        <h2>Roles (from store)</h2>
        {roles.length === 0 ? (
          <p className="hint">No roles loaded (run app via Tauri, not Vite-only).</p>
        ) : (
          <ul className="status-list">
            {roles.map((r) => (
              <li key={r.id}>
                <span
                  className="role-dot"
                  style={{ backgroundColor: r.color }}
                  aria-hidden
                />
                <strong>{r.name}</strong> — {r.defaultMode} · {r.fieldCount}{" "}
                fields
              </li>
            ))}
          </ul>
        )}
      </section>

      <StartupForm
        roles={roles}
        cliFound={!!cli?.found}
        defaultCwd={devCwd}
      />

      <section className="status-card">
        <h2>Dev session (T1.2 / T1.3)</h2>
        <p className="hint">
          Persistent <code>agent acp</code> connection: start →{" "}
          <code>session/prompt</code> → stop.
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
        {devSession && (
          <p className="hint">
            Session <code>{devSession.sessionId}</code> · {devSession.modeId}
          </p>
        )}
        <label className="field-label">
          Prompt
          <textarea
            className="text-input prompt-area"
            value={devPrompt}
            onChange={(e) => setDevPrompt(e.target.value)}
            rows={3}
            disabled={!devSession || devBusy}
          />
        </label>
        <button
          type="button"
          className="primary-button"
          onClick={sendDevPrompt}
          disabled={!devSession || devBusy}
        >
          {devBusy ? "…" : "Send prompt"}
        </button>
        {devResult && (
          <div className="probe-result">
            {devResult.stopReason && (
              <p>
                <strong>Stop:</strong> {devResult.stopReason}
              </p>
            )}
            <p>
              <strong>Updates:</strong> {devResult.updateCount}
            </p>
            {devResult.agentText && (
              <pre className="mono-snippet">{devResult.agentText}</pre>
            )}
            {!devResult.agentText && devResult.updateCount > 0 && (
              <p className="hint">
                Received updates but no text chunks matched — check parser.
              </p>
            )}
          </div>
        )}
      </section>

      <section className="status-card">
        <h2>ACP probes (dev)</h2>
        <p className="hint">
          Full handshake: <code>initialize</code> → <code>authenticate</code> →{" "}
          <code>session/new</code> → <code>session/set_mode</code> (T0.3).
        </p>
        <div className="button-row">
          <button
            type="button"
            className="secondary-button"
            onClick={runProbe}
            disabled={probeBusy || handshakeBusy || !cli?.found}
          >
            {probeBusy ? "…" : "Initialize only"}
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={runHandshake}
            disabled={probeBusy || handshakeBusy || !cli?.found}
          >
            {handshakeBusy ? "Handshaking…" : "Full handshake"}
          </button>
        </div>
        {handshake && (
          <ul className="status-list probe-result">
            <li>
              <strong>Handshake:</strong> {handshake.success ? "ok" : "failed"}
            </li>
            {handshake.sessionId && (
              <li>
                <strong>Session:</strong> <code>{handshake.sessionId}</code>
              </li>
            )}
            {handshake.modeId && (
              <li>
                <strong>Mode:</strong> {handshake.modeId}
              </li>
            )}
            {handshake.error && (
              <li>
                <strong>Error:</strong> {handshake.error}
              </li>
            )}
            {handshake.steps.map((step) => (
              <li key={step.method}>
                <strong>{step.method}:</strong>{" "}
                {step.success ? "ok" : `fail — ${step.error ?? "unknown"}`}
              </li>
            ))}
          </ul>
        )}
        {probe && !handshake && (
          <ul className="status-list probe-result">
            <li>
              <strong>Initialize:</strong> {probe.success ? "ok" : "failed"}
            </li>
            {probe.firstResponseLine && (
              <li>
                <pre className="mono-snippet">{probe.firstResponseLine}</pre>
              </li>
            )}
          </ul>
        )}
      </section>

      <section className="docs-hint">
        <p>
          Track work in <code>docs/PROGRESS.md</code> and{" "}
          <code>docs/TASKS.md</code> before each commit.
        </p>
      </section>
    </main>
  );
}

export default App;
