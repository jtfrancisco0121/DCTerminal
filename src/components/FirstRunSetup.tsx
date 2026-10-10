import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { CliDetectResult, LoginStatus, ProviderReport, RoleSummary } from "../bridge";
import { accountLabel, claudeLoginHint } from "../provider/descriptor";
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
  /** Claude Code detection + sign-in for the configured config folder. */
  claudeStatus: () => Promise<ProviderReport>;
  /** Saves `providers.claude.configDir` (null = default `~/.claude`). */
  saveClaudeFolder?: (dir: string | null) => Promise<void>;
  roles: RoleSummary[];
  initialFolder: string;
  onFinish: (choice: FirstRunFinish) => void;
  onSkip: () => void;
};

type Step = "claude" | "cursor" | "folder" | "role";

const STEPS: Step[] = ["claude", "cursor", "folder", "role"];
const INSTALL_URL = "https://cursor.com/docs/cli/installation";
const CLAUDE_INSTALL_URL = "https://docs.anthropic.com/en/docs/claude-code/setup";

function stepLabel(step: Step): string {
  switch (step) {
    case "claude":
      return "Claude Code";
    case "cursor":
      return "Cursor CLI";
    case "folder":
      return "Folder";
    case "role":
      return "Role";
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * F8: first-run walk: Claude Code (config folder + account) → Cursor CLI
 * (optional) → folder → role → Start.
 */
export function FirstRunSetup({
  cli,
  detect,
  loginStatus,
  claudeStatus,
  saveClaudeFolder,
  roles,
  initialFolder,
  onFinish,
  onSkip,
}: Props) {
  const [step, setStep] = useState<Step>("claude");
  const [cliState, setCliState] = useState(cli);
  const [login, setLogin] = useState<LoginStatus | null>(null);
  const [claude, setClaude] = useState<ProviderReport | null>(null);
  const [editingDir, setEditingDir] = useState(false);
  const [dirDraft, setDirDraft] = useState("");
  const [folder, setFolder] = useState(initialFolder);
  const [roleId, setRoleId] = useState<string | null>(null);
  const [surface, setSurface] = useState<"chat" | "terminal">("chat");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setCliState(cli);
  }, [cli]);

  // A new function each parent render must not re-run the checks.
  const loginStatusRef = useRef(loginStatus);
  loginStatusRef.current = loginStatus;
  const claudeStatusRef = useRef(claudeStatus);
  claudeStatusRef.current = claudeStatus;

  useEffect(() => {
    if (step !== "claude" || claude) return;
    let cancelled = false;
    setBusy(true);
    setError(null);
    claudeStatusRef
      .current()
      // Busy clears with the result: setClaude re-runs this effect, whose
      // cleanup would otherwise cancel a later .finally and leave the wizard locked.
      .then((report) => {
        if (cancelled) return;
        setClaude(report);
        setBusy(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(errorText(err));
        setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [step, claude]);

  useEffect(() => {
    if (step !== "cursor" || !cliState?.found || login) return;
    let cancelled = false;
    setBusy(true);
    setError(null);
    loginStatusRef
      .current()
      .then((status) => {
        if (cancelled) return;
        setLogin(status);
        setBusy(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(errorText(err));
        setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [step, cliState?.found, login]);

  const at = STEPS.indexOf(step);
  const claudeFound = !!claude?.status.found;
  const canNext =
    step === "claude"
      ? claudeFound || !!cliState?.found
      : step === "cursor"
        ? true
        : step === "folder"
          ? folder.trim().length > 0
          : !!roleId;

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err: unknown) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const recheckClaude = () => run(async () => setClaude(await claudeStatus()));
  const recheckCursor = () =>
    run(async () => {
      const next = await detect();
      setCliState(next);
      setLogin(next.found ? await loginStatus() : null);
    });
  const saveDir = () =>
    run(async () => {
      if (!saveClaudeFolder) return;
      await saveClaudeFolder(dirDraft.trim() || null);
      setEditingDir(false);
      setClaude(await claudeStatus());
    });

  const dir = claude?.configDir ?? null;
  const claudeAccount = accountLabel(claude?.login);

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

        {step === "claude" && (
          <section className="first-run-panel" aria-label="Claude Code">
            {!claude ? (
              <p className="hint">Looking for Claude Code…</p>
            ) : claudeFound ? (
              <>
                <p className="ok">Claude Code found.</p>
                {claude.status.version && <p className="hint">Version {claude.status.version}</p>}
                {claude.status.path && <code className="first-run-path">{claude.status.path}</code>}
              </>
            ) : (
              <>
                <p className="error">{claude.status.error ?? "Claude Code (claude) was not found."}</p>
                <p>
                  <a
                    href={CLAUDE_INSTALL_URL}
                    onClick={(event) => {
                      event.preventDefault();
                      void openUrl(CLAUDE_INSTALL_URL).catch(() => {});
                    }}
                  >
                    Install Claude Code
                  </a>
                  , then check again. You can also continue with the Cursor CLI only.
                </p>
              </>
            )}
            {dir && (
              <div className="first-run-claude-dir">
                <p>
                  Config folder: <code title={dir.path}>{dir.display}</code>
                  {dir.source === "env" ? " (set by DCT_CLAUDE_CONFIG_DIR)" : ""}
                  {!dir.exists ? " — folder not found" : ""}
                  {saveClaudeFolder && dir.source !== "env" && !editingDir && (
                    <>
                      {" "}
                      <button
                        type="button"
                        className="link-button"
                        disabled={busy}
                        onClick={() => {
                          setDirDraft(dir.source === "setting" ? dir.display : "");
                          setEditingDir(true);
                        }}
                      >
                        Change folder
                      </button>
                    </>
                  )}
                </p>
                {editingDir && (
                  <div className="settings-folder-row">
                    <input
                      type="text"
                      aria-label="Claude config folder"
                      placeholder="~/.claude"
                      value={dirDraft}
                      onChange={(event) => setDirDraft(event.target.value)}
                    />
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busy}
                      onClick={() => void saveDir()}
                    >
                      Use folder
                    </button>
                  </div>
                )}
                {claudeAccount ? (
                  <p className="ok">
                    Signed in as {claudeAccount}
                    {claude?.login.method ? ` (${claude.login.method})` : ""}.
                  </p>
                ) : claudeFound && dir.exists ? (
                  <p className="hint">
                    Not signed in for this folder. {claudeLoginHint(dir)} Then check again.
                  </p>
                ) : null}
              </div>
            )}
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => void recheckClaude()}
            >
              Check again
            </button>
          </section>
        )}

        {step === "cursor" && (
          <section className="first-run-panel" aria-label="Cursor CLI">
            <p className="hint">Optional: tabs can also run on the Cursor CLI.</p>
            {cliState?.found ? (
              <>
                <p className="ok">Cursor CLI found.</p>
                {cliState.version && <p className="hint">Version {cliState.version}</p>}
                {cliState.path && <code className="first-run-path">{cliState.path}</code>}
                {busy && !login ? (
                  <p className="hint">Checking sign-in…</p>
                ) : login?.state === "loggedIn" ? (
                  <p className="ok">Signed in{login.account ? ` as ${login.account}` : ""}.</p>
                ) : login?.state === "loggedOut" ? (
                  <p className="hint">
                    Not signed in. Run <code>agent login</code> in a terminal to use Cursor tabs.
                  </p>
                ) : login ? (
                  <p className="hint">
                    Could not tell whether the CLI is signed in
                    {login.detail ? `: ${login.detail}` : "."}
                  </p>
                ) : null}
                {login?.apiKeyEnv && (
                  <p className="hint">CURSOR_API_KEY is set in this environment.</p>
                )}
              </>
            ) : (
              <p className="hint">
                Not found. To use it,{" "}
                <a
                  href={INSTALL_URL}
                  onClick={(event) => {
                    event.preventDefault();
                    void openUrl(INSTALL_URL).catch(() => {});
                  }}
                >
                  install the Cursor CLI
                </a>{" "}
                and run <code>agent login</code>.
              </p>
            )}
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => void recheckCursor()}
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
