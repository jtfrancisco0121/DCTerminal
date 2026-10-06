import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  closeTab,
  devSessionCancel,
  devSessionSend,
  devSessionStop,
  listenPermissionRequests,
  respondPermissionRequest,
  getAppState,
  getTab,
  getFormRecall,
  getRole,
  listenPromptFinished,
  listenSessionUpdates,
  newDraftTab,
  roleSessionStart,
  saveFormDraft,
  selectActiveTab,
  syncActiveTabForm,
  validateAndPreview,
  type DevPromptResult,
  type DevSessionInfo,
  type FieldError,
  type Role,
  type RoleSessionStartResult,
  type RoleSummary,
  type TabSummary,
  type PermissionRequestEvent,
  type SessionUpdateEvent,
  type ValidatePreviewResult,
} from "./bridge";
import { SessionTerminal } from "./SessionTerminal";
import { TabBar } from "./TabBar";
import {
  appendStreamSegment,
  reconcileAgentStream,
  streamSegmentFromEvent,
  streamSegmentFromSystemMessage,
  segmentsToPlainText,
  type StreamSegment,
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
  onSessionActiveChange?: (active: boolean) => void;
};

export function StartupForm({
  roles,
  cliFound,
  defaultCwd,
  onSessionActiveChange,
}: Props) {
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
  const [streamSegments, setStreamSegments] = useState<StreamSegment[]>([]);
  const [savedTabs, setSavedTabs] = useState<TabSummary[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [resendStartup, setResendStartup] = useState(false);
  const skipRecallRef = useRef(false);
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionActiveRef = useRef(false);
  const pendingUpdatesRef = useRef<SessionUpdateEvent[]>([]);
  const flushRafRef = useRef<number | null>(null);
  const tabsBootstrappedRef = useRef(false);

  const loadTabIntoForm = useCallback((tab: {
    roleId: string;
    cwd: string;
    answers: Record<string, string>;
    id: string;
    transcript?: string | null;
  }) => {
    skipRecallRef.current = true;
    setRoleId(tab.roleId);
    setValues({ ...tab.answers, cwd: tab.cwd });
    setActiveTabId(tab.id);
    setPreview(null);
    if (tab.transcript?.trim()) {
      setStreamSegments([
        {
          id: "restored_transcript",
          kind: "agent",
          text: tab.transcript,
        },
      ]);
    } else {
      setStreamSegments([]);
    }
  }, []);

  const refreshTabs = useCallback(async () => {
    const snap = await getAppState();
    setSavedTabs(snap.tabs);
    setActiveTabId(snap.activeTabId);
    return snap;
  }, []);

  useEffect(() => {
    if (tabsBootstrappedRef.current) return;
    tabsBootstrappedRef.current = true;
    const seedRoleId = roles[0]?.id ?? "role_implementer";
    refreshTabs()
      .then(async (snap) => {
        if (snap.tabs.length === 0) {
          const { tab } = await newDraftTab(seedRoleId, defaultCwd);
          await refreshTabs();
          loadTabIntoForm(tab);
          return;
        }
        const activeId = snap.activeTabId ?? snap.tabs[snap.tabs.length - 1]?.id;
        if (!activeId) return;
        const summary = snap.tabs.find((t) => t.id === activeId);
        if (!summary) return;
        if (summary.phase === "running") {
          setActiveTabId(activeId);
          return;
        }
        const { tab } = await selectActiveTab(activeId);
        loadTabIntoForm(tab);
      })
      .catch(() => setSavedTabs([]));
  }, [loadTabIntoForm, refreshTabs, defaultCwd, roles]);

  useEffect(() => {
    sessionActiveRef.current = !!session;
  }, [session]);

  useEffect(() => {
    onSessionActiveChange?.(!!session);
  }, [session, onSessionActiveChange]);

  useEffect(() => {
    if (!session) return;
    let unlisten: (() => void) | undefined;
    listenPermissionRequests((evt) => {
      if (evt.sessionId !== session.sessionId) return;
      setPermissionRequest(evt);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [session]);

  useEffect(() => {
    if (!session) return;
    const sessionId = session.sessionId;

    const flushUpdates = () => {
      const batch = pendingUpdatesRef.current;
      if (batch.length === 0) return;
      pendingUpdatesRef.current = [];
      setStreamSegments((prev) => {
        let next = prev;
        for (const evt of batch) {
          const seg = streamSegmentFromEvent(evt);
          if (seg) next = appendStreamSegment(next, seg);
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
        setStreamSegments((prev) =>
          reconcileAgentStream(prev, evt.result?.agentText ?? ""),
        );
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

  const activeTabSummary = useMemo(
    () => savedTabs.find((t) => t.id === activeTabId) ?? null,
    [savedTabs, activeTabId],
  );

  const canContinueSession = useMemo(() => {
    if (!activeTabSummary) return false;
    return (
      activeTabSummary.phase === "awaitingInput" &&
      (activeTabSummary.startupPromptSent || activeTabSummary.hasTranscript)
    );
  }, [activeTabSummary]);

  useEffect(() => {
    if (session || !role) return;
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(() => {
      const cwd = values.cwd ?? defaultCwd;
      saveFormDraft(roleId, cwd, formValues).catch(() => {});
      if (activeTabId) {
        syncActiveTabForm(activeTabId, roleId, cwd, formValues)
          .then(() => refreshTabs())
          .catch(() => {});
      }
    }, 800);
    return () => {
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    };
  }, [
    formValues,
    roleId,
    session,
    role,
    values.cwd,
    defaultCwd,
    activeTabId,
    refreshTabs,
  ]);

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
    const continuing = canContinueSession && !resendStartup;
    if (continuing) {
      setStreamSegments((prev) => [
        ...prev,
        streamSegmentFromSystemMessage(
          "Reconnecting to agent (startup prompt skipped). Send a follow-up below to continue.",
        ),
      ]);
    } else {
      setStreamSegments([
        streamSegmentFromSystemMessage(
          "Connecting to agent and sending startup prompt…",
        ),
      ]);
    }
    try {
      const result = await roleSessionStart(
        roleId,
        formValues,
        activeTabId,
        resendStartup,
      );
      setStartResult(result);
      if (result.errors.length > 0) {
        setSession(null);
        setStreamSegments([]);
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
        resumedSession: false,
        skippedStartupInjection: false,
      });
    } finally {
      setBusy(false);
    }
  }, [
    roleId,
    formValues,
    refreshTabs,
    activeTabId,
    canContinueSession,
    resendStartup,
  ]);

  const stopSession = useCallback(async () => {
    setBusy(true);
    try {
      const scrollback = segmentsToPlainText(streamSegments);
      await devSessionStop(scrollback || undefined);
      setSession(null);
      setStartResult(null);
      setLastPromptResult(null);
      setPromptInFlight(false);
      setPromptError(null);
      await refreshTabs();
    } finally {
      setBusy(false);
    }
  }, [refreshTabs, streamSegments]);

  const handleSelectTab = useCallback(
    async (tabId: string) => {
      if (session) return;
      setBusy(true);
      try {
        const { tab } = await selectActiveTab(tabId);
        setSession(null);
        setStartResult(null);
        setStreamSegments([]);
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

  const [draftQueuedHint, setDraftQueuedHint] = useState(false);
  const [permissionRequest, setPermissionRequest] =
    useState<PermissionRequestEvent | null>(null);

  const handleNewTab = useCallback(async () => {
    setBusy(true);
    setDraftQueuedHint(false);
    try {
      const cwd = session?.cwd ?? values.cwd ?? defaultCwd;
      await newDraftTab(roleId, cwd);
      await refreshTabs();
      if (session) {
        setDraftQueuedHint(true);
        return;
      }
      const snap = await getAppState();
      const newActive = snap.activeTabId;
      if (!newActive) return;
      const { tab } = await getTab(newActive);
      skipRecallRef.current = true;
      setRoleId(tab.roleId);
      const recall = await getFormRecall(tab.roleId, cwd);
      setValues({ ...recall.values, cwd: recall.cwd });
      setActiveTabId(tab.id);
    } finally {
      setBusy(false);
    }
  }, [session, roleId, values.cwd, defaultCwd, refreshTabs]);

  const cancelTurn = useCallback(async () => {
    setBusy(true);
    try {
      await devSessionCancel();
    } catch (err: unknown) {
      setPromptError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!session || !promptInFlight) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancelTurn();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [session, promptInFlight, cancelTurn]);

  const handlePermissionSelect = useCallback(async (optionId: string) => {
    setBusy(true);
    try {
      await respondPermissionRequest("selected", optionId);
      setPermissionRequest(null);
    } catch (err: unknown) {
      setPromptError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const handlePermissionCancel = useCallback(async () => {
    setBusy(true);
    try {
      await respondPermissionRequest("cancelled");
      setPermissionRequest(null);
    } catch (err: unknown) {
      setPromptError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

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

  const composerFields = (
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
  );

  const idleActions = (
    <>
      <div className="button-row">
        <button
          type="button"
          className="secondary-button"
          onClick={runPreview}
          disabled={busy || previewBusy}
        >
          {previewBusy ? "…" : "Validate & preview"}
        </button>
        <button
          type="button"
          className="primary-button"
          onClick={startSession}
          disabled={busy || !cliFound}
        >
          {canContinueSession && !resendStartup
            ? "Continue session"
            : "Start role session"}
        </button>
      </div>
      {canContinueSession && (
        <label className="field-label continue-option">
          <input
            type="checkbox"
            checked={resendStartup}
            onChange={(e) => setResendStartup(e.target.checked)}
            disabled={busy}
          />
          Re-send startup prompt (full restart with merged role template)
        </label>
      )}
      {preview?.merged && preview.merged.text && (
        <details className="preview-details">
          <summary>
            Merged prompt ({preview.merged.chars.toLocaleString()} chars)
          </summary>
          <pre className="mono-snippet">{preview.merged.text}</pre>
        </details>
      )}
    </>
  );

  if (session) {
    const attachFirst =
      startResult?.injectionStrategy === "attach_to_first_message";
    return (
      <section className="status-card status-card-session-full">
        <TabBar
          tabs={savedTabs}
          activeTabId={activeTabId}
          disableSwitch={true}
          disableNew={busy}
          onSelect={handleSelectTab}
          onClose={handleCloseTab}
          onNew={handleNewTab}
        />
        {draftQueuedHint && (
          <p className="hint tab-draft-hint">
            Draft tab added — <strong>Stop session</strong> to switch to it and
            edit the form.
          </p>
        )}
        <SessionTerminal
          title={activeTabSummary?.label ?? "Session"}
          cwd={session.cwd}
          sessionId={session.sessionId}
          segments={streamSegments}
          promptInFlight={promptInFlight}
          followUp={followUp}
          busy={busy}
          canSendFollowUp={!attachFirst || !startResult?.startupInjected}
          promptError={promptError}
          permissionRequest={permissionRequest}
          onPermissionSelect={handlePermissionSelect}
          onPermissionCancel={handlePermissionCancel}
          onCancelTurn={cancelTurn}
          onFollowUpChange={setFollowUp}
          onSendFollowUp={sendFollowUp}
          onStop={stopSession}
        />
        {lastPromptResult && !promptInFlight && (
          <p className="hint session-turn-hint">
            Last turn: {lastPromptResult.stopReason ?? "finished"}
          </p>
        )}
        <details className="startup-form-details">
          <summary>Startup form (read-only)</summary>
          {composerFields}
        </details>
      </section>
    );
  }

  return (
    <section className="status-card">
      <h2>Start role session</h2>
      <p className="hint">
        One tab = one workspace. <strong>Start</strong> opens a full-height agent
        pane (structured stream from <code>agent acp</code>, not a shell PTY).
        Use <strong>+ New tab</strong> for another task.
      </p>
      <TabBar
        tabs={savedTabs}
        activeTabId={activeTabId}
        disableSwitch={busy}
        disableNew={busy}
        onSelect={handleSelectTab}
        onClose={handleCloseTab}
        onNew={handleNewTab}
      />
      {canContinueSession && (
        <p className="hint">
          This tab has saved history. Use <strong>Continue session</strong> to
          reconnect without re-sending the startup prompt — then send a
          follow-up. Check the box above only if you want a full restart.
        </p>
      )}
      {composerFields}
      {idleActions}
      {streamSegments.length > 0 && (
        <details className="startup-form-details" open>
          <summary>Last session transcript (saved on Stop)</summary>
          <pre className="mono-snippet transcript-saved">
            {segmentsToPlainText(streamSegments)}
          </pre>
        </details>
      )}
    </section>
  );
}
