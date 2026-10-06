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
  listCursorCliHistory,
  newDraftTab,
  roleSessionStart,
  saveFormDraft,
  selectActiveTab,
  syncActiveTabForm,
  getTerminalSettings,
  handoffBindTab,
  handoffGet,
  handoffList,
  handoffSave,
  ptyWrite,
  roleTerminalStart,
  scratchSave,
  setTerminalSettings,
  shellTerminalStart,
  terminalPlanFile,
  validateAndPreview,
  type ClosedTabSummary,
  type FieldError,
  type PlanRequestEvent,
  type CliDetectResult,
  type DiagnosticsStatus,
  type Role,
  type RoleSessionStartResult,
  type HandoffRecord,
  type RoleSummary,
  type SessionUpdateEvent,
  type TabSummary,
  type TerminalSettings,
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
  folderTabNotice,
  runtimeFor,
  type TabRuntime,
} from "./liveTabs";
import { CommandPalette } from "./components/CommandPalette";
import {
  HandoffActions,
  HandoffBanner,
  HandoffDialog,
  SavedPlanDialog,
} from "./components/HandoffDialog";
import { destroyTerminal, TerminalView, readTerminalHandoff } from "./components/TerminalView";
import {
  handoffBlockReason,
  latestAgentMessage,
  mapHandoff,
  selectionInside,
  type HandoffField,
  type HandoffScope,
  type HandoffSource,
  type HandoffSurface,
  type HandoffTargetId,
} from "./handoff/map";
import { FolderPicker } from "./components/FolderPicker";
import { SettingsPage } from "./components/SettingsPage";
import { folderForTab } from "./projectsView";
import {
  canContinueStoredSession,
  folderToWrite,
  mergeTabDraft,
  showStartupFields,
  tabFormFromRecord,
  tabSurface,
  toggleSettings,
  type TabDraft,
} from "./workspaceView";
import { ScratchPad } from "./components/ScratchPad";
import { SessionCards } from "./components/SessionCards";
import { ShortcutsOverlay } from "./components/ShortcutsOverlay";
import { SplitPanes } from "./components/SplitPanes";
import { TabSwitcher } from "./components/TabSwitcher";
import { detectPlatform, type ShortcutMatch, type TerminalAction } from "./keymap";
import { beginLivePty, dropLivePty, livePty, rekeyLivePty } from "./terminal/live";
import {
  copyTerminalSelection,
  focusedTerminalId,
  pasteTerminalText,
  requestTerminalSearch,
} from "./terminal/park";
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
import { answersForRole, fieldsForForm } from "./startupFields";
import { CursorHistoryList } from "./components/CursorHistoryList";
import {
  resumeIdForStart,
  segmentsAfterResume,
  segmentsWhileStarting,
  type CursorHistoryEntry,
} from "./cursorHistory";
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
  return fieldsForForm(role).filter((field) => fieldVisible(role, field.key, values));
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
  const savedTabsRef = useRef(savedTabs);
  savedTabsRef.current = savedTabs;
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
  const [handoffs, setHandoffs] = useState<HandoffRecord[]>([]);
  const [handoffTarget, setHandoffTarget] = useState<HandoffTargetId | null>(null);
  const [handoffFields, setHandoffFields] = useState<HandoffField[] | null>(null);
  const [handoffSelection, setHandoffSelection] = useState("");
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const [savedPlan, setSavedPlan] = useState<HandoffRecord | null>(null);
  const [savedPlanLoading, setSavedPlanLoading] = useState(false);
  const [pickedRoleId, setPickedRoleId] = useState<string | null>(null);
  const [launchChoice, setLaunchChoice] = useState<"shell" | "cursor-cli" | null>(null);
  const [terminalSettings, setTerminalSettingsState] = useState<TerminalSettings | null>(null);
  const [terminalError, setTerminalError] = useState<string | null>(null);
  const [terminalCapture, setTerminalCapture] = useState<{
    selection: string;
    tail: string;
    planFileText: string;
    planFileName: string;
  } | null>(null);
  const [paneByTab, setPaneByTab] = useState<Record<string, { open: boolean; beside: boolean }>>(
    {},
  );
  const [newSessionOpen, setNewSessionOpenState] = useState(false);
  const [transcriptSaveError, setTranscriptSaveError] = useState<string | null>(null);
  const [historyEntries, setHistoryEntries] = useState<CursorHistoryEntry[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [cliLaunchNote, setCliLaunchNote] = useState<string | null>(null);
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
  const valuesRef = useRef(values);
  valuesRef.current = values;
  const pickedRoleRef = useRef(pickedRoleId);
  pickedRoleRef.current = pickedRoleId;
  const transcriptRef = useRef(savedTranscript);
  transcriptRef.current = savedTranscript;
  const newSessionOpenRef = useRef(newSessionOpen);
  newSessionOpenRef.current = newSessionOpen;
  const resendRef = useRef(resendStartup);
  resendRef.current = resendStartup;
  const draftsRef = useRef<Record<string, TabDraft>>({});
  const knownFoldersRef = useRef<Record<string, string>>({});
  const previewsRef = useRef<Record<string, ValidatePreviewResult | null>>({});
  const scrollPositions = useRef<Record<string, number>>({});
  const emptyStateRef = useRef<HTMLDivElement | null>(null);
  const ignoreScrollRef = useRef(false);
  const recallTokenRef = useRef(0);
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
  const dialogOpen =
    paletteOpen || switcherOpen || shortcutsOpen || settingsOpen || handoffTarget !== null || savedPlan !== null;
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

  const captureDraft = useCallback((): TabDraft => {
    return {
      roleId: roleIdRef.current,
      pickedRoleId: pickedRoleRef.current,
      values: { ...valuesRef.current },
      transcript: transcriptRef.current,
      newSessionOpen: newSessionOpenRef.current,
      resendStartup: resendRef.current,
    };
  }, []);

  const applyDraft = useCallback((tabId: string, draft: TabDraft) => {
    if (draft.roleId !== roleIdRef.current) skipRecallRef.current = true;
    recallTokenRef.current += 1;
    hydratedRef.current = true;
    const cwd = folderForTab(draft.values.cwd);
    if (cwd) knownFoldersRef.current[tabId] = cwd;
    const stored = { ...draft, values: { ...draft.values, cwd } };
    draftsRef.current[tabId] = stored;
    setRoleId(stored.roleId);
    setPickedRoleId(stored.pickedRoleId);
    setValues(stored.values);
    setSavedTranscript(stored.transcript);
    setNewSessionOpenState(stored.newSessionOpen);
    setResendStartup(stored.resendStartup);
    setActiveTabId(tabId);
    setPreview(previewsRef.current[tabId] ?? null);
  }, []);

  const stashActiveTab = useCallback(() => {
    const leaving = activeTabIdRef.current;
    if (!leaving || !hydratedRef.current) return;
    const snap = captureDraft();
    draftsRef.current[leaving] = snap;
    if (emptyStateRef.current) {
      scrollPositions.current[leaving] = emptyStateRef.current.scrollTop;
    }
    if (draftTimerRef.current) {
      clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
    const cwd = folderToWrite(knownFoldersRef.current[leaving] ?? "", snap.values.cwd ?? "");
    if (cwd) knownFoldersRef.current[leaving] = cwd;
    // A role switch can still be loading its schema. Skip the write then so
    // another role's keys are not saved under this tab.
    if (!role || role.id !== snap.roleId) return;
    const payload = answersForRole({ ...snap.values, cwd }, fieldsForForm(role));
    void syncActiveTabForm(leaving, snap.roleId, cwd, payload).catch(() => {});
    if (cwd) void saveFormDraft(snap.roleId, cwd, payload).catch(() => {});
  }, [captureDraft, role]);

  const loadTabIntoForm = useCallback((tab: {
    roleId: string;
    cwd: string;
    answers: Record<string, string>;
    id: string;
    transcript?: string | null;
  }) => {
    const incoming = tabFormFromRecord(tab);
    applyDraft(tab.id, mergeTabDraft(draftsRef.current[tab.id], incoming));
  }, [applyDraft]);

  const refreshTabs = useCallback(async () => {
    const snap = await getAppState();
    setSavedTabs(snap.tabs);
    setClosedTabs(snap.closedTabs ?? []);
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
        if (summary.kind === "terminal" || summary.phase === "running") {
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
    if (roleId === "terminal" || roleId === "cursor-cli") return;
    if (!roles.some((r) => r.id === roleId) && roles.length > 0) {
      setRoleId(roles[0].id);
    }
  }, [roles, roleId]);

  useEffect(() => {
    getTerminalSettings()
      .then(setTerminalSettingsState)
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    getRole(roleId)
      .then((r) => {
        if (!cancelled) {
          setRole(r);
          setValues((prev) => {
            const next = answersForRole(prev, fieldsForForm(r));
            const same =
              Object.keys(prev).length === Object.keys(next).length &&
              Object.keys(next).every((key) => next[key] === prev[key]);
            return same ? prev : next;
          });
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
    const tabId = activeTabIdRef.current;
    const draft = tabId ? draftsRef.current[tabId] : null;
    if (draft && (folderForTab(draft.values.cwd) || draft.transcript.trim())) return;
    const token = ++recallTokenRef.current;
    getFormRecall(roleId)
      .then((recall) => {
        if (token !== recallTokenRef.current) return;
        if (activeTabIdRef.current !== tabId) return;
        setValues((prev) => {
          const cwd = folderForTab(prev.cwd) || folderForTab(recall.cwd);
          const next = { ...recall.values, cwd };
          if (tabId) {
            const current = draftsRef.current[tabId];
            if (current) draftsRef.current[tabId] = { ...current, values: next };
            if (cwd) knownFoldersRef.current[tabId] = cwd;
          }
          return next;
        });
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

  useEffect(() => {
    if (!activeTabId || !activeTabSummary || session) return;
    const saved = folderForTab(activeTabSummary.cwd);
    if (!saved) return;
    if (!knownFoldersRef.current[activeTabId]) knownFoldersRef.current[activeTabId] = saved;
    if (!folderForTab(valuesRef.current.cwd)) {
      setValues((prev) => (folderForTab(prev.cwd) ? prev : { ...prev, cwd: saved }));
    }
  }, [activeTabId, activeTabSummary, session]);

  const canContinueSession = useMemo(
    () => canContinueStoredSession(activeTabSummary),
    [activeTabSummary],
  );

  const historyFolder = folderForTab(values.cwd);
  useEffect(() => {
    if (session || !historyFolder) {
      setHistoryEntries([]);
      setHistoryError(null);
      return;
    }
    let cancelled = false;
    listCursorCliHistory(historyFolder)
      .then((rows) => {
        if (!cancelled) {
          setHistoryEntries(rows);
          setHistoryError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setHistoryError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [historyFolder, session]);

  useEffect(() => {
    // Wait until the loaded schema matches the tab. Saving earlier would
    // write the previous role's answers (for example taskType) onto this role.
    if (!hydratedRef.current || session || !role || role.id !== roleId || !activeTabId) return;
    const visible = savedTabsRef.current.find((tab) => tab.id === activeTabId);
    if (visible?.kind === "terminal") return;
    const tabId = activeTabId;
    const cwd = folderToWrite(knownFoldersRef.current[tabId] ?? "", formValues.cwd ?? "");
    if (cwd) knownFoldersRef.current[tabId] = cwd;
    const draft: TabDraft = {
      roleId,
      pickedRoleId,
      values: { ...formValues, cwd },
      transcript: savedTranscript,
      newSessionOpen,
      resendStartup,
    };
    draftsRef.current[tabId] = draft;
    if (cwd && !folderForTab(formValues.cwd)) {
      setValues((prev) => (folderForTab(prev.cwd) ? prev : { ...prev, cwd }));
    }
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(() => {
      if (activeTabIdRef.current !== tabId) return;
      const writeCwd = folderToWrite(
        knownFoldersRef.current[tabId] ?? "",
        draftsRef.current[tabId]?.values.cwd ?? "",
      );
      const payload = answersForRole(
        { ...(draftsRef.current[tabId]?.values ?? formValues), cwd: writeCwd },
        fieldsForForm(role),
      );
      // A failed draft save must not skip the tab update, and a non-promise
      // result must not throw out of this timer.
      if (writeCwd) {
        void Promise.resolve(saveFormDraft(roleId, writeCwd, payload)).catch(() => {});
      }
      void Promise.resolve(syncActiveTabForm(tabId, roleId, writeCwd, payload))
        .then(() => {
          if (activeTabIdRef.current === tabId) void refreshTabs();
        })
        .catch(() => {});
    }, 800);
    return () => {
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    };
  }, [
    formValues,
    roleId,
    pickedRoleId,
    savedTranscript,
    newSessionOpen,
    resendStartup,
    session,
    role,
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
    loadedViaSessionLoad: false,
    replayMessageCount: 0,
    replayTruncated: false,
    replay: [],
  });

  const startSession = useCallback(async (
    forceResend = false,
    resume?: {
      sessionId?: string;
      tabId?: string;
      cwd?: string;
      /** Continue button: load the id stored on this tab. Start new session does not. */
      resumeStored?: boolean;
    },
  ) => {
    if (startLockRef.current) return;
    startLockRef.current = true;
    setBusy(true);
    const tabKey = resume?.tabId ?? activeTabId;
    const resend = forceResend;
    const resumeId = resumeIdForStart({
      explicitSessionId: resume?.sessionId,
      storedSessionId: activeTabSummary?.acpSessionId,
      resumeStored: resume?.resumeStored,
      forceResend: resend,
    });
    const continuing = !!resumeId;
    const startValues = resume?.cwd
      ? { ...formValues, cwd: resume.cwd }
      : formValues;
    if (tabKey) {
      patchRuntime(tabKey, (rt) => ({
        ...rt,
        accepting: true,
        promptError: null,
        agentExited: false,
        startResult: null,
        lastResult: null,
        segments: segmentsWhileStarting({
          continuing,
          sessionId: resumeId,
          savedTranscript,
          existing: rt.segments,
        }),
      }));
    }
    try {
      const result = await roleSessionStart(
        roleId,
        startValues,
        tabKey,
        resend,
        resumeId,
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
        let segments = segmentsAfterResume({
          segments: rt.segments,
          loaded: result.loadedViaSessionLoad,
          replay: result.replay ?? [],
          replayMessageCount: result.replayMessageCount ?? 0,
          savedTranscript,
          folderWarning: result.folderWarning,
        });
        if (result.injectionInFlight && !continuing) {
          const startupText = preview?.merged?.text?.trim();
          segments = startupText
            ? appendStreamSegment(segments, streamSegmentFromUserMessage(startupText))
            : [
                ...segments,
                streamSegmentFromSystemMessage("Startup prompt sent to agent."),
              ];
        }
        if (result.replayTruncated) {
          segments = appendStreamSegment(
            segments,
            streamSegmentFromSystemMessage(
              "The CLI replayed more history than this tab kept. You are still in the same session.",
            ),
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
    activeTabSummary,
    preview,
    patchRuntime,
    savedTranscript,
  ]);

  const updateTerminalSettings = useCallback((next: TerminalSettings) => {
    setTerminalSettingsState(next);
    setTerminalSettings(next)
      .then(setTerminalSettingsState)
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        setTerminalError(message);
      });
  }, []);

  const rememberedSurface = useCallback(
    (id: string): HandoffSurface =>
      terminalSettings?.roleSurface[id] === "terminal" ? "terminal" : "chat",
    [terminalSettings],
  );

  const rememberSurface = useCallback(
    (id: string, surface: HandoffSurface) => {
      const current = terminalSettings ?? {
        shell: "",
        fontSize: 14,
        roleSurface: {},
        roleRunMode: {},
      };
      updateTerminalSettings({
        ...current,
        roleSurface: { ...current.roleSurface, [id]: surface },
      });
    },
    [terminalSettings, updateTerminalSettings],
  );

  const startRoleTerminal = useCallback(
    async (options?: {
      roleId: string;
      values: Record<string, string>;
      tabId?: string | null;
      handoffPlan?: string | null;
    }) => {
      if (startLockRef.current) return null;
      startLockRef.current = true;
      setBusy(true);
      setTerminalError(null);
      const roleToStart = options?.roleId ?? roleId;
      const form = options?.values ?? formValues;
      const preferred = options && "tabId" in options ? options.tabId : activeTabId;
      const pendingId = preferred || `starting-${Date.now()}`;
      const live = beginLivePty(pendingId);
      try {
        const result = await roleTerminalStart({
          roleId: roleToStart,
          values: form,
          tabId: preferred,
          handoffPlan: options?.handoffPlan ?? null,
          cols: 80,
          rows: 24,
          onOutput: live.channel,
        });
        if (result.errors.length > 0 || !result.tabId) {
          dropLivePty(pendingId);
          setPreview({
            errors:
              result.errors.length > 0
                ? result.errors
                : [{ key: "_session", message: "Terminal did not start" }],
            merged: null,
          });
          return null;
        }
        if (result.tabId !== pendingId) rekeyLivePty(pendingId, result.tabId);
        setActiveTabId(result.tabId);
        setPreview(null);
        await refreshTabs();
        return result.tabId;
      } catch (err: unknown) {
        dropLivePty(pendingId);
        const message = err instanceof Error ? err.message : String(err);
        setTerminalError(message);
        return null;
      } finally {
        startLockRef.current = false;
        setBusy(false);
      }
    },
    [activeTabId, formValues, refreshTabs, roleId],
  );

  const startBlankTerminal = useCallback(
    async (launch: "shell" | "cursor-cli") => {
      if (startLockRef.current) return;
      const cwd = folderForTab(values.cwd);
      if (!cwd) {
        setTerminalError("Choose a working folder first.");
        return;
      }
      startLockRef.current = true;
      setBusy(true);
      setTerminalError(null);
      const pendingId = activeTabId || `starting-${Date.now()}`;
      const live = beginLivePty(pendingId);
      try {
        const result = await shellTerminalStart({
          tabId: activeTabId,
          cwd,
          launch,
          cols: 80,
          rows: 24,
          onOutput: live.channel,
        });
        if (result.errors.length > 0 || !result.tabId) {
          dropLivePty(pendingId);
          setPreview({
            errors:
              result.errors.length > 0
                ? result.errors
                : [{ key: "cwd", message: "Terminal did not start" }],
            merged: null,
          });
          return;
        }
        if (result.tabId !== pendingId) rekeyLivePty(pendingId, result.tabId);
        setLaunchChoice(null);
        setActiveTabId(result.tabId);
        await refreshTabs();
      } catch (err: unknown) {
        dropLivePty(pendingId);
        const message = err instanceof Error ? err.message : String(err);
        setTerminalError(message);
      } finally {
        startLockRef.current = false;
        setBusy(false);
      }
    },
    [activeTabId, refreshTabs, values.cwd],
  );

  const openCursorCli = useCallback(async (sessionId: string, cwd: string) => {
    if (startLockRef.current) return;
    setCliLaunchNote(null);
    setTerminalError(null);
    startLockRef.current = true;
    setBusy(true);
    const pendingId = `starting-${Date.now()}`;
    const live = beginLivePty(pendingId);
    try {
      const result = await shellTerminalStart({
        tabId: null,
        cwd,
        launch: "cursor-cli",
        resumeSessionId: sessionId,
        cols: 80,
        rows: 24,
        onOutput: live.channel,
      });
      if (result.errors.length > 0 || !result.tabId) {
        dropLivePty(pendingId);
        const message = result.errors[0]?.message ?? "The terminal did not start.";
        setCliLaunchNote(message);
        return;
      }
      if (result.tabId !== pendingId) rekeyLivePty(pendingId, result.tabId);
      setActiveTabId(result.tabId);
      setCliLaunchNote("Opened this chat in a terminal tab.");
      await refreshTabs();
    } catch (err: unknown) {
      dropLivePty(pendingId);
      setCliLaunchNote(err instanceof Error ? err.message : String(err));
    } finally {
      startLockRef.current = false;
      setBusy(false);
    }
  }, [refreshTabs]);

  const resumeHistoryEntry = useCallback(
    async (entry: CursorHistoryEntry) => {
      if (startLockRef.current) return;
      setBusy(true);
      try {
        const { tab } = await newDraftTab(roleId, entry.cwd);
        activeTabIdRef.current = tab.id;
        setActiveTabId(tab.id);
        setValues((prev) => ({ ...prev, cwd: entry.cwd }));
        await startSession(false, {
          sessionId: entry.id,
          tabId: tab.id,
          cwd: entry.cwd,
        });
      } catch (err: unknown) {
        setHistoryError(err instanceof Error ? err.message : String(err));
        setBusy(false);
      }
    },
    [roleId, startSession],
  );

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
      if (tabId === activeTabIdRef.current) return;
      stashActiveTab();
      const summary = savedTabs.find((tab) => tab.id === tabId);
      if (summary?.kind === "terminal") {
        setActiveTabId(tabId);
        setBusy(true);
        try {
          await selectActiveTab(tabId);
          await refreshTabs();
        } finally {
          setBusy(false);
        }
        return;
      }
      const cached = draftsRef.current[tabId];
      if (cached) applyDraft(tabId, cached);
      setBusy(true);
      try {
        const { tab } = await selectActiveTab(tabId);
        if (tab.kind === "terminal") {
          setActiveTabId(tab.id);
          await refreshTabs();
          return;
        }
        loadTabIntoForm(tab);
        await refreshTabs();
      } finally {
        setBusy(false);
      }
    },
    [applyDraft, loadTabIntoForm, refreshTabs, savedTabs, stashActiveTab],
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
        if (tabId === activeTabIdRef.current) stashActiveTab();
        delete draftsRef.current[tabId];
        delete knownFoldersRef.current[tabId];
        delete scrollPositions.current[tabId];
        dropLivePty(tabId);
        destroyTerminal(tabId);
        const snap = await closeTab(tabId);
        setRuntimes((prev) => {
          const next = { ...prev };
          delete next[tabId];
          return next;
        });
        setSavedTabs(snap.tabs);
        setClosedTabs(snap.closedTabs ?? []);
        const next = snap.tabs.find((tab) => tab.id === snap.activeTabId);
        if (next?.kind === "terminal") {
          setActiveTabId(next.id);
        } else if (snap.activeTabId && snap.activeTabId !== tabId) {
          const { tab } = await selectActiveTab(snap.activeTabId);
          if (tab.kind === "terminal") setActiveTabId(tab.id);
          else loadTabIntoForm(tab);
        } else if (!snap.activeTabId) {
          const recall = await getFormRecall(roleId);
          setValues({ ...recall.values, cwd: folderForTab(recall.cwd) });
          setSavedTranscript("");
          setPickedRoleId(null);
          setActiveTabId(null);
        }
      } finally {
        setBusy(false);
      }
    },
    [roleId, loadTabIntoForm, runtimes, values.cwd, scratch, stashActiveTab],
  );

  const handleNewTab = useCallback(async () => {
    setBusy(true);
    try {
      stashActiveTab();
      const seed = roles.some((item) => item.id === roleId)
        ? roleId
        : (roles[0]?.id ?? "role_implementer");
      await newDraftTab(seed, "");
      const snap = await getAppState();
      setSavedTabs(snap.tabs);
      setClosedTabs(snap.closedTabs ?? []);
      const newActive = snap.activeTabId;
      if (!newActive) return;
      const { tab } = await getTab(newActive);
      applyDraft(tab.id, {
        roleId: tab.roleId,
        pickedRoleId: null,
        values: { cwd: "" },
        transcript: "",
        newSessionOpen: false,
        resendStartup: false,
      });
    } finally {
      setBusy(false);
    }
  }, [applyDraft, roleId, roles, stashActiveTab]);

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
      stashActiveTab();
      const { tab } = await reopenClosedTab();
      await refreshTabs();
      loadTabIntoForm(tab);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setPreview({ errors: [{ key: "_session", message }], merged: null });
    } finally {
      setBusy(false);
    }
  }, [loadTabIntoForm, refreshTabs, stashActiveTab]);

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

  const togglePane = useCallback(() => {
    const tabId = activeTabIdRef.current;
    if (!tabId) return;
    const summary = savedTabs.find((tab) => tab.id === tabId);
    if (summary?.kind === "terminal") return;
    setPaneByTab((prev) => {
      const current = prev[tabId] ?? { open: false, beside: false };
      return { ...prev, [tabId]: { ...current, open: !current.open } };
    });
  }, [savedTabs]);

  const transferToTerminalNow = useCallback(async () => {
    const tabId = activeTabIdRef.current;
    if (!tabId) return;
    const summary = savedTabs.find((tab) => tab.id === tabId);
    const target = summary?.kind === "terminal" ? tabId : `${tabId}::pane`;
    if (summary?.kind !== "terminal") {
      setPaneByTab((prev) => ({
        ...prev,
        [tabId]: { open: true, beside: prev[tabId]?.beside ?? false },
      }));
    }
    const field = padRef.current;
    let text = scratch.content;
    if (field && field.selectionStart !== field.selectionEnd) {
      text = field.value.slice(field.selectionStart, field.selectionEnd);
    }
    const payload = text.endsWith("\n") ? text : `${text}\n`;
    if (!payload.trim()) return;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await ptyWrite(target, payload);
        setTerminalError(null);
        return;
      } catch {
        await new Promise((resolve) => window.setTimeout(resolve, 50));
      }
    }
    setTerminalError("The terminal is not ready for input yet.");
  }, [savedTabs, scratch.content]);

  const onTerminalAction = useCallback(
    (action: TerminalAction) => {
      if (action === "togglePane") togglePane();
      else if (action === "transferToTerminal") void transferToTerminalNow();
      else if (action === "search") requestTerminalSearch();
      else if (action === "copy") {
        const id = focusedTerminalId();
        if (id) void copyTerminalSelection(id);
      } else if (action === "paste") {
        const id = focusedTerminalId();
        if (id) void pasteTerminalText(id);
      }
    },
    [togglePane, transferToTerminalNow],
  );

  const getSurface = useCallback(() => {
    const el = document.activeElement;
    if (el?.closest(".terminal-slot, .xterm")) return "terminal" as const;
    return "chat" as const;
  }, []);

  useAppShortcuts({
    platform,
    dialogOpen,
    promptInFlight: !!promptInFlight,
    getSurface,
    onAction: onShortcut,
    onTerminal: onTerminalAction,
    onCancelTurn: () => {
      void cancelTurn();
    },
  });

  useEffect(() => {
    handoffList()
      .then(setHandoffs)
      .catch(() => {});
  }, []);

  useEffect(() => {
    diagnosticsStatus()
      .then((status) => {
        setDiagnostics(status);
        setCaptureOn(status.capturePermissionPayloads);
      })
      .catch(() => {});
  }, []);

  const loadHandoffFields = useCallback((target: HandoffTargetId) => {
    setHandoffFields(null);
    getRole(target)
      .then((loaded) => {
        setHandoffFields(
          loaded.fields.map((field) => ({ key: field.key, options: field.options })),
        );
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        setHandoffError(message);
      });
  }, []);

  const isPlannerTerminal =
    activeTabSummary?.kind === "terminal" &&
    activeTabSummary.terminalLaunch === "role" &&
    activeTabSummary.roleId === "role_planner";

  const openTerminalHandoff = useCallback(
    async (target: HandoffTargetId) => {
      const tabId = activeTabIdRef.current;
      if (!tabId) return;
      const captured = readTerminalHandoff(tabId);
      const started = livePty(tabId)?.startedAt ?? Date.now();
      let planFileText = "";
      let planFileName = "";
      try {
        const file = await terminalPlanFile(started);
        if (file?.text.trim()) {
          planFileText = file.text;
          planFileName = file.name;
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        setHandoffError(message);
      }
      setTerminalCapture({
        selection: captured.selection,
        tail: captured.tail,
        planFileText,
        planFileName,
      });
      setHandoffSelection(captured.selection);
      setHandoffTarget(target);
      loadHandoffFields(target);
    },
    [loadHandoffFields],
  );

  const openHandoffDialog = useCallback(
    (target: HandoffTargetId) => {
      const summary = savedTabs.find((tab) => tab.id === activeTabIdRef.current);
      const fromTerminal =
        summary?.kind === "terminal" &&
        summary.terminalLaunch === "role" &&
        summary.roleId === "role_planner";
      if (fromTerminal) {
        void openTerminalHandoff(target);
        return;
      }
      setTerminalCapture(null);
      const screen = document.querySelector("[data-session-screen]");
      setHandoffSelection(selectionInside(screen instanceof HTMLElement ? screen : null));
      setHandoffError(null);
      setHandoffTarget(target);
      loadHandoffFields(target);
    },
    [loadHandoffFields, openTerminalHandoff, savedTabs],
  );

  const handoffSource = useMemo((): HandoffSource => {
    if (terminalCapture && isPlannerTerminal) {
      return {
        sourceRoleId: "role_planner",
        sourceTabId: activeTabId ?? "",
        sourceLabel: activeTabSummary?.label ?? "Planner",
        cwd: activeTabSummary?.cwd || values.cwd || "",
        answers: values,
        latestMessage: "",
        plan: [],
        todos: [],
        selection: terminalCapture.selection,
        turnInFlight: false,
        fromTerminal: true,
        planFileText: terminalCapture.planFileText,
        planFileName: terminalCapture.planFileName,
        terminalTail: terminalCapture.tail,
      };
    }
    const cards = cardsByTab[activeTabId ?? ""] ?? emptySessionCards();
    return {
      sourceRoleId: roleId,
      sourceTabId: activeTabId ?? "",
      sourceLabel: savedTabs.find((tab) => tab.id === activeTabId)?.label ?? "Planner",
      cwd: session?.cwd || values.cwd || "",
      answers: values,
      latestMessage: latestAgentMessage(streamSegments),
      plan: cards.plan,
      todos: cards.todos,
      selection: handoffSelection,
      turnInFlight: !!promptInFlight,
    };
  }, [
    activeTabId,
    activeTabSummary,
    cardsByTab,
    handoffSelection,
    isPlannerTerminal,
    promptInFlight,
    roleId,
    savedTabs,
    session?.cwd,
    streamSegments,
    terminalCapture,
    values,
  ]);

  const handoffOffer =
    roleId === "role_planner" && session
      ? {
          enabled: handoffBlockReason({ ...handoffSource, selection: "" }) === null,
          reason: handoffBlockReason({ ...handoffSource, selection: "" }),
          onSend: openHandoffDialog,
        }
      : null;

  const confirmHandoff = useCallback(
    async (scope: HandoffScope, surface: HandoffSurface) => {
      if (!handoffTarget || !handoffSource.sourceTabId) return;
      const mapped = mapHandoff(handoffSource, scope, {
        roleId: handoffTarget,
        fields: handoffFields ?? [],
      });
      if (!mapped.planText) {
        setHandoffError(mapped.warning ?? "That choice has no content.");
        return;
      }
      setBusy(true);
      setHandoffError(null);
      try {
        const saved = await handoffSave({
          sourceTabId: handoffSource.sourceTabId,
          sourceRoleId: handoffSource.sourceRoleId,
          sourceLabel: handoffSource.sourceLabel,
          targetRoleId: handoffTarget,
          title: mapped.title,
          cwd: handoffSource.cwd,
          scope,
          planText: mapped.planText,
          truncated: mapped.truncated,
          warning: mapped.warning,
          planField: mapped.planField,
        });
        const nextValues = { ...mapped.answers, cwd: handoffSource.cwd };
        if (surface === "terminal") {
          stashActiveTab();
          const tabId = await startRoleTerminal({
            roleId: handoffTarget,
            values: nextValues,
            tabId: null,
            handoffPlan: mapped.planText,
          });
          if (!tabId) {
            setHandoffError("Terminal did not start.");
            return;
          }
          const bound = await handoffBindTab(saved.id, tabId);
          if (mapped.usesScratchPad) {
            scratch.setContent(tabId, mapped.inlinePlan);
            await scratchSave(tabId, mapped.inlinePlan, []);
          }
          setHandoffs((prev) => [bound, ...prev.filter((item) => item.id !== bound.id)]);
          setTerminalCapture(null);
          setHandoffTarget(null);
          return;
        }
        stashActiveTab();
        const { tab } = await newDraftTab(handoffTarget, handoffSource.cwd);
        await syncActiveTabForm(tab.id, handoffTarget, handoffSource.cwd, nextValues);
        const bound = await handoffBindTab(saved.id, tab.id);
        if (mapped.usesScratchPad) {
          scratch.setContent(tab.id, mapped.inlinePlan);
          await scratchSave(tab.id, mapped.inlinePlan, []);
        }
        applyDraft(tab.id, {
          roleId: handoffTarget,
          pickedRoleId: handoffTarget,
          values: nextValues,
          transcript: "",
          newSessionOpen: false,
          resendStartup: false,
        });
        setHandoffs((prev) => [bound, ...prev.filter((item) => item.id !== bound.id)]);
        setTerminalCapture(null);
        setHandoffTarget(null);
        await refreshTabs();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        setHandoffError(message);
      } finally {
        setBusy(false);
      }
    },
    [
      applyDraft,
      handoffFields,
      handoffSource,
      handoffTarget,
      refreshTabs,
      scratch,
      startRoleTerminal,
      stashActiveTab,
    ],
  );

  const openSavedHandoff = useCallback((record: HandoffRecord) => {
    if (savedTabs.some((tab) => tab.id === record.sourceTabId)) {
      void handleSelectTab(record.sourceTabId);
      return;
    }
    setSavedPlan(record);
    setSavedPlanLoading(true);
    setHandoffError(null);
    handoffGet(record.id)
      .then((full) => setSavedPlan(full))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        setHandoffError(message);
      })
      .finally(() => setSavedPlanLoading(false));
  }, [handleSelectTab, savedTabs]);

  const runPalette = (id: string) => {
    setPaletteOpen(false);
    if (id === "sendPlanImplementer") {
      openHandoffDialog("role_implementer");
      return;
    }
    if (id === "sendPlanDeveloper") {
      openHandoffDialog("role_developer");
      return;
    }
    if (id === "toggleTerminal") {
      togglePane();
      return;
    }
    if (id === "transferToTerminal") {
      void transferToTerminalNow();
      return;
    }
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
    setValues((prev) => {
      const next = { ...prev, [key]: value };
      const tabId = activeTabIdRef.current;
      if (tabId) {
        const current = draftsRef.current[tabId] ?? captureDraft();
        draftsRef.current[tabId] = { ...current, values: next };
        if (key === "cwd" && folderForTab(value)) knownFoldersRef.current[tabId] = folderForTab(value);
      }
      return next;
    });
    setPreview(null);
    const tabId = activeTabIdRef.current;
    if (tabId) previewsRef.current[tabId] = null;
  };

  const openNewSessionForm = () => {
    setNewSessionOpenState(true);
    setResendStartup(true);
    const tabId = activeTabIdRef.current;
    if (!tabId) return;
    const current = draftsRef.current[tabId] ?? captureDraft();
    draftsRef.current[tabId] = { ...current, newSessionOpen: true, resendStartup: true };
  };

  useEffect(() => {
    const el = emptyStateRef.current;
    if (!el || !activeTabId || session || settingsOpen) return;
    ignoreScrollRef.current = true;
    el.scrollTop = scrollPositions.current[activeTabId] ?? 0;
    const timer = window.setTimeout(() => {
      ignoreScrollRef.current = false;
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activeTabId, session, settingsOpen]);

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
    setLaunchChoice(null);
    const tabId = activeTabIdRef.current;
    const existing = tabId ? draftsRef.current[tabId] : null;
    const keepSaved =
      !!existing &&
      (folderForTab(existing.values.cwd).length > 0 || existing.transcript.trim().length > 0);
    skipRecallRef.current = keepSaved;
    pickedRoleRef.current = id;
    setPickedRoleId(id);
    setRoleId(id);
    if (tabId) {
      draftsRef.current[tabId] = {
        ...(existing ?? captureDraft()),
        roleId: id,
        pickedRoleId: id,
      };
    }
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
      terminalSettings={terminalSettings}
      onTerminalSettings={updateTerminalSettings}
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
          canSendPlan={(roleId === "role_planner" && !!session) || !!isPlannerTerminal}
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
      {handoffTarget && (
        <HandoffDialog
          source={handoffSource}
          targetRoleId={handoffTarget}
          targetFields={handoffFields}
          folderWarning={folderStatusMessage(
            savedTabs.find((tab) => tab.id === activeTabId)?.folderStatus ?? "",
            handoffSource.cwd,
          )}
          busy={busy}
          error={handoffError}
          preferredSurface={rememberedSurface(handoffTarget)}
          onTarget={(target) => {
            setHandoffTarget(target);
            setHandoffError(null);
            loadHandoffFields(target);
          }}
          onConfirm={(scope, surface) => {
            void confirmHandoff(scope, surface);
          }}
          onClose={() => {
            if (!busy) {
              setHandoffTarget(null);
              setTerminalCapture(null);
            }
          }}
        />
      )}
      {savedPlan && (
        <SavedPlanDialog
          title={savedPlan.title}
          cwd={savedPlan.cwd}
          createdAt={savedPlan.createdAt}
          planText={savedPlan.planText}
          loading={savedPlanLoading}
          error={handoffError}
          onClose={() => setSavedPlan(null)}
        />
      )}
    </>
  );

  const fontSize = terminalSettings?.fontSize ?? 14;
  if (activeTabSummary?.kind === "terminal" && !settingsOpen) {
    const linked = handoffs.find((item) => item.targetTabId === activeTabId) ?? null;
    const launch =
      activeTabSummary.terminalLaunch === "cursor-cli"
        ? "cursor-cli"
        : activeTabSummary.terminalLaunch === "role"
          ? "role"
          : "shell";
    return (
      <section className="workspace-shell">
        {tabBar}
        <section className="status-card status-card-session-full terminal-screen">
          {linked && (
            <HandoffBanner
              sourceRoleId={linked.sourceRoleId}
              title={linked.title}
              warning={linked.warning}
              onOpen={() => openSavedHandoff(linked)}
            />
          )}
          {terminalError && <p className="error">{terminalError}</p>}
          {isPlannerTerminal && (
            <div className="terminal-toolbar">
              <HandoffActions
                enabled
                reason={null}
                busy={busy}
                onSend={(target) => {
                  void openTerminalHandoff(target);
                }}
              />
            </div>
          )}
          <TerminalView
            ptyId={activeTabSummary.id}
            cwd={activeTabSummary.cwd}
            launch={launch}
            roleId={activeTabSummary.roleId}
            fontSize={fontSize}
            resumeSessionId={activeTabSummary.resumeSessionId}
            autoOpen={!livePty(activeTabSummary.id)}
            menuActions={
              isPlannerTerminal
                ? [
                    {
                      id: "send-implementer",
                      label: "Send to Implementer",
                      onSelect: () => {
                        void openTerminalHandoff("role_implementer");
                      },
                    },
                    {
                      id: "send-developer",
                      label: "Send to Developer",
                      onSelect: () => {
                        void openTerminalHandoff("role_developer");
                      },
                    },
                  ]
                : []
            }
          />
        </section>
        {overlays}
      </section>
    );
  }

  if (!role) {
    return (
      <section className="workspace-shell">
        {tabBar}
        {settingsOpen ? settingsPage : <p className="hint empty-state">Loading…</p>}
        {overlays}
      </section>
    );
  }

  const activeHandoff = handoffs.find((item) => item.targetTabId === activeTabId) ?? null;
  const handoffBanner = activeHandoff ? (
    <HandoffBanner
      sourceRoleId={activeHandoff.sourceRoleId}
      title={activeHandoff.title}
      warning={activeHandoff.warning}
      onOpen={() => openSavedHandoff(activeHandoff)}
    />
  ) : null;

  const showFields = showStartupFields({ surface, newSessionOpen });
  const displayedFolder = folderForTab(values.cwd);
  const folderNotice = folderTabNotice({
    status: activeTabSummary?.folderStatus ?? "",
    savedCwd: activeTabSummary?.cwd ?? "",
    displayedCwd: displayedFolder,
  });

  const composerFields = (
    <div className="composer-fields">
      {showFields && visibleFields(role, formValues).map((field) => (
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

      {showFields && errors.length > 0 && (
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

  const restoreActions = surface === "restore" && (
    <div className="restore-compact">
      <div className="button-row">
        {canContinueSession && (
          <button
            type="button"
            className="primary-button"
            onClick={() => void startSession(false, { resumeStored: true })}
            disabled={busy || !cliFound}
            title="Continues this session in DCTerminal."
          >
            Continue session
          </button>
        )}
        <button
          type="button"
          className="secondary-button"
          aria-expanded={newSessionOpen}
          onClick={openNewSessionForm}
          disabled={busy}
        >
          Start new session
        </button>
      </div>
      {savedTranscript && !activeTabSummary?.acpSessionId && (
        <p className="hint">
          This tab has saved text, but it cannot be continued. Start a new session.
        </p>
      )}
      {savedTranscript && (
        <details className="startup-form-details">
          <summary>Last session transcript (read-only)</summary>
          <pre className="mono-snippet transcript-preview">{savedTranscript}</pre>
        </details>
      )}
    </div>
  );

  const idleActions = showFields && (
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
          onClick={() => {
            if (rememberedSurface(roleId) === "terminal") void startRoleTerminal();
            else void startSession(surface === "restore" && resendStartup);
          }}
          disabled={busy || !cliFound}
        >
          {rememberedSurface(roleId) === "terminal" ? "Start terminal" : "Start"}
        </button>
      </div>
      {surface === "restore" && (
        <label className="field-label continue-option">
          <input
            type="checkbox"
            checked={resendStartup}
            onChange={(e) => {
              const checked = e.target.checked;
              setResendStartup(checked);
              const tabId = activeTabIdRef.current;
              if (tabId && draftsRef.current[tabId]) {
                draftsRef.current[tabId] = {
                  ...draftsRef.current[tabId],
                  resendStartup: checked,
                };
              }
            }}
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
        {handoffBanner}
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
          handoff={handoffOffer}
        />
        <SplitPanes
          mode={split.mode}
          primary={
            <SplitPanes
              mode={
                paneByTab[activeTabId ?? ""]?.open
                  ? paneByTab[activeTabId ?? ""]?.beside
                    ? "horizontal"
                    : "vertical"
                  : "single"
              }
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
              handoff={handoffOffer}
            />
              }
              secondary={
                paneByTab[activeTabId ?? ""]?.open && activeTabId ? (
                  <div className="terminal-pane">
                    <div className="terminal-pane-bar">
                      <span>Terminal</span>
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => {
                          const tabId = activeTabId;
                          setPaneByTab((prev) => {
                            const current = prev[tabId] ?? { open: true, beside: false };
                            return { ...prev, [tabId]: { ...current, beside: !current.beside } };
                          });
                        }}
                      >
                        {paneByTab[activeTabId]?.beside ? "Below" : "Beside"}
                      </button>
                      <button type="button" className="secondary-button" onClick={togglePane}>
                        Hide
                      </button>
                    </div>
                    <TerminalView
                      ptyId={`${activeTabId}::pane`}
                      cwd={session.cwd}
                      launch="shell"
                      fontSize={fontSize}
                      autoOpen
                      autoFocus={false}
                    />
                  </div>
                ) : null
              }
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
          onTransferTerminal={() => void transferToTerminalNow()}
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
        <div
          className="empty-state"
          ref={emptyStateRef}
          key={activeTabId ?? "new"}
          onScroll={(event) => {
            if (ignoreScrollRef.current) return;
            const tabId = activeTabIdRef.current;
            if (tabId) scrollPositions.current[tabId] = event.currentTarget.scrollTop;
          }}
        >
          <div className="empty-state-card">
            {handoffBanner}
            {activeHandoff && !activeHandoff.planField && (
              <label className="field-label">
                Plan from Planner
                <textarea
                  className="text-input prompt-area"
                  rows={8}
                  value={scratch.content}
                  onChange={(event) => {
                    if (activeTabId) scratch.setContent(activeTabId, event.target.value);
                  }}
                  disabled={busy}
                />
                <span className="hint">
                  This role has no plan field. The text is in the scratch pad. Start does not
                  send it. After the session is running, Transfer moves it into the input.
                </span>
              </label>
            )}
            <div className="empty-state-header">
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
                <button
                  type="button"
                  className="role-choice"
                  aria-pressed={launchChoice === "shell"}
                  onClick={() => {
                    setLaunchChoice("shell");
                    setPickedRoleId(null);
                  }}
                  disabled={busy}
                >
                  Terminal
                </button>
                <button
                  type="button"
                  className="role-choice"
                  aria-pressed={launchChoice === "cursor-cli"}
                  onClick={() => {
                    setLaunchChoice("cursor-cli");
                    setPickedRoleId(null);
                  }}
                  disabled={busy}
                >
                  Cursor CLI
                </button>
              </div>
              {pickedRoleId && !launchChoice && (
                <div className="role-choices" role="group" aria-label="Open as">
                  <button
                    type="button"
                    className="role-choice"
                    aria-pressed={rememberedSurface(pickedRoleId) === "chat"}
                    onClick={() => rememberSurface(pickedRoleId, "chat")}
                    disabled={busy}
                  >
                    Chat
                  </button>
                  <button
                    type="button"
                    className="role-choice"
                    aria-pressed={rememberedSurface(pickedRoleId) === "terminal"}
                    onClick={() => rememberSurface(pickedRoleId, "terminal")}
                    disabled={busy}
                  >
                    Terminal
                  </button>
                </div>
              )}
              <div className="field-label">
                Working folder
                <FolderPicker
                  value={displayedFolder}
                  unavailable={folderNotice?.tone === "error"}
                  disabled={busy}
                  onChange={(path) => setField("cwd", path)}
                />
              </div>
              {folderNotice?.tone === "error" && <p className="error">{folderNotice.text}</p>}
            </div>
            {launchChoice ? (
              <div className="button-row">
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => void startBlankTerminal(launchChoice)}
                  disabled={
                    busy || !displayedFolder || (launchChoice === "cursor-cli" && !cliFound)
                  }
                >
                  {launchChoice === "cursor-cli" ? "Start Cursor CLI" : "Start terminal"}
                </button>
              </div>
            ) : (
              <>
                {restoreActions}
                {composerFields}
                {historyFolder && (
                  <CursorHistoryList
                    entries={historyEntries}
                    error={historyError}
                    busy={busy}
                    onResume={(entry) => void resumeHistoryEntry(entry)}
                    onOpenCli={(entry) => void openCursorCli(entry.id, entry.cwd)}
                  />
                )}
                {idleActions}
              </>
            )}
            {cliLaunchNote && <p className="hint">{cliLaunchNote}</p>}
            {terminalError && <p className="error">{terminalError}</p>}
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
