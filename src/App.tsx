import { useEffect, useState } from "react";
import { detectCli, listRoles, type CliDetectResult, type RoleSummary } from "./bridge";
import { DevToolsPanel } from "./DevToolsPanel";
import { StartupForm } from "./StartupForm";
import "./App.css";

const showDevTools =
  import.meta.env.DEV ||
  import.meta.env.VITE_SHOW_DEVTOOLS === "true";

function App() {
  const [cli, setCli] = useState<CliDetectResult | null>(null);
  const [cliError, setCliError] = useState<string | null>(null);
  const [roles, setRoles] = useState<RoleSummary[]>([]);
  const defaultCwd = "C:\\Users\\user\\Documents\\Projects\\DCTerminal";
  const [roleSessionActive, setRoleSessionActive] = useState(false);

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

  return (
    <main
      className={`container${roleSessionActive ? " container-session" : ""}`}
    >
      <header className="app-header">
        <h1>DCTerminal</h1>
        {!roleSessionActive && (
          <p className="tagline">
            Role tabs on Cursor CLI — fill the form, start once, follow up in
            the session pane.
          </p>
        )}
      </header>

      {!roleSessionActive && !showDevTools && cli && (
        <section className="status-card status-card-compact" aria-live="polite">
          <p className="hint cli-status-line">
            Cursor CLI:{" "}
            {cli.found ? (
              <>
                <strong>ready</strong>
                {cli.version ? ` (${cli.version})` : ""}
              </>
            ) : (
              <span className="error">
                not found — install CLI and run <code>agent login</code>
              </span>
            )}
          </p>
        </section>
      )}

      {showDevTools && !roleSessionActive && (
        <DevToolsPanel cli={cli} cliError={cliError} />
      )}

      {!roleSessionActive && showDevTools && roles.length > 0 && (
        <section className="status-card">
          <h2>Roles (from store)</h2>
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
        </section>
      )}

      <StartupForm
        roles={roles}
        cliFound={!!cli?.found}
        defaultCwd={defaultCwd}
        onSessionActiveChange={setRoleSessionActive}
      />

      {!roleSessionActive && (
        <section className="docs-hint">
          <p>
            Using the app: see <code>docs/MVP-FINISH.md</code>. Track build
            status in <code>docs/PROGRESS.md</code>.
          </p>
        </section>
      )}
    </main>
  );
}

export default App;
