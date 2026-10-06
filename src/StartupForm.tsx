import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  closeTab,
  devSessionSend,
  devSessionStop,
  getAppState,
  getFormRecall,
  getRole,
  listenPromptFinished,
  listenSessionUpdates,
  newDraftTab,
  roleSessionStart,
  saveFormDraft,
  selectActiveTab,
  validateAndPreview,
  type DevPromptResult,
  type DevSessionInfo,
  type FieldError,
  type Role,
  type RoleSessionStartResult,
  type RoleSummary,
  type TabSummary,
  type SessionUpdateEvent,
  type ValidatePreviewResult,
} from "./bridge";
import { TabBar } from "./TabBar";
import {
  coalesceAgentLines,
  sessionUpdateToLine,
  type TranscriptLine,
} from "./transcript";

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
  const [promptInFlight, setPromptInFlight] = useState(false);
  const [lastPromptResult, setLastPromptResult] = useState<DevPromptResult | null>(
    null,
  );
  const [promptError, setPromptError] = useState<string | null>(null);
  const [followUp, setFollowUp] = useState("");
  const [busy, setBusy] = useState(false);
  const [transcriptLines, setTranscriptLines] = useState<TranscriptLine[]>([]);
  const [savedTabs, setSavedTabs] = useState<TabSummary[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const skipRecallRef = useRef(false);
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionActiveRef = useRef(false);
  const pendingUpdatesRef = useRef<SessionUpdateEvent[]>([]);
  const flushRafRef = useRef<number | null>(null);
  const [restoredTabId, setRestoredTabId] = useState<string | null>(null);

  const loadTabIntoForm = useCallback((tab: {
    roleId: string;
    cwd: string;
    answers: Record<string, string>;
    id: string;
  }) => {
    skipRecallRef.current = true;
    setRoleId(tab.roleId);
    setValues({ ...tab.answers, cwd: tab.cwd });
    setActiveTabId(tab.id);
    setPreview(null);
    setRestoredTabId(tab.id);
  }, []);

  const refreshTabs = useCallback(async () => {
    const snap = await getAppState();
    setSavedTabs(snap.tabs);
    setActiveTabId(snap.activeTabId);
    return snap;
  }, []);

  useEffect(() => {
    refreshTabs()
      .then((snap) => {
        if (!snap.activeTabId) return;
        const summary = snap.tabs.find((t) => t.id === snap.activeTabId);
        if (!summary) return;
        if (summary.phase === "running") return;
        return selectActiveTab(snap.activeTabId).then(({ tab }) => {
          loadTabIntoForm(tab);
        });
      })
      .catch(() => setSavedTabs([]));
  }, [loadTabIntoForm, refreshTabs]);

  useEffect(() => {
    sessionActiveRef.current = !!session;
  }, [session]);

  useEffect(() => {
    if (!session) return;
    const sessionId = session.sessionId;

    const flushUpdates = () => {
      const batch = pendingUpdatesRef.current;
      if (batch.length === 0) return;
      pendingUpdatesRef.current = [];
      setTranscriptLines((prev) => {
        let next = prev;
        for (const evt of batch) {
          next = coalesceAgentLines([...next, sessionUpdateToLine(evt)]);
        }
        return next;
      });
    };

    let unlisten: (() => void) | undefined;
    listenSessionUpdates((evt) => {
      if (evt.sessionId !== sessionId) return;
      pendingUpdatesRef.current.push(evt);
      if (flushRafRef.current === null) {
        flushRafRef.current = requestAnimationFrame(() => {
          flushRafRef.current = null;
          flushUpdates();
        });
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
      if (flushRafRef.current !== null) {
        cancelAnimationFrame(flushRafRef.current);
        flushRafRef.current = null;
      }
      pendingUpdatesRef.current = [];
    };
  }, [session]);

  useEffect(() => {
    if (!session) return;
    let unlisten: (() => void) | undefined;
    listenPromptFinished((evt) => {
      if (evt.sessionId !== session.sessionId) return;
      setPromptInFlight(false);
      if (evt.success && evt.result) {
        setLastPromptResult(evt.result);
        setPromptError(null);
        setStartResult((prev) =>
          prev ? { ...prev, startupInjected: true } : prev,
        );
      } else if (evt.error) {
        setPromptError(evt.error);
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
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
          if (!sessionActiveRef.current) {
            setPreview(null);
            setStartResult(null);
          }
        }
      })
      .catch(() => {
        if (!cancelled) setRole(null);
      });
    return () => {
      cancelled = true;
    };
  }, [roleId]);

  useEffect(() => {
    if (skipRecallRef.current) {
      skipRecallRef.current = false;
      return;
    }
    if (session) return;
    getFormRecall(roleId, defaultCwd)
      .then((recall) => {
        setValues({ ...recall.values, cwd: recall.cwd });
      })
      .catch(() => {
        setValues((prev) => ({ ...prev, cwd: prev.cwd || defaultCwd }));
      });
  }, [roleId, defaultCwd, session]);

  const formValues = useMemo((): Record<string, string> => {
    if (!role) return values;
    return { ...values, cwd: values.cwd ?? defaultCwd };
  }, [role, values, defaultCwd]);

  useEffect(() => {
    if (session || !role) return;
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(() => {
      const cwd = values.cwd ?? defaultCwd;
      saveFormDraft(roleId, cwd, formValues).catch(() => {});
    }, 800);
    return () => {
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    };
  }, [formValues, roleId, session, role, values.cwd, defaultCwd]);

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
    setLastPromptResult(null);
    setPromptError(null);
    setTranscriptLines([
      {
        id: "startup_status",
        kind: "system",
        label: "session",
        text: "Connecting to agent and sending startup prompt…",
      },
    ]);
    try {
      const result = await roleSessionStart(roleId, formValues);
      setStartResult(result);
      if (result.errors.length > 0) {
        setSession(null);
        setTranscriptLines([]);
        return;
      }
      setSession(result.session);
      if (result.tabId) setActiveTabId(result.tabId);
      setPromptInFlight(!!result.injectionInFlight);
      setPreview(null);
      await refreshTabs();
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
        injectionInFlight: false,
        tabId: null,
      });
    } finally {
      setBusy(false);
    }
  }, [roleId, formValues, refreshTabs]);

  const stopSession = useCallback(async () => {
    setBusy(true);
    try {
      await devSessionStop();
      setSession(null);
      setStartResult(null);
      setLastPromptResult(null);
      setPromptInFlight(false);
      setPromptError(null);
      setTranscriptLines([]);
      await refreshTabs();
    } finally {
      setBusy(false);
    }
  }, [refreshTabs]);

  const handleSelectTab = useCallback(
    async (tabId: string) => {
      if (session) return;
      setBusy(true);
      try {
        const { tab } = await selectActiveTab(tabId);
        loadTabIntoForm(tab);
        await refreshTabs();
      } finally {
        setBusy(false);
      }
    },
    [session, loadTabIntoForm, refreshTabs],
  );

  const handleCloseTab = useCallback(
    async (tabId: string) => {
      if (session) return;
      setBusy(true);
      try {
        const snap = await closeTab(tabId);
        setSavedTabs(snap.tabs);
        setActiveTabId(snap.activeTabId);
        if (snap.activeTabId) {
          const { tab } = await selectActiveTab(snap.activeTabId);
          loadTabIntoForm(tab);
        } else {
          const recall = await getFormRecall(roleId, defaultCwd);
          setValues({ ...recall.values, cwd: recall.cwd });
        }
      } finally {
        setBusy(false);
      }
    },
    [session, roleId, defaultCwd, loadTabIntoForm],
  );

  const handleNewTab = useCallback(async () => {
    if (session) return;
    setBusy(true);
    try {
      const cwd = values.cwd ?? defaultCwd;
      const { tab } = await newDraftTab(roleId, cwd);
      await refreshTabs();
      skipRecallRef.current = true;
      setRoleId(tab.roleId);
      const recall = await getFormRecall(tab.roleId, cwd);
      setValues({ ...recall.values, cwd: recall.cwd });
      setActiveTabId(tab.id);
      setRestoredTabId(tab.id);
    } finally {
      setBusy(false);
    }
  }, [session, roleId, values.cwd, defaultCwd, refreshTabs]);

  const sendFollowUp = useCallback(async () => {
    setBusy(true);
    setPromptError(null);
    try {
      await devSessionSend(followUp);
      setPromptInFlight(true);
      setFollowUp("");
    } catch (err: unknown) {
      setPromptError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [followUp]);

  const setField = (key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setPreview(null);
  };

  const errors: FieldError[] =
    (startResult?.errors?.length ?? 0) > 0
      ? startResult!.errors
      : (preview?.errors?.length ?? 0) > 0
        ? preview!.errors
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
        <code>send_on_start</code> injection. Answers and merged prompt persist
        in <code>state.json</code>.
      </p>
      <TabBar
        tabs={savedTabs}
        activeTabId={activeTabId}
        disabled={busy || !!session}
        onSelect={handleSelectTab}
        onClose={handleCloseTab}
        onNew={handleNewTab}
      />
      {restoredTabId && !session && (
        <p className="hint">
          Tab <code>{restoredTabId}</code> — switch tabs when idle; stopped
          sessions stay <code>awaitingInput</code> (no re-injection).
        </p>
      )}

      {session && (
        <p className="hint composer-locked">
          Session running — use <strong>Stop</strong> to return to the startup
          form. Switch tabs only after stopping.
        </p>
      )}

      <div className={session ? "composer-fields composer-fields-locked" : "composer-fields"}>
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

      </div>

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
          disabled={!session}
        >
          Stop session
        </button>
      </div>

      {preview?.merged && preview.merged.text && !session && (
        <details className="preview-details">
          <summary>
            Merged prompt ({preview.merged.chars.toLocaleString()} chars)
          </summary>
          <pre className="mono-snippet">{preview.merged.text}</pre>
        </details>
      )}

      {session && (
        <div className="session-panel">
          <p className="session-panel-title">
            Active session
            {activeTabId && (
              <span className="hint">
                {" "}
                · tab <code>{activeTabId}</code>
              </span>
            )}
          </p>
          <p className="hint">
            <code>{session.sessionId}</code> · {session.modeId}
            {startResult?.injectionStrategy && (
              <> · {startResult.injectionStrategy}</>
            )}
          </p>
          {promptInFlight && (
            <p className="session-running" role="status">
              Agent is working… (updates stream below; UI stays responsive)
            </p>
          )}
          {promptError && <p className="error">{promptError}</p>}
        </div>
      )}

      {session && (
        <div className="probe-result transcript-panel">
          <p>
            <strong>Transcript</strong>
            {transcriptLines.length > 0 && (
              <span className="hint"> · {transcriptLines.length} lines</span>
            )}
          </p>
          <ul className="transcript-lines transcript-body">
            {transcriptLines.map((line) => (
              <li
                key={line.id}
                className={`transcript-line transcript-line-${line.kind}`}
              >
                <div className="transcript-line-meta">{line.label}</div>
                {String(line.text)}
              </li>
            ))}
          </ul>
          {lastPromptResult && !promptInFlight && (
            <p className="hint">
              Last turn: {lastPromptResult.stopReason ?? "finished"} ·{" "}
              {lastPromptResult.updateCount} updates
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
        </>
      )}

      {session &&
        startResult?.injectionStrategy === "send_on_start" && (
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
          </>
        )}
    </section>
  );
}
