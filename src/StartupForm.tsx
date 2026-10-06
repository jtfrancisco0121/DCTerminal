import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  acpSetModel,
  closeTab,
  devSessionCancel,
  getLayout,
  getModelSettings,
  listModels,
  setModelSettings,
  ptyKill,
  setLayout,
  setTabModel,
  type ModelList,
  type ModelSettings,
  devSessionSend,
  devSessionStop,
  cursorApprovalMode,
  diagnosticsSetCapture,
  diagnosticsStatus,
  listenPermissionAuto,
  listenPermissionRequests,
  listenPlanRequests,
  respondPermissionRequest,
  respondPlanRequest,
  reopenClosedTab,
  historySearch,
  transcriptLoad,
  promptClearRecent,
  promptDelete,
  promptLibraryGet,
  promptMarkUsed,
  promptRecordSend,
  promptSave,
  type PromptLibrary,
  workspaceDelete,
  workspaceOpen,
  workspaceSave,
  workspacesList,
  type WorkspaceList,
  cliLoginStatus,
  detectCli,
  firstRunComplete,
  firstRunStatus,
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
  getNotificationSettings,
  setNotificationSettings,
  gitRepoInfo,
  changesList,
  worktreeTabCheck,
  worktreeTabNew,
  worktreeTabRemove,
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
  type ApprovalModeStatus,
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
import { StatusBar, type StatusMessage, type StatusTone } from "./components/StatusBar";
import { summarizeSessionActivity } from "./sessionActivity";
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
import { TerminalScratchPad, type TerminalPadHandle } from "./components/TerminalScratchPad";
import { SessionCards } from "./components/SessionCards";
import { ShortcutsOverlay } from "./components/ShortcutsOverlay";
import { SplitPanes } from "./components/SplitPanes";
import { WorkspaceSplit } from "./components/WorkspaceSplit";
import { FilePanel } from "./components/FilePanel";
import { ModelPicker } from "./components/ModelPicker";
import { AgentToasts } from "./components/AgentToasts";
import { WorktreeDialog, type WorktreeCreateInput } from "./components/WorktreeDialog";
import { ChangesPanel } from "./components/ChangesPanel";
import { ChatSearchDialog, type ChatSearchHit } from "./components/ChatSearchDialog";
import { TranscriptView } from "./components/TranscriptView";
import { PromptLibraryDialog } from "./components/PromptLibraryDialog";
import { WorkspacesDialog } from "./components/WorkspacesDialog";
import { FirstRunSetup, type FirstRunFinish } from "./components/FirstRunSetup";
import { insertIntoPad, type PadSelection } from "./prompts/library";
import type { ChatFindRequest } from "./SessionTerminal";
import { classifyPromptFinished, type NotificationSettings } from "./notify/agentNotify";
import { showSystemNotification } from "./notify/systemNotify";
import { useAgentNotifications } from "./notify/useAgentNotifications";
import { isWindowFocused, useWindowFocused } from "./notify/windowFocus";
import { terminalActivity } from "./terminal/activity";
import {
  clearMarks,
  computeTabStatus,
  markAfterTurn,
  tabStatusLabel,
  type TabMark,
  type TabStatus,
} from "./tabStatus";
import { appendReference } from "./files/paths";
import { effectiveModel, modelChangeNote } from "./models";
import { TabSwitcher } from "./components/TabSwitcher";
import { detectPlatform, type ShortcutMatch, type TerminalAction } from "./keymap";
import { beginLivePty, dropLivePty, livePty, rekeyLivePty } from "./terminal/live";
import {
  blurParkedTerminal,
  copyTerminalSelection,
  focusParkedTerminal,
  focusedTerminalId,
  parkedTerminal,
  pasteTerminalText,
  refitTerminal,
  requestTerminalSearch,
  terminalBracketedPaste,
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
import { ChatHistoryDialog } from "./components/ChatHistoryDialog";
import {
  resumeIdForStart,
  segmentsAfterResume,
  segmentsWhileStarting,
  type CursorHistoryEntry,
} from "./cursorHistory";
import { TabBar } from "./TabBar";
import {
  clampSplitSize,
  closeSplit,
  emptySplit,
  reconcileSplit,
  splitCandidates,
  splitFromLayout,
  splitOpen,
  swapSplit,
  tabAtIndex,
  type SplitState,
  parsePaletteId,
  type PaletteAction,
  type PaletteModelOptions,
} from "./tabChrome";
import { useAppShortcuts } from "./useAppShortcuts";
import { useScratchPads } from "./useScratchPads";
import { useUiSettings } from "./useUiSettings";
import {
  appendStreamSegment,
  streamSegmentFromSystemMessage,
  streamSegmentFromUserMessage,
  segmentsToPlainText,
} from "./transcript";

/** Plain shells have no model; chats, role terminals, and Cursor CLI do. */
function tabHasModel(tab: TabSummary): boolean {
  return !(
    tab.kind === "terminal" &&
    tab.terminalLaunch !== "role" &&
    tab.terminalLaunch !== "cursor-cli"
  );
}

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
  /** F8: re-run CLI detection (App keeps the result). */
  onRedetectCli?: () => Promise<CliDetectResult>;
};

export function StartupForm({
  roles,
  cli,
  cliError,
  cliFound,
  showDevTools,
  onRedetectCli,
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
  // F2: finished/question/error left on a tab the user was not watching.
  const [tabMarks, setTabMarks] = useState<Record<string, TabMark>>({});
  const [terminalBusy, setTerminalBusy] = useState<string[]>([]);
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [worktreeDialogOpen, setWorktreeDialogOpen] = useState(false);
  /** F4: the tab whose changes (diff) panel is open. */
  const [changesTabId, setChangesTabId] = useState<string | null>(null);
  /** Files changed in each tab's last turn (shown on the Changes button). */
  const [changeCounts, setChangeCounts] = useState<Record<string, number>>({});
  /** acceptKey()s per tab: files the user kept after review. */
  const [acceptedChanges, setAcceptedChanges] = useState<Record<string, string[]>>({});
  const [fileFocus, setFileFocus] = useState<{ path: string; nonce: number } | null>(null);
  /** F8: first-run setup is showing. */
  const [firstRunOpen, setFirstRunOpen] = useState(false);
  /** F8: after setup, start this role once the form has it and the folder. */
  const [pendingStart, setPendingStart] = useState<FirstRunFinish | null>(null);
  /** F7: workspaces dialog; focusSave starts on the name field. */
  const [workspacesOpen, setWorkspacesOpen] = useState<{ focusSave: boolean } | null>(null);
  const [workspaceList, setWorkspaceList] = useState<WorkspaceList | null>(null);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  /** F6: prompt library dialog; saveDraft opens it on "Save as prompt". */
  const [promptLibraryOpen, setPromptLibraryOpen] = useState<{ saveDraft: string | null } | null>(
    null,
  );
  const [promptLibrary, setPromptLibrary] = useState<PromptLibrary | null>(null);
  const [promptLibraryError, setPromptLibraryError] = useState<string | null>(null);
  /** Last cursor/selection in a tab's pad, so a library insert lands there. */
  const padSelectionRef = useRef<(PadSelection & { tabId: string }) | null>(null);
  /** F5: Search all chats is open with this starting query. */
  const [chatSearchQuery, setChatSearchQuery] = useState<string | null>(null);
  /** F5: open the find bar in this chat tab (Mod+F, or a search jump). */
  const [findRequest, setFindRequest] = useState<{ tabId: string; req: ChatFindRequest } | null>(
    null,
  );
  /** F5: a jump into a tab's saved (read-only) transcript. */
  const [transcriptFocus, setTranscriptFocus] = useState<{
    tabId: string;
    query: string;
    occurrence: number;
    text: string;
    nonce: number;
  } | null>(null);
  const refreshChangeCount = useCallback((tabId: string) => {
    changesList(tabId, "turn")
      .then((set) => {
        const count = set.state === "ok" ? set.files.length : 0;
        setChangeCounts((prev) => (prev[tabId] === count ? prev : { ...prev, [tabId]: count }));
      })
      .catch(() => {});
  }, []);
  const [split, setSplit] = useState<SplitState>(emptySplit());
  const [splitPicker, setSplitPicker] = useState<"horizontal" | "vertical" | null>(null);
  const [focusedPane, setFocusedPane] = useState<"primary" | "secondary">("primary");
  const focusedPaneRef = useRef(focusedPane);
  focusedPaneRef.current = focusedPane;
  const [filePanelOpen, setFilePanelOpen] = useState(false);
  const [filePanelWidth, setFilePanelWidth] = useState(280);
  const layoutLoadedRef = useRef(false);
  const previousActiveRef = useRef<string | null>(null);
  const secondaryInputRef = useRef<HTMLTextAreaElement>(null);
  const [modelList, setModelList] = useState<ModelList | null>(null);
  const [modelSettings, setModelSettingsState] = useState<ModelSettings | null>(null);
  const [modelNotice, setModelNotice] = useState<string | null>(null);
  const [modelsRefreshing, setModelsRefreshing] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** Text the palette opens with, and a key so reopening resets it. */
  const [palettePrefill, setPalettePrefill] = useState({ query: "", key: 0 });
  const [chatHistoryOpen, setChatHistoryOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [captureOn, setCaptureOn] = useState(false);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsStatus | null>(null);
  const [approvalMode, setApprovalMode] = useState<ApprovalModeStatus | null>(null);
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
  const [notificationSettings, setNotificationSettingsState] =
    useState<NotificationSettings | null>(null);
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
  const scratch = useScratchPads(activeTabId);
  const padRef = useRef<HTMLTextAreaElement>(null);
  const terminalPadRef = useRef<TerminalPadHandle>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const waiterRef = useRef(createTurnWaiter());
  const chainAbortRef = useRef(false);
  const dialogOpen =
    paletteOpen ||
    switcherOpen ||
    shortcutsOpen ||
    settingsOpen ||
    splitPicker !== null ||
    handoffTarget !== null ||
    savedPlan !== null ||
    worktreeDialogOpen ||
    changesTabId !== null ||
    chatSearchQuery !== null ||
    promptLibraryOpen !== null ||
    workspacesOpen !== null ||
    chatHistoryOpen ||
    firstRunOpen;
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

  // F1: toasts and OS notifications for agent events on tabs you are not watching.
  const windowFocused = useWindowFocused();
  const agentNotifications = useAgentNotifications({
    settings: notificationSettings,
    visibleTabIds: () => {
      const current = splitRef.current;
      return [activeTabIdRef.current, splitOpen(current) ? current.secondaryTabId : null];
    },
    tabLabel: (tabId) => savedTabsRef.current.find((tab) => tab.id === tabId)?.label ?? "",
  });
  const notifyAgent = agentNotifications.notify;
  /** On screen in a focused window: nothing is left unseen. */
  const isWatchingTab = useCallback((tabId: string) => {
    if (!isWindowFocused()) return false;
    const current = splitRef.current;
    return (
      tabId === activeTabIdRef.current ||
      (splitOpen(current) && current.secondaryTabId === tabId)
    );
  }, []);
  const dismissTabToasts = agentNotifications.dismissTab;
  const showNotice = agentNotifications.notice;

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
        notifyAgent(evt.tabId, { kind: "permission", detail: evt.title || evt.message });
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
        const event = classifyPromptFinished(evt);
        if (event) notifyAgent(evt.tabId, event);
        const watching = isWatchingTab(evt.tabId);
        setTabMarks((marks) => markAfterTurn(marks, evt.tabId!, event?.kind ?? null, watching));
        refreshChangeCount(evt.tabId);
      }),
      listenPlanRequests((evt) => {
        if (!evt.tabId) return;
        setPlanRequest(evt);
        setChain((current) => (current ? chainMarkBlocked(current) : current));
        notifyAgent(evt.tabId, { kind: "plan", detail: evt.title });
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
  }, [isWatchingTab, notifyAgent, patchRuntime, refreshChangeCount]);

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
    getNotificationSettings()
      .then(setNotificationSettingsState)
      .catch(() => {});
  }, []);

  // A tab's toasts are stale once it is on screen in a focused window.
  useEffect(() => {
    if (!windowFocused) return;
    const secondary = splitOpen(split) ? split.secondaryTabId : null;
    if (activeTabId) dismissTabToasts(activeTabId);
    if (secondary) dismissTabToasts(secondary);
    setTabMarks((marks) => clearMarks(marks, [activeTabId, secondary]));
  }, [activeTabId, dismissTabToasts, split, windowFocused]);

  // Terminal tabs: busy while output streams; a finished dot when a busy
  // tab goes quiet off screen. Polls only while terminal tabs exist.
  const hasTerminalTabs = savedTabs.some((tab) => tab.kind === "terminal");
  useEffect(() => {
    if (!hasTerminalTabs) {
      setTerminalBusy((prev) => (prev.length === 0 ? prev : []));
      return;
    }
    const timer = window.setInterval(() => {
      const { busy, settled } = terminalActivity.sweep();
      setTerminalBusy((prev) =>
        prev.length === busy.length && prev.every((id, i) => id === busy[i]) ? prev : busy,
      );
      if (settled.length > 0) {
        setTabMarks((marks) =>
          settled.reduce(
            (acc, id) => markAfterTurn(acc, id, "finished", isWatchingTab(id)),
            marks,
          ),
        );
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [hasTerminalTabs, isWatchingTab]);

  const tabStatuses = useMemo(() => {
    const out: Record<string, TabStatus> = {};
    for (const tab of savedTabs) {
      out[tab.id] = computeTabStatus({
        runtime: runtimes[tab.id],
        mark: tabMarks[tab.id],
        planPending: planRequest?.tabId === tab.id,
        terminalBusy: terminalBusy.includes(tab.id),
      });
    }
    return out;
  }, [planRequest, runtimes, savedTabs, tabMarks, terminalBusy]);

  const uiSettings = useUiSettings();
  // U2: one pad size for chat and terminal tabs; saved when a drag ends.
  const [padHeight, setPadHeight] = useState<number | null>(null);
  const savedPadHeight = uiSettings.ui.padHeight;
  useEffect(() => {
    setPadHeight(savedPadHeight > 0 ? savedPadHeight : null);
  }, [savedPadHeight]);
  const padOpen = !uiSettings.ui.padHidden;
  const padHiddenNow = uiSettings.ui.padHidden;
  const updateUi = uiSettings.update;
  const padSizeProps = {
    height: padHeight,
    onHeightChange: setPadHeight,
    onHeightCommit: (height: number) => uiSettings.update({ padHeight: height }),
  };

  const notificationSettingsRef = useRef(notificationSettings);
  notificationSettingsRef.current = notificationSettings;
  const updateNotificationSettings = useCallback((next: NotificationSettings) => {
    const prev = notificationSettingsRef.current;
    // Turning system notifications on is a click, so ask the OS now.
    if (next.enabled && next.system && !(prev?.enabled && prev?.system)) {
      void showSystemNotification("DCTerminal notifications", "System notifications are on.", {
        askAgain: true,
      });
    }
    setNotificationSettingsState(next);
    void setNotificationSettings(next)
      .then(setNotificationSettingsState)
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    getLayout()
      .then((layout) => {
        if (cancelled) return;
        setSplit(splitFromLayout(layout));
        setFilePanelOpen(layout.filePanelOpen);
        setFilePanelWidth(layout.filePanelWidth);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) layoutLoadedRef.current = true;
      });
    getModelSettings()
      .then((value) => {
        if (!cancelled) setModelSettingsState(value);
      })
      .catch(() => {});
    listModels(false)
      .then((list) => {
        if (!cancelled) setModelList(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Split and file panel survive a restart (state.json).
  useEffect(() => {
    if (!layoutLoadedRef.current) return;
    const timer = window.setTimeout(() => {
      const open = splitOpen(split);
      void setLayout({
        splitMode: open ? split.mode : "single",
        secondaryTabId: open ? split.secondaryTabId : null,
        primarySize: clampSplitSize(split.primarySize),
        filePanelOpen,
        filePanelWidth,
      }).catch(() => {});
    }, 300);
    return () => window.clearTimeout(timer);
  }, [split, filePanelOpen, filePanelWidth]);

  // One tab is never in both panes. Selecting the second pane's tab swaps.
  useEffect(() => {
    const previous = previousActiveRef.current;
    previousActiveRef.current = activeTabId;
    if (savedTabs.length === 0) return;
    const ids = savedTabs.map((tab) => tab.id);
    setSplit((current) =>
      reconcileSplit(current, ids, previous === activeTabId ? null : previous, activeTabId),
    );
  }, [activeTabId, savedTabs]);

  useEffect(() => {
    if (!splitOpen(split)) setFocusedPane("primary");
  }, [split]);

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
  const focusedTranscript =
    transcriptFocus && transcriptFocus.tabId === activeTabId
      ? savedTranscript || transcriptFocus.text
      : "";

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

  /** Stop a chat shown in the second pane. The main pane's tab is untouched. */
  const stopSecondarySession = useCallback(
    async (tabId: string) => {
      setBusy(true);
      try {
        const scrollback = segmentsToPlainText(runtimesRef.current[tabId]?.segments ?? []);
        await devSessionStop(scrollback || undefined, tabId);
        patchRuntime(tabId, (rt) => clearLiveSession(rt));
        await refreshTabs();
      } finally {
        setBusy(false);
      }
    },
    [patchRuntime, refreshTabs],
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

  /** F3: the user clicked Create in "New tab in worktree…". */
  const createWorktreeTab = useCallback(
    async (input: WorktreeCreateInput) => {
      stashActiveTab();
      const { tab } = await worktreeTabNew(input);
      setWorktreeDialogOpen(false);
      await refreshTabs();
      loadTabIntoForm(tab);
      showNotice(
        "Worktree created",
        `${tab.worktree?.branch ?? input.branch} · ${tab.cwd}`,
      );
    },
    [loadTabIntoForm, refreshTabs, showNotice, stashActiveTab],
  );

  /**
   * F3 removal: refuse a dirty tree, confirm, close the tab (stops its agent
   * or shell), then `git worktree remove` without --force.
   */
  const removeWorktreeFor = useCallback(
    async (tabId: string | null) => {
      if (!tabId) return;
      const summary = savedTabsRef.current.find((tab) => tab.id === tabId);
      if (!summary?.worktreePath) return;
      try {
        const check = await worktreeTabCheck(tabId);
        const branch = check.branch ?? check.worktree.branch;
        if (check.dirty.length > 0) {
          showNotice(
            "Worktree not removed",
            `${branch} has ${check.dirty.length} uncommitted or untracked change${
              check.dirty.length === 1 ? "" : "s"
            }. Commit, stash, or discard them first.`,
            "failed",
          );
          return;
        }
        const ok = window.confirm(
          `Remove the worktree for ${branch}?\n\n${check.worktree.path}\n\n` +
            "This closes the tab, stops its agent or shell, and deletes that folder. " +
            "The branch and its commits are kept.",
        );
        if (!ok) return;
        await handleCloseTab(tabId);
        await worktreeTabRemove(tabId, true);
        showNotice("Worktree removed", `${branch} · ${check.worktree.path}`);
      } catch (err: unknown) {
        showNotice(
          "Worktree not removed",
          err instanceof Error ? err.message : String(err),
          "failed",
        );
      }
    },
    [handleCloseTab, showNotice],
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

  const cancelTurnFor = useCallback(async (tabId: string | null) => {
    if (!tabId) return;
    setBusy(true);
    try {
      await devSessionCancel(tabId);
      patchRuntime(tabId, (rt) => ({
        ...rt,
        segments: [
          ...rt.segments,
          streamSegmentFromSystemMessage("Cancelling the current turn…"),
        ],
      }));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      patchRuntime(tabId, (rt) => ({ ...rt, promptError: message }));
    } finally {
      setBusy(false);
    }
  }, [patchRuntime]);

  const cancelTurn = useCallback(() => cancelTurnFor(activeTabId), [activeTabId, cancelTurnFor]);

  /** Answer a permission card on any tab (main or second pane). */
  const respondPermissionFor = useCallback(
    async (tabId: string | null, optionId: string | null) => {
      if (!tabId) return;
      const request = runtimesRef.current[tabId]?.permission;
      if (!request) return;
      setBusy(true);
      try {
        if (optionId === null) {
          await respondPermissionRequest(tabId, request.jsonRpcId, "cancelled");
        } else {
          await respondPermissionRequest(tabId, request.jsonRpcId, "selected", optionId);
        }
        patchRuntime(tabId, (rt) => ({ ...rt, permission: null }));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        patchRuntime(tabId, (rt) => ({ ...rt, promptError: message }));
      } finally {
        setBusy(false);
      }
    },
    [patchRuntime],
  );

  const handlePermissionSelect = useCallback(
    (optionId: string) => respondPermissionFor(activeTabId, optionId),
    [activeTabId, respondPermissionFor],
  );

  const handlePermissionCancel = useCallback(
    () => respondPermissionFor(activeTabId, null),
    [activeTabId, respondPermissionFor],
  );

  const sendText = useCallback(
    async (tabId: string, text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return "error" as const;
      const pending = waiterRef.current.expect(tabId);
      setHistoryCursor(-1);
      scratch.remember(tabId, trimmed);
      void promptRecordSend(trimmed, "chat").catch(() => {});
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

  const sendFollowUpFor = useCallback(
    async (tabId: string | null) => {
      if (!tabId) return;
      const rt = runtimesRef.current[tabId];
      const text = rt?.followUp.trim() ?? "";
      if (!text || !rt || rt.agentExited || rt.promptInFlight) return;
      setBusy(true);
      try {
        await sendText(tabId, text);
      } finally {
        setBusy(false);
      }
    },
    [sendText],
  );

  const sendFollowUp = useCallback(
    () => sendFollowUpFor(activeTabId),
    [activeTabId, sendFollowUpFor],
  );

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

  // F8: show first-run setup on a fresh profile only.
  useEffect(() => {
    let cancelled = false;
    firstRunStatus()
      .then((status) => {
        if (!cancelled && status?.needed) setFirstRunOpen(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // F8: once the form shows the chosen role and folder, press Start for the
  // user. A role with required fields waits for them instead.
  useEffect(() => {
    if (!pendingStart || busy || !role) return;
    if (role.id !== pendingStart.roleId || roleId !== pendingStart.roleId) return;
    if (folderForTab(values.cwd) !== pendingStart.folder) return;
    setPendingStart(null);
    const missing = visibleFields(role, formValues).filter(
      (field) => field.required && field.key !== "cwd" && !(formValues[field.key] ?? "").trim(),
    );
    if (missing.length > 0) {
      showNotice(
        "Almost ready",
        `Fill in ${missing.map((field) => field.label).join(", ")}, then press Start.`,
        "question",
      );
      window.setTimeout(() => {
        const el = document.querySelector<HTMLElement>(`[data-field-key="${missing[0].key}"]`);
        el?.focus();
      }, 0);
      return;
    }
    if (pendingStart.surface === "terminal") void startRoleTerminal();
    else void startSession(false);
  }, [busy, formValues, pendingStart, role, roleId, showNotice, startRoleTerminal, startSession, values.cwd]);

  const roleNames = useMemo(
    () => Object.fromEntries(roles.map((item) => [item.id, item.name])),
    [roles],
  );

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

  const splitRef = useRef(split);
  splitRef.current = split;

  /** Settings role key for a tab: its role, or "cursor-cli" for CLI tabs. */
  const modelRoleKey = (tab: TabSummary | null | undefined): string | null => {
    if (!tab) return null;
    if (tab.kind === "terminal" && tab.terminalLaunch === "cursor-cli") return "cursor-cli";
    return tab.roleId || null;
  };

  const inheritedModel = (tab: TabSummary | null | undefined): string =>
    effectiveModel(modelSettings, modelRoleKey(tab), null);

  /**
   * Change one tab's model. A live chat switches in place (or restarts the
   * agent with --model and reloads the session). A running terminal must be
   * restarted, so we ask first.
   */
  const changeTabModel = useCallback(
    async (tab: TabSummary, model: string | null) => {
      setModelNotice(null);
      const rt = runtimesRef.current[tab.id];
      try {
        if (tab.kind !== "terminal" && rt?.session && !rt.agentExited) {
          const target = model ?? effectiveModel(modelSettings, modelRoleKey(tab), null);
          const result = await acpSetModel(tab.id, target);
          if (model === null) await setTabModel(tab.id, null);
          patchRuntime(tab.id, (current) => ({
            ...current,
            session: current.session ? { ...current.session, model: result.model } : current.session,
            segments: appendStreamSegment(current.segments, {
              id: `model-${Date.now()}`,
              kind: "system",
              text: modelChangeNote(result.model, result.via, result.restarted),
            }),
          }));
        } else {
          await setTabModel(tab.id, model);
          const live = livePty(tab.id);
          if (tab.kind === "terminal" && live && live.exitCode == null) {
            const restart = window.confirm(
              "The new model applies when the terminal restarts. Stop the running agent now?",
            );
            if (restart) {
              await ptyKill(tab.id).catch(() => {});
              setModelNotice("The agent stopped. Press Restart to use the new model.");
            } else {
              setModelNotice("The new model applies the next time this terminal starts.");
            }
          }
        }
        await refreshTabs();
      } catch (err: unknown) {
        setModelNotice(err instanceof Error ? err.message : String(err));
      }
    },
    [modelSettings, patchRuntime, refreshTabs],
  );

  const changesButton = (tabId: string) => {
    const count = changeCounts[tabId] ?? 0;
    return (
      <button
        type="button"
        className="secondary-button changes-button"
        onClick={() => setChangesTabId(tabId)}
        title="Files changed since the last turn started: review, accept, or revert"
      >
        {count > 0 ? `Changes (${count})` : "Changes"}
      </button>
    );
  };

  const refreshModelList = useCallback(() => {
    setModelsRefreshing(true);
    return listModels(true)
      .then((list) => {
        setModelList(list);
        return list;
      })
      .finally(() => setModelsRefreshing(false));
  }, []);

  const modelPickerFor = (tab: TabSummary | null | undefined, liveModel?: string | null) => {
    if (!tab || !tabHasModel(tab)) return null;
    const inherited = inheritedModel(tab);
    const models = modelList?.models ?? [];
    return (
      <ModelPicker
        compact
        models={models}
        value={liveModel && liveModel !== (tab.model ?? inherited) ? liveModel : (tab.model ?? null)}
        inherited={{ model: inherited, label: "Default" }}
        ariaLabel={`Model for ${tab.label}`}
        disabled={busy || !!runtimes[tab.id]?.promptInFlight}
        onChange={(model) => void changeTabModel(tab, model)}
      />
    );
  };

  /** Move keyboard focus into the main pane or the second pane. */
  const focusPane = useCallback(
    (pane: "primary" | "secondary") => {
      const tabId =
        pane === "secondary"
          ? splitOpen(splitRef.current)
            ? splitRef.current.secondaryTabId
            : null
          : activeTabIdRef.current;
      if (!tabId) return;
      setFocusedPane(pane);
      const summary = savedTabs.find((tab) => tab.id === tabId);
      if (summary?.kind === "terminal") {
        focusParkedTerminal(tabId);
        parkedTerminal(tabId)?.term.focus();
        return;
      }
      if (pane === "secondary") secondaryInputRef.current?.focus();
      else inputRef.current?.focus();
    },
    [savedTabs],
  );

  /** The second pane's tab becomes active; the active tab moves across. */
  const swapPanes = useCallback(() => {
    const swapped = swapSplit(splitRef.current, activeTabIdRef.current);
    if (!swapped) return;
    // reconcileSplit moves the previous active tab into the second pane.
    void handleSelectTab(swapped.activate);
    setFocusedPane("primary");
  }, [handleSelectTab]);

  /** Mod+F: the terminal's search, the chat's find bar, or Search all chats. */
  const handleFind = useCallback(() => {
    const secondaryId = splitOpen(split) ? split.secondaryTabId : null;
    const tabId =
      focusedPaneRef.current === "secondary" && secondaryId ? secondaryId : activeTabIdRef.current;
    const summary = savedTabs.find((tab) => tab.id === tabId);
    if (!tabId || !summary) {
      setChatSearchQuery("");
      return;
    }
    if (summary.kind === "terminal") {
      requestTerminalSearch(tabId);
      return;
    }
    if (runtimes[tabId]?.session) {
      setFindRequest({ tabId, req: { query: "", nonce: Date.now() } });
      return;
    }
    setChatSearchQuery("");
  }, [runtimes, savedTabs, split]);

  const onShortcut = useCallback(
    (match: ShortcutMatch) => {
      if (match.action === "closeDialog") {
        setChangesTabId(null);
        setChatSearchQuery(null);
        setPromptLibraryOpen(null);
        setWorkspacesOpen(null);
        setChatHistoryOpen(false);
        setWorktreeDialogOpen(false);
        setPaletteOpen(false);
        setSwitcherOpen(false);
        setShortcutsOpen(false);
        setSettingsOpen(false);
        setSplitPicker(null);
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
        setPalettePrefill((current) => ({ query: "", key: current.key + 1 }));
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
      const secondaryId = splitOpen(split) ? split.secondaryTabId : null;
      const inSecondary =
        !!secondaryId && !!document.activeElement?.closest("[data-pane='secondary']");
      if (match.action === "send" && inSecondary) {
        if (document.activeElement === secondaryInputRef.current) void sendFollowUpFor(secondaryId);
        return;
      }
      if (match.action === "focusInput" && inSecondary && secondaryId) {
        focusPane("secondary");
        return;
      }
      if (match.action === "send") {
        const summary = savedTabs.find((tab) => tab.id === activeTabIdRef.current);
        const inPad = document.activeElement?.closest(".scratch-pad");
        if (summary?.kind === "terminal" && inPad) {
          terminalPadRef.current?.send(true);
          return;
        }
        if (document.activeElement === padRef.current) sendFromPad();
        else void sendFollowUp();
        return;
      }
      if (match.action === "transferPad") {
        const summary = savedTabs.find((tab) => tab.id === activeTabIdRef.current);
        if (summary?.kind === "terminal") return;
        transferPad();
        return;
      }
      if (match.action === "focusPad") {
        const tabId = activeTabIdRef.current;
        const summary = savedTabs.find((tab) => tab.id === tabId);
        if (summary?.kind === "terminal" && tabId) {
          blurParkedTerminal(tabId);
          terminalPadRef.current?.focus();
          return;
        }
        if (padHiddenNow) {
          updateUi({ padHidden: false });
          window.setTimeout(() => padRef.current?.focus(), 0);
          return;
        }
        padRef.current?.focus();
        return;
      }
      if (match.action === "focusInput") {
        const tabId = activeTabIdRef.current;
        const summary = savedTabs.find((tab) => tab.id === tabId);
        if (summary?.kind === "terminal" && tabId) {
          focusParkedTerminal(tabId);
          parkedTerminal(tabId)?.term.focus();
          return;
        }
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
        if (splitCandidates(savedTabs, activeTabId).length === 0) {
          showNotice("Nothing to split with", "Open another tab first, then split.", "question");
          return;
        }
        setSplitPicker(match.action === "splitRight" ? "horizontal" : "vertical");
        return;
      }
      if (match.action === "swapPanes") {
        swapPanes();
        return;
      }
      if (match.action === "focusOtherPane") {
        if (!secondaryId) return;
        focusPane(focusedPaneRef.current === "secondary" ? "primary" : "secondary");
        return;
      }
      if (match.action === "closeSplit") {
        setSplit((current) => closeSplit(current));
        focusPane("primary");
        return;
      }
      if (match.action === "toggleFilePanel") {
        setFilePanelOpen((open) => !open);
        return;
      }
      if (match.action === "find") {
        handleFind();
        return;
      }
      if (match.action === "searchChats") {
        setChatSearchQuery("");
        return;
      }
      if (match.action === "renameTab" && activeTabId) {
        setRenamingTabId(activeTabId);
      }
    },
    [
      activeTabId,
      handleFind,
      cycleTab,
      handleCloseTab,
      handleNewTab,
      refreshTabs,
      reopenTab,
      savedTabs,
      selectTabByIndex,
      sendFollowUp,
      sendFollowUpFor,
      sendFromPad,
      split,
      swapPanes,
      focusPane,
      transferPad,
      padHiddenNow,
      updateUi,
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
    if (summary?.kind === "terminal") {
      terminalPadRef.current?.send(true);
      return;
    }
    const target = `${tabId}::pane`;
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
        terminalActivity.input(target);
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
    // The pad is not the PTY. Keys typed there must stay in the textarea.
    if (el?.closest(".scratch-pad")) return "chat" as const;
    if (el?.closest(".terminal-slot, .xterm")) return "terminal" as const;
    return "chat" as const;
  }, []);

  const focusActiveTerminal = useCallback(() => {
    const tabId = activeTabIdRef.current;
    if (!tabId) return;
    focusParkedTerminal(tabId);
    parkedTerminal(tabId)?.term.focus();
  }, []);

  const secondaryInFlight =
    splitOpen(split) && !!split.secondaryTabId && !!runtimes[split.secondaryTabId]?.promptInFlight;

  useAppShortcuts({
    platform,
    dialogOpen,
    promptInFlight: !!promptInFlight || secondaryInFlight,
    getSurface,
    onAction: onShortcut,
    onTerminal: onTerminalAction,
    onCancelTurn: () => {
      // Escape cancels the turn in the pane that has focus.
      const inSecondary = !!document.activeElement?.closest("[data-pane='secondary']");
      if (inSecondary) {
        if (secondaryInFlight) void cancelTurnFor(split.secondaryTabId);
        return;
      }
      if (promptInFlight) void cancelTurn();
    },
    onPadEscape: () => {
      const summary = savedTabs.find((tab) => tab.id === activeTabIdRef.current);
      if (summary?.kind !== "terminal") return false;
      focusActiveTerminal();
      return true;
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

  const refreshApprovalMode = useCallback(() => {
    cursorApprovalMode()
      .then(setApprovalMode)
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshApprovalMode();
    const onFocus = () => refreshApprovalMode();
    const onVisibility = () => {
      if (document.visibilityState === "visible") refreshApprovalMode();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refreshApprovalMode]);

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
      const screen =
        document.querySelector("[data-pane='primary'] [data-session-screen]") ??
        document.querySelector("[data-session-screen]");
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

  const openPaletteWith = (query: string) => {
    setPalettePrefill((current) => ({ query, key: current.key + 1 }));
    setPaletteOpen(true);
  };

  const paletteModel: PaletteModelOptions | null =
    activeTabSummary && tabHasModel(activeTabSummary) && (modelList?.models.length ?? 0) > 0
      ? {
          current: activeTabSummary.model ?? null,
          inherited: inheritedModel(activeTabSummary),
          models: (modelList?.models ?? []).map(({ id, label }) => ({ id, label })),
        }
      : null;

  const runPaletteModel = (model: string | null) => {
    const tab = activeTabSummary;
    if (!tab || !tabHasModel(tab)) {
      showNotice("No model here", "This tab is a plain shell. Pick a chat or Cursor CLI tab.", "question");
      return;
    }
    if (busy || runtimes[tab.id]?.promptInFlight) {
      showNotice("Model not changed", "Wait for the current turn to finish, then try again.", "question");
      return;
    }
    void changeTabModel(tab, model);
  };

  /** Run one palette command. Every PaletteAction must have a case here. */
  const runPaletteAction = (id: PaletteAction) => {
    switch (id) {
      case "sendPlanImplementer":
        openHandoffDialog("role_implementer");
        return;
      case "sendPlanDeveloper":
        openHandoffDialog("role_developer");
        return;
      case "handoffHelp":
        showNotice(
          "Nothing to hand off",
          "Hand-off sends a plan to an Implementer or Developer. Open a Planner chat or Planner terminal that has a plan, then try again.",
          "question",
        );
        return;
      case "changeModel":
        if (!paletteModel) {
          runPaletteModel(null);
          return;
        }
        openPaletteWith("use model ");
        return;
      case "refreshModels":
        void refreshModelList()
          .then((list) =>
            showNotice("Model list refreshed", `${list.models.length} models available.`),
          )
          .catch((err: unknown) =>
            showNotice(
              "Could not refresh models",
              err instanceof Error ? err.message : String(err),
              "question",
            ),
          );
        return;
      case "chatHistory":
        setChatHistoryOpen(true);
        return;
      case "toggleTerminal":
        togglePane();
        return;
      case "transferToTerminal":
        void transferToTerminalNow();
        return;
      case "settings":
        setSettingsOpen(true);
        return;
      case "toggleCapture":
        void diagnosticsSetCapture(!captureOn).then((status) => {
          setDiagnostics(status);
          setCaptureOn(status.capturePermissionPayloads);
        });
        return;
      case "firstRunSetup":
        setFirstRunOpen(true);
        return;
      case "workspaces":
      case "saveWorkspace":
        openWorkspaces(id === "saveWorkspace");
        return;
      case "promptLibrary":
        openPromptLibrary(false);
        return;
      case "savePrompt":
        openPromptLibrary(true);
        return;
      case "showChanges":
        if (activeTabId) setChangesTabId(activeTabId);
        return;
      case "newWorktreeTab":
        setWorktreeDialogOpen(true);
        return;
      case "removeWorktree":
        void removeWorktreeFor(activeTabId);
        return;
      case "newTab":
      case "closeTab":
      case "reopenClosedTab":
      case "nextTab":
      case "prevTab":
      case "renameTab":
      case "tabSwitcher":
      case "splitRight":
      case "splitDown":
      case "closeSplit":
      case "swapPanes":
      case "focusOtherPane":
      case "toggleFilePanel":
      case "find":
      case "searchChats":
      case "focusPad":
      case "focusInput":
      case "transferPad":
      case "send":
      case "shortcutsHelp":
        onShortcut({ action: id });
        return;
      default: {
        const unhandled: never = id;
        throw new Error(`Unhandled palette action: ${String(unhandled)}`);
      }
    }
  };

  const runPalette = (id: string) => {
    setPaletteOpen(false);
    const route = parsePaletteId(id);
    if (!route) return;
    if (route.kind === "goto") {
      void handleSelectTab(route.tabId);
      return;
    }
    if (route.kind === "model") {
      runPaletteModel(route.model);
      return;
    }
    runPaletteAction(route.id);
  };

  const setFollowUpFor = (tabId: string | null, value: string) => {
    if (!tabId) return;
    patchRuntime(tabId, (rt) => ({ ...rt, followUp: value }));
  };
  const setFollowUp = (value: string) => setFollowUpFor(activeTabId, value);

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

  const modelForTab = (tab: TabSummary): string | null => {
    if (!tabHasModel(tab)) return null;
    return runtimes[tab.id]?.session?.model ?? tab.model ?? inheritedModel(tab);
  };

  const tabBar = (
    <TabBar
      tabs={savedTabs}
      activeTabId={activeTabId}
      roleColors={roleColors}
      disableSwitch={busy && !session}
      disableNew={busy}
      statuses={tabStatuses}
      renamingTabId={renamingTabId}
      onRenameStart={setRenamingTabId}
      onRename={(tabId, label) => {
        void setTabLabel(tabId, label)
          .then(() => refreshTabs())
          .catch(() => {});
      }}
      onRenameEnd={() => setRenamingTabId(null)}
      canReopen={closedTabs.length > 0}
      settingsOpen={settingsOpen}
      roleRulesOff={!!approvalMode?.roleRulesOff}
      roleNames={roleNames}
      modelFor={modelForTab}
      onSelect={handleSelectTab}
      onClose={handleCloseTab}
      onNew={handleNewTab}
      onNewWorktree={() => setWorktreeDialogOpen(true)}
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
      notificationSettings={notificationSettings}
      onNotificationSettings={updateNotificationSettings}
      uiSettings={uiSettings.ui}
      onUiSettings={uiSettings.update}
      onTestNotification={agentNotifications.sendTest}
      modelList={modelList}
      modelSettings={modelSettings}
      onModelSettings={(next) => {
        setModelSettingsState(next);
        void setModelSettings(next)
          .then(setModelSettingsState)
          .catch(() => {});
      }}
      modelsRefreshing={modelsRefreshing}
      onRefreshModels={() => {
        void refreshModelList().catch(() => {});
      }}
      approvalMode={approvalMode}
      onClose={() => setSettingsOpen(false)}
    />
  );

  const changesTab = changesTabId ? savedTabs.find((tab) => tab.id === changesTabId) : undefined;

  /** F8: setup finished: put the role and folder on the active draft tab, then Start. */
  const finishFirstRun = (choice: FirstRunFinish) => {
    setFirstRunOpen(false);
    void firstRunComplete().catch(() => {});
    chooseRole(choice.roleId);
    setField("cwd", choice.folder);
    setPendingStart(choice);
    rememberSurface(choice.roleId, choice.surface);
  };

  const skipFirstRun = () => {
    setFirstRunOpen(false);
    void firstRunComplete().catch(() => {});
  };

  /** F7: open the workspaces dialog (and push the active form to state.json). */
  function openWorkspaces(focusSave: boolean) {
    stashActiveTab();
    setWorkspacesOpen({ focusSave });
    setWorkspaceError(null);
    void workspacesList()
      .then(setWorkspaceList)
      .catch((err: unknown) =>
        setWorkspaceError(err instanceof Error ? err.message : String(err)),
      );
  }

  const saveWorkspaceAs = async (name: string, replace: boolean) => {
    stashActiveTab();
    setWorkspaceList(await workspaceSave(name, replace));
  };

  /** F7: open a saved workspace as new tabs; `replace` closes the open ones. */
  const openWorkspace = async (id: string, replace: boolean) => {
    const old = savedTabs;
    if (replace) {
      const live = old.filter(
        (t) => t.phase === "running" || (t.kind === "terminal" && livePty(t.id)),
      );
      if (
        live.length > 0 &&
        !window.confirm(
          `Replace the open tabs? ${live.length} running agent or terminal${
            live.length === 1 ? "" : "s"
          } will be stopped. Closed tabs stay in Reopen closed tab.`,
        )
      ) {
        return;
      }
      for (const t of old) {
        const rt = runtimes[t.id];
        if (rt && rt.segments.length > 0) {
          await transcriptSave(t.id, segmentsToPlainText(rt.segments), rt.session?.cwd ?? t.cwd).catch(
            () => {},
          );
        }
      }
    }
    scratch.flush();
    stashActiveTab();
    const result = await workspaceOpen(id, replace);
    if (replace) {
      for (const t of old) {
        delete draftsRef.current[t.id];
        delete knownFoldersRef.current[t.id];
        delete scrollPositions.current[t.id];
        dropLivePty(t.id);
        destroyTerminal(t.id);
      }
      setRuntimes((prev) => {
        const next = { ...prev };
        for (const t of old) delete next[t.id];
        return next;
      });
      setSplit((current) => closeSplit(current));
    }
    setSavedTabs(result.state.tabs);
    setClosedTabs(result.state.closedTabs ?? []);
    setWorkspacesOpen(null);
    const activeId = result.state.activeTabId;
    const summary = result.state.tabs.find((t) => t.id === activeId);
    if (activeId && summary?.kind === "terminal") {
      setActiveTabId(activeId);
    } else if (activeId) {
      const { tab } = await selectActiveTab(activeId);
      if (tab.kind === "terminal") setActiveTabId(tab.id);
      else loadTabIntoForm(tab);
    }
    if (result.skipped.length > 0) {
      showNotice(
        "Some workspace tabs were not opened",
        `Their role no longer exists: ${result.skipped.join(", ")}`,
        "failed",
      );
    }
  };

  /** The active tab's pad editor (chat pad or terminal pad), if mounted. */
  const activePadField = (): HTMLTextAreaElement | null => {
    const summary = savedTabs.find((tab) => tab.id === activeTabIdRef.current);
    if (summary?.kind === "terminal") return terminalPadRef.current?.field() ?? null;
    return padRef.current;
  };

  function notePadSelection() {
    const field = activePadField();
    const tabId = activeTabIdRef.current;
    if (!field || !tabId) return;
    padSelectionRef.current = { tabId, start: field.selectionStart, end: field.selectionEnd };
  }

  const reloadPromptLibrary = () =>
    promptLibraryGet()
      .then((lib) => {
        setPromptLibrary(lib);
        setPromptLibraryError(null);
      })
      .catch((err: unknown) =>
        setPromptLibraryError(err instanceof Error ? err.message : String(err)),
      );

  /** F6: open the library; `save` starts "Save as prompt" with the pad (or its selection). */
  function openPromptLibrary(save: boolean) {
    const field = activePadField();
    if (field && document.activeElement === field) notePadSelection();
    let saveDraft: string | null = null;
    if (save) {
      const sel = padSelectionRef.current;
      const content = scratch.content;
      const picked =
        sel && sel.tabId === activeTabIdRef.current && sel.end > sel.start
          ? content.slice(sel.start, sel.end)
          : "";
      saveDraft = picked.trim() ? picked : content;
    }
    setPromptLibraryOpen({ saveDraft });
    void reloadPromptLibrary();
  }

  const insertLibraryPrompt = (text: string, promptId: string | null) => {
    const tabId = activeTabIdRef.current;
    if (!tabId) return;
    const sel = padSelectionRef.current?.tabId === tabId ? padSelectionRef.current : null;
    const next = insertIntoPad(scratch.content, text, sel);
    scratch.setContent(tabId, next.content);
    padSelectionRef.current = { tabId, start: next.caret, end: next.caret };
    setPromptLibraryOpen(null);
    if (promptId) {
      void promptMarkUsed(promptId)
        .then(setPromptLibrary)
        .catch(() => {});
    }
    const terminal = savedTabs.find((tab) => tab.id === tabId)?.kind === "terminal";
    if (terminal) {
      blurParkedTerminal(tabId);
      terminalPadRef.current?.focus();
    }
    window.setTimeout(() => {
      const field = activePadField();
      if (!field) return;
      field.focus();
      field.setSelectionRange(next.caret, next.caret);
    }, 0);
  };

  /** F5: open the hit's tab (reopening a closed one) and land on the match. */
  const jumpToHit = async (hit: ChatSearchHit, query: string) => {
    setChatSearchQuery(null);
    const nonce = Date.now();
    try {
      if (hit.source === "live") {
        await handleSelectTab(hit.tabId);
        setFindRequest({
          tabId: hit.tabId,
          req: { query, segmentId: hit.segmentId, occurrence: hit.occurrence, nonce },
        });
        return;
      }
      const file = await transcriptLoad(hit.tabId).catch(() => null);
      if (hit.source === "closed") {
        stashActiveTab();
        const { tab } = await reopenClosedTab(hit.tabId);
        await refreshTabs();
        loadTabIntoForm(tab);
      } else {
        await handleSelectTab(hit.tabId);
      }
      setTranscriptFocus({
        tabId: hit.tabId,
        query,
        occurrence: hit.occurrence,
        text: file?.text ?? "",
        nonce,
      });
    } catch (err: unknown) {
      showNotice("Could not open that chat", err instanceof Error ? err.message : String(err), "failed");
    }
  };

  const liveChatSources = savedTabs
    .filter((tab) => (runtimes[tab.id]?.segments.length ?? 0) > 0)
    .map((tab) => ({ tabId: tab.id, label: tab.label, segments: runtimes[tab.id]!.segments }));
  const overlays = (
    <>
      {firstRunOpen && (
        <FirstRunSetup
          cli={cli}
          detect={onRedetectCli ?? detectCli}
          loginStatus={cliLoginStatus}
          roles={roles}
          initialFolder={folderForTab(values.cwd)}
          onFinish={finishFirstRun}
          onSkip={skipFirstRun}
        />
      )}
      {chatHistoryOpen && (
        <ChatHistoryDialog
          folder={folderForTab(activeTabSummary?.cwd || values.cwd)}
          load={listCursorCliHistory}
          busy={busy}
          onResume={(entry) => {
            setChatHistoryOpen(false);
            void resumeHistoryEntry(entry);
          }}
          onOpenCli={(entry) => {
            setChatHistoryOpen(false);
            void openCursorCli(entry.id, entry.cwd);
          }}
          onClose={() => setChatHistoryOpen(false)}
        />
      )}
      {workspacesOpen && (
        <WorkspacesDialog
          list={workspaceList}
          loadError={workspaceError}
          openTabCount={savedTabs.length}
          focusSave={workspacesOpen.focusSave}
          onSave={saveWorkspaceAs}
          onOpen={openWorkspace}
          onDelete={async (id) => setWorkspaceList(await workspaceDelete(id))}
          onClose={() => setWorkspacesOpen(null)}
        />
      )}
      {promptLibraryOpen && (
        <PromptLibraryDialog
          library={promptLibrary}
          loadError={promptLibraryError}
          canInsert={!!activeTabId}
          saveDraft={promptLibraryOpen.saveDraft}
          onInsert={insertLibraryPrompt}
          onSave={async (id, name, body) => setPromptLibrary(await promptSave(id, name, body))}
          onDelete={async (id) => setPromptLibrary(await promptDelete(id))}
          onClearRecent={async () => setPromptLibrary(await promptClearRecent())}
          onClose={() => setPromptLibraryOpen(null)}
        />
      )}
      {chatSearchQuery !== null && (
        <ChatSearchDialog
          initialQuery={chatSearchQuery}
          liveSources={liveChatSources}
          search={historySearch}
          loadTranscript={async (tabId) => (await transcriptLoad(tabId)).text}
          onJump={(hit, query) => void jumpToHit(hit, query)}
          onClose={() => setChatSearchQuery(null)}
        />
      )}
      {changesTab && (
        <ChangesPanel
          key={changesTab.id}
          tabId={changesTab.id}
          tabLabel={changesTab.label}
          busy={!!tabStatuses[changesTab.id]?.busy}
          accepted={new Set(acceptedChanges[changesTab.id] ?? [])}
          onAccept={(key) =>
            setAcceptedChanges((prev) => ({
              ...prev,
              [changesTab.id]: [...(prev[changesTab.id] ?? []), key],
            }))
          }
          onOpenInFilePanel={(path) => {
            setChangesTabId(null);
            if (changesTab.id !== activeTabId) void handleSelectTab(changesTab.id);
            setFilePanelOpen(true);
            setFileFocus({ path, nonce: Date.now() });
          }}
          onClose={() => {
            setChangesTabId(null);
            refreshChangeCount(changesTab.id);
          }}
        />
      )}
      {worktreeDialogOpen && (
        <WorktreeDialog
          initialRepo={activeTabSummary?.cwd || values.cwd || ""}
          roles={roles}
          defaultRoleId={
            roles.some((item) => item.id === roleId) ? roleId : (roles[0]?.id ?? "")
          }
          loadRepo={gitRepoInfo}
          onCreate={createWorktreeTab}
          onClose={() => setWorktreeDialogOpen(false)}
        />
      )}
      <AgentToasts
        toasts={agentNotifications.toasts}
        paused={!windowFocused}
        onDismiss={agentNotifications.dismiss}
        onOpen={(toast) => {
          agentNotifications.dismiss(toast.id);
          if (savedTabsRef.current.some((tab) => tab.id === toast.tabId)) {
            setSettingsOpen(false);
            void handleSelectTab(toast.tabId);
          }
        }}
      />
      {paletteOpen && (
        <CommandPalette
          tabs={savedTabs.map((tab) => ({ id: tab.id, label: tab.label, cwd: tab.cwd }))}
          canReopen={closedTabs.length > 0}
          splitOpen={splitOpen(split)}
          canSendPlan={(roleId === "role_planner" && !!session) || !!isPlannerTerminal}
          canRemoveWorktree={!!activeTabSummary?.worktreePath}
          model={paletteModel}
          initialQuery={palettePrefill.query}
          key={palettePrefill.key}
          onRun={runPalette}
          onClose={() => setPaletteOpen(false)}
        />
      )}
      {switcherOpen && (
        <TabSwitcher
          tabs={savedTabs}
          activeTabId={activeTabId}
          statuses={tabStatuses}
          onSelect={(tabId) => {
            setSwitcherOpen(false);
            void handleSelectTab(tabId);
          }}
          onClose={() => setSwitcherOpen(false)}
        />
      )}
      {splitPicker && (
        <TabSwitcher
          title={splitPicker === "horizontal" ? "Split right with tab" : "Split down with tab"}
          placeholder="Show which tab in the second pane?"
          tabs={splitCandidates(savedTabs, activeTabId)}
          onSelect={(tabId) => {
            const mode = splitPicker;
            setSplitPicker(null);
            setSplit((current) => ({
              mode,
              secondaryTabId: tabId,
              primarySize: clampSplitSize(current.primarySize),
            }));
          }}
          onClose={() => setSplitPicker(null)}
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

  const secondaryTab =
    !settingsOpen && splitOpen(split) && split.secondaryTabId !== activeTabId
      ? savedTabs.find((tab) => tab.id === split.secondaryTabId)
      : undefined;

  const renderSecondary = (tab: TabSummary) => {
    const rt = runtimes[tab.id];
    const liveChat = tab.kind !== "terminal" && !!rt?.session;
    let body: ReactNode;
    if (tab.kind === "terminal") {
      const tabLaunch =
        tab.terminalLaunch === "cursor-cli"
          ? "cursor-cli"
          : tab.terminalLaunch === "role"
            ? "role"
            : "shell";
      body = (
        <TerminalView
          key={tab.id}
          ptyId={tab.id}
          cwd={tab.cwd}
          launch={tabLaunch}
          roleId={tab.roleId}
          fontSize={fontSize}
          resumeSessionId={tab.resumeSessionId}
          autoOpen={!livePty(tab.id)}
          autoFocus={false}
        />
      );
    } else if (rt?.session) {
      const attach = rt.startResult?.injectionStrategy === "attach_to_first_message";
      body = (
        <SessionTerminal
          key={tab.id}
          title={tab.label}
          findRequest={findRequest?.tabId === tab.id ? findRequest.req : null}
          onSearchAllChats={(query) => setChatSearchQuery(query)}
          branch={tab.worktreeBranch ?? null}
          cwd={rt.session.cwd}
          sessionId={rt.session.sessionId}
          segments={rt.segments}
          promptInFlight={rt.promptInFlight}
          followUp={rt.followUp}
          busy={busy}
          canSendFollowUp={!attach || !rt.startResult?.startupInjected}
          promptError={rt.promptError}
          permissionRequest={rt.permission}
          onPermissionSelect={(optionId) => void respondPermissionFor(tab.id, optionId)}
          onPermissionCancel={() => void respondPermissionFor(tab.id, null)}
          onCancelTurn={() => void cancelTurnFor(tab.id)}
          onFollowUpChange={(value) => setFollowUpFor(tab.id, value)}
          onSendFollowUp={() => void sendFollowUpFor(tab.id)}
          onStop={() => void stopSecondarySession(tab.id)}
          folderWarning={rt.folderWarning}
          agentExited={rt.agentExited}
          onRestart={() => void stopSecondarySession(tab.id)}
          inputRef={secondaryInputRef}
          headerExtra={
            <>
              {modelPickerFor(tab, rt.session.model)}
              {changesButton(tab.id)}
            </>
          }
        />
      );
    } else {
      body = (
        <div className="split-pane-empty">
          <p className="hint">This tab has no running session.</p>
          <button type="button" className="secondary-button" onClick={swapPanes}>
            Open in main pane
          </button>
        </div>
      );
    }
    const planWaiting = planRequest?.tabId === tab.id;
    return (
      <div
        className={
          focusedPane === "secondary" ? "split-pane split-pane-focused" : "split-pane"
        }
        data-pane="secondary"
        aria-label={`Second pane: ${tab.label}`}
        onFocusCapture={() => setFocusedPane("secondary")}
        onMouseDown={() => setFocusedPane("secondary")}
      >
        <div className="split-pane-bar">
          <span className="split-pane-title" title={tab.cwd}>
            {tab.label}
          </span>
          {!liveChat && modelPickerFor(tab)}
          <span className="split-pane-spacer" />
          <button
            type="button"
            className="secondary-button"
            onClick={swapPanes}
            title="Swap panes"
            aria-label="Swap panes"
          >
            Swap
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              setSplit((current) => closeSplit(current));
              setFocusedPane("primary");
            }}
            title="Close split"
            aria-label="Close split"
          >
            Close
          </button>
        </div>
        {planWaiting && (
          <p className="hint split-pane-note">
            A plan is waiting for review. Swap panes to answer it.
          </p>
        )}
        <div className="split-pane-body">{body}</div>
      </div>
    );
  };

  const activeCwd = activeTabSummary?.cwd ?? "";
  const filePanel =
    filePanelOpen && !settingsOpen && activeTabId ? (
      <div className="file-panel-shell" style={{ width: filePanelWidth }}>
        {activeCwd ? (
          <FilePanel
            key={activeTabId}
            tabId={activeTabId}
            cwd={activeCwd}
            platform={platform}
            focusFile={fileFocus}
            onInsertReference={(path) => {
              scratch.setContent(activeTabId, appendReference(scratch.content, path));
            }}
            onClose={() => setFilePanelOpen(false)}
          />
        ) : (
          <div className="file-panel">
            <p className="hint">Choose a working folder to see its files.</p>
          </div>
        )}
        <div
          className="file-panel-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize file panel"
          onMouseDown={(event) => {
            event.preventDefault();
            const startX = event.clientX;
            const startWidth = filePanelWidth;
            const onMove = (move: MouseEvent) => {
              const next = Math.min(900, Math.max(160, startWidth + move.clientX - startX));
              setFilePanelWidth(next);
            };
            const onUp = () => {
              window.removeEventListener("mousemove", onMove);
              window.removeEventListener("mouseup", onUp);
            };
            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup", onUp);
          }}
        />
      </div>
    ) : null;

  const activeStatus = ((): { tone: StatusTone; text: string } => {
    const tab = activeTabSummary;
    const marks = activeTabId ? tabStatuses[activeTabId] : undefined;
    if (!tab) return { tone: "idle", text: "No tab" };
    if (marks?.needsYou) return { tone: "needs", text: tabStatusLabel(marks) };
    if (tab.kind === "terminal") {
      const kind =
        tab.terminalLaunch === "cursor-cli"
          ? "Cursor CLI"
          : tab.terminalLaunch === "role"
            ? "Role terminal"
            : "Terminal";
      return marks?.busy ? { tone: "busy", text: `${kind} · working` } : { tone: "ok", text: kind };
    }
    if (session) {
      const activity = summarizeSessionActivity(streamSegments, {
        promptInFlight: !!promptInFlight,
        waitingPermission: !!permissionRequest,
      });
      if (activity) return { tone: permissionRequest ? "needs" : "busy", text: activity };
      return { tone: "ok", text: activeRuntime.agentExited ? "Agent exited" : "Ready" };
    }
    return { tone: "idle", text: "Not started" };
  })();
  const statusMessages: StatusMessage[] = [
    ...(session && activeRuntime.folderWarning
      ? [{ id: "folder", text: activeRuntime.folderWarning, tone: "warn" as const }]
      : []),
    ...(modelNotice
      ? [{ id: "model", text: modelNotice, tone: "info" as const, onDismiss: () => setModelNotice(null) }]
      : []),
  ];
  const statusBar = (
    <StatusBar
      status={activeStatus}
      model={activeTabSummary ? modelForTab(activeTabSummary) : null}
      folder={session?.cwd || activeTabSummary?.cwd || folderForTab(values.cwd) || null}
      branch={activeTabSummary?.worktreeBranch ?? null}
      roleRulesOff={!!approvalMode?.roleRulesOff}
      messages={statusMessages}
    />
  );

  const shell = (content: ReactNode) => (
    <section className="workspace-shell">
      {tabBar}
      <div className="workspace-body">
        {filePanel}
        <div className="workspace-main">
          <WorkspaceSplit
            mode={secondaryTab ? split.mode : "single"}
            primarySize={clampSplitSize(split.primarySize)}
            onResize={(size) => {
              const next = clampSplitSize(size);
              setSplit((current) =>
                Math.abs(clampSplitSize(current.primarySize) - next) < 0.5
                  ? current
                  : { ...current, primarySize: next },
              );
            }}
            primary={
              <div
                className={
                  secondaryTab && focusedPane === "primary"
                    ? "split-pane split-pane-primary split-pane-focused"
                    : "split-pane split-pane-primary"
                }
                data-pane="primary"
                onFocusCapture={() => setFocusedPane("primary")}
                onMouseDown={() => setFocusedPane("primary")}
              >
                {content}
              </div>
            }
            secondary={secondaryTab ? renderSecondary(secondaryTab) : null}
          />
        </div>
      </div>
      {statusBar}
      {overlays}
    </section>
  );
  if (activeTabSummary?.kind === "terminal" && !settingsOpen) {
    const linked = handoffs.find((item) => item.targetTabId === activeTabId) ?? null;
    const launch =
      activeTabSummary.terminalLaunch === "cursor-cli"
        ? "cursor-cli"
        : activeTabSummary.terminalLaunch === "role"
          ? "role"
          : "shell";
    const terminalModelPicker = modelPickerFor(activeTabSummary);
    return shell(
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
          {(isPlannerTerminal ||
            terminalModelPicker ||
            activeTabSummary.worktreeBranch ||
            activeTabSummary.cwd) && (
            <div className="terminal-toolbar">
              {activeTabSummary.worktreeBranch && (
                <span
                  className="session-branch"
                  aria-label="Git branch"
                  title={activeTabSummary.worktreePath ?? undefined}
                >
                  ⎇ {activeTabSummary.worktreeBranch}
                </span>
              )}
              {terminalModelPicker}
              {activeTabSummary.cwd && changesButton(activeTabSummary.id)}
              {isPlannerTerminal && (
                <HandoffActions
                  enabled
                  reason={null}
                  busy={busy}
                  onSend={(target) => {
                    void openTerminalHandoff(target);
                  }}
                />
              )}
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
          <TerminalScratchPad
            ref={terminalPadRef}
            tabId={activeTabSummary.id}
            ptyId={activeTabSummary.id}
            content={scratch.content}
            truncated={scratch.truncated}
            persistError={scratch.persistError}
            platform={platform}
            onChange={(value) => scratch.setContent(activeTabSummary.id, value)}
            onBlur={() => {
              notePadSelection();
              scratch.flush();
            }}
            onSent={(text) => void promptRecordSend(text, "terminal").catch(() => {})}
            onOpenLibrary={() => openPromptLibrary(false)}
            write={ptyWrite}
            bracketedPaste={terminalBracketedPaste(activeTabSummary.id)}
            onFocusTerminal={focusActiveTerminal}
            onFocusPad={() => blurParkedTerminal(activeTabSummary.id)}
            onOpenChange={() => refitTerminal(activeTabSummary.id)}
            open={padOpen}
            onOpenToggle={(open) => uiSettings.update({ padHidden: !open })}
            {...padSizeProps}
          />
        </section>,
    );
  }

  if (!role) {
    if (settingsOpen) {
      return (
        <section className="workspace-shell">
          {tabBar}
          {settingsPage}
          {overlays}
        </section>
      );
    }
    return shell(<p className="hint empty-state">Loading…</p>);
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
        <label
          key={field.key}
          className={`field-label${field.type === "multiline" ? " field-label-wide" : ""}`}
        >
          {field.label}
          {field.required ? " *" : ""}
          {field.type === "multiline" ? (
            <textarea
              className="text-input prompt-area"
              rows={3}
              data-field-key={field.key}
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
              data-field-key={field.key}
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

  const blankRoleKey =
    launchChoice === "cursor-cli" ? "cursor-cli" : launchChoice === "shell" ? null : roleId || null;
  const blankModelPicker =
    activeTabSummary && blankRoleKey ? (
      <ModelPicker
        compact
        models={modelList?.models ?? []}
        value={activeTabSummary.model ?? null}
        inherited={{ model: effectiveModel(modelSettings, blankRoleKey, null), label: "Default" }}
        ariaLabel="Model for this tab"
        disabled={busy}
        onChange={(model) => {
          const tabId = activeTabSummary.id;
          void setTabModel(tabId, model)
            .then(() => refreshTabs())
            .catch((err: unknown) =>
              setModelNotice(err instanceof Error ? err.message : String(err)),
            );
        }}
      />
    ) : null;

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
      {(savedTranscript || focusedTranscript) && (
        <details
          className="startup-form-details"
          open={focusedTranscript ? true : undefined}
          key={transcriptFocus?.tabId === activeTabId ? `focus-${transcriptFocus?.nonce}` : "plain"}
        >
          <summary>Last session transcript (read-only)</summary>
          {transcriptFocus && focusedTranscript ? (
            <TranscriptView
              text={savedTranscript || focusedTranscript}
              query={transcriptFocus.query}
              occurrence={transcriptFocus.occurrence}
              label="Saved transcript"
            />
          ) : (
            <pre className="mono-snippet transcript-preview">{savedTranscript}</pre>
          )}
        </details>
      )}
    </div>
  );

  // U5: model, preview, and Start sit on the start row; extras go under it.
  const startButtons = showFields && (
    <>
      {blankModelPicker}
      <button
        type="button"
        className="secondary-button"
        onClick={runPreview}
        disabled={busy || previewBusy}
        aria-label="Validate & preview"
        title="Check the fields and show the merged startup prompt"
      >
        {previewBusy ? "…" : "Preview"}
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
    </>
  );

  const idleActions = showFields && (
    <>
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
    return shell(
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
              findRequest={
                activeTabId && findRequest?.tabId === activeTabId ? findRequest.req : null
              }
              onSearchAllChats={(query) => setChatSearchQuery(query)}
              branch={activeTabSummary?.worktreeBranch ?? null}
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
              statusInBar
              details={[
                `Role: ${roleNames[roleId] ?? roleId}`,
                `Model: ${session.model ?? (activeTabSummary ? modelForTab(activeTabSummary) : "") ?? ""}`,
              ].join("\n")}
              headerExtra={
                <>
                  {modelPickerFor(activeTabSummary, session.model)}
                  {activeTabSummary && changesButton(activeTabSummary.id)}
                </>
              }
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
          onBlur={() => {
            notePadSelection();
            scratch.flush();
          }}
          onOpenLibrary={() => openPromptLibrary(false)}
          collapsed={!padOpen}
          onToggle={() => uiSettings.update({ padHidden: padOpen })}
          {...padSizeProps}
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
        </section>,
    );
  }

  if (settingsOpen) {
    return (
      <section className="workspace-shell">
        {tabBar}
        {settingsPage}
        {overlays}
      </section>
    );
  }

  return shell(
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
          <div className="empty-state-card start-screen">
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
            <div className="start-row" role="group" aria-label="Start a tab">
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
                    title="Open as chat"
                  >
                    Chat
                  </button>
                  <button
                    type="button"
                    className="role-choice"
                    aria-pressed={rememberedSurface(pickedRoleId) === "terminal"}
                    onClick={() => rememberSurface(pickedRoleId, "terminal")}
                    disabled={busy}
                    aria-label="Terminal"
                    title="Open as terminal (agent CLI in a terminal)"
                  >
                    <span aria-hidden>›_</span>
                  </button>
                </div>
              )}
              <FolderPicker
                compact
                value={displayedFolder}
                unavailable={folderNotice?.tone === "error"}
                disabled={busy}
                onChange={(path) => setField("cwd", path)}
              />
              <span className="start-row-spacer" aria-hidden />
              {launchChoice ? (
                <>
                  {launchChoice === "cursor-cli" && blankModelPicker}
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
                </>
              ) : (
                startButtons
              )}
            </div>
            {folderNotice?.tone === "error" && <p className="error">{folderNotice.text}</p>}
            {activeTabSummary?.worktreeBranch && (
              <p className="hint">
                Worktree on branch <strong>{activeTabSummary.worktreeBranch}</strong>. Remove it
                from the command palette when you are done.
              </p>
            )}
            <div
              className={`start-body${historyFolder && !launchChoice ? " start-body-with-history" : ""}`}
            >
              <div className="start-main">
                {!launchChoice && (
                  <>
                    {restoreActions}
                    {composerFields}
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
              {historyFolder && !launchChoice && (
                <aside className="start-history">
                  <CursorHistoryList
                    entries={historyEntries}
                    error={historyError}
                    busy={busy}
                    onResume={(entry) => void resumeHistoryEntry(entry)}
                    onOpenCli={(entry) => void openCursorCli(entry.id, entry.cwd)}
                  />
                </aside>
              )}
            </div>
          </div>
        </div>,
  );
}
