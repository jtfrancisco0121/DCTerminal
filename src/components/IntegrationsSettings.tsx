import { useEffect, useState } from "react";
import {
  clickupStatus,
  clickupTest,
  clickupTokenClear,
  clickupTokenSet,
  type ClickUpAccountStatus,
  type ClickUpWorkspaceOption,
} from "../bridge";
import { useConfirm } from "./confirm";
import { errorText, InlineNotice } from "./InlineNotice";

/** Where the account's token comes from, in words. */
function sourceText(status: ClickUpAccountStatus): string {
  if (status.source === "env") {
    return "Token from DCT_CLICKUP_TOKEN, set when DCTerminal started. Change or remove it there.";
  }
  if (status.source === "keychain") return "Token saved in the system keychain.";
  return "No token yet.";
}

/**
 * One Claude account's ClickUp row. The token typed here goes to the
 * keychain and is cleared from the field; it is never shown again.
 */
function ClickUpAccountRow({
  status,
  onStatus,
}: {
  status: ClickUpAccountStatus;
  onStatus: (next: ClickUpAccountStatus) => void;
}) {
  const confirm = useConfirm();
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<"save" | "test" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<ClickUpWorkspaceOption[]>([]);
  const fromEnv = status.source === "env";
  const fieldId = `clickup-token-${status.accountId}`;

  const run = async (kind: "save" | "test" | "remove", work: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    setNotice(null);
    try {
      await work();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const test = (workspaceId?: string) =>
    run("test", async () => {
      const result = await clickupTest(status.accountId, workspaceId);
      onStatus(result.status);
      setWorkspaces(result.workspaces);
      setNotice(`Connected to ${result.status.workspaceName ?? "ClickUp"}.`);
    });

  const save = () =>
    run("save", async () => {
      const next = await clickupTokenSet(status.accountId, token);
      setToken("");
      onStatus(next);
      // Checked straight away, so a bad paste shows now, not at intake.
      const result = await clickupTest(status.accountId);
      onStatus(result.status);
      setWorkspaces(result.workspaces);
      setNotice(`Saved. Connected to ${result.status.workspaceName ?? "ClickUp"}.`);
    });

  const remove = async () => {
    const ok = await confirm({
      title: "Remove the ClickUp token?",
      message: `DCTerminal forgets the ClickUp token and workspace for ${status.accountName}. Other accounts keep theirs.`,
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    await run("remove", async () => {
      onStatus(await clickupTokenClear(status.accountId));
      setWorkspaces([]);
      setNotice("Removed.");
    });
  };

  return (
    <div className="settings-subsection" aria-label={`ClickUp for ${status.accountName}`} role="group">
      <h4>{status.accountName}</h4>
      <p className="hint">
        {sourceText(status)}{" "}
        {status.workspaceName
          ? `Workspace: ${status.workspaceName}.`
          : status.configured
            ? "No workspace yet: Test picks one."
            : ""}
      </p>
      {status.envRejected && (
        <InlineNotice tone="error">
          DCT_CLICKUP_TOKEN is set but is not a valid token, so it is not used.
        </InlineNotice>
      )}
      <form
        className="button-row"
        onSubmit={(event) => {
          event.preventDefault();
          if (token.trim() && !busy) void save();
        }}
      >
        <label className="sr-only" htmlFor={fieldId}>
          ClickUp token for {status.accountName}
        </label>
        <input
          id={fieldId}
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={status.source === "keychain" ? "Paste a new token to replace it" : "pk_…"}
          value={token}
          disabled={fromEnv || busy !== null}
          onChange={(event) => setToken(event.target.value)}
        />
        <button
          type="submit"
          className="primary-button"
          disabled={fromEnv || busy !== null || !token.trim()}
        >
          {busy === "save" ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={!status.configured || busy !== null}
          onClick={() => void test()}
        >
          {busy === "test" ? "Testing…" : "Test"}
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={status.source !== "keychain" || busy !== null}
          title={fromEnv ? "The token comes from DCT_CLICKUP_TOKEN" : undefined}
          onClick={() => void remove()}
        >
          {busy === "remove" ? "Removing…" : "Remove"}
        </button>
      </form>
      {workspaces.length > 1 && (
        <label className="field-label settings-inline-field">
          <span>Workspace</span>
          <select
            value={status.workspaceId ?? ""}
            disabled={busy !== null}
            onChange={(event) => void test(event.target.value)}
          >
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      {notice && <InlineNotice>{notice}</InlineNotice>}
    </div>
  );
}

/** Settings › Integrations: ClickUp, one token and workspace per Claude account. */
export function IntegrationsSettings() {
  const [accounts, setAccounts] = useState<ClickUpAccountStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    clickupStatus()
      .then((next) => {
        if (!cancelled) setAccounts(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorText(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const replace = (next: ClickUpAccountStatus) =>
    setAccounts((prev) =>
      (prev ?? []).map((account) => (account.accountId === next.accountId ? next : account)),
    );

  return (
    <section className="settings-section" aria-label="Integrations">
      <h3>Integrations</h3>
      <div className="settings-subsection">
        <h4>ClickUp</h4>
        <p className="hint">
          Each Claude account has its own ClickUp token and workspace, and a window only uses its
          own account&apos;s. Create a personal token in ClickUp under Settings › Apps. It is kept
          in the system keychain and never shown to Claude.
        </p>
        {accounts && accounts.length > 0 && (
          <p className="hint">
            DCT_CLICKUP_TOKEN, if set when DCTerminal starts, is used for the first account (
            {accounts[0].accountName}) only.
          </p>
        )}
        {error && <InlineNotice tone="error">{error}</InlineNotice>}
        {!accounts && !error && <p className="hint">Loading…</p>}
        {accounts?.map((account) => (
          <ClickUpAccountRow key={account.accountId} status={account} onStatus={replace} />
        ))}
      </div>
    </section>
  );
}
