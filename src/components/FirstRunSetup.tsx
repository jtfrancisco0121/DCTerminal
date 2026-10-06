import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { CliDetectResult, LoginStatus, RoleSummary } from "../bridge";
import { FolderPicker } from "./FolderPicker";

export type FirstRunFinish = {
  roleId: string;
  folder: string;
  surface: "chat" | "terminal";
};

type Props = {
  cli: CliDetectResult | null;
  detect: () => Promise<CliDetectResult>;
  loginStatus: () => Promise<LoginStatus>;
  roles: RoleSummary[];
  initialFolder: string;
  onFinish: (choice: FirstRunFinish) => void;
  onSkip: () => void;
};

type Step = "detect" | "login" | "folder" | "role";

const STEPS: Step[] = ["detect", "login", "folder", "role"];
const INSTALL_URL = "https://cursor.com/docs/cli/installation";

function stepLabel(step: Step): string {
  switch (step) {
    case "detect":
      return "Cursor CLI";
    case "login":
      return "Sign in";
    case "folder":
      return "Folder";
    case "role":
      return "Role";
  }
}

/** F8: first-run walk: detect → login hint → folder → role → Start. */
export function FirstRunSetup({
  cli,
  detect,
  loginStatus,
  roles,
  initialFolder,
  onFinish,
  onSkip,
}: Props) {
  const [step, setStep] = useState<Step>("detect");
  const [cliState, setCliState] = useState(cli);
  const [login, setLogin] = useState<LoginStatus | null>(null);
  const [folder, setFolder] = useState(initialFolder);
  const [roleId, setRoleId] = useState<string | null>(null);
  const [surface, setSurface] = useState<"chat" | "terminal">("chat");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setCliState(cli);
  }, [cli]);

  // A new function each parent render must not re-run the check.
  const loginStatusRef = useRef(loginStatus);
  loginStatusRef.current = loginStatus;
  useEffect(() => {
    if (step !== "login") return;
    let cancelled = false;
    setBusy(true);
    setError(null);
    loginStatusRef
      .current()
      .then((status) => {
        if (!cancelled) setLogin(status);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [step]);

  const at = STEPS.indexOf(step);
  const canNext =
    step === "detect"
      ? !!cliState?.found
      : step === "login"
        ? true
        : step === "folder"
          ? folder.trim().length > 0
          : !!roleId;

  const recheckDetect = async () => {
    setBusy(true);
    setError(null);
    try {
      setCliState(await detect());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const recheckLogin = async () => {
    setBusy(true);
    setError(null);
    try {
      setLogin(await loginStatus());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay-backdrop" role="presentation">
      <div className="overlay-panel first-run" role="dialog" aria-label="Set up DCTerminal">
        <h3>Set up DCTerminal</h3>
        <ol className="first-run-steps" aria-label="Setup steps">
          {STEPS.map((item, i) => (
            <li
              key={item}
              className={
                item === step ? "active" : i < at ? "done" : undefined
              }
              aria-current={item === step ? "step" : undefined}
            >
              {stepLabel(item)}
            </li>
          ))}
        </ol>

        {step === "detect" && (
          <section className="first-run-panel" aria-label="Detect Cursor CLI">
            {cliState?.found ? (
              <>
                <p className="ok">Cursor CLI found.</p>
                {cliState.version && <p className="hint">Version {cliState.version}</p>}
                {cliState.path && <code className="first-run-path">{cliState.path}</code>}
              </>
            ) : (
              <>
                <p className="error">
                  {cliState?.error ?? "Looking for the Cursor CLI (agent)…"}
                </p>
                <p>
                  <a
                    href={INSTALL_URL}
                    onClick={(event) => {
                      event.preventDefault();
                      void openUrl(INSTALL_URL).catch(() => {});
                    }}
                  >
                    Install the Cursor CLI
                  </a>
                  , then run <code>agent login</code> in a terminal, and check again.
                </p>
              </>
            )}
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => void recheckDetect()}
            >
              Check again
            </button>
          </section>
        )}

        {step === "login" && (
          <section className="first-run-panel" aria-label="Sign in">
            {busy && !login ? (
              <p className="hint">Checking sign-in…</p>
            ) : login?.state === "loggedIn" ? (
              <p className="ok">
                Signed in{login.account ? ` as ${login.account}` : ""}.
              </p>
            ) : login?.state === "loggedOut" ? (
              <>
                <p className="error">Not signed in.</p>
                <p>
                  In a terminal, run <code>agent login</code>, finish the browser flow, then check
                  again. You can continue without signing in; Start will fail until you do.
                </p>
              </>
            ) : (
              <>
                <p className="hint">
                  Could not tell whether the CLI is signed in
                  {login?.detail ? `: ${login.detail}` : "."}
                </p>
                <p>
                  If Start fails later, run <code>agent login</code> in a terminal and try again.
                </p>
              </>
            )}
            {login?.apiKeyEnv && (
              <p className="hint">CURSOR_API_KEY is set in this environment.</p>
            )}
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => void recheckLogin()}
            >
              Check again
            </button>
          </section>
        )}

        {step === "folder" && (
          <section className="first-run-panel" aria-label="Working folder">
            <p>Pick the folder this first tab will work in.</p>
            <div className="field-label">
              Working folder
              <FolderPicker value={folder} onChange={setFolder} disabled={busy} />
            </div>
          </section>
        )}

        {step === "role" && (
          <section className="first-run-panel" aria-label="Role">
            <p>Choose a role for the first tab, then Start.</p>
            <div className="role-choices" role="radiogroup" aria-label="Role">
              {roles.map((role) => (
                <button
                  key={role.id}
                  type="button"
                  role="radio"
                  className="role-choice"
                  aria-checked={roleId === role.id}
                  aria-pressed={roleId === role.id}
                  onClick={() => setRoleId(role.id)}
                >
                  <span className="role-dot" style={{ background: role.color }} aria-hidden />
                  {role.name}
                </button>
              ))}
            </div>
            {roleId && (
              <div className="role-choices" role="radiogroup" aria-label="Open as">
                <button
                  type="button"
                  role="radio"
                  className="role-choice"
                  aria-checked={surface === "chat"}
                  aria-pressed={surface === "chat"}
                  onClick={() => setSurface("chat")}
                >
                  Chat
                </button>
                <button
                  type="button"
                  role="radio"
                  className="role-choice"
                  aria-checked={surface === "terminal"}
                  aria-pressed={surface === "terminal"}
                  onClick={() => setSurface("terminal")}
                >
                  Terminal
                </button>
              </div>
            )}
          </section>
        )}

        {error && <p className="error">{error}</p>}

        <div className="first-run-actions">
          {at > 0 && (
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => setStep(STEPS[at - 1])}
            >
              Back
            </button>
          )}
          {step !== "role" ? (
            <button
              type="button"
              className="primary-button"
              disabled={busy || !canNext}
              onClick={() => setStep(STEPS[at + 1])}
            >
              Next
            </button>
          ) : (
            <button
              type="button"
              className="primary-button"
              disabled={busy || !roleId || !folder.trim()}
              onClick={() => {
                if (!roleId) return;
                onFinish({ roleId, folder: folder.trim(), surface });
              }}
            >
              Start
            </button>
          )}
          <button type="button" className="link-button" disabled={busy} onClick={onSkip}>
            Skip setup
          </button>
        </div>
      </div>
    </div>
  );
}
