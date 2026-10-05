import { useCallback, useEffect, useMemo, useState } from "react";
import {
  devSessionSend,
  devSessionStop,
  getRole,
  listenSessionUpdates,
  roleSessionStart,
  validateAndPreview,
  type DevPromptResult,
  type DevSessionInfo,
  type FieldError,
  type Role,
  type RoleSessionStartResult,
  type RoleSummary,
  type ValidatePreviewResult,
} from "./bridge";

function fieldVisible(
  role: Role,
  fieldKey: string,
  values: Record<string, string>,
): boolean {
  const field = role.fields.find((f) => f.key === fieldKey);
  if (!field?.showWhen) return true;
  const current = (values[field.showWhen.fieldKey] ?? "").trim();
  return field.showWhen.equals.includes(current);
}

function visibleFields(role: Role, values: Record<string, string>) {
  return role.fields.filter((f) => fieldVisible(role, f.key, values));
}

type Props = {
  roles: RoleSummary[];
  cliFound: boolean;
  defaultCwd: string;
};

export function StartupForm({ roles, cliFound, defaultCwd }: Props) {
  const [roleId, setRoleId] = useState("role_implementer");
  const [role, setRole] = useState<Role | null>(null);
  const [values, setValues] = useState<Record<string, string>>({ cwd: defaultCwd });
  const [preview, setPreview] = useState<ValidatePreviewResult | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [session, setSession] = useState<DevSessionInfo | null>(null);
  const [startResult, setStartResult] = useState<RoleSessionStartResult | null>(
    null,
  );
  const [followUp, setFollowUp] = useState("");
  const [followUpResult, setFollowUpResult] = useState<DevPromptResult | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [streamKinds, setStreamKinds] = useState<string[]>([]);

  useEffect(() => {
    if (!session) {
      setStreamText("");
      setStreamKinds([]);
      return;
    }
    let unlisten: (() => void) | undefined;
    listenSessionUpdates((evt) => {
      if (evt.sessionId !== session.sessionId) return;
      if (evt.textDelta) {
        setStreamText((prev) => prev + evt.textDelta);
      }
      setStreamKinds((prev) => {
        if (prev.length > 0 && prev[prev.length - 1] === evt.kind) {
          return prev;
        }
        return [...prev, evt.kind];
      });
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [session]);

  useEffect(() => {
    if (!roles.some((r) => r.id === roleId) && roles.length > 0) {
      setRoleId(roles[0].id);
    }
  }, [roles, roleId]);

  useEffect(() => {
    let cancelled = false;
    getRole(roleId)
      .then((r) => {
        if (!cancelled) {
          setRole(r);
          setValues((prev) => ({ cwd: prev.cwd || defaultCwd }));
          setPreview(null);
          setStartResult(null);
        }
      })
      .catch(() => {
        if (!cancelled) setRole(null);
      });
    return () => {
      cancelled = true;
    };
  }, [roleId, defaultCwd]);

  const formValues = useMemo((): Record<string, string> => {
    if (!role) return values;
    return { ...values, cwd: values.cwd ?? defaultCwd };
  }, [role, values, defaultCwd]);

  const runPreview = useCallback(async () => {
    if (!role) return;
    setPreviewBusy(true);
    try {
      setPreview(await validateAndPreview(roleId, formValues));
    } catch (err: unknown) {
      setPreview({
        errors: [
          {
            key: "_form",
            message: err instanceof Error ? err.message : String(err),
          },
        ],
        merged: null,
      });
    } finally {
      setPreviewBusy(false);
    }
  }, [role, roleId, formValues]);

  const startSession = useCallback(async () => {
    setBusy(true);
    setStartResult(null);
    setFollowUpResult(null);
    setStreamText("");
    setStreamKinds([]);
    try {
      const result = await roleSessionStart(roleId, formValues);
      setStartResult(result);
      if (result.errors.length > 0) {
        setSession(null);
        return;
      }
      setSession(result.session);
      if (result.mergedChars != null) {
        const latest = await validateAndPreview(roleId, formValues);
        setPreview(latest);
      }
    } catch (err: unknown) {
      setStartResult({
        errors: [
          {
            key: "_session",
            message: err instanceof Error ? err.message : String(err),
          },
        ],
        session: null,
        mergedChars: null,
        injectionStrategy: null,
        startupInjected: false,
        injectionResult: null,
      });
    } finally {
      setBusy(false);
    }
  }, [roleId, formValues]);

  const stopSession = useCallback(async () => {
    setBusy(true);
    try {
      await devSessionStop();
      setSession(null);
      setStartResult(null);
      setFollowUpResult(null);
    } finally {
      setBusy(false);
    }
  }, []);

  const sendFollowUp = useCallback(async () => {
    setBusy(true);
    try {
      setFollowUpResult(await devSessionSend(followUp));
    } catch (err: unknown) {
      setFollowUpResult({
        stopReason: err instanceof Error ? err.message : String(err),
        agentText: "",
        updateCount: 0,
      });
    } finally {
      setBusy(false);
    }
  }, [followUp]);

  const setField = (key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setPreview(null);
  };

  const errors: FieldError[] =
    startResult?.errors.length
      ? startResult.errors
      : preview?.errors.length
        ? preview.errors
        : [];

  if (!role) {
    return (
      <section className="status-card">
        <h2>Start role session (T2.8)</h2>
        <p className="hint">Loading role…</p>
      </section>
    );
  }

  return (
    <section className="status-card">
      <h2>Start role session (T2.8)</h2>
      <p className="hint">
        Schema-driven form → merge → <code>agent acp</code> with{" "}
        <code>send_on_start</code> injection.
      </p>

      <label className="field-label">
        Role
        <select
          className="text-input"
          value={roleId}
          onChange={(e) => setRoleId(e.target.value)}
          disabled={!!session || busy}
        >
          {roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </label>

      <label className="field-label">
        Working folder
        <input
          className="text-input"
          value={values.cwd ?? defaultCwd}
          onChange={(e) => setField("cwd", e.target.value)}
          disabled={!!session || busy}
        />
      </label>

      {visibleFields(role, formValues).map((field) => (
        <label key={field.key} className="field-label">
          {field.label}
          {field.required ? " *" : ""}
          {field.type === "multiline" ? (
            <textarea
              className="text-input prompt-area"
              rows={4}
              value={values[field.key] ?? ""}
              onChange={(e) => setField(field.key, e.target.value)}
              disabled={!!session || busy}
            />
          ) : field.type === "select" && field.options ? (
            <select
              className="text-input"
              value={values[field.key] ?? ""}
              onChange={(e) => setField(field.key, e.target.value)}
              disabled={!!session || busy}
            >
              <option value="">Select…</option>
              {field.options.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          ) : (
            <input
              className="text-input"
              type="text"
              value={values[field.key] ?? ""}
              onChange={(e) => setField(field.key, e.target.value)}
              disabled={!!session || busy}
            />
          )}
        </label>
      ))}

      {errors.length > 0 && (
        <ul className="field-errors">
          {errors.map((e) => (
            <li key={`${e.key}-${e.message}`}>
              <strong>{e.key}:</strong> {e.message}
            </li>
          ))}
        </ul>
      )}

      <div className="button-row">
        <button
          type="button"
          className="secondary-button"
          onClick={runPreview}
          disabled={busy || !!session || previewBusy}
        >
          {previewBusy ? "…" : "Validate & preview"}
        </button>
        <button
          type="button"
          className="primary-button"
          onClick={startSession}
          disabled={busy || !cliFound || !!session}
        >
          Start role session
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={stopSession}
          disabled={busy || !session}
        >
          Stop
        </button>
      </div>

      {preview?.merged && preview.merged.text && (
        <details className="preview-details">
          <summary>
            Merged prompt ({preview.merged.chars.toLocaleString()} chars)
          </summary>
          <pre className="mono-snippet">{preview.merged.text}</pre>
        </details>
      )}

      {session && (
        <p className="hint">
          Session <code>{session.sessionId}</code> · mode {session.modeId}
          {startResult?.injectionStrategy && (
            <> · injection {startResult.injectionStrategy}</>
          )}
        </p>
      )}

      {(streamText || startResult?.injectionResult) && (
        <div className="probe-result transcript-panel">
          <p>
            <strong>Transcript</strong>
            {streamKinds.length > 0 && (
              <span className="hint">
                {" "}
                · {streamKinds.length} update kind
                {streamKinds.length === 1 ? "" : "s"}
              </span>
            )}
          </p>
          <pre className="mono-snippet transcript-body">
            {streamText ||
              startResult?.injectionResult?.agentText ||
              "(no text chunks yet — check event parser)"}
          </pre>
          {startResult?.injectionResult && (
            <p className="hint">
              Startup turn:{" "}
              {startResult.injectionResult.stopReason ?? "finished"} ·{" "}
              {startResult.injectionResult.updateCount} updates
            </p>
          )}
        </div>
      )}

      {session && startResult?.injectionStrategy === "attach_to_first_message" && (
        <>
          <label className="field-label">
            First message (startup prompt will attach)
            <textarea
              className="text-input prompt-area"
              rows={2}
              value={followUp}
              onChange={(e) => setFollowUp(e.target.value)}
              disabled={busy}
            />
          </label>
          <button
            type="button"
            className="primary-button"
            onClick={sendFollowUp}
            disabled={busy || !followUp.trim()}
          >
            Send
          </button>
          {followUpResult && (
            <div className="probe-result">
              <p>
                <strong>Stop:</strong> {followUpResult.stopReason ?? "—"}
              </p>
              <p>
                <strong>Updates:</strong> {followUpResult.updateCount}
              </p>
              {followUpResult.agentText && (
                <pre className="mono-snippet">{followUpResult.agentText}</pre>
              )}
            </div>
          )}
        </>
      )}

      {session &&
        startResult?.startupInjected &&
        startResult.injectionStrategy === "send_on_start" && (
          <>
            <label className="field-label">
              Follow-up message
              <textarea
                className="text-input prompt-area"
                rows={2}
                value={followUp}
                onChange={(e) => setFollowUp(e.target.value)}
                disabled={busy}
              />
            </label>
            <button
              type="button"
              className="secondary-button"
              onClick={sendFollowUp}
              disabled={busy || !followUp.trim()}
            >
              Send follow-up
            </button>
            {followUpResult && (
              <div className="probe-result">
                <p>
                  <strong>Stop:</strong> {followUpResult.stopReason ?? "—"}
                </p>
                {followUpResult.agentText && (
                  <pre className="mono-snippet">{followUpResult.agentText}</pre>
                )}
              </div>
            )}
          </>
        )}
    </section>
  );
}
