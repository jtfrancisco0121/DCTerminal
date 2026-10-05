import { useCallback, useEffect, useState } from "react";
import {
  detectCli,
  probeAcp,
  type AcpProbeResult,
  type CliDetectResult,
} from "./bridge";
import "./App.css";

function App() {
  const [cli, setCli] = useState<CliDetectResult | null>(null);
  const [cliError, setCliError] = useState<string | null>(null);
  const [probe, setProbe] = useState<AcpProbeResult | null>(null);
  const [probeBusy, setProbeBusy] = useState(false);

  useEffect(() => {
    detectCli()
      .then(setCli)
      .catch((err: unknown) => {
        setCliError(err instanceof Error ? err.message : String(err));
      });
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

  return (
    <main className="container">
      <header className="app-header">
        <h1>DCTerminal</h1>
        <p className="tagline">
          Role-aware tabs on top of the Cursor CLI (ACP). Phase 0 — CLI + ACP
          probe.
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
        <h2>ACP handshake (dev)</h2>
        <p className="hint">
          Spawns <code>agent acp</code> and sends one <code>initialize</code>{" "}
          request (T0.1).
        </p>
        <button
          type="button"
          className="primary-button"
          onClick={runProbe}
          disabled={probeBusy || !cli?.found}
        >
          {probeBusy ? "Probing…" : "Probe ACP initialize"}
        </button>
        {probe && (
          <ul className="status-list probe-result">
            <li>
              <strong>Success:</strong> {probe.success ? "yes" : "no"}
            </li>
            {probe.error && (
              <li>
                <strong>Error:</strong> {probe.error}
              </li>
            )}
            {probe.firstResponseLine && (
              <li>
                <strong>First line:</strong>
                <pre className="mono-snippet">{probe.firstResponseLine}</pre>
              </li>
            )}
            {probe.stderrTail && (
              <li>
                <strong>Stderr:</strong>
                <pre className="mono-snippet">{probe.stderrTail}</pre>
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
