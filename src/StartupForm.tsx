import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  closeTab,
  devSessionCancel,
  devSessionSend,
  devSessionStop,
  diagnosticsSetCapture,
  diagnosticsStatus,
  listenPermissionAuto,
  listenPermissionRequests,
  listenPlanRequests,
  respondPermissionRequest,
  respondPlanRequest,
  reopenClosedTab,
  setTabColor,
  setTabLabel,
  transcriptSave,
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
  type ClosedTabSummary,
  type FieldError,
  type PlanRequestEvent,
  type CliDetectResult,
  type DiagnosticsStatus,
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
import { CommandPalette } from "./components/CommandPalette";
import { FolderPicker } from "./components/FolderPicker";
import { SettingsPage } from "./components/SettingsPage";
import { folderForTab } from "./projectsView";
import { tabSurface, toggleSettings } from "./workspaceView";
import { ScratchPad } from "./components/ScratchPad";
import { SessionCards } from "./components/SessionCards";
import { ShortcutsOverlay } from "./components/ShortcutsOverlay";
import { SplitPanes } from "./components/SplitPanes";
import { TabSwitcher } from "./components/TabSwitcher";
import { detectPlatform, type ShortcutMatch } from "./keymap";
import { emptySessionCards, reduceSessionCards, type SessionCards as Cards } from "./sessionCards";
import {
  chainMarkBlocked,
  chainMarkSent,
  chainMarkSettled,
  chainStart,
  chainStepToSend,
  chainStop,
  splitChainSteps,
  transferToInput,
  type ChainCursor,
} from "./scratch/pad";
import { createTurnWaiter } from "./scratch/turnWait";
import { SessionTerminal } from "./SessionTerminal";
import { TabBar } from "./TabBar";
import { closeSplit, emptySplit, openSplit, tabAtIndex, type SplitState } from "./tabChrome";
import { useAppShortcuts } from "./useAppShortcuts";
import { useScratchPads } from "./useScratchPads";
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
  cli: CliDetectResult | null;
  cliError: string | null;
  cliFound: boolean;
  showDevTools: boolean;
};

export function StartupForm({
  roles,
  cli,
  cliError,
  cliFound,
  showDevTools,
}: Props) {
  const [roleId, setRoleId] = useState("role_implementer");
  const [role, setRole] = useState<Role | null>(null);
  const [values, setValues] = useState<Record<string, string>>({ cwd: "" });
  const [preview, setPreview] = useState<ValidatePreviewResult | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [runtimes, setRuntimes] = useState<Record<string, TabRuntime>>({});
  const [busy, setBusy] = useState(false);
  const [savedTranscript, setSavedTranscript] = useState("");
  const [savedTabs, setSavedTabs] = useState<TabSummary[]>([]);
  const [closedTabs, setClosedTabs] = useState<ClosedTabSummary[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [cardsByTab, setCardsByTab] = useState<Record<string, Cards>>({});
  const [planRequest, setPlanRequest] = useState<PlanRequestEvent | null>(null);
  const [split, setSplit] = useState<SplitState>(emptySplit());
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [captureOn, setCaptureOn] = useState(false);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsStatus | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pickedRoleId, setPickedRoleId] = useState<string | null>(null);
  const [transcriptSaveError, setTranscriptSaveError] = useState<string | null>(null);
  const [historyCursor, setHistoryCursor] = useState(-1);
  const [chain, setChain] = useState<ChainCursor | null>(null);
  const [resendStartup, setResendStartup] = useState(false);
  const skipRecallRef = useRef(false);
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionActiveRef = useRef(false);
  const pendingUpdatesRef = useRef<Record<string, SessionUpdateEvent[]>>({});
  const runtimesRef = useRef(runtimes);
  runtimesRef.current = runtimes;
  const flushRafRef = useRef<number | null>(null);
  const tabsBootstrappedRef = useRef(false);
  const hydratedRef = useRef(false);
  const startLockRef = useRef(false);
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  const roleIdRef = useRef(roleId);
  roleIdRef.current = roleId;
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
  const scratch = useScratchPads(activeTabId);
  const padRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const waiterRef = useRef(createTurnWaiter());
  const chainAbortRef = useRef(false);
  const dialogOpen = paletteOpen || switcherOpen || shortcutsOpen || settingsOpen;
  const platform = useMemo(
    () => detectPlatform(typeof navigator === "undefined" ? "" : navigator.platform),
    [],
  );

  const patchRuntime = useCallback(
    (tabId: string, update: (rt: TabRuntime) => TabRuntime) => {
      setRuntimes((prev) => ({
        ...prev,
        [tabId]: update(prev[tabId] ?? emptyRuntime()),
      }));
    },
    [],
  );

  const persistTranscripts = useCallback(async (snapshot: Record<string, TabRuntime>) => {
    const jobs = Object.entries(snapshot)
      .filter(([, rt]) => rt.segments.length > 0)
      .map(async ([tabId, rt]) => {
        const cwd = rt.session?.cwd ?? "";
        try {
          await transcriptSave(tabId, segmentsToPlainText(rt.segments), cwd);
          setTranscriptSaveError(null);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          setTranscriptSaveError(message);
        }
      });
    await Promise.all(jobs);
  }, []);

  const loadTabIntoForm = useCallback((tab: {
    roleId: string;
    cwd: string;
    answers: Record<string, string>;
    id: string;
    transcript?: string | null;
  }) => {
    if (tab.roleId !== roleIdRef.current) {
      skipRecallRef.current = true;
    }
    hydratedRef.current = true;
    setRoleId(tab.roleId);
    const fresh = !folderForTab(tab.cwd) && !(tab.transcript?.trim());
    setPickedRoleId(fresh ? null : tab.roleId);
    setValues({ ...tab.answers, cwd: folderForTab(tab.cwd) });
    setActiveTabId(tab.id);
    setPreview(null);
    setSavedTranscript(tab.transcript?.trim() ?? "");
  }, []);

  const refreshTabs = useCallback(async () => {
    const snap = await getAppState();
    setSavedTabs(snap.tabs);
    setClosedTabs(snap.closedTabs ?? []);
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
          const { tab } = await newDraftTab(seedRoleId, "");
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
  }, [loadTabIntoForm, refreshTabs, roles]);

  useEffect(() => {
    sessionActiveRef.current = !!session;
  }, [session]);

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
        setCardsByTab((prev) => ({
          ...prev,
          [evt.tabId]: reduceSessionCards(prev[evt.tabId] ?? emptySessionCards(), evt),
        }));
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
        setChain((current) => (current ? chainMarkBlocked(current) : current));
        patchRuntime(evt.tabId, (rt) => applyPermission(rt, evt));
      }),
      listenPermissionAuto((evt) => {
        if (!evt.tabId) return;
        patchRuntime(evt.tabId, (rt) => applyAutoPermission(rt, evt));
      }),
      listenPromptFinished((evt) => {
        if (!evt.tabId) return;
        waiterRef.current.notify({
          tabId: evt.tabId,
          success: evt.success,
          stopReason: evt.result?.stopReason,
          error: evt.error,
        });
        patchRuntime(evt.tabId, (rt) => applyPromptFinished(rt, evt));
      }),
      listenPlanRequests((evt) => {
        if (!evt.tabId) return;
        setPlanRequest(evt);
        setChain((current) => (current ? chainMarkBlocked(current) : current));
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
    const timer = window.setTimeout(() => {
      void persistTranscripts(runtimes);
    }, 800);
    return () => window.clearTimeout(timer);
  }, [runtimes, persistTranscripts]);

  useEffect(() => {
    const onHide = () => {
      void persistTranscripts(runtimesRef.current);
    };
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, [persistTranscripts]);

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
    if (!hydratedRef.current) return;
    if (skipRecallRef.current) {
      skipRecallRef.current = false;
      return;
    }
    if (session) return;
    getFormRecall(roleId)
      .then((recall) => {
        setValues({ ...recall.values, cwd: folderForTab(recall.cwd) });
      })
      .catch(() => {});
  }, [roleId, session]);

  const formValues = useMemo((): Record<string, string> => {
    if (!role) return values;
    return { ...values, cwd: values.cwd ?? "" };
  }, [role, values]);

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
    if (!hydratedRef.current || session || !role) return;
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(() => {
      const cwd = values.cwd ?? "";
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

  const startSession = useCallback(async (forceResend = false) => {
    if (startLockRef.current) return;
    startLockRef.current = true;
    setBusy(true);
    const tabKey = activeTabId;
    const resend = forceResend || resendStartup;
    const continuing = canContinueSession && !resend;
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
        resend,
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
        const rt = runtimes[tabId];
        if (rt && rt.segments.length > 0) {
          const cwd = rt.session?.cwd ?? values.cwd ?? "";
          await transcriptSave(tabId, segmentsToPlainText(rt.segments), cwd).catch(
            (err: unknown) => {
              const message = err instanceof Error ? err.message : String(err);
              setTranscriptSaveError(message);
            },
          );
        }
        scratch.flush();
        const snap = await closeTab(tabId);
        setRuntimes((prev) => {
          const next = { ...prev };
          delete next[tabId];
          return next;
        });
        setSavedTabs(snap.tabs);
        setClosedTabs(snap.closedTabs ?? []);
        setActiveTabId(snap.activeTabId);
        if (snap.activeTabId) {
          const { tab } = await selectActiveTab(snap.activeTabId);
          loadTabIntoForm(tab);
        } else {
          const recall = await getFormRecall(roleId);
          setValues({ ...recall.values, cwd: folderForTab(recall.cwd) });
          setSavedTranscript("");
        }
      } finally {
        setBusy(false);
      }
    },
    [roleId, loadTabIntoForm, runtimes, values.cwd, scratch],
  );

  const handleNewTab = useCallback(async () => {
    setBusy(true);
    try {
      await newDraftTab(roleId, "");
      const snap = await getAppState();
      setSavedTabs(snap.tabs);
      const newActive = snap.activeTabId;
      if (!newActive) return;
      const { tab } = await getTab(newActive);
      if (tab.roleId !== roleId) {
        skipRecallRef.current = true;
      }
      hydratedRef.current = true;
      setRoleId(tab.roleId);
      const recall = await getFormRecall(tab.roleId);
      setValues({ ...recall.values, cwd: "" });
      setPickedRoleId(null);
      setActiveTabId(tab.id);
      setSavedTranscript("");
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }, [roleId]);

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

  const sendText = useCallback(
    async (tabId: string, text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return "error" as const;
      const pending = waiterRef.current.expect(tabId);
      setHistoryCursor(-1);
      scratch.remember(tabId, trimmed);
      patchRuntime(tabId, (rt) => ({
        ...rt,
        promptError: null,
        followUp: "",
        promptInFlight: true,
        segments: appendStreamSegment(rt.segments, streamSegmentFromUserMessage(trimmed)),
      }));
      try {
        await devSessionSend(trimmed, tabId);
      } catch (err: unknown) {
        waiterRef.current.cancel(tabId);
        const message = err instanceof Error ? err.message : String(err);
        patchRuntime(tabId, (rt) => ({
          ...rt,
          promptError: message,
          promptInFlight: false,
        }));
        return "error" as const;
      }
      return pending;
    },
    [patchRuntime, scratch],
  );

  const sendFollowUp = useCallback(async () => {
    const text = followUp.trim();
    if (!text || !activeTabId || activeRuntime.agentExited || promptInFlight) return;
    setBusy(true);
    try {
      await sendText(activeTabId, text);
    } finally {
      setBusy(false);
    }
  }, [followUp, activeTabId, activeRuntime.agentExited, promptInFlight, sendText]);

  const transferPad = useCallback(() => {
    if (!activeTabId) return;
    const selected = padRef.current
      ? padRef.current.value.slice(
          padRef.current.selectionStart,
          padRef.current.selectionEnd,
        )
      : "";
    const next = transferToInput(followUp, scratch.content, selected);
    setFollowUp(next);
    inputRef.current?.focus();
  }, [activeTabId, followUp, scratch.content]);

  const runChain = useCallback(async () => {
    if (!activeTabId || promptInFlight || permissionRequest) return;
    const started = chainStart(scratch.content);
    if (!started) return;
    chainAbortRef.current = false;
    let cursor = started;
    setChain(cursor);
    while (cursor.phase !== "done" && cursor.phase !== "stopped") {
      if (chainAbortRef.current) {
        cursor = chainStop(cursor);
        setChain(cursor);
        break;
      }
      const step = chainStepToSend(cursor);
      if (!step) break;
      cursor = chainMarkSent(cursor);
      setChain(cursor);
      const outcome = await sendText(activeTabId, step);
      if (chainAbortRef.current) {
        cursor = chainStop(cursor);
        setChain(cursor);
        break;
      }
      cursor = chainMarkSettled(cursor, outcome);
      setChain(cursor);
    }
  }, [activeTabId, permissionRequest, promptInFlight, scratch.content, sendText]);

  const sendFromPad = useCallback(() => {
    if (!activeTabId) return;
    if (splitChainSteps(scratch.content).length > 1 && !followUp.trim()) {
      void runChain();
      return;
    }
    if (followUp.trim()) {
      void sendFollowUp();
      return;
    }
    if (scratch.content.trim()) {
      void sendText(activeTabId, scratch.content);
    }
  }, [activeTabId, followUp, runChain, scratch.content, sendFollowUp, sendText]);

  const roleColors = useMemo(() => {
    const map: Record<string, string> = {};
    for (const item of roles) map[item.id] = item.color;
    return map;
  }, [roles]);

  const selectTabByIndex = useCallback(
    (index: number) => {
      const tab = tabAtIndex(savedTabs, index);
      if (tab) void handleSelectTab(tab.id);
    },
    [savedTabs, handleSelectTab],
  );

  const cycleTab = useCallback(
    (delta: number) => {
      if (savedTabs.length === 0) return;
      const current = savedTabs.findIndex((tab) => tab.id === activeTabId);
      const next = (current + delta + savedTabs.length) % savedTabs.length;
      const tab = savedTabs[next];
      if (tab) void handleSelectTab(tab.id);
    },
    [savedTabs, activeTabId, handleSelectTab],
  );

  const reopenTab = useCallback(async () => {
    setBusy(true);
    try {
      const { tab } = await reopenClosedTab();
      await refreshTabs();
      loadTabIntoForm(tab);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setPreview({ errors: [{ key: "_session", message }], merged: null });
    } finally {
      setBusy(false);
    }
  }, [loadTabIntoForm, refreshTabs]);

  const onShortcut = useCallback(
    (match: ShortcutMatch) => {
      if (match.action === "closeDialog") {
        setPaletteOpen(false);
        setSwitcherOpen(false);
        setShortcutsOpen(false);
        setSettingsOpen(false);
        return;
      }
      if (match.action === "settings") {
        setPaletteOpen(false);
        setSwitcherOpen(false);
        setShortcutsOpen(false);
        setSettingsOpen((open) => toggleSettings(open));
        return;
      }
      if (match.action === "commandPalette") {
        setPaletteOpen(true);
        return;
      }
      if (match.action === "tabSwitcher") {
        setSwitcherOpen(true);
        return;
      }
      if (match.action === "shortcutsHelp") {
        setShortcutsOpen(true);
        return;
      }
      if (match.action === "send") {
        if (document.activeElement === padRef.current) sendFromPad();
        else void sendFollowUp();
        return;
      }
      if (match.action === "transferPad") {
        transferPad();
        return;
      }
      if (match.action === "focusPad") {
        padRef.current?.focus();
        return;
      }
      if (match.action === "focusInput") {
        inputRef.current?.focus();
        return;
      }
      if (match.action === "newTab") {
        void handleNewTab();
        return;
      }
      if (match.action === "closeTab" && activeTabId) {
        const running = savedTabs.find((tab) => tab.id === activeTabId)?.phase === "running";
        if (running && !window.confirm("Stop this tab's agent and close it?")) return;
        void handleCloseTab(activeTabId);
        return;
      }
      if (match.action === "nextTab") {
        cycleTab(1);
        return;
      }
      if (match.action === "prevTab") {
        cycleTab(-1);
        return;
      }
      if (match.action === "goToTab" && match.tabIndex != null) {
        selectTabByIndex(match.tabIndex);
        return;
      }
      if (match.action === "reopenClosedTab") {
        void reopenTab();
        return;
      }
      if (match.action === "splitRight" || match.action === "splitDown") {
        const other = savedTabs.find((tab) => tab.id !== activeTabId);
        if (!other) return;
        setSplit(openSplit(split, match.action === "splitRight" ? "horizontal" : "vertical", other.id));
        return;
      }
      if (match.action === "renameTab" && activeTabId) {
        const current = savedTabs.find((tab) => tab.id === activeTabId)?.label ?? "";
        const next = window.prompt("Tab name", current);
        if (next && next.trim()) {
          void setTabLabel(activeTabId, next.trim()).then(() => refreshTabs());
        }
      }
    },
    [
      activeTabId,
      cycleTab,
      handleCloseTab,
      handleNewTab,
      refreshTabs,
      reopenTab,
      savedTabs,
      selectTabByIndex,
      sendFollowUp,
      sendFromPad,
      split,
      transferPad,
    ],
  );

  useAppShortcuts({
    platform,
    dialogOpen,
    promptInFlight: !!promptInFlight,
    onAction: onShortcut,
    onCancelTurn: () => {
      void cancelTurn();
    },
  });

  useEffect(() => {
    diagnosticsStatus()
      .then((status) => {
        setDiagnostics(status);
        setCaptureOn(status.capturePermissionPayloads);
      })
      .catch(() => {});
  }, []);

  const runPalette = (id: string) => {
    setPaletteOpen(false);
    if (id === "settings") {
      setSettingsOpen(true);
      return;
    }
    if (id === "toggleCapture") {
      void diagnosticsSetCapture(!captureOn).then((status) => {
        setDiagnostics(status);
        setCaptureOn(status.capturePermissionPayloads);
      });
      return;
    }
    if (id === "closeSplit") {
      setSplit(closeSplit());
      return;
    }
    if (id.startsWith("goto:")) {
      void handleSelectTab(id.slice("goto:".length));
      return;
    }
    onShortcut({ action: id as ShortcutMatch["action"] });
  };

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

  const surface = tabSurface({
    sessionActive: !!session,
    hasSavedHistory: canContinueSession || savedTranscript.trim().length > 0,
    roleChosen: pickedRoleId !== null,
    folder: folderForTab(values.cwd),
  });

  const chooseRole = (id: string) => {
    setPickedRoleId(id);
    setRoleId(id);
  };

  const tabBar = (
    <TabBar
      tabs={savedTabs}
      activeTabId={activeTabId}
      roleColors={roleColors}
      disableSwitch={busy && !session}
      disableNew={busy}
      attentionTabIds={needsAttention}
      canReopen={closedTabs.length > 0}
      settingsOpen={settingsOpen}
      onSelect={handleSelectTab}
      onClose={handleCloseTab}
      onNew={handleNewTab}
      onReopen={() => void reopenTab()}
      onSettings={() => setSettingsOpen((open) => toggleSettings(open))}
      onColor={(tabId, color) => {
        void setTabColor(tabId, color).then(() => refreshTabs());
      }}
    />
  );

  const settingsPage = (
    <SettingsPage
      roles={roles}
      cli={cli}
      cliError={cliError}
      platform={platform}
      diagnostics={diagnostics}
      captureOn={captureOn}
      showDevTools={showDevTools}
      onToggleCapture={(enabled) => {
        void diagnosticsSetCapture(enabled).then((status) => {
          setDiagnostics(status);
          setCaptureOn(status.capturePermissionPayloads);
        });
      }}
      onClose={() => setSettingsOpen(false)}
    />
  );

  const overlays = (
    <>
      {paletteOpen && (
        <CommandPalette
          tabs={savedTabs.map((tab) => ({ id: tab.id, label: tab.label }))}
          canReopen={closedTabs.length > 0}
          splitOpen={split.mode !== "single"}
          onRun={runPalette}
          onClose={() => setPaletteOpen(false)}
        />
      )}
      {switcherOpen && (
        <TabSwitcher
          tabs={savedTabs}
          onSelect={(tabId) => {
            setSwitcherOpen(false);
            void handleSelectTab(tabId);
          }}
          onClose={() => setSwitcherOpen(false)}
        />
      )}
      {shortcutsOpen && (
        <ShortcutsOverlay platform={platform} onClose={() => setShortcutsOpen(false)} />
      )}
    </>
  );

  if (!role) {
    return (
      <section className="workspace-shell">
        {tabBar}
        {settingsOpen ? settingsPage : <p className="hint empty-state">Loading…</p>}
        {overlays}
      </section>
    );
  }

  const composerFields = (
    <div className="composer-fields">
      <div className="field-label">
        Working folder
        <FolderPicker
          value={folderForTab(values.cwd)}
          unavailable={
            !!activeTabSummary &&
            folderForTab(activeTabSummary.cwd) === folderForTab(values.cwd) &&
            activeTabSummary.folderStatus !== "ok" &&
            folderForTab(values.cwd).length > 0
          }
          disabled={!!session || busy}
          onChange={(path) => setField("cwd", path)}
        />
      </div>

      {surface !== "pick" && visibleFields(role, formValues).map((field) => (
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

      {surface !== "pick" && errors.length > 0 && (
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
          onClick={() => void startSession()}
          disabled={busy || !cliFound}
        >
          {canContinueSession && !resendStartup ? "Continue session" : "Start"}
        </button>
        {savedTranscript && (
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              setResendStartup(true);
              void startSession(true);
            }}
            disabled={busy || !cliFound}
          >
            Start new session
          </button>
        )}
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

  if (session && !settingsOpen) {
    const attachFirst =
      startResult?.injectionStrategy === "attach_to_first_message";
    return (
      <section className="workspace-shell">
        {tabBar}
        <section className="status-card status-card-session-full">
        <SessionCards
          cards={cardsByTab[activeTabId ?? ""] ?? emptySessionCards()}
          segments={streamSegments}
          planRequest={
            planRequest && planRequest.tabId === activeTabId ? planRequest : null
          }
          busy={busy}
          onAcceptPlan={() => {
            if (!activeTabId || !planRequest) return;
            void respondPlanRequest(activeTabId, planRequest.jsonRpcId, "accepted").then(
              () => setPlanRequest(null),
            );
          }}
          onRejectPlan={() => {
            if (!activeTabId || !planRequest) return;
            void respondPlanRequest(activeTabId, planRequest.jsonRpcId, "cancelled").then(
              () => setPlanRequest(null),
            );
          }}
        />
        <SplitPanes
          mode={split.mode}
          primary={
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
              inputRef={inputRef}
              history={scratch.history}
              historyCursor={historyCursor}
              onHistoryCursor={setHistoryCursor}
            />
          }
          secondary={
            split.secondaryTabId ? (
              <aside className="split-secondary" aria-label="Second tab">
                <p className="hint">
                  {savedTabs.find((tab) => tab.id === split.secondaryTabId)?.label ??
                    "Other tab"}
                </p>
                <pre className="mono-snippet">
                  {segmentsToPlainText(
                    runtimes[split.secondaryTabId]?.segments ?? [],
                  ) || "No live output in this tab yet."}
                </pre>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setSplit(closeSplit())}
                >
                  Close split
                </button>
              </aside>
            ) : null
          }
        />
        <ScratchPad
          ref={padRef}
          content={scratch.content}
          truncated={scratch.truncated}
          persistError={scratch.persistError}
          chain={chain}
          disabled={busy || !!permissionRequest}
          onChange={(value) => {
            if (activeTabId) scratch.setContent(activeTabId, value);
          }}
          onTransfer={transferPad}
          onSend={sendFromPad}
          onBlur={() => scratch.flush()}
          onStopChain={() => {
            chainAbortRef.current = true;
            setChain((current) => (current ? chainStop(current) : current));
            void cancelTurn();
          }}
        />
        {transcriptSaveError && (
          <p className="error scratch-pad-status">
            Could not save the transcript: {transcriptSaveError}
          </p>
        )}
        {lastPromptResult && !promptInFlight && (
          <p className="hint session-turn-hint">
            Last turn: {lastPromptResult.stopReason ?? "finished"}
          </p>
        )}
        {overlays}
        </section>
      </section>
    );
  }

  return (
    <section className="workspace-shell">
      {tabBar}
      {settingsOpen ? (
        settingsPage
      ) : (
        <div className="empty-state">
          <div className="empty-state-card">
            <div className="role-choices" role="group" aria-label="Role">
              {roles.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="role-choice"
                  aria-pressed={pickedRoleId === item.id}
                  onClick={() => chooseRole(item.id)}
                  disabled={busy}
                >
                  <span className="role-dot" style={{ background: item.color }} aria-hidden />
                  {item.name}
                </button>
              ))}
            </div>
            {composerFields}
            {surface !== "pick" && idleActions}
            {surface === "restore" && savedTranscript && (
              <details className="startup-form-details" open>
                <summary>Last session transcript (read-only)</summary>
                <pre className="mono-snippet transcript-saved">{savedTranscript}</pre>
              </details>
            )}
            {activeTabSummary &&
              folderStatusMessage(activeTabSummary.folderStatus, activeTabSummary.cwd) && (
                <p className="error">
                  {folderStatusMessage(activeTabSummary.folderStatus, activeTabSummary.cwd)}
                </p>
              )}
            {transcriptSaveError && (
              <p className="error">Could not save the transcript: {transcriptSaveError}</p>
            )}
            {!cliFound && <p className="error">Cursor CLI was not found.</p>}
          </div>
        </div>
      )}
      {overlays}
    </section>
  );
}
