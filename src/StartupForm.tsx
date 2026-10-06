import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  closeTab,
  devSessionCancel,
  devSessionSend,
  devSessionStop,
  listenPermissionAuto,
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
  type FieldError,
  type Role,
  type RoleSessionStartResult,
  type RoleSummary,
  type SessionUpdateEvent,
  type TabSummary,
  type ValidatePreviewResult,
} from "./bridge";
import {
  applyAutoPermission,
  applyPermission,
  applyPromptFinished,
  applySessionUpdate,
  attentionTabIds,
  clearLiveSession,
  emptyRuntime,
  folderStatusMessage,
  runtimeFor,
  type TabRuntime,
} from "./liveTabs";
import { SessionTerminal } from "./SessionTerminal";
import { TabBar } from "./TabBar";
import {
  appendStreamSegment,
  streamSegmentFromSystemMessage,
  streamSegmentFromUserMessage,
  segmentsToPlainText,
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
  const [runtimes, setRuntimes] = useState<Record<string, TabRuntime>>({});
  const [busy, setBusy] = useState(false);
  const [savedTranscript, setSavedTranscript] = useState("");
  const [savedTabs, setSavedTabs] = useState<TabSummary[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [resendStartup, setResendStartup] = useState(false);
  const skipRecallRef = useRef(false);
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionActiveRef = useRef(false);
  const pendingUpdatesRef = useRef<Record<string, SessionUpdateEvent[]>>({});
  const flushRafRef = useRef<number | null>(null);
  const tabsBootstrappedRef = useRef(false);
  const startLockRef = useRef(false);
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  const activeRuntime = runtimeFor(runtimes, activeTabId);
  const session = activeRuntime.session;
  const startResult = activeRuntime.startResult;
  const promptInFlight = activeRuntime.promptInFlight;
  const lastPromptResult = activeRuntime.lastResult;
  const promptError = activeRuntime.promptError;
  const followUp = activeRuntime.followUp;
  const streamSegments = activeRuntime.segments;
  const permissionRequest = activeRuntime.permission;
  const needsAttention = useMemo(() => attentionTabIds(runtimes), [runtimes]);

  const patchRuntime = useCallback(
    (tabId: string, update: (rt: TabRuntime) => TabRuntime) => {
      setRuntimes((prev) => ({
        ...prev,
        [tabId]: update(prev[tabId] ?? emptyRuntime()),
      }));
    },
    [],
  );

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
    setSavedTranscript(tab.transcript?.trim() ?? "");
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
    const pending = pendingUpdatesRef;
    const flushUpdates = () => {
      const batches = pending.current;
      pending.current = {};
      const tabIds = Object.keys(batches);
      if (tabIds.length === 0) return;
      setRuntimes((prev) => {
        const next = { ...prev };
        for (const tabId of tabIds) {
          let rt = next[tabId] ?? emptyRuntime();
          for (const evt of batches[tabId]) {
            rt = applySessionUpdate(rt, evt);
          }
          next[tabId] = rt;
        }
        return next;
      });
    };

    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    void Promise.all([
      listenSessionUpdates((evt) => {
        if (!evt.tabId) return;
        const queue = pending.current[evt.tabId] ?? [];
        queue.push(evt);
        pending.current[evt.tabId] = queue;
        if (flushRafRef.current === null) {
          flushRafRef.current = requestAnimationFrame(() => {
            flushRafRef.current = null;
            flushUpdates();
          });
        }
      }),
      listenPermissionRequests((evt) => {
        if (!evt.tabId) return;
        patchRuntime(evt.tabId, (rt) => applyPermission(rt, evt));
      }),
      listenPermissionAuto((evt) => {
        if (!evt.tabId) return;
        patchRuntime(evt.tabId, (rt) => applyAutoPermission(rt, evt));
      }),
      listenPromptFinished((evt) => {
        if (!evt.tabId) return;
        patchRuntime(evt.tabId, (rt) => applyPromptFinished(rt, evt));
      }),
    ]).then((fns) => {
      if (cancelled) {
        fns.forEach((fn) => fn());
        return;
      }
      unlisteners.push(...fns);
    });

    return () => {
      cancelled = true;
      unlisteners.forEach((fn) => fn());
      if (flushRafRef.current !== null) {
        cancelAnimationFrame(flushRafRef.current);
        flushRafRef.current = null;
      }
    };
  }, [patchRuntime]);

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
            const tabId = activeTabIdRef.current;
            if (tabId) {
              setRuntimes((prev) => {
                const rt = prev[tabId];
                if (!rt?.startResult) return prev;
                return { ...prev, [tabId]: { ...rt, startResult: null } };
              });
            }
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

  const failedStart = (message: string, key = "_session"): RoleSessionStartResult => ({
    errors: [{ key, message }],
    session: null,
    mergedChars: null,
    injectionStrategy: null,
    startupInjected: false,
    injectionInFlight: false,
    tabId: null,
    resumedSession: false,
    skippedStartupInjection: false,
    folderWarning: null,
  });

  const startSession = useCallback(async () => {
    if (startLockRef.current) return;
    startLockRef.current = true;
    setBusy(true);
    const tabKey = activeTabId;
    const continuing = canContinueSession && !resendStartup;
    if (tabKey) {
      patchRuntime(tabKey, (rt) => {
        const prior =
          rt.segments.length > 0
            ? rt.segments
            : savedTranscript
              ? [
                  {
                    id: "saved_transcript",
                    kind: "agent" as const,
                    text: savedTranscript,
                  },
                ]
              : [];
        return {
          ...rt,
          accepting: true,
          promptError: null,
          agentExited: false,
          startResult: null,
          lastResult: null,
          segments: [
            ...prior,
            streamSegmentFromSystemMessage(
              continuing
                ? "Reconnecting to agent (startup prompt skipped). Send a follow-up below to continue."
                : "Connecting to agent and sending startup prompt…",
            ),
          ],
        };
      });
    }
    try {
      const result = await roleSessionStart(
        roleId,
        formValues,
        activeTabId,
        resendStartup,
      );
      const targetId = result.tabId ?? tabKey;
      if (result.errors.length > 0 || !result.session || !targetId) {
        if (targetId) {
          patchRuntime(targetId, (rt) => ({
            ...clearLiveSession(rt),
            startResult: result.errors.length > 0 ? result : failedStart("Session did not start"),
            accepting: false,
          }));
        }
        return;
      }
      setActiveTabId(targetId);
      patchRuntime(targetId, (rt) => {
        let segments = rt.segments.filter(
          (s) =>
            s.kind !== "system" || !s.text.includes("Connecting to agent"),
        );
        if (result.injectionInFlight && !continuing) {
          const startupText = preview?.merged?.text?.trim();
          segments = startupText
            ? appendStreamSegment(segments, streamSegmentFromUserMessage(startupText))
            : [
                ...segments,
                streamSegmentFromSystemMessage("Startup prompt sent to agent."),
              ];
        }
        if (result.folderWarning) {
          segments = appendStreamSegment(
            segments,
            streamSegmentFromSystemMessage(result.folderWarning),
          );
        }
        return {
          ...rt,
          session: result.session,
          startResult: result,
          promptInFlight: !!result.injectionInFlight,
          folderWarning: result.folderWarning,
          promptError: null,
          agentExited: false,
          accepting: true,
          segments,
        };
      });
      setPreview(null);
      await refreshTabs();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (tabKey) {
        patchRuntime(tabKey, (rt) => ({
          ...clearLiveSession(rt),
          startResult: failedStart(message),
        }));
      }
    } finally {
      startLockRef.current = false;
      setBusy(false);
    }
  }, [
    roleId,
    formValues,
    refreshTabs,
    activeTabId,
    canContinueSession,
    resendStartup,
    preview,
    patchRuntime,
    savedTranscript,
  ]);

  const stopSession = useCallback(async () => {
    if (!activeTabId) return;
    setBusy(true);
    try {
      const scrollback = segmentsToPlainText(streamSegments);
      setSavedTranscript(scrollback);
      await devSessionStop(scrollback || undefined, activeTabId);
      patchRuntime(activeTabId, (rt) => clearLiveSession(rt));
      await refreshTabs();
    } finally {
      setBusy(false);
    }
  }, [refreshTabs, streamSegments, activeTabId, patchRuntime]);

  const handleSelectTab = useCallback(
    async (tabId: string) => {
      setBusy(true);
      try {
        const { tab } = await selectActiveTab(tabId);
        loadTabIntoForm(tab);
        await refreshTabs();
      } finally {
        setBusy(false);
      }
    },
    [loadTabIntoForm, refreshTabs],
  );

  const handleCloseTab = useCallback(
    async (tabId: string) => {
      setBusy(true);
      try {
        const snap = await closeTab(tabId);
        setRuntimes((prev) => {
          const next = { ...prev };
          delete next[tabId];
          return next;
        });
        setSavedTabs(snap.tabs);
        setActiveTabId(snap.activeTabId);
        if (snap.activeTabId) {
          const { tab } = await selectActiveTab(snap.activeTabId);
          loadTabIntoForm(tab);
        } else {
          const recall = await getFormRecall(roleId, defaultCwd);
          setValues({ ...recall.values, cwd: recall.cwd });
          setSavedTranscript("");
        }
      } finally {
        setBusy(false);
      }
    },
    [roleId, defaultCwd, loadTabIntoForm],
  );

  const handleNewTab = useCallback(async () => {
    setBusy(true);
    try {
      const cwd = session?.cwd ?? values.cwd ?? defaultCwd;
      await newDraftTab(roleId, cwd);
      const snap = await getAppState();
      setSavedTabs(snap.tabs);
      const newActive = snap.activeTabId;
      if (!newActive) return;
      const { tab } = await getTab(newActive);
      skipRecallRef.current = true;
      setRoleId(tab.roleId);
      const recall = await getFormRecall(tab.roleId, cwd);
      setValues({ ...recall.values, cwd: recall.cwd });
      setActiveTabId(tab.id);
      setSavedTranscript("");
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }, [session, roleId, values.cwd, defaultCwd]);

  const cancelTurn = useCallback(async () => {
    if (!activeTabId) return;
    setBusy(true);
    try {
      await devSessionCancel(activeTabId);
      patchRuntime(activeTabId, (rt) => ({
        ...rt,
        segments: [
          ...rt.segments,
          streamSegmentFromSystemMessage("Cancelling the current turn…"),
        ],
      }));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      patchRuntime(activeTabId, (rt) => ({ ...rt, promptError: message }));
    } finally {
      setBusy(false);
    }
  }, [activeTabId, patchRuntime]);

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

  const handlePermissionSelect = useCallback(
    async (optionId: string) => {
      if (!activeTabId || !permissionRequest) return;
      setBusy(true);
      try {
        await respondPermissionRequest(
          activeTabId,
          permissionRequest.jsonRpcId,
          "selected",
          optionId,
        );
        patchRuntime(activeTabId, (rt) => ({ ...rt, permission: null }));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        patchRuntime(activeTabId, (rt) => ({ ...rt, promptError: message }));
      } finally {
        setBusy(false);
      }
    },
    [activeTabId, permissionRequest, patchRuntime],
  );

  const handlePermissionCancel = useCallback(async () => {
    if (!activeTabId || !permissionRequest) return;
    setBusy(true);
    try {
      await respondPermissionRequest(
        activeTabId,
        permissionRequest.jsonRpcId,
        "cancelled",
      );
      patchRuntime(activeTabId, (rt) => ({ ...rt, permission: null }));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      patchRuntime(activeTabId, (rt) => ({ ...rt, promptError: message }));
    } finally {
      setBusy(false);
    }
  }, [activeTabId, permissionRequest, patchRuntime]);

  const sendFollowUp = useCallback(async () => {
    const text = followUp.trim();
    if (!text || !activeTabId || activeRuntime.agentExited) return;
    setBusy(true);
    patchRuntime(activeTabId, (rt) => ({
      ...rt,
      promptError: null,
      followUp: "",
      promptInFlight: true,
      segments: appendStreamSegment(rt.segments, streamSegmentFromUserMessage(text)),
    }));
    try {
      await devSessionSend(text, activeTabId);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      patchRuntime(activeTabId, (rt) => ({
        ...rt,
        promptError: message,
        promptInFlight: false,
      }));
    } finally {
      setBusy(false);
    }
  }, [followUp, activeTabId, activeRuntime.agentExited, patchRuntime]);

  const setFollowUp = (value: string) => {
    if (!activeTabId) return;
    patchRuntime(activeTabId, (rt) => ({ ...rt, followUp: value }));
  };

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
          disableSwitch={false}
          disableNew={busy}
          attentionTabIds={needsAttention}
          onSelect={handleSelectTab}
          onClose={handleCloseTab}
          onNew={handleNewTab}
        />
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
          folderWarning={activeRuntime.folderWarning}
          agentExited={activeRuntime.agentExited}
          onRestart={stopSession}
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
        One tab = one agent. <strong>Start</strong> opens a full-height agent
        pane. Other tabs can keep their own sessions running. <strong>+ New
        tab</strong> starts another task without stopping this one.
      </p>
      <TabBar
        tabs={savedTabs}
        activeTabId={activeTabId}
        disableSwitch={busy}
        disableNew={busy}
        attentionTabIds={needsAttention}
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
      {activeTabSummary &&
        folderStatusMessage(activeTabSummary.folderStatus, activeTabSummary.cwd) && (
          <p className="error">
            {folderStatusMessage(activeTabSummary.folderStatus, activeTabSummary.cwd)}
          </p>
        )}
      {composerFields}
      {idleActions}
      {savedTranscript && (
        <details className="startup-form-details" open>
          <summary>Last session transcript (saved on Stop)</summary>
          <pre className="mono-snippet transcript-saved">{savedTranscript}</pre>
        </details>
      )}
    </section>
  );
}
