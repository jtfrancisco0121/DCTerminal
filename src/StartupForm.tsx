import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  acpSetModel,
  getPipelineRun,
  type PipelineRun,
  type RunLane,
  closeTab,
  devSessionCancel,
  getLayout,
  getModelSettings,
  listModels,
  setModelSettings,
  ptyKill,
  setTabModel,
  setTabProvider,
  providerStatus,
  type ModelList,
  type ProviderModelSettings,
  devSessionSend,
  devSessionLive,
  devSessionStop,
  cursorApprovalMode,
  createExecutionPipelineTabs,
  createPipelineTabs,
  openGithubTab,
  openPreviewTab,
  diagnosticsReadLog,
  diagnosticsSetCapture,
  diagnosticsStatus,
  sessionAgentLogs,
  listenPermissionAuto,
  listenPermissionRequests,
  listenPlanRequests,
  listenQuestionRequests,
  respondPermissionRequest,
  respondPlanRequest,
  respondQuestionRequest,
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
  ackProviderNotice,
  getClaudeUsage,
  listenNewWindow,
  listClaudeHistory,
  listCursorCliHistory,
  newDraftTab,
  openAccountWindow,
  openChainOverview,
  chainLoopBack,
  setTabChain,
  startEagleEye,
  startupNotices,
  onWindowCloseRequested,
  roleSessionStart,
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
  handoffGet,
  handoffList,
  ptyWrite,
  roleTerminalStart,
  scratchSave,
  setTerminalSettings,
  shellTerminalStart,
  terminalPlanFile,
  terminalSessionLog,
  validateAndPreview,
  type ClosedTabSummary,
  type FieldError,
  type CliDetectResult,
  type ApprovalModeStatus,
  type DiagnosticsStatus,
  type Role,
  type RoleSessionStartResult,
  type HandoffRecord,
  type PlanFileInfo,
  type RoleSummary,
  type SessionUpdateEvent,
  type TabSummary,
  type TerminalSessionLog,
  type TerminalSettings,
  type ValidatePreviewResult,
} from "./bridge";
import { loadHistoryInTwoPasses } from "./historyLoad";
import {
  applyAutoPermission,
  applyPermission,
  applyPlan,
  applyPromptFinished,
  applyQuestion,
  applySessionUpdate,
  clearPlan,
  clearQuestion,
  clearLiveSession,
  emptyRuntime,
  folderStatusMessage,
  runtimeFor,
  type TabRuntime,
} from "./liveTabs";
import { blockedSlashCommand } from "./composer/slashCommands";
import { CommandPalette } from "./components/CommandPalette";
import { useConfirm } from "./components/confirm";
import { Dialog } from "./components/Dialog";
import { InlineNotice, errorText } from "./components/InlineNotice";
import {
  HandoffBanner,
  HandoffDialog,
  type LoopBackTarget,
  SavedPlanDialog,
} from "./components/HandoffDialog";
import { PipelineOverview } from "./components/PipelineOverview";
import { PreviewTab } from "./components/PreviewTab";
import { GitHubTab } from "./components/GitHubTab";
import { useGithubPoller } from "./github/useGithubPoller";
import { PreviewSlot } from "./preview/PreviewLayer";
import { DEFAULT_PREVIEW_URL } from "./preview/previewUrl";
import { relativeToCwd } from "./terminal/links";
import { destroyTerminal, readTerminalHandoff } from "./components/TerminalView";
import {
  handoffBlockReason,
  handoffTargets,
  isCaptureSource,
  isHandoffSource,
  isPlanSource,
  latestAgentMessage,
  latestReplyText,
  composePlanText,
  roleDisplayName,
  selectionInside,
  terminalHandoffInput,
  terminalLogFields,
  type HandoffField,
  type HandoffScope,
  type HandoffSource,
  type HandoffSurface,
  type HandoffTargetId,
} from "./handoff/map";
import { runTranscriptExport } from "./export/runTranscriptExport";
import { LogDrawer } from "./components/LogDrawer";
import { SettingsPage } from "./components/SettingsPage";
import { StatusBar, type StatusMessage, type StatusTone } from "./components/StatusBar";
import { summarizeSessionActivity } from "./sessionActivity";
import { chatSessionStatus } from "./chatStatus";
import { folderForTab } from "./projectsView";
import {
  canContinueStoredSession,
  clearFormText,
  folderToWrite,
  formTextOf,
  mergeTabDraft,
  tabFormFromRecord,
  tabWasStarted,
  tabSurface,
  toggleSettings,
  type TabDraft,
} from "./workspaceView";
import type { TerminalPadHandle } from "./components/TerminalScratchPad";
import { ShortcutsOverlay } from "./components/ShortcutsOverlay";
import {
  addAccepted,
  loadAccepted,
  saveAccepted,
  type AcceptedChanges,
} from "./changes/acceptedStore";
import { FilePanel, type FileDiscardGuard } from "./components/FilePanel";
import { AgentToasts } from "./components/AgentToasts";
import { WorktreeDialog, type WorktreeCreateInput } from "./components/WorktreeDialog";
import { ChangesPanel } from "./components/ChangesPanel";
import { PanelResizer } from "./components/PanelResizer";
import { ActivityPanel } from "./components/ActivityPanel";
import { ChatSearchDialog, type ChatSearchHit } from "./components/ChatSearchDialog";
import { PromptLibraryDialog, type PromptLibraryView } from "./components/PromptLibraryDialog";
import { WorkspacesDialog } from "./components/WorkspacesDialog";
import { FirstRunSetup, type FirstRunFinish } from "./components/FirstRunSetup";
import { insertIntoPad, type PadSelection } from "./prompts/library";
import { startQueue } from "./terminal/startQueue";
import {
  chainRound,
  chainTabFor,
  loopBackChain,
  loopBackRecord,
  newChain,
  type ChainRef,
} from "./handoff/chains";
import { handoffRoute, loopBackMessage } from "./handoff/routing";
import {
  attachHandoff,
  claimManualHandoff,
  handoffFieldsOf,
  prepareHandoff,
  saveHandoff,
} from "./handoff/executor";
import { behaviourRole, pipelineDef, pipelineStages, roleBehaviour, stageBehaviour } from "./pipeline/defs";
import { useAutopilot } from "./pipeline/useAutopilot";
import { onceValue, subscribeAutopilotStops } from "./pipeline/autopilotStops";
import { terminalStageSource, turnId } from "./pipeline/autopilot";
import { approveByHand, fanOutRun, planStageFor, stageTab, startLane } from "./pipeline/fanOut";
import {
  isReviewerRole,
  parseReviewVerdict,
  terminalLogVerdict,
  type ReviewVerdict,
} from "./handoff/verdict";
import { limitAlerts, statusLimit } from "./usage/limits";
import { stopNotice } from "./pipeline/stopReasons";
import type { ChatFindRequest } from "./SessionTerminal";
import { classifyPromptFinished, DATA_RECOVERED_SLOT, type NotificationSettings } from "./notify/agentNotify";
import { showSystemNotification } from "./notify/systemNotify";
import { useAgentNotifications } from "./notify/useAgentNotifications";
import { isWindowFocused, useWindowFocused } from "./notify/windowFocus";
import { terminalActivity } from "./terminal/activity";
import {
  afterSessionLogRead,
  sameSessionLog,
  sessionLogDue,
  sessionLogTick,
  type SessionLogPollState,
} from "./terminal/sessionLogPoll";
import {
  deriveTerminalState,
  dialogAfterRead,
  dialogDrawn,
  dialogToolFor,
  logRecordsSeen,
  quietTurnIds,
  sameTerminalState,
  terminalNeedsMessage,
  terminalWaitingText,
  type DialogOwner,
  type LogRecordsSeen,
  type TerminalState,
} from "./terminal/claudeState";
import { dialogDetector } from "./terminal/permissionDialog";
import { headerStateOf, trackWorkingSince } from "./terminal/headerState";
import {
  clearMarks,
  computeTabStatus,
  IDLE_STATUS,
  markAfterTurn,
  tabStatusLabel,
  type TabMark,
  type TabStatus,
} from "./tabStatus";
import { appendReference } from "./files/paths";
import { effectiveModelFor, modelChangeNote } from "./models";
import { TabSwitcher } from "./components/TabSwitcher";
import { launchProviders, RoleLauncher, type RoleLaunch } from "./components/RoleLauncher";
import { useNewTab } from "./useNewTab";
import { activeTabFolder } from "./newTab";
import { liveTabs } from "./liveWork";
import { startTerminalTab, type NewTerminalLaunch } from "./terminal/openTerminalTab";
import { detectPlatform, keySurface, type ShortcutMatch, type TerminalAction } from "./keymap";
import {
  beginLivePty,
  dropLivePty,
  livePty,
  notePtyInput,
  ptyExitCode,
  rekeyLivePty,
  subscribeLivePty,
  subscribePtyExit,
} from "./terminal/live";
import {
  blurParkedTerminal,
  copyTerminalSelection,
  focusParkedTerminal,
  focusedTerminalId,
  parkedTerminal,
  pasteTerminalText,
  setOptionAsMeta,
  setCopyOnSelect,
  setTerminalFileOpener,
  clearTerminalScrollback,
  zoomedFontSize,
  requestTerminalSearch,
  setLinkOpenErrorHandler,
  terminalBracketedPaste,
  terminalScrollbackText,
  terminalSelection,
  terminalTailText,
  measuredTerminalSize,
} from "./terminal/park";
import { encodeTerminalPaste } from "./terminal/paste";
import { terminalViewOf } from "./terminal/chatEntries";
import { pressStop } from "./terminal/ptyAnswers";
import { saveLayout } from "./layoutSave";
import { reportError, setErrorNotifier } from "./uiErrors";
import { createSwitchTickets } from "./tabSwitch";
import { runStartupSteps, type StartupFailure, type StartupStep } from "./startupSteps";
import { toggledView, useTerminalViews } from "./terminal/terminalViews";
import { forgetComposerDraft, type TerminalComposerHandle } from "./views/TerminalChatControls";
import { usePrunePlanPanes } from "./views/planPaneState";
import { planFileMentions } from "./terminal/text";
import {
  emptySessionCards,
  reduceSessionCards,
  type SessionCards as Cards,
} from "./sessionCards";
import {
  chainMarkSent,
  chainMarkSettled,
  chainStart,
  chainStepToSend,
  chainStop,
  splitChainSteps,
  firstChainStep,
  padAfterSend,
  padSelection,
  transferToInput,
  type ChainCursor,
  type TurnOutcome,
} from "./scratch/pad";
import { chainAfterAgentRequest } from "./scratch/chainPause";
import { createTurnWaiter } from "./scratch/turnWait";
import { answersForRole, fieldsForForm } from "./startupFields";
import { ShortcutBar } from "./components/ShortcutBar";
import { FIRST_USE_TIP_ID, FirstUseTip, shouldShowTip } from "./components/FirstUseTip";
import { normalizeTheme, THEME_CHOICES } from "./theme";
import { ChatHistoryDialog } from "./components/ChatHistoryDialog";
import {
  resumeIdForStart,
  segmentsAfterResume,
  segmentsWhileStarting,
  type CursorHistoryEntry,
} from "./cursorHistory";
import { TabBar } from "./TabBar";
import {
  addToGrid,
  clampSplitSize,
  closeSplit,
  emptySplit,
  GRID_MAX_TABS,
  gridOpen,
  openGrid,
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
import { isEditableTarget } from "./PermissionCard";
import { useScratchPads } from "./useScratchPads";
import { headerControls } from "./views/SessionHeaderControls";
import { TerminalTabView } from "./views/TerminalTabView";
import { ChatSessionView } from "./views/ChatSessionView";
import { StartScreen } from "./views/StartScreen";
import { createPaneRenderers } from "./views/workspacePanes";
import { terminalHeaderFor, terminalHeaderState, type TerminalHeaderDeps } from "./views/terminalHeader";
import { WorkspaceShell } from "./views/WorkspaceShell";
import {
  CLI_LABEL,
  type CliLaunch,
  isClaudeTerminal,
  tabHasModel,
  visibleFields,
} from "./views/tabHelpers";
import { useChatImages } from "./attachments/useChatImages";
import { withImageMarkers } from "./attachments/chatImages";
import { promptNeedsSnapshot, snapshotTerminalTurn } from "./changes/turnSnapshot";
import { useUiSettings } from "./useUiSettings";
import { useProviders } from "./provider/useProviders";
import { useClaudeVersionNotice } from "./terminal/claudeVersion";
import {
  modelsForProvider,
  providerIndicator,
  providerTooltipLine,
  tabHasProvider,
} from "./provider/descriptor";
import { claudeAccounts, providerForRole, type ProviderId } from "./provider/types";
import {
  acceptNewWindowRequest,
  ensureWindow,
  isNewWindowShortcut,
  newWindowShortcutLabel,
  shortcutPlatform,
  type WindowContext,
} from "./windowScope";
import {
  appendStreamSegment,
  streamSegmentFromSystemMessage,
  streamSegmentFromUserMessage,
  segmentsToPlainText,
} from "./transcript";

/** A role terminal running Claude Code (not Cursor CLI, not a shell). */
function isClaudeRoleTerminal(tab: TabSummary): boolean {
  return tab.kind === "terminal" && tab.terminalLaunch === "role" && tab.provider !== "cursor";
}

/** The prompt was written after `sinceMs` (a little slack for clock rounding). */
function promptAfter(promptAt: string | null | undefined, sinceMs: number): boolean {
  const at = promptAt ? Date.parse(promptAt) : NaN;
  return Number.isFinite(at) && at >= sinceMs - 2000;
}

/** A finished terminal turn's toast text: a reviewer's verdict, else its last line. */
function finishedDetail(roleId: string, log: TerminalSessionLog, chainKind?: string | null): string {
  if (isReviewerRole(roleId, chainKind)) {
    const verdict = terminalLogVerdict(log, "");
    if (verdict) return `Verdict: ${verdict}`;
  }
  const lines = log.lastReply
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[lines.length - 1] ?? "Claude finished its turn.";
}

/**
 * Plan file names a terminal printed (they win), and the names other
 * terminals printed (another Planner's plan, never this tab's).
 */
function terminalPlanNames(
  tabs: readonly TabSummary[],
  tabId: string,
  scrollback: string,
): { mentioned: string[]; claimed: string[] } {
  const mentioned = planFileMentions(scrollback);
  const claimed = tabs
    .filter((tab) => tab.kind === "terminal" && tab.id !== tabId)
    .flatMap((tab) => planFileMentions(terminalScrollbackText(tab.id)))
    .filter((name) => !mentioned.includes(name));
  return { mentioned, claimed };
}

type Props = {
  roles: RoleSummary[];
  cli: CliDetectResult | null;
  cliError: string | null;
  /** Why the roles failed to load, if they did. */
  rolesError?: string | null;
  cliFound: boolean;
  showDevTools: boolean;
  /** F8: re-run CLI detection (App keeps the result). */
  onRedetectCli?: () => Promise<CliDetectResult>;
  onRefreshRoles?: () => Promise<void>;
  /** Your own pipelines were saved (Settings › Pipelines). */
  onPipelinesChanged?: () => void;
};

export function StartupForm({
  roles,
  cli,
  cliError,
  rolesError = null,
  cliFound,
  showDevTools,
  onRedetectCli,
  onRefreshRoles,
  onPipelinesChanged,
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
  /** Set by the first tab list load; until then savedTabs is only the empty start. */
  const [tabsLoaded, setTabsLoaded] = useState(false);
  /** Set once useNewTab exists; the tab bootstrap calls it on a first launch. */
  const newTabLaunchRef = useRef<(draftTabId: string, mode: string) => Promise<void>>(
    async () => {},
  );
  /** The launch draft waiting for first-run setup to close (Skip runs the launch step). */
  const firstRunLaunchRef = useRef<string | null>(null);
  /** The "New tab opens" setting decides what replaces a launch draft's start screen. */
  const runNewTabLaunch = async (draftTabId: string) => {
    const mode = await getTerminalSettings().then((t) => t.newTabOpens, () => "start");
    await newTabLaunchRef.current(draftTabId, mode);
  };
  const [closedTabs, setClosedTabs] = useState<ClosedTabSummary[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [cardsByTab, setCardsByTab] = useState<Record<string, Cards>>({});
  // F2: finished/question/error left on a tab the user was not watching.
  const [tabMarks, setTabMarks] = useState<Record<string, TabMark>>({});
  const [terminalBusy, setTerminalBusy] = useState<string[]>([]);
  /** Claude role terminals mid-turn with no output or new log record for a minute. */
  const [quietTurnTabs, setQuietTurnTabs] = useState<string[]>([]);
  /** Terminal or Chat per Claude terminal tab, kept across restarts. */
  const { views: terminalViews, setView: setTerminalView } = useTerminalViews(
    savedTabs.map((tab) => tab.id),
  );
  usePrunePlanPanes(savedTabs.map((tab) => tab.id));
  const terminalViewsRef = useRef(terminalViews);
  terminalViewsRef.current = terminalViews;
  const terminalComposerRef = useRef<TerminalComposerHandle>(null);
  /** The active tab shows its chat view now (set each render). */
  const chatViewShownRef = useRef(false);
  const showGridRef = useRef(false);
  /** The role launcher is open (palette "New tab with role…" or its shortcut). */
  const [roleLauncherOpen, setRoleLauncherOpen] = useState(false);
  /** An untouched draft the launcher's pick fills instead of a new tab (a first launch). */
  const roleLauncherReuseRef = useRef<string | null>(null);
  /** The role launcher's entry point (palette, shortcut, the new-tab picker's Role…). */
  const openRoleLauncher = useCallback((reuseTabId: string | null = null) => {
    roleLauncherReuseRef.current = reuseTabId;
    setPaletteOpen(false);
    setSwitcherOpen(false);
    setRoleLauncherOpen(true);
  }, []);
  /** A launcher pick and the draft tab opened for it: its start form then preselects it. */
  const [pendingLaunch, setPendingLaunch] = useState<(RoleLaunch & { tabId: string }) | null>(null);
  /** Claude session logs of terminal role tabs on screen or in a chain (null: none). */
  const [sessionLogs, setSessionLogs] = useState<Record<string, TerminalSessionLog | null>>({});
  const sessionLogsRef = useRef(sessionLogs);
  sessionLogsRef.current = sessionLogs;
  const sessionLogWatch = useRef(
    new Map<
      string,
      {
        since: number;
        poll?: SessionLogPollState;
        seenPromptAt?: string | null;
        /** lastPromptAt of the turn already reported as finished. */
        finishedPromptAt?: string | null;
        /** Read at the next tick even if a read is in flight now (a dialog appeared). */
        forceRead?: boolean;
        /** What the last read found and when (claudeState.ts `quietTurn`). */
        records?: LogRecordsSeen;
      }
    >(),
  );
  /** Bumped when a PTY starts or exits, so derived terminal state re-reads it. */
  const [ptyVersion, setPtyVersion] = useState(0);
  /** Terminals whose PTY output shows Claude Code's permission dialog. */
  const [dialogTabs, setDialogTabs] = useState<string[]>([]);
  /** The open tool each visible permission dialog asks about. */
  const dialogOwners = useRef(new Map<string, DialogOwner>());
  /** Bumped when a dialog's tool becomes known or it goes away. */
  const [dialogOwnerVersion, setDialogOwnerVersion] = useState(0);
  const setDialogOwner = useCallback((tabId: string, owner: DialogOwner | undefined) => {
    const prev = dialogOwners.current.get(tabId);
    if (owner) dialogOwners.current.set(tabId, owner);
    else dialogOwners.current.delete(tabId);
    if (prev?.toolId !== owner?.toolId || prev?.promptKey !== owner?.promptKey) {
      setDialogOwnerVersion((value) => value + 1);
    }
  }, []);
  /** Tabs whose PTYs a workspace replace is stopping: their exit is not news. */
  const replacingTabs = useRef(new Set<string>());
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null);
  const [worktreeDialogOpen, setWorktreeDialogOpen] = useState(false);
  /** F4: the tab whose changes (diff) panel is open. */
  const [changesTabId, setChangesTabId] = useState<string | null>(null);
  /** The tab whose agent activity log is open. */
  const [activityTabId, setActivityTabId] = useState<string | null>(null);
  /** Files changed in each tab's last turn (shown on the Changes button). */
  const [changeCounts, setChangeCounts] = useState<Record<string, number>>({});
  /** acceptKey()s per tab: files the user kept after review. */
  const [acceptedChanges, setAcceptedChanges] = useState<AcceptedChanges>(loadAccepted);
  const [fileFocus, setFileFocus] = useState<{ path: string; nonce: number } | null>(null);
  /** F8: first-run setup is showing. */
  const [firstRunOpen, setFirstRunOpen] = useState(false);
  // One setup check per mount: the launch and the setup dialog must agree.
  const firstRunCheckRef = useRef<ReturnType<typeof firstRunStatus> | null>(null);
  const firstRunCheck = () => (firstRunCheckRef.current ??= firstRunStatus());
  /** F8: after setup, start this role once the form has it and the folder. */
  const [pendingStart, setPendingStart] = useState<FirstRunFinish | null>(null);
  /** F7: workspaces dialog; focusSave starts on the name field. */
  const [workspacesOpen, setWorkspacesOpen] = useState<{ focusSave: boolean } | null>(null);
  const [workspaceList, setWorkspaceList] = useState<WorkspaceList | null>(null);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  /** F6: prompt library dialog; saveDraft opens it on "Save as prompt", view picks the list. */
  const [promptLibraryOpen, setPromptLibraryOpen] = useState<{
    saveDraft: string | null;
    view: PromptLibraryView;
  } | null>(null);
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
      // intentionally silent: a polled badge count; the Changes panel shows its own errors.
      .catch(() => {});
  }, []);
  const [split, setSplit] = useState<SplitState>(emptySplit());
  const [splitPicker, setSplitPicker] = useState<"horizontal" | "vertical" | "grid" | null>(null);
  const [focusedPane, setFocusedPane] = useState<"primary" | "secondary">("primary");
  const focusedPaneRef = useRef(focusedPane);
  focusedPaneRef.current = focusedPane;
  const [filePanelOpen, setFilePanelOpen] = useState(false);
  const [filePanelWidth, setFilePanelWidth] = useState(280);
  // Set while the file panel is mounted; asks there before unsaved edits go.
  const fileDiscardGuardRef = useRef<FileDiscardGuard | null>(null);
  const guardFileEdits = useCallback((run: () => void) => {
    const guard = fileDiscardGuardRef.current;
    if (!guard?.dirty()) {
      run();
      return;
    }
    void guard.confirm().then((ok) => {
      if (ok) run();
    });
  }, []);
  const layoutLoadedRef = useRef(false);
  const previousActiveRef = useRef<string | null>(null);
  const secondaryInputRef = useRef<HTMLTextAreaElement>(null);
  const [modelList, setModelList] = useState<ModelList | null>(null);
  const [claudeModelList, setClaudeModelList] = useState<ModelList | null>(null);
  const [modelSettings, setModelSettingsState] = useState<ProviderModelSettings | null>(null);
  /** Claude-first Phase 2: provider settings + detection (Settings, status bar). */
  const providers = useProviders();
  const [modelNotice, setModelNotice] = useState<string | null>(null);
  const [modelsRefreshing, setModelsRefreshing] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [accountPickerOpen, setAccountPickerOpen] = useState(false);
  const [windowAccount, setWindowAccount] = useState<{
    id: string;
    name: string;
    config: WindowContext["config"];
  } | null>(null);
  const newWindowAt = useRef(0);
  /** Text the palette opens with, and a key so reopening resets it. */
  const [palettePrefill, setPalettePrefill] = useState({ query: "", key: 0 });
  const [chatHistoryOpen, setChatHistoryOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [captureOn, setCaptureOn] = useState(false);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsStatus | null>(null);
  const [approvalMode, setApprovalMode] = useState<ApprovalModeStatus | null>(null);
  const [usageSnap, setUsageSnap] = useState<Awaited<ReturnType<typeof getClaudeUsage>> | null>(null);
  /** Limit alerts already shown in this app run (keys from limitAlerts). */
  const limitAlertedRef = useRef<Set<string>>(new Set());
  const eagleOnRef = useRef(false);
  const [eagleOn, setEagleOn] = useState(false);
  // The Eagle-Eye tick belongs to the tab it was set on.
  useEffect(() => {
    eagleOnRef.current = false;
    setEagleOn(false);
  }, [activeTabId]);
  /** A tab already in a chain keeps it; starting it never begins a new one. */
  const inChain = (tabId: string | null | undefined) =>
    !!tabId && !!savedTabsRef.current.find((tab) => tab.id === tabId)?.chain;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [handoffs, setHandoffs] = useState<HandoffRecord[]>([]);
  const [handoffTarget, setHandoffTarget] = useState<HandoffTargetId | null>(null);
  const [handoffFields, setHandoffFields] = useState<HandoffField[] | null>(null);
  const [handoffTemplate, setHandoffTemplate] = useState<string | null>(null);
  const [handoffSelection, setHandoffSelection] = useState("");
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const [savedPlan, setSavedPlan] = useState<HandoffRecord | null>(null);
  const [savedPlanLoading, setSavedPlanLoading] = useState(false);
  const [pickedRoleId, setPickedRoleId] = useState<string | null>(null);
  const [launchChoice, setLaunchChoice] = useState<"shell" | CliLaunch | null>(null);
  const [terminalSettings, setTerminalSettingsState] = useState<TerminalSettings | null>(null);
  const optionAsMeta = terminalSettings?.optionAsMeta ?? true;
  useEffect(() => setOptionAsMeta(optionAsMeta), [optionAsMeta]);
  const copyOnSelect = terminalSettings?.copyOnSelect ?? false;
  useEffect(() => setCopyOnSelect(copyOnSelect), [copyOnSelect]);
  const [notificationSettings, setNotificationSettingsState] =
    useState<NotificationSettings | null>(null);
  const [terminalError, setTerminalError] = useState<string | null>(null);
  /** A chat Planner's plan file, read when its "Ready to code?" plan is no longer in memory. */
  const [chatPlanFile, setChatPlanFile] = useState<{
    tabId: string;
    text: string;
    name: string;
  } | null>(null);
  const [terminalCapture, setTerminalCapture] = useState<{
    tabId: string;
    selection: string;
    tail: string;
    scrollback: string;
    planFile: PlanFileInfo | null;
    /** The tab's Claude session log, read when the dialog opened. */
    log: TerminalSessionLog | null;
    /** The terminal tab's own saved form, not the form on screen. */
    answers: Record<string, string>;
  } | null>(null);
  /** A reviewer terminal's verdict, read when its hand-off buttons or menu are used. */
  const [terminalVerdict, setTerminalVerdict] = useState<{
    tabId: string;
    verdict: ReviewVerdict | null;
  } | null>(null);
  const [paneByTab, setPaneByTab] = useState<Record<string, { open: boolean; beside: boolean }>>(
    {},
  );
  const [newSessionOpen, setNewSessionOpenState] = useState(false);
  const [transcriptSaveError, setTranscriptSaveError] = useState<string | null>(null);
  const [historyEntries, setHistoryEntries] = useState<CursorHistoryEntry[]>([]);
  const [historyOverride, setHistoryOverride] = useState<ProviderId | null>(null);
  const [historyReadFrom, setHistoryReadFrom] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [cliLaunchNote, setCliLaunchNote] = useState<string | null>(null);
  const [historyCursor, setHistoryCursor] = useState(-1);
  const [logDrawerOpen, setLogDrawerOpen] = useState(false);
  const [logDrawer, setLogDrawer] = useState({
    stderr: "",
    appLog: "",
    logPath: null as string | null,
  });
  const [logBusy, setLogBusy] = useState(false);
  const [chain, setChain] = useState<ChainCursor | null>(null);
  const [resendStartup, setResendStartup] = useState(false);
  /** Text fields emptied by "Clear form", kept so Undo can put them back. */
  const [clearedForm, setClearedForm] = useState<{
    tabId: string;
    values: Record<string, string>;
  } | null>(null);
  /** Answers a started tab last ran with, offered by "Use the previous values". */
  const previousAnswersRef = useRef<Record<string, Record<string, string>>>({});
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
  /** One hand-off confirm at a time: a double click must not open two tabs. */
  const handoffLockRef = useRef(false);
  /** The hand-off autopilot made already that you were warned about; Send again makes it anyway. */
  const confirmedClaimRef = useRef<string | null>(null);
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  /** The newest tab switch wins; an older one's late answer is dropped (tabSwitch.ts). */
  const tabSwitchesRef = useRef(createSwitchTickets());
  /** A startup step that failed after the tabs loaded, with its Retry. */
  const [startupFailure, setStartupFailure] = useState<StartupFailure | null>(null);
  // A grid cell clicked in its composer: the active cell renders a new one, so focus it.
  const gridFocusRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeTabId || gridFocusRef.current !== activeTabId) return;
    gridFocusRef.current = null;
    const input = document.querySelector<HTMLTextAreaElement>(
      "[data-pane='primary'] textarea.session-terminal-input",
    );
    input?.focus();
  }, [activeTabId]);
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
  const followUp = activeRuntime.followUp;
  const streamSegments = activeRuntime.segments;
  const permissionRequest = activeRuntime.permission;
  const questionRequest = activeRuntime.question;
  const scratch = useScratchPads(activeTabId);
  const chatImages = useChatImages();
  // Pasted images: Claude chats whose agent takes them (Rust sets the flag).
  const imagesFor = (tabId: string | null, info: { supportsImages?: boolean } | null | undefined) =>
    tabId && info?.supportsImages ? chatImages.propsFor(tabId) : null;
  /** Latest pad text per tab, for callbacks that finish after a send. */
  const padTextRef = useRef<Record<string, string>>({});
  if (activeTabId) padTextRef.current[activeTabId] = scratch.content;
  /** Up-arrow history, oldest first. The pad keeps the same sends, newest first, on disk. */
  // scratch.history is newest first, the order historyNavigate walks.
  const composerHistory = scratch.history;
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
    activityTabId !== null ||
    chatSearchQuery !== null ||
    promptLibraryOpen !== null ||
    workspacesOpen !== null ||
    chatHistoryOpen ||
    firstRunOpen ||
    accountPickerOpen;
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
  const rawNotifyAgent = agentNotifications.notify;
  // A late event for a closed or unknown tab is not news.
  const notifyAgent = useCallback(
    (...args: Parameters<typeof rawNotifyAgent>) => {
      if (!savedTabsRef.current.some((tab) => tab.id === args[0])) return;
      rawNotifyAgent(...args);
    },
    [rawNotifyAgent],
  );
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
  const showNoticeRef = useRef(showNotice);
  showNoticeRef.current = showNotice;
  useEffect(() => {
    setLinkOpenErrorHandler((message) => showNoticeRef.current("Could not open link", message, "failed"));
    // reportError (uiErrors.ts) shows a failed user action here.
    setErrorNotifier((title, message) => showNoticeRef.current(title, message, "failed"));
    return () => {
      setLinkOpenErrorHandler(null);
      setErrorNotifier(null);
    };
  }, []);
  /** A background load or poll that failed: say so once per `key`, not per retry. */
  const reportOnce = useCallback((key: string, title: string, err: unknown) => {
    reportError(title, err, { notify: true, once: key });
  }, []);
  const confirm = useConfirm();
  const settingsDirtyRef = useRef(false);
  const onSettingsUnsaved = useCallback((dirty: boolean) => {
    settingsDirtyRef.current = dirty;
  }, []);
  useEffect(() => {
    if (rolesError) showNotice("Roles did not load", rolesError, "question");
  }, [rolesError, showNotice]);
  const claudeVersionNotice = useCallback(
    (title: string, body: string, slot: string) => showNotice(title, body, "question", slot),
    [showNotice],
  );
  // Needs-you detection is pinned to one Claude Code version: say so once per window.
  useClaudeVersionNotice(providers.claude?.status.version, claudeVersionNotice);

  const launchAccountWindow = useCallback(
    (accountId: string) => {
      setAccountPickerOpen(false);
      void openAccountWindow(accountId).catch((err: unknown) => {
        showNotice(
          "New window",
          errorText(err),
          "failed",
        );
      });
    },
    [showNotice],
  );

  const requestNewWindow = useCallback(() => {
    if (!acceptNewWindowRequest(newWindowAt.current, Date.now(), accountPickerOpen)) return;
    newWindowAt.current = Date.now();
    const accounts = providers.view
      ? claudeAccounts(providers.view.settings.claude)
      : [{ id: "default", name: "Claude", configDir: null }];
    if (accounts.length <= 1) {
      launchAccountWindow(accounts[0]?.id ?? "default");
      return;
    }
    setAccountPickerOpen(true);
  }, [accountPickerOpen, launchAccountWindow, providers.view]);

  useEffect(() => {
    let cancelled = false;
    void ensureWindow().then((ctx) => {
      if (cancelled || !ctx.config?.path) return;
      setWindowAccount({ id: ctx.accountId, name: ctx.accountName, config: ctx.config });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const host = shortcutPlatform();
    const onKey = (event: KeyboardEvent) => {
      if (!isNewWindowShortcut(event, host)) return;
      event.preventDefault();
      requestNewWindow();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestNewWindow]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listenNewWindow(() => {
      if (!cancelled) requestNewWindow();
    }).then((stop) => {
      if (cancelled) stop();
      else unlisten = stop;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [requestNewWindow]);

  const persistTranscripts = useCallback(async (snapshot: Record<string, TabRuntime>) => {
    const jobs = Object.entries(snapshot)
      .filter(([, rt]) => rt.segments.length > 0)
      .map(async ([tabId, rt]) => {
        const cwd = rt.session?.cwd ?? "";
        try {
          await transcriptSave(tabId, segmentsToPlainText(rt.segments), cwd);
          setTranscriptSaveError(null);
        } catch (err: unknown) {
          const message = errorText(err);
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
    // A started tab keeps the answers it ran with. Its "Start new session"
    // draft stays in memory only.
    if (tabWasStarted(savedTabsRef.current, leaving)) return;
    const payload = answersForRole({ ...snap.values, cwd }, fieldsForForm(role));
    void syncActiveTabForm(leaving, snap.roleId, cwd, payload).catch((err: unknown) =>
      reportOnce("tabFormSync", "Tab form not saved", err),
    );
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
    setTabsLoaded(true);
    return snap;
  }, []);

  /** Show a failed startup step with its Retry, or clear it. Logged once per step. */
  const settleStartup = useCallback((failure: StartupFailure | null) => {
    if (failure) reportError(failure.title, failure.error, { once: `startup:${failure.title}` });
    setStartupFailure(failure);
  }, []);

  useEffect(() => {
    if (tabsBootstrappedRef.current) return;
    tabsBootstrappedRef.current = true;
    const seedRoleId = roles[0]?.id ?? "role_implementer";
    refreshTabs()
      .then(async (snap) => {
        // A reloaded webview reattaches to chats whose agent is still running.
        for (const running of snap.tabs) {
          if (running.phase !== "running" || running.kind === "terminal") continue;
          if (running.kind === "pipeline_overview") continue;
          let live: Awaited<ReturnType<typeof devSessionLive>> | null = null;
          try {
            live = await devSessionLive(running.id);
          } catch (err: unknown) {
            showNotice(`${running.label} not reconnected`, errorText(err), "failed");
            continue;
          }
          if (!live) continue;
          const { roleId: _role, promptInFlight: inFlight, exited, ...info } = live;
          patchRuntime(running.id, (rt) => ({
            ...rt,
            session: info,
            promptInFlight: inFlight,
            agentExited: exited,
            accepting: true,
            segments: rt.segments.length
              ? rt.segments
              : [
                  streamSegmentFromSystemMessage(
                    "Reconnected to the running agent. Output from before the reload is in the saved transcript.",
                  ),
                ],
          }));
        }
        settleStartup(await runStartupSteps(startupSteps(snap)));
      })
      .catch((err: unknown) => {
        // Without the tab list there is nothing to show or retry from.
        setSavedTabs([]);
        showNotice("Tabs did not load", errorText(err), "failed");
      });

    /** What runs once the tabs load. A failure keeps the tabs and offers Retry. */
    function startupSteps(snap: Awaited<ReturnType<typeof refreshTabs>>): StartupStep[] {
      if (snap.tabs.length === 0) {
        let draft: Awaited<ReturnType<typeof newDraftTab>>["tab"] | null = null;
        return [
          {
            title: "New tab did not open",
            run: async () => {
              draft = (await newDraftTab(seedRoleId, "")).tab;
            },
          },
          {
            title: "Tabs did not refresh",
            run: async () => {
              if (!draft) return;
              await refreshTabs();
              loadTabIntoForm(draft);
            },
          },
          {
            title: "New tab did not start",
            run: async () => {
              if (!draft) return;
              // A fresh profile shows first-run setup over this draft; the setting
              // applies only once setup is skipped (finishing it starts a role here).
              const setupNeeded = await firstRunCheck().then((s) => !!s?.needed, () => false);
              if (setupNeeded) {
                firstRunLaunchRef.current = draft.id;
                return;
              }
              await runNewTabLaunch(draft.id);
            },
          },
        ];
      }
      const activeId = snap.activeTabId ?? snap.tabs[snap.tabs.length - 1]?.id;
      if (!activeId) return [];
      const summary = snap.tabs.find((t) => t.id === activeId);
      if (!summary) return [];
      if (
        summary.kind === "terminal" ||
        summary.kind === "pipeline_overview" ||
        summary.kind === "preview" ||
        summary.kind === "github" ||
        summary.phase === "running"
      ) {
        setActiveTabId(activeId);
        return [];
      }
      return [
        {
          title: "Active tab did not load",
          run: async () => {
            // A tab the user opened meanwhile wins: before a Retry, or during this load.
            if (activeTabIdRef.current) return;
            const seen = tabSwitchesRef.current.watch();
            const { tab } = await selectActiveTab(activeId);
            if (seen.isCurrent()) loadTabIntoForm(tab);
          },
        },
      ];
    }
  }, [loadTabIntoForm, patchRuntime, refreshTabs, roles, settleStartup, showNotice]);

  useEffect(() => {
    sessionActiveRef.current = !!session;
  }, [session]);

  // Once a tab runs, its "Start new session" form closes. Opening it again
  // starts empty instead of showing the answers that just ran.
  useEffect(() => {
    if (!session) return;
    setNewSessionOpenState(false);
    const tabId = activeTabIdRef.current;
    const current = tabId ? draftsRef.current[tabId] : undefined;
    if (tabId && current?.newSessionOpen) {
      draftsRef.current[tabId] = { ...current, newSessionOpen: false };
    }
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
        setChain((current) => chainAfterAgentRequest(current, evt.tabId, savedTabsRef.current));
        patchRuntime(evt.tabId, (rt) => applyPermission(rt, evt));
        notifyAgent(evt.tabId, { kind: "permission", detail: evt.title || evt.message });
      }),
      listenPermissionAuto((evt) => {
        if (!evt.tabId) return;
        patchRuntime(evt.tabId, (rt) => applyAutoPermission(rt, evt));
      }),
      listenPromptFinished((evt) => {
        if (!evt.tabId) return;
        // Chunks still waiting for the next frame belong to this turn; apply them first
        // so the final reply isn't added on top of them.
        if (flushRafRef.current !== null) {
          cancelAnimationFrame(flushRafRef.current);
          flushRafRef.current = null;
        }
        flushUpdates();
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
        setChain((current) => chainAfterAgentRequest(current, evt.tabId, savedTabsRef.current));
        patchRuntime(evt.tabId, (rt) => applyPlan(rt, evt));
        notifyAgent(evt.tabId, { kind: "plan", detail: evt.title });
      }),
      listenQuestionRequests((evt) => {
        if (!evt.tabId) return;
        setChain((current) => chainAfterAgentRequest(current, evt.tabId, savedTabsRef.current));
        patchRuntime(evt.tabId, (rt) => applyQuestion(rt, evt));
        notifyAgent(evt.tabId, {
          kind: "question",
          detail: evt.prompt || evt.title,
        });
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
    if (roleId === "terminal" || roleId === "cursor-cli" || roleId === "claude-cli") return;
    if (!roles.some((r) => r.id === roleId) && roles.length > 0) {
      setRoleId(roles[0].id);
    }
  }, [roles, roleId]);

  useEffect(() => {
    getTerminalSettings()
      .then(setTerminalSettingsState)
      .catch((err: unknown) => reportOnce("settingsLoad", "Settings did not load", err));
    getNotificationSettings()
      .then(setNotificationSettingsState)
      .catch((err: unknown) => reportOnce("settingsLoad", "Settings did not load", err));
  }, [reportOnce]);

  // A tab's toasts are stale once it is on screen in a focused window.
  useEffect(() => {
    if (!windowFocused) return;
    const secondary = splitOpen(split) ? split.secondaryTabId : null;
    const onScreen = [activeTabId, secondary, ...(gridOpen(split) ? (split.gridTabIds ?? []) : [])];
    for (const id of onScreen) if (id) dismissTabToasts(id);
    setTabMarks((marks) => clearMarks(marks, onScreen));
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
      const now = Date.now();
      const { busy, settled } = terminalActivity.sweep(now);
      setTerminalBusy((prev) =>
        prev.length === busy.length && prev.every((id, i) => id === busy[i]) ? prev : busy,
      );
      // Mid-turn Claude terminals quiet for a minute show as unknown.
      const quietTurns = quietTurnIds(
        sessionLogWatch.current,
        sessionLogsRef.current,
        terminalActivity.lastOutputAt,
        now,
      );
      setQuietTurnTabs((prev) =>
        prev.length === quietTurns.length && prev.every((id, i) => id === quietTurns[i])
          ? prev
          : quietTurns,
      );
      // A Claude role terminal is marked when its turn ends, not when output
      // stops; an exited process is reported as exited, never as finished.
      const quiet = settled.filter((id) => {
        const tab = savedTabsRef.current.find((item) => item.id === id);
        if (tab && isClaudeRoleTerminal(tab)) return false;
        if (ptyExitCode(id) != null) return false;
        return !(sessionLogWatch.current.has(id) && sessionLogsRef.current[id]);
      });
      if (quiet.length > 0) {
        for (const id of quiet) {
          if (!isWatchingTab(id)) {
            notifyAgent(id, { kind: "finished", detail: "Terminal output settled." });
          }
        }
        setTabMarks((marks) =>
          quiet.reduce(
            (acc, id) => markAfterTurn(acc, id, "finished", isWatchingTab(id)),
            marks,
          ),
        );
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [hasTerminalTabs, isWatchingTab, notifyAgent]);

  /** Autopilot sees every fresh session log (set once the hook exists). */
  const autopilotLogRef = useRef<((tabId: string, log: TerminalSessionLog | null) => void) | null>(
    null,
  );
  const storeSessionLog = useCallback(
    /** `readAt`: when the read started, so a read older than a dialog is not used for it. */
    (tabId: string, log: TerminalSessionLog | null, readAt: number) => {
      const prev = sessionLogsRef.current[tabId];
      const watched = sessionLogWatch.current.get(tabId);
      if (watched && log) {
        // A prompt typed straight into the terminal: same "This turn" snapshot as a pad send.
        if (
          promptNeedsSnapshot({
            promptAt: log.lastPromptAt,
            seenPromptAt: watched.seenPromptAt,
            watchedSinceMs: watched.since,
            lastSnapshotMs: snapshotTerminalTurn.lastAt(tabId),
          })
        ) {
          void snapshotTerminalTurn(tabId);
        }
        watched.seenPromptAt = log.lastPromptAt;
        // With no earlier read, a turn whose prompt came after the watch
        // started is new: a first turn can end before the first read.
        const ended =
          log.turnDone &&
          watched.finishedPromptAt !== log.lastPromptAt &&
          (prev
            ? !prev.turnDone || prev.lastPromptAt !== log.lastPromptAt
            : promptAfter(log.lastPromptAt, watched.since));
        if (ended && ptyExitCode(tabId) == null) {
          watched.finishedPromptAt = log.lastPromptAt;
          const watching = isWatchingTab(tabId);
          if (!watching) {
            const tab = savedTabsRef.current.find((item) => item.id === tabId);
            notifyAgent(tabId, { kind: "finished", detail: finishedDetail(tab?.roleId ?? "", log, tab?.chain?.kind) });
          }
          setTabMarks((marks) => markAfterTurn(marks, tabId, "finished", watching));
        }
      }
      // Hide the dialog once the tool it asked about was answered: a later
      // tool needs a fresh dialog. An earlier tool finishing is not that.
      const next = dialogAfterRead(
        dialogOwners.current.get(tabId),
        log,
        readAt,
        dialogDetector.answering(tabId),
      );
      setDialogOwner(tabId, next.owner);
      // Mid-turn, the next call's dialog may be half drawn already.
      if (next.clear) dialogDetector.clear(tabId, { keepPartial: !!log && !log.turnDone });
      // New records restart the quiet minute before a turn shows as unknown.
      if (watched) watched.records = logRecordsSeen(watched.records, log, Date.now());
      if (prev === undefined || !sameSessionLog(prev, log)) {
        sessionLogsRef.current = { ...sessionLogsRef.current, [tabId]: log };
        setSessionLogs(sessionLogsRef.current);
      }
      // After the stored log is this one: autopilot compares a tab's stored
      // log with the turn it decides on, and a stale one reads as a newer prompt.
      autopilotLogRef.current?.(tabId, log);
    },
    [isWatchingTab, notifyAgent, setDialogOwner],
  );

  // PTY start and exit change which terminals are live and their state.
  useEffect(() => {
    let last = new Map<string, number | null | undefined>();
    const unsubscribeLive = subscribeLivePty(() => {
      const now = new Map(
        savedTabsRef.current.map((tab) => [tab.id, livePty(tab.id) ? ptyExitCode(tab.id) : undefined]),
      );
      const changed =
        now.size !== last.size || [...now].some(([id, code]) => last.get(id) !== code);
      last = now;
      if (changed) setPtyVersion((value) => value + 1);
    });
    const unsubscribeExit = subscribePtyExit((id, code) => {
      setPtyVersion((value) => value + 1);
      if (replacingTabs.current.has(id)) return;
      const tab = savedTabsRef.current.find((item) => item.id === id);
      if (!tab || !isClaudeRoleTerminal(tab)) return;
      const watching = isWatchingTab(id);
      notifyAgent(id, { kind: "failed", detail: `Claude Code exited (code ${code}).` });
      setTabMarks((marks) => markAfterTurn(marks, id, "failed", watching));
    });
    const unsubscribeDialog = dialogDetector.subscribe((id) => {
      const visible = dialogDetector.isVisible(id);
      setDialogTabs((prev) => {
        if (visible === prev.includes(id)) return prev;
        return visible ? [...prev, id] : prev.filter((item) => item !== id);
      });
      // A new draw belongs to whatever tool the next read finds open.
      setDialogOwner(
        id,
        visible
          ? dialogDrawn(
              dialogOwners.current.get(id),
              Date.now(),
              dialogDetector.prompt(id),
              dialogDetector.drawnAfterAnswer(id),
            )
          : undefined,
      );
      // Read the log now: the open tool decides what the dialog is for.
      const entry = sessionLogWatch.current.get(id);
      if (visible && entry) entry.forceRead = true;
    });
    return () => {
      unsubscribeLive();
      unsubscribeExit();
      unsubscribeDialog();
    };
  }, [isWatchingTab, notifyAgent, setDialogOwner]);

  // Every live Claude role terminal, plus role terminals on screen or in a
  // chain: read their Claude session log while the PTY streams output, until
  // the turn ends (see sessionLogPoll.ts).
  const sessionLogTabIds = useMemo(() => {
    const onScreen = new Set([
      activeTabId,
      splitOpen(split) ? split.secondaryTabId : null,
      ...(gridOpen(split) ? (split.gridTabIds ?? []) : []),
    ]);
    const running = (id: string) => {
      const pty = livePty(id);
      return !!pty && !pty.exited;
    };
    return savedTabs
      .filter(
        (tab) =>
          isClaudeRoleTerminal(tab) &&
          (running(tab.id) || onScreen.has(tab.id) || !!tab.chain || !!tab.pipelineRunId),
      )
      .map((tab) => tab.id)
      .join("\n");
    // ptyVersion: a PTY started or exited.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId, savedTabs, split, ptyVersion]);
  useEffect(() => {
    const ids = sessionLogTabIds ? sessionLogTabIds.split("\n") : [];
    const watch = sessionLogWatch.current;
    for (const id of [...watch.keys()]) if (!ids.includes(id)) watch.delete(id);
    const logs = sessionLogsRef.current;
    if (Object.keys(logs).some((id) => !ids.includes(id))) {
      sessionLogsRef.current = Object.fromEntries(
        Object.entries(logs).filter(([id]) => ids.includes(id)),
      );
      setSessionLogs(sessionLogsRef.current);
    }
    if (ids.length === 0) return;
    for (const id of ids) if (!watch.has(id)) watch.set(id, { since: Date.now() });
    let cancelled = false;
    const reading = new Set<string>();
    const tick = () => {
      const now = Date.now();
      for (const id of ids) {
        const entry = watch.get(id);
        if (!entry || reading.has(id)) continue;
        const busy = terminalActivity.isBusy(id, now);
        if (entry.forceRead) {
          entry.forceRead = false;
          entry.poll = undefined;
        }
        entry.poll = sessionLogTick(entry.poll, busy);
        if (!sessionLogDue(entry.poll, busy, now)) continue;
        reading.add(id);
        void terminalSessionLog(id)
          // intentionally silent: a polled status read; the next tick retries.
          .catch(() => null)
          .then((log) => {
            reading.delete(id);
            if (cancelled) return;
            entry.poll = afterSessionLogRead(entry.poll, busy, log, Date.now());
            storeSessionLog(id, log, now);
          });
      }
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [sessionLogTabIds, storeSessionLog]);
  /**
   * Claude role terminals' one state (exited, needs you, working, idle), read
   * by the chip, status bar, grid, chain overview and hand-off.
   */
  const terminalStatesRef = useRef<Record<string, TerminalState>>({});
  const terminalStates = useMemo(() => {
    const prev = terminalStatesRef.current;
    const next: Record<string, TerminalState> = {};
    let changed = false;
    for (const tab of savedTabs) {
      if (!isClaudeRoleTerminal(tab)) continue;
      const state = deriveTerminalState({
        log: sessionLogs[tab.id],
        // Only once a log read tied the dialog to one of the turn's tools.
        dialogTool: dialogTabs.includes(tab.id)
          ? dialogToolFor(dialogOwners.current.get(tab.id), sessionLogs[tab.id])
          : null,
        ptyBusy: terminalBusy.includes(tab.id),
        exitCode: ptyExitCode(tab.id),
        quiet: quietTurnTabs.includes(tab.id),
      });
      next[tab.id] = sameTerminalState(prev[tab.id], state) ? prev[tab.id] : state;
      if (next[tab.id] !== prev[tab.id]) changed = true;
    }
    if (!changed && Object.keys(prev).length === Object.keys(next).length) return prev;
    terminalStatesRef.current = next;
    return next;
    // ptyVersion: exit codes, dialogOwnerVersion: dialog owners live outside React state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialogOwnerVersion, dialogTabs, ptyVersion, quietTurnTabs, savedTabs, sessionLogs, terminalBusy]);

  // One toast and OS notification per prompt that needs the user.
  const needsNotified = useRef(new Set<string>());
  useEffect(() => {
    for (const [tabId, state] of Object.entries(terminalStates)) {
      if (state.kind !== "needs") continue;
      // A permission prompt is keyed by the dialog, not the call: a subagent's
      // prompts share its Agent call, and a dialog may move to another call.
      const which = state.needs === "permission" ? `prompt ${state.promptKey ?? state.toolId}` : state.toolId;
      const key = `${tabId}\n${state.needs}\n${which}`;
      if (needsNotified.current.has(key)) continue;
      needsNotified.current.add(key);
      notifyAgent(tabId, { kind: state.needs, detail: terminalNeedsMessage(state) });
    }
  }, [notifyAgent, terminalStates]);

  /** Working until its turn ends (a prompt waiting on the user included). */
  const terminalWorking = useCallback(
    (tabId: string) => {
      const state = terminalStates[tabId];
      if (state) return state.kind === "working" || state.kind === "needs";
      const log = sessionLogs[tabId];
      return log ? !log.turnDone : terminalBusy.includes(tabId);
    },
    [sessionLogs, terminalBusy, terminalStates],
  );

  const tabStatuses = useMemo(() => {
    const out: Record<string, TabStatus> = {};
    for (const tab of savedTabs) {
      out[tab.id] = computeTabStatus({
        runtime: runtimes[tab.id],
        mark: tabMarks[tab.id],
        planPending: runtimes[tab.id]?.plan != null,
        questionPending: runtimes[tab.id]?.question != null,
        terminalBusy: terminalBusy.includes(tab.id),
        terminal: terminalStates[tab.id],
      });
    }
    return out;
  }, [runtimes, savedTabs, tabMarks, terminalBusy, terminalStates]);

  /** When each terminal's working turn started, for the header's "Working · 12s". */
  const workingSinceRef = useRef<Record<string, number>>({});
  const workingSince = useMemo(() => {
    const tabs = savedTabs
      .filter((tab) => tab.kind === "terminal")
      .map((tab) => {
        const state = terminalStates[tab.id];
        const lastPromptAt = state ? sessionLogs[tab.id]?.lastPromptAt : null;
        return {
          tabId: tab.id,
          working:
            headerStateOf({ state, status: tabStatuses[tab.id], turnEnded: false }).tone ===
            "working",
          turnStartedAt: lastPromptAt ? Date.parse(lastPromptAt) : null,
        };
      });
    workingSinceRef.current = trackWorkingSince(workingSinceRef.current, tabs, Date.now());
    return workingSinceRef.current;
  }, [savedTabs, sessionLogs, tabStatuses, terminalStates]);

  const uiSettings = useUiSettings((title, message) => showNotice(title, message, "failed"));
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
  const updateNotificationSettings = useCallback((next: NotificationSettings): Promise<void> => {
    const prev = notificationSettingsRef.current;
    // Turning system notifications on is a click, so ask the OS now.
    if (next.enabled && next.system && !(prev?.enabled && prev?.system)) {
      void showSystemNotification("DCTerminal notifications", "System notifications are on.", {
        askAgain: true,
      });
    }
    setNotificationSettingsState(next);
    return setNotificationSettings(next).then(setNotificationSettingsState);
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
      .catch((err: unknown) => reportOnce("layoutLoad", "Layout did not load", err))
      .finally(() => {
        if (!cancelled) layoutLoadedRef.current = true;
      });
    getModelSettings()
      .then((value) => {
        if (!cancelled) setModelSettingsState(value);
      })
      .catch((err: unknown) => reportOnce("modelsLoad", "Model settings did not load", err));
    listModels("cursor", false)
      .then((list) => {
        if (!cancelled) setModelList(list);
      })
      .catch((err: unknown) => reportOnce("modelsLoad", "Model settings did not load", err));
    listModels("claude", false)
      .then((list) => {
        if (!cancelled) setClaudeModelList(list);
      })
      .catch((err: unknown) => reportOnce("modelsLoad", "Model settings did not load", err));
    return () => {
      cancelled = true;
    };
  }, []);

  // Split and file panel survive a restart (state.json).
  useEffect(() => {
    if (!layoutLoadedRef.current) return;
    const timer = window.setTimeout(() => {
      void saveLayout(split, filePanelOpen, filePanelWidth);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [split, filePanelOpen, filePanelWidth]);

  // Changes panel "Accepted" marks survive a reload (merged across windows).
  useEffect(() => {
    saveAccepted(acceptedChanges);
  }, [acceptedChanges]);

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
    if (!splitOpen(split) || split.mode === "grid") setFocusedPane("primary");
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
      .catch((err: unknown) => {
        if (cancelled) return;
        setRole(null);
        reportOnce("roleLoad", "The role did not load", err);
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
    // Only the role's last folder is recalled. Text and choice fields start
    // empty; old prompts must not pre-fill a new tab or a role pick.
    getFormRecall(roleId)
      .then((recall) => {
        if (token !== recallTokenRef.current) return;
        if (activeTabIdRef.current !== tabId) return;
        setValues((prev) => {
          const cwd = folderForTab(prev.cwd) || folderForTab(recall.cwd);
          if (cwd === (prev.cwd ?? "")) return prev;
          const next = { ...prev, cwd };
          if (tabId) {
            const current = draftsRef.current[tabId];
            if (current) draftsRef.current[tabId] = { ...current, values: next };
            if (cwd) knownFoldersRef.current[tabId] = cwd;
          }
          return next;
        });
      })
      // intentionally silent: recalling the last folder is a convenience.
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
  /** Tabs saved before providers carry no provider: they are Cursor tabs. */
  const providerOf = (tab: TabSummary | null): ProviderId => tab?.provider ?? "cursor";
  const claudeInfo = (() => {
    const fallback = providers.claude
      ? { configDir: providers.claude.configDir, login: providers.claude.login }
      : providers.view
        ? { configDir: providers.view.claudeConfigDir, login: null }
        : null;
    if (!windowAccount?.config.path) return fallback;
    const row = providers.accountLogins.find((item) => item.id === windowAccount.id);
    const source =
      windowAccount.config.source === "env" || windowAccount.config.source === "setting"
        ? windowAccount.config.source
        : ("default" as const);
    const configDir = row?.config ?? {
      path: windowAccount.config.path,
      display: windowAccount.config.display,
      source,
      exists: windowAccount.config.exists,
    };
    const firstId = providers.view
      ? (claudeAccounts(providers.view.settings.claude)[0]?.id ?? "default")
      : "default";
    const login = row?.login ?? (windowAccount.id === firstId ? (providers.claude?.login ?? null) : null);
    return { configDir, login, accountName: windowAccount.name || null };
  })();
  const activeProvider = providerOf(activeTabSummary);
  const historyProvider = historyOverride ?? activeProvider;
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
    // Rows of the previous folder or provider never show under the new one.
    setHistoryEntries([]);
    setHistoryError(null);
    if (session || !historyFolder) {
      setHistoryLoading(false);
      return;
    }
    setHistoryLoading(true);
    let cancelled = false;
    const showRows = (rows: CursorHistoryEntry[]) => {
      setHistoryEntries(rows);
      setHistoryError(null);
    };
    const load =
      historyProvider === "claude"
        ? loadHistoryInTwoPasses(
            () => listClaudeHistory(historyFolder, true).then((view) => view.entries),
            () =>
              listClaudeHistory(historyFolder).then((view) => {
                if (!cancelled) setHistoryReadFrom(view.configDisplay);
                return view.entries;
              }),
            showRows,
            () => cancelled,
          )
        : loadHistoryInTwoPasses(
            null,
            () =>
              listCursorCliHistory(historyFolder).then((rows) => {
                if (!cancelled) setHistoryReadFrom(null);
                return rows;
              }),
            showRows,
            () => cancelled,
          );
    load
      .catch((err: unknown) => {
        if (!cancelled) {
          setHistoryError(errorText(err));
        }
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [historyFolder, historyProvider, session]);

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
    // Only an unsent tab saves its form. A started tab keeps the answers it
    // ran with, so its "Start new session" text is never written back.
    if (tabWasStarted(savedTabsRef.current, tabId)) return;
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
      // A non-promise result must not throw out of this timer.
      void Promise.resolve(syncActiveTabForm(tabId, roleId, writeCwd, payload))
        .then(() => {
          if (activeTabIdRef.current === tabId) void refreshTabs();
        })
        .catch((err: unknown) => reportOnce("tabFormSync", "Tab form not saved", err));
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
            message: errorText(err),
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
      /**
       * Start a tab that is not the active one (the second pane's Restart):
       * its own role, answers and transcript, and it stays in its pane.
       */
      pane?: { roleId: string; values: Record<string, string>; transcript: string };
    },
  ) => {
    if (startLockRef.current) return;
    startLockRef.current = true;
    setBusy(true);
    const pane = resume?.pane ?? null;
    const tabKey = resume?.tabId ?? activeTabId;
    const startRoleId = pane?.roleId ?? roleId;
    const transcript = pane ? pane.transcript : savedTranscript;
    const resend = forceResend;
    const resumeId = resumeIdForStart({
      explicitSessionId: resume?.sessionId,
      storedSessionId: activeTabSummary?.acpSessionId,
      resumeStored: resume?.resumeStored,
      forceResend: resend,
    });
    const continuing = !!resumeId;
    const baseValues = pane?.values ?? formValues;
    const startValues = resume?.cwd
      ? { ...baseValues, cwd: resume.cwd }
      : baseValues;
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
          savedTranscript: transcript,
          existing: rt.segments,
        }),
      }));
    }
    try {
      const result = await roleSessionStart(
        startRoleId,
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
      if (!pane) setActiveTabId(targetId);
      patchRuntime(targetId, (rt) => {
        let segments = segmentsAfterResume({
          segments: rt.segments,
          loaded: result.loadedViaSessionLoad,
          replay: result.replay ?? [],
          replayMessageCount: result.replayMessageCount ?? 0,
          savedTranscript: transcript,
          folderWarning: result.folderWarning,
        });
        if (result.injectionInFlight && !continuing) {
          // The preview belongs to the active tab, not to a tab in its own pane.
          const startupText = pane ? undefined : preview?.merged?.text?.trim();
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
      if (!pane) setPreview(null);
      if (
        !resumeId &&
        eagleOnRef.current &&
        targetId &&
        !inChain(targetId) &&
        (startRoleId === "role_planner" || startRoleId === "role_implementer")
      ) {
        const kind = startRoleId === "role_planner" ? "eagle1" : "eagle2";
        await setTabChain(targetId, newChain(kind));
      }
      await refreshTabs();
    } catch (err: unknown) {
      const message = errorText(err);
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

  // The latest settings, also ahead of a render, so back-to-back patches stack.
  const terminalSettingsRef = useRef(terminalSettings);
  terminalSettingsRef.current = terminalSettings;
  /** Applies and saves. Rejects when the save fails, so Settings can show it. */
  const saveTerminalSettings = useCallback((next: TerminalSettings): Promise<void> => {
    terminalSettingsRef.current = next;
    setTerminalSettingsState(next);
    return setTerminalSettings(next).then(setTerminalSettingsState);
  }, []);
  const terminalPatchesRef = useRef<Promise<void>>(Promise.resolve());
  /**
   * Changes one part of the settings and saves. Before the settings load it
   * patches a fresh read, so the save cannot overwrite stored fields with
   * defaults. Patches run in order; returning `current` saves nothing.
   */
  const patchTerminalSettings = useCallback(
    (patch: (current: TerminalSettings) => TerminalSettings) => {
      terminalPatchesRef.current = terminalPatchesRef.current
        .then(async () => {
          const current = terminalSettingsRef.current ?? (await getTerminalSettings());
          const next = patch(current);
          if (next !== current) await saveTerminalSettings(next);
        })
        .catch((err: unknown) => {
          setTerminalError(errorText(err));
        });
    },
    [saveTerminalSettings],
  );

  const rememberedSurface = useCallback(
    // Terminal by default (the real Claude Code CLI); Chat only when chosen for the role.
    (id: string): HandoffSurface =>
      terminalSettings?.roleSurface[id] === "chat" ? "chat" : "terminal",
    [terminalSettings],
  );

  const rememberSurface = useCallback(
    (id: string, surface: HandoffSurface) =>
      patchTerminalSettings((current) => ({
        ...current,
        roleSurface: { ...current.roleSurface, [id]: surface },
      })),
    [patchTerminalSettings],
  );

  /** Terminals whose startup prompt was too long to pass inline and went through a file. */
  const [promptFileTabs, setPromptFileTabs] = useState<string[]>([]);
  /** Quiet starts wait their turn here instead of failing on a start in progress. */
  const quietStarts = useMemo(() => startQueue(() => startLockRef.current), []);
  const startRoleTerminalNow = useCallback(
    async (options?: {
      roleId: string;
      values: Record<string, string>;
      tabId?: string | null;
      handoffPlan?: string | null;
      /** Autopilot: keep the current tab on screen and throw errors instead of showing them. */
      quiet?: boolean;
      /** Launch as this provider (a hand-off keeps its source tab's). */
      provider?: ProviderId | null;
      /** The chain tag a hand-off's new tab joins: its stage kind sets the permission mode. */
      chain?: ChainRef | null;
    }) => {
      const quiet = !!options?.quiet;
      if (startLockRef.current) {
        // Unreachable for quiet starts: startQueue waits for the lock.
        if (quiet) throw new Error("Another tab is starting. Try again when it has started.");
        setTerminalError("Another tab is starting. Try again in a moment.");
        return null;
      }
      startLockRef.current = true;
      if (!quiet) {
        setBusy(true);
        setTerminalError(null);
      }
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
          provider: options?.provider ?? null,
          chain: options?.chain ?? null,
          ...measuredTerminalSize(),
          onOutput: live.channel,
        });
        if (result.errors.length > 0 || !result.tabId) {
          dropLivePty(pendingId);
          const errors =
            result.errors.length > 0
              ? result.errors
              : [{ key: "_session", message: "Terminal did not start" }];
          if (quiet) throw new Error(errors.map((err) => err.message).join(" "));
          setPreview({ errors, merged: null });
          return null;
        }
        if (result.tabId !== pendingId) rekeyLivePty(pendingId, result.tabId);
        if (result.usedPromptFile) {
          const fileTab = result.tabId;
          setPromptFileTabs((prev) => (prev.includes(fileTab) ? prev : [...prev, fileTab]));
        }
        if (!quiet) {
          setActiveTabId(result.tabId);
          setPreview(null);
        }
        if (
          !options &&
          eagleOnRef.current &&
          !inChain(pendingId) &&
          !inChain(result.tabId) &&
          (roleToStart === "role_planner" || roleToStart === "role_implementer")
        ) {
          const kind = roleToStart === "role_planner" ? "eagle1" : "eagle2";
          await setTabChain(result.tabId, newChain(kind));
        }
        await refreshTabs();
        return result.tabId;
      } catch (err: unknown) {
        dropLivePty(pendingId);
        if (quiet) throw err;
        const message = errorText(err);
        setTerminalError(message);
        return null;
      } finally {
        startLockRef.current = false;
        if (!quiet) setBusy(false);
      }
    },
    [activeTabId, formValues, refreshTabs, roleId],
  );
  const startRoleTerminal = useCallback(
    (options?: Parameters<typeof startRoleTerminalNow>[0]) =>
      options?.quiet ? quietStarts(() => startRoleTerminalNow(options)) : startRoleTerminalNow(options),
    [quietStarts, startRoleTerminalNow],
  );

  /** Starts a lane's role terminal in its own (worktree) draft tab, without taking focus. */
  const laneStartTerminal = useCallback(
    (tabId: string, laneRoleId: string, laneValues: Record<string, string>, plan: string | null) =>
      startRoleTerminal({ roleId: laneRoleId, values: laneValues, tabId, handoffPlan: plan, quiet: true }),
    [startRoleTerminal],
  );
  const startLaneOf = useCallback(
    async (run: PipelineRun, lane: RunLane) => {
      const laneRole =
        pipelineStages(run.kind).find((stage) => stage.id === run.fanOutStage)?.roleId ??
        behaviourRole(run.kind, "implementer");
      return startLane(run, lane, laneRole, { startTerminal: laneStartTerminal, refreshTabs });
    },
    [laneStartTerminal, refreshTabs],
  );
  /** A stage tab's hand-off source outside the dialog: a Claude terminal's log, or a chat's reply. */
  const stageSourceOf = useCallback(
    async (tab: TabSummary): Promise<HandoffSource> => {
      const answers = await getTab(tab.id)
        .then(({ tab: record }) => ({ ...record.answers }))
        .catch(() => ({ cwd: tab.cwd }));
      if (tab.kind === "terminal") {
        const log =
          sessionLogsRef.current[tab.id] ?? (await terminalSessionLog(tab.id).catch(() => null));
        return terminalStageSource({
          tab,
          log,
          answers,
          tail: terminalTailText(tab.id),
          roles,
          awaitingPlan: false,
        });
      }
      const segments = runtimesRef.current[tab.id]?.segments ?? [];
      return {
        sourceRoleId: tab.roleId,
        sourceChainKind: tab.chain?.kind ?? null,
        sourceTabId: tab.id,
        sourceLabel: tab.label || roleDisplayName(tab.roleId, roles),
        cwd: tab.cwd,
        answers,
        latestMessage:
          roleBehaviour(tab.roleId, tab.chain?.kind) === "implementer"
            ? latestAgentMessage(segments)
            : latestReplyText(segments),
        plan: [],
        todos: [],
        selection: "",
        turnInFlight: !!runtimesRef.current[tab.id]?.promptInFlight,
        transcriptText: segments.map((segment) => segment.text).join("\n"),
      };
    },
    [roles],
  );
  /** Overview › Fan out: one Implementer per pull request in the plan stage's reply. */
  const fanOutRunOf = useCallback(
    async (runId: string) => {
      const { run } = await getPipelineRun(runId);
      const def = pipelineDef(run.kind);
      const fanStage = def?.stages.find((stage) => stageBehaviour(def, stage) === "implementer");
      const planStage = def && fanStage ? planStageFor(def, fanStage) : null;
      const planTab = planStage ? stageTab(run, planStage, savedTabsRef.current) : null;
      if (!fanStage || !planTab?.chain) {
        throw new Error("Fan out needs this run's plan stage tab (the stage before the Implementer) to be open.");
      }
      const source = await stageSourceOf(planTab);
      const result = await fanOutRun(
        { run, stage: fanStage, source, sourceChain: planTab.chain },
        { startTerminal: laneStartTerminal, syncForm: syncActiveTabForm, refreshTabs, roles },
      );
      showNotice(
        "Fanned out",
        `Started ${result.started.length} pull request${result.started.length === 1 ? "" : "s"}` +
          (result.waiting.length ? `; ${result.waiting.length} wait for the ones they build on.` : "."),
      );
    },
    [laneStartTerminal, refreshTabs, roles, showNotice, stageSourceOf],
  );
  const startLaneById = useCallback(
    async (runId: string, laneId: string) => {
      const { run } = await getPipelineRun(runId);
      const lane = run.lanes?.find((item) => item.id === laneId);
      if (!lane) throw new Error(`No lane ${laneId} on this run.`);
      if (!(await startLaneOf(run, lane))) throw new Error(`${lane.title} is not waiting to start.`);
    },
    [startLaneOf],
  );
  /**
   * Overview › Mark approved (a lane) or Mark complete (`laneId` null, a run
   * without lanes): approve it by hand, then start the lanes it unblocks.
   */
  const approveLaneById = useCallback(
    async (runId: string, laneId: string | null) => {
      if (await approveByHand(runId, laneId, startLaneOf)) showNotice("Run complete", "Approved by you.");
    },
    [showNotice, startLaneOf],
  );

  const autopilot = useAutopilot({
    tabs: () => savedTabsRef.current,
    roles: () => roles,
    terminalState: (tabId) => terminalStatesRef.current[tabId],
    startTerminal: (options) =>
      startRoleTerminal({ ...options, tabId: null, quiet: true }),
    refreshTabs,
    notifyStop: (tabId, reason, code) =>
      notifyAgent(tabId, { kind: "question", detail: `Autopilot stopped. ${stopNotice(code, reason)}` }),
    notice: (title, body) => showNotice(title, body),
    startLane: startLaneOf,
    sessionLog: (tabId) => sessionLogsRef.current[tabId],
  });
  autopilotLogRef.current = autopilot.onTerminalLog;
  // The core stopped a run by itself (a stall, or a turn that finished while
  // the app was closed): tell you the way a stop autopilot made does.
  // Stops made before this listener attached (the startup reconcile) are
  // fetched once it is attached and this window's tabs have loaded (so the
  // toast's tab is known), and only those on this window's tabs.
  const [ownTabs] = useState(() => onceValue<string[]>());
  useEffect(() => {
    if (tabsLoaded) ownTabs.resolve(savedTabs.map((tab) => tab.id));
  }, [ownTabs, tabsLoaded, savedTabs]);
  useEffect(
    () =>
      subscribeAutopilotStops((event) => {
        notifyAgent(event.tabId, { kind: "question", detail: `Autopilot: ${event.summary}` });
      }, ownTabs.promise),
    [notifyAgent, ownTabs],
  );

  const startBlankTerminal = useCallback(
    async (launch: "shell" | CliLaunch) => {
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
          ...measuredTerminalSize(),
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
        const message = errorText(err);
        setTerminalError(message);
      } finally {
        startLockRef.current = false;
        setBusy(false);
      }
    },
    [activeTabId, refreshTabs, values.cwd],
  );

  const openCursorCli = useCallback(async (sessionId: string, cwd: string, source = "cli") => {
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
        launch: source === "claude" ? "claude-cli" : "cursor-cli",
        resumeSessionId: sessionId,
        ...measuredTerminalSize(),
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
      setCliLaunchNote(errorText(err));
    } finally {
      startLockRef.current = false;
      setBusy(false);
    }
  }, [refreshTabs]);

  /** A new Claude Code or shell terminal tab in `cwd` (⌘T, the new-tab picker). */
  const openTerminalTab = useCallback(
    async (launch: NewTerminalLaunch, cwd: string, reuseTabId: string | null = null) => {
      if (startLockRef.current) return;
      startLockRef.current = true;
      setBusy(true);
      // Only an untouched draft (a fresh start screen) turns into the terminal.
      const reusable = savedTabsRef.current.some(
        (tab) => tab.id === reuseTabId && tab.phase === "draft" && tab.kind !== "terminal",
      );
      try {
        if (!reusable) stashActiveTab();
        const tabId = await startTerminalTab(launch, cwd, reusable ? reuseTabId : null);
        setActiveTabId(tabId);
        await refreshTabs();
      } catch (err: unknown) {
        showNotice("Terminal did not start", errorText(err), "failed");
      } finally {
        startLockRef.current = false;
        setBusy(false);
      }
    },
    [refreshTabs, showNotice, stashActiveTab],
  );

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
        setHistoryError(errorText(err));
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

  const confirmStop = useCallback(
    () =>
      confirm({
        title: "Stop this session?",
        message:
          "The agent stops and any turn in progress is lost. The transcript is saved with the tab, and you can continue the session later.",
        confirmLabel: "Stop session",
        danger: true,
      }),
    [confirm],
  );

  /** The Stop button: ends the agent for good, so it asks first. */
  const requestStopSession = useCallback(async () => {
    if (await confirmStop()) await stopSession();
  }, [confirmStop, stopSession]);

  /** The second pane's Stop button: asks first, like the main pane's. */
  const requestStopSecondarySession = useCallback(
    async (tabId: string) => {
      if (await confirmStop()) await stopSecondarySession(tabId);
    },
    [confirmStop, stopSecondarySession],
  );

  /** The second pane's Restart: stop that tab and start it again in its pane, resuming its session. */
  const restartSecondarySession = useCallback(
    async (tabId: string) => {
      const tab = savedTabsRef.current.find((t) => t.id === tabId);
      if (!tab) return;
      const rt = runtimesRef.current[tabId];
      const resumeId = rt?.session?.sessionId || tab.acpSessionId || undefined;
      const transcript = segmentsToPlainText(rt?.segments ?? []);
      const draft = draftsRef.current[tabId];
      const values = { ...(draft?.values ?? {}), cwd: tab.cwd || draft?.values.cwd || "" };
      await stopSecondarySession(tabId);
      await startSession(false, {
        tabId,
        sessionId: resumeId,
        pane: { roleId: draft?.roleId ?? tab.roleId, values, transcript },
      });
    },
    [stopSecondarySession, startSession],
  );

  /** Restart: stop an agent that exited and start the same tab again, resuming its session. */
  const restartSession = useCallback(async () => {
    const tabId = activeTabId;
    if (!tabId) return;
    const resumeId = session?.sessionId || activeTabSummary?.acpSessionId || undefined;
    await stopSession();
    await startSession(false, resumeId ? { tabId, sessionId: resumeId } : { tabId });
  }, [activeTabId, session, activeTabSummary, stopSession, startSession]);

  const handleSelectTab = useCallback(
    async (tabId: string) => {
      if (tabId === activeTabIdRef.current) {
        // Back on the tab still shown: a switch to another tab that is still loading must not land.
        if (tabSwitchesRef.current.stayOn(tabId)) setBusy(false);
        return;
      }
      const fileGuard = fileDiscardGuardRef.current;
      if (fileGuard?.dirty() && !(await fileGuard.confirm())) return;
      // The answer can come after another switch.
      if (tabId === activeTabIdRef.current) return;
      stashActiveTab();
      // A newer switch drops this one's answer and ends the busy state itself.
      const ticket = tabSwitchesRef.current.begin(tabId);
      const summary = savedTabs.find((tab) => tab.id === tabId);
      if (
        summary?.kind === "terminal" ||
        summary?.kind === "pipeline_overview" ||
        summary?.kind === "preview" ||
        summary?.kind === "github"
      ) {
        setActiveTabId(tabId);
        setBusy(true);
        try {
          await selectActiveTab(tabId);
          if (!ticket.isCurrent()) return;
          await refreshTabs();
        } finally {
          if (ticket.finish()) setBusy(false);
        }
        return;
      }
      const cached = draftsRef.current[tabId];
      if (cached) applyDraft(tabId, cached);
      setBusy(true);
      try {
        const { tab } = await selectActiveTab(tabId);
        if (!ticket.isCurrent()) return;
        if (tab.kind === "terminal") {
          setActiveTabId(tab.id);
          await refreshTabs();
          return;
        }
        loadTabIntoForm(tab);
        await refreshTabs();
      } finally {
        if (ticket.finish()) setBusy(false);
      }
    },
    [applyDraft, loadTabIntoForm, refreshTabs, savedTabs, stashActiveTab],
  );

  /** Show (or open) an Eagle-Eye chain's overview tab. Starts nothing. */
  const openChainOverviewTab = useCallback(
    async (chainId: string) => {
      const fileGuard = fileDiscardGuardRef.current;
      if (fileGuard?.dirty() && !(await fileGuard.confirm())) return;
      try {
        stashActiveTab();
        const { tabId, state } = await openChainOverview(chainId);
        setSavedTabs(state.tabs);
        setClosedTabs(state.closedTabs ?? []);
        setActiveTabId(tabId);
      } catch (err: unknown) {
        showNotice("Chain overview", errorText(err), "failed");
      }
    },
    [showNotice, stashActiveTab],
  );

  const handleCloseTab = useCallback(
    async (tabId: string): Promise<boolean> => {
      const fileGuard = fileDiscardGuardRef.current;
      if (tabId === activeTabIdRef.current && fileGuard?.dirty() && !(await fileGuard.confirm())) {
        return false;
      }
      setBusy(true);
      try {
        const rt = runtimes[tabId];
        if (rt && rt.segments.length > 0) {
          const cwd = rt.session?.cwd ?? values.cwd ?? "";
          await transcriptSave(tabId, segmentsToPlainText(rt.segments), cwd).catch(
            (err: unknown) => {
              const message = errorText(err);
              setTranscriptSaveError(message);
            },
          );
        }
        scratch.flush();
        if (tabId === activeTabIdRef.current) stashActiveTab();
        delete draftsRef.current[tabId];
        delete knownFoldersRef.current[tabId];
        delete scrollPositions.current[tabId];
        forgetComposerDraft(tabId);
        dropLivePty(tabId);
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
          // Folder only: the closed tab's text must not carry over.
          const recall = await getFormRecall(roleId);
          setValues({ cwd: folderForTab(recall.cwd) });
          setSavedTranscript("");
          setPickedRoleId(null);
          setActiveTabId(null);
        }
        // Released once the tab's view has unmounted; released earlier, the
        // still-mounted view would create a fresh terminal and park it.
        window.setTimeout(() => destroyTerminal(tabId), 0);
        return true;
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
        const ok = await confirm({
          title: "Remove worktree",
          message:
            `Remove the worktree for ${branch}?\n\n${check.worktree.path}\n\n` +
            "This closes the tab, stops its agent or shell, and deletes that folder. " +
            "The branch and its commits are kept.",
          confirmLabel: "Remove worktree",
          danger: true,
        });
        if (!ok) return;
        if (!(await handleCloseTab(tabId))) return;
        await worktreeTabRemove(tabId, true);
        showNotice("Worktree removed", `${branch} · ${check.worktree.path}`);
      } catch (err: unknown) {
        showNotice(
          "Worktree not removed",
          errorText(err),
          "failed",
        );
      }
    },
    [confirm, handleCloseTab, showNotice],
  );

  /** Opens a draft tab on the start screen; resolves to its id (null when none opened). */
  const openStartScreenTab = useCallback(async (): Promise<string | null> => {
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
      if (!newActive) return null;
      const { tab } = await getTab(newActive);
      applyDraft(tab.id, {
        roleId: tab.roleId,
        pickedRoleId: null,
        values: { cwd: "" },
        transcript: "",
        newSessionOpen: false,
        resendStartup: false,
      });
      return tab.id;
    } finally {
      setBusy(false);
    }
  }, [applyDraft, roleId, roles, stashActiveTab]);

  /** The window's GitHub tab: opened, or switched to when it already exists. */
  const openGithub = useCallback(() => {
    stashActiveTab();
    void openGithubTab()
      .then((snap) => {
        setSavedTabs(snap.tabs);
        setClosedTabs(snap.closedTabs ?? []);
        if (snap.activeTabId) setActiveTabId(snap.activeTabId);
      })
      .catch((err: unknown) => showNotice("Could not open GitHub", errorText(err), "failed"));
  }, [stashActiveTab, showNotice]);

  const newTab = useNewTab({
    mode: () => terminalSettings?.newTabOpens,
    activeCwd: () => activeTabFolder(savedTabsRef.current, activeTabIdRef.current),
    openStartScreen: openStartScreenTab,
    openRoleLauncher,
    openGithub,
    openTerminal: openTerminalTab,
    saveMode: (mode) => patchTerminalSettings((current) => ({ ...current, newTabOpens: mode })),
  });
  newTabLaunchRef.current = newTab.launch;
  const requestNewTab = newTab.request;

  // The GitHub monitor polls for the window while it has a GitHub tab, on
  // screen or not, and announces what needs the user.
  const githubTabId = savedTabs.find((tab) => tab.kind === "github")?.id ?? null;
  const githubVisible =
    !!githubTabId &&
    !settingsOpen &&
    (activeTabId === githubTabId ||
      (splitOpen(split) && split.secondaryTabId === githubTabId) ||
      (gridOpen(split) && (split.gridTabIds ?? []).includes(githubTabId)));
  useGithubPoller({
    tabId: githubTabId,
    visible: githubVisible,
    visibleTabIds: () => {
      const current = splitRef.current;
      return [activeTabIdRef.current, splitOpen(current) ? current.secondaryTabId : null];
    },
    settings: notificationSettings,
    toast: (tabId, title, body) => showNotice(title, body, "finished", tabId),
  });

  const handleNewTab = useCallback(async () => {
    const fileGuard = fileDiscardGuardRef.current;
    if (fileGuard?.dirty() && !(await fileGuard.confirm())) return;
    await requestNewTab();
  }, [requestNewTab]);

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
      const message = errorText(err);
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
        const message = errorText(err);
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

  const respondPlanFor = useCallback(
    async (tabId: string | null, outcome: "accepted" | "cancelled") => {
      if (!tabId) return;
      const request = runtimesRef.current[tabId]?.plan;
      if (!request) return;
      setBusy(true);
      try {
        await respondPlanRequest(tabId, request.jsonRpcId, outcome);
        patchRuntime(tabId, (rt) => clearPlan(rt));
      } catch (err: unknown) {
        const message = errorText(err);
        patchRuntime(tabId, (rt) => ({ ...rt, promptError: message }));
      } finally {
        setBusy(false);
      }
    },
    [patchRuntime],
  );

  const respondQuestionFor = useCallback(
    async (
      tabId: string | null,
      outcome: "answered" | "skipped" | "cancelled",
      choiceId?: string,
    ) => {
      if (!tabId) return;
      const request = runtimesRef.current[tabId]?.question;
      if (!request) return;
      setBusy(true);
      try {
        await respondQuestionRequest(tabId, request.jsonRpcId, outcome, choiceId);
        patchRuntime(tabId, (rt) => clearQuestion(rt));
      } catch (err: unknown) {
        const message = errorText(err);
        patchRuntime(tabId, (rt) => ({ ...rt, promptError: message }));
      } finally {
        setBusy(false);
      }
    },
    [patchRuntime],
  );

  const handleQuestionAnswer = useCallback(
    (choiceId: string) => respondQuestionFor(activeTabId, "answered", choiceId),
    [activeTabId, respondQuestionFor],
  );

  const handleQuestionSkip = useCallback(
    () => respondQuestionFor(activeTabId, "skipped"),
    [activeTabId, respondQuestionFor],
  );

  const handleQuestionCancel = useCallback(
    () => respondQuestionFor(activeTabId, "cancelled"),
    [activeTabId, respondQuestionFor],
  );

  /** Hands a prompt to the agent; `turn` settles when that turn ends. */
  const dispatchText = useCallback(
    async (
      tabId: string,
      text: string,
      onNotSent?: () => void,
      /** A send-back from another tab: the user's own draft and images stay put. */
      fromHandoff = false,
    ): Promise<{ turn: Promise<TurnOutcome> } | "error"> => {
      const trimmed = text.trim();
      const blocked = trimmed ? blockedSlashCommand(trimmed) : null;
      if (blocked) {
        // Staged images stay on the tab for the corrected message.
        patchRuntime(tabId, (rt) => ({ ...rt, promptError: blocked }));
        onNotSent?.();
        return "error" as const;
      }
      // Pasted images go with this message only, so a --- chain's later steps send none.
      const images = fromHandoff ? [] : chatImages.actions.take(tabId);
      if (!trimmed && images.length === 0) return "error" as const;
      waiterRef.current.forget(tabId);
      const pending = waiterRef.current.expect(tabId);
      setHistoryCursor(-1);
      if (trimmed && !fromHandoff) {
        // Saved with the tab's pad (scratch.json), so Up-arrow history survives a restart.
        scratch.remember(tabId, trimmed);
        // intentionally silent: the recent-sends record is best effort.
        void promptRecordSend(trimmed, "chat").catch(() => {});
      }
      patchRuntime(tabId, (rt) => ({
        ...rt,
        promptError: null,
        followUp: fromHandoff ? rt.followUp : "",
        promptInFlight: true,
        planStale: true,
        segments: appendStreamSegment(
          rt.segments,
          streamSegmentFromUserMessage(withImageMarkers(trimmed, images)),
        ),
      }));
      try {
        const ids = images.map((image) => image.id);
        await (ids.length ? devSessionSend(trimmed, tabId, ids) : devSessionSend(trimmed, tabId));
      } catch (err: unknown) {
        waiterRef.current.cancel(tabId);
        chatImages.actions.restore(tabId, images);
        const message = errorText(err);
        patchRuntime(tabId, (rt) => ({
          ...rt,
          promptError: message,
          promptInFlight: false,
        }));
        onNotSent?.();
        return "error" as const;
      }
      return { turn: pending };
    },
    [chatImages.actions, patchRuntime, scratch],
  );

  /** Sends and waits for the turn to end (chain steps). */
  const sendText = useCallback(
    async (tabId: string, text: string, onNotSent?: () => void) => {
      const sent = await dispatchText(tabId, text, onNotSent);
      return sent === "error" ? sent : sent.turn;
    },
    [dispatchText],
  );

  const sendFollowUpFor = useCallback(
    async (tabId: string | null) => {
      if (!tabId) return;
      const rt = runtimesRef.current[tabId];
      const text = rt?.followUp.trim() ?? "";
      if ((!text && !chatImages.actions.has(tabId)) || !rt || rt.agentExited || rt.promptInFlight) {
        return;
      }
      // Busy only until the prompt is handed off, not for the whole turn.
      setBusy(true);
      try {
        await dispatchText(tabId, text);
      } finally {
        setBusy(false);
      }
    },
    [chatImages.actions, dispatchText],
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
    if (next === followUp) return;
    setFollowUp(next);
    // The text moved to the input, so it leaves the pad.
    scratch.setContent(activeTabId, padAfterSend(scratch.content, padSelection(padRef.current)));
    inputRef.current?.focus();
  }, [activeTabId, followUp, scratch]);

  const runChain = useCallback(async () => {
    if (!activeTabId || promptInFlight || permissionRequest || questionRequest) return;
    const started = chainStart(scratch.content);
    if (!started) return;
    // Refuse the whole chain up front, so no step goes out before a blocked one.
    const blocked = started.steps.map(blockedSlashCommand).find(Boolean);
    if (blocked) {
      patchRuntime(activeTabId, (rt) => ({ ...rt, promptError: blocked }));
      return;
    }
    const tabId = activeTabId;
    const padAtStart = scratch.content;
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
    // Every step was sent: empty the pad, unless it was edited meanwhile.
    // A stopped chain keeps its steps.
    if (cursor.phase === "done" && padTextRef.current[tabId] === padAtStart) {
      scratch.setContent(tabId, "");
    }
  }, [activeTabId, patchRuntime, permissionRequest, questionRequest, promptInFlight, scratch, sendText]);

  const sendFromPad = useCallback(() => {
    // One turn at a time: a second send would be refused and must not end the running one.
    if (!activeTabId || runtimesRef.current[activeTabId]?.promptInFlight) return;
    const steps = splitChainSteps(scratch.content);
    if (steps.length > 1 && !followUp.trim()) {
      void runChain();
      return;
    }
    if (followUp.trim()) {
      void sendFollowUp();
      return;
    }
    const pad = scratch.content;
    // A pad with one real step and stray --- lines sends just that step.
    const text = steps.length === 1 ? steps[0] : pad;
    if (text.trim() || chatImages.actions.has(activeTabId)) {
      const tabId = activeTabId;
      // Sent text leaves the pad (Recent sends keeps it). If it never
      // reached the agent and the pad is still empty, put it back.
      scratch.setContent(tabId, "");
      void sendText(tabId, text, () => {
        if (!padTextRef.current[tabId]) scratch.setContent(tabId, pad);
      });
    }
  }, [activeTabId, chatImages.actions, followUp, runChain, scratch, sendFollowUp, sendText]);

  // F8: show first-run setup on a fresh profile only.
  useEffect(() => {
    let cancelled = false;
    firstRunCheck()
      .then((status) => {
        if (!cancelled && status?.needed) setFirstRunOpen(true);
      })
      .catch((err: unknown) => reportOnce("firstRunStatus", "Setup check failed", err));
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
    const fileGuard = fileDiscardGuardRef.current;
    if (fileGuard?.dirty() && !(await fileGuard.confirm())) return;
    setBusy(true);
    try {
      stashActiveTab();
      const { tab } = await reopenClosedTab();
      await refreshTabs();
      loadTabIntoForm(tab);
    } catch (err: unknown) {
      const message = errorText(err);
      setPreview({ errors: [{ key: "_session", message }], merged: null });
    } finally {
      setBusy(false);
    }
  }, [loadTabIntoForm, refreshTabs, stashActiveTab]);

  const splitRef = useRef(split);
  splitRef.current = split;

  /** Settings role key for a tab: its role, or "cursor-cli" / "claude-cli" for CLI tabs. */
  const modelRoleKey = (tab: TabSummary | null | undefined): string | null => {
    if (!tab) return null;
    if (tab.kind === "terminal" && tab.terminalLaunch === "cursor-cli") return "cursor-cli";
    if (tab.kind === "terminal" && tab.terminalLaunch === "claude-cli") return "claude-cli";
    return tab.roleId || null;
  };

  const inheritedModel = (tab: TabSummary | null | undefined): string =>
    effectiveModelFor(
      tab && tabHasProvider(tab) ? providerOf(tab) : "cursor",
      modelSettings,
      modelRoleKey(tab),
      null,
    );
  /** Model choices follow the tab's provider. Claude uses the cached adapter list. */
  const modelsForTab = (tab: TabSummary | null | undefined) =>
    modelsForProvider(
      tab && tabHasProvider(tab) ? providerOf(tab) : "cursor",
      modelList?.models ?? [],
      claudeModelList?.models,
    );

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
          const target =
            model ??
            effectiveModelFor(
              tabHasProvider(tab) ? providerOf(tab) : "cursor",
              modelSettings,
              modelRoleKey(tab),
              null,
            );
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
            const restart = await confirm({
              title: "Restart to apply the model",
              message: "The new model applies when the terminal restarts. Stop the running agent now?",
              confirmLabel: "Stop the agent",
              cancelLabel: "Later",
            });
            if (restart) {
              await ptyKill(tab.id).catch((err: unknown) =>
                showNotice("Could not stop the agent", errorText(err), "failed"),
              );
              setModelNotice("The agent stopped. Press Restart to use the new model.");
            } else {
              setModelNotice("The new model applies the next time this terminal starts.");
            }
          }
        }
        await refreshTabs();
      } catch (err: unknown) {
        setModelNotice(errorText(err));
      }
    },
    [confirm, modelSettings, patchRuntime, refreshTabs, showNotice],
  );

  const controls = headerControls({
    busy,
    savedTabs,
    runtimes,
    cardsByTab,
    tabStatuses,
    changeCounts,
    activityTabId,
    setChangesTabId,
    setActivityTabId,
    providerOf,
    inheritedModel,
    modelsForTab,
    changeTabModel,
    patchRuntime,
    showNotice,
  });

  const refreshModelList = useCallback(() => {
    setModelsRefreshing(true);
    return Promise.all([listModels("cursor", true), listModels("claude", false)])
      .then(([cursor, claude]) => {
        setModelList(cursor);
        setClaudeModelList(claude);
        return cursor;
      })
      .finally(() => setModelsRefreshing(false));
  }, []);

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

  /** Grid view on or off. It opens with the active tab, then tabs in bar order. */
  const toggleGrid = useCallback(() => {
    const current = splitRef.current;
    if (gridOpen(current)) {
      setSplit(closeSplit(current));
      return;
    }
    const active = activeTabIdRef.current;
    const ids = savedTabs.map((tab) => tab.id);
    if (ids.length < 2) {
      showNotice("Nothing to show in a grid", "Open another tab first, then use Grid view.", "question");
      return;
    }
    const seed = active ? [active, ...ids.filter((id) => id !== active)] : ids;
    setSplit(openGrid(current, seed.slice(0, GRID_MAX_TABS), active));
  }, [savedTabs, showNotice]);

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
        // Settings holds unsaved role edits: Escape asks before dropping them.
        if (settingsOpen && settingsDirtyRef.current) {
          void confirm({
            title: "Leave Settings?",
            message: "Your role edits are not saved. Leaving discards them.",
            confirmLabel: "Discard and leave",
            danger: true,
          }).then((ok) => {
            if (ok) setSettingsOpen(false);
          });
          return;
        }
        setChangesTabId(null);
        setActivityTabId(null);
        setChatSearchQuery(null);
        setPromptLibraryOpen(null);
        setWorkspacesOpen(null);
        setChatHistoryOpen(false);
        setWorktreeDialogOpen(false);
        setPaletteOpen(false);
        setSwitcherOpen(false);
        setRoleLauncherOpen(false);
        setShortcutsOpen(false);
        setSettingsOpen(false);
        setSplitPicker(null);
        // The hand-off dialog closes like its Cancel button: not mid-confirm.
        if (!handoffLockRef.current) {
          setHandoffTarget(null);
          setTerminalCapture(null);
        }
        return;
      }
      if (match.action === "settings") {
        setPaletteOpen(false);
        setSwitcherOpen(false);
        setShortcutsOpen(false);
        guardFileEdits(() => setSettingsOpen((open) => toggleSettings(open)));
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
      // A Claude terminal tab shown as Chat: the composer is its input.
      const chatViewTab = chatViewShownRef.current;
      if (match.action === "toggleTerminalView") {
        const tab = savedTabs.find((item) => item.id === activeTabIdRef.current);
        if (!tab || showGridRef.current || !isClaudeTerminal(tab)) return;
        const next = toggledView(terminalViewOf(terminalViewsRef.current, tab.id));
        setTerminalView(tab.id, next);
        // The terminal takes focus when it mounts; the composer focuses itself.
        return;
      }
      if (match.action === "roleLauncher") {
        openRoleLauncher();
        return;
      }
      if (
        chatViewTab &&
        (match.action === "send" || match.action === "focusInput" || match.action === "focusPad")
      ) {
        if (match.action === "send") {
          const inComposer = document.activeElement?.closest(".terminal-chat-composer");
          if (inComposer) terminalComposerRef.current?.send();
        } else {
          terminalComposerRef.current?.focus();
        }
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
        const closing = activeTabId;
        void (async () => {
          if (
            running &&
            !(await confirm({
              title: "Close tab",
              message: "Stop this tab's agent and close it?",
              confirmLabel: "Stop and close",
              danger: true,
            }))
          ) {
            return;
          }
          await handleCloseTab(closing);
        })();
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
      if (match.action === "toggleGrid") {
        toggleGrid();
        return;
      }
      if (match.action === "toggleFilePanel") {
        guardFileEdits(() => setFilePanelOpen((open) => !open));
        return;
      }
      if (match.action === "find") {
        handleFind();
        return;
      }
      if (
        match.action === "zoomIn" ||
        match.action === "zoomOut" ||
        match.action === "zoomReset"
      ) {
        const action = match.action;
        patchTerminalSettings((current) => {
          const next = zoomedFontSize(current.fontSize, action);
          return next === current.fontSize ? current : { ...current, fontSize: next };
        });
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
      confirm,
      settingsOpen,
      handleFind,
      terminalSettings,
      patchTerminalSettings,
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
      toggleGrid,
      focusPane,
      transferPad,
      padHiddenNow,
      updateUi,
      guardFileEdits,
      setTerminalView,
      openRoleLauncher,
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
    const padBefore = scratch.content;
    const selected = padSelection(field);
    // `---` steps reach a shell one per send, never as a `---` command.
    const step = selected ? null : firstChainStep(padBefore);
    const sent = step?.range ?? selected;
    let text = step?.text ?? padBefore;
    if (field && selected) text = field.value.slice(selected.start, selected.end);
    const payload = text.endsWith("\n") ? text : `${text}\n`;
    if (!payload.trim()) return;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        notePtyInput(target);
        await ptyWrite(target, payload);
        setTerminalError(null);
        // Sent to the shell: it leaves the pad and joins Recent sends.
        // intentionally silent: the recent-sends record is best effort.
        void promptRecordSend(text.trim(), "terminal").catch(() => {});
        if (padTextRef.current[tabId] === padBefore) {
          scratch.setContent(tabId, padAfterSend(padBefore, sent));
        }
        return;
      } catch {
        // The PTY may not be attached yet: retry; the loop ends in a visible error below.
        await new Promise((resolve) => window.setTimeout(resolve, 50));
      }
    }
    setTerminalError("The terminal is not ready for input yet.");
  }, [savedTabs, scratch]);

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

  // path:line in terminal output opens that file in the Files panel.
  const openTerminalFileRef = useRef<(id: string, path: string) => void>(() => {});
  openTerminalFileRef.current = (id, path) => {
    const tabId = id.replace(/::pane$/, "");
    const tab = savedTabs.find((item) => item.id === tabId);
    if (!tab) return;
    const relative = relativeToCwd(path, tab.cwd);
    if (!relative) {
      showNotice("Cannot open file", `${path} is outside this tab's folder.`, "question");
      return;
    }
    if (tabId !== activeTabIdRef.current) void handleSelectTab(tabId);
    setFilePanelOpen(true);
    setFileFocus({ path: relative, nonce: Date.now() });
  };
  useEffect(() => {
    setTerminalFileOpener((id, path) => openTerminalFileRef.current(id, path));
    return () => setTerminalFileOpener(null);
  }, []);

  const getSurface = useCallback(() => {
    const el = document.activeElement;
    // The visible view decides (keySurface): a chat view routes like chat
    // even while its parked xterm still holds focus. The pad is not the PTY.
    return keySurface({
      // The second pane is another tab with its own view.
      view: chatViewShownRef.current && !el?.closest("[data-pane='secondary']") ? "chat" : null,
      focus: el?.closest(".scratch-pad")
        ? "pad"
        : el?.closest(".terminal-slot, .xterm")
          ? "terminal"
          : "other",
    });
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
    onPermissionEscape: (target) => {
      // The focused pane's permission card takes a bare Escape, as its own key listener would.
      if (isEditableTarget(target)) return false;
      const tabId =
        focusedPane === "secondary" && splitOpen(split) ? split.secondaryTabId : activeTabId;
      if (!tabId || !runtimesRef.current[tabId]?.permission) return false;
      if (!busy) void respondPermissionFor(tabId, null);
      return true;
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
      .catch((err: unknown) => reportOnce("handoffList", "Hand-offs did not load", err));
  }, []);

  useEffect(() => {
    diagnosticsStatus()
      .then((status) => {
        setDiagnostics(status);
        setCaptureOn(status.capturePermissionPayloads);
      })
      .catch((err: unknown) => reportOnce("diagnosticsStatus", "Diagnostics status did not load", err));
  }, []);

  useEffect(() => {
    // A data file moved aside at startup (damaged, or from another version).
    startupNotices()
      .then((notes) => {
        // One toast for all notes: the toast list keeps only the newest few,
        // so a toast per note would drop the oldest when many files were kept.
        if (!notes?.length) return;
        const body =
          notes.length === 1
            ? notes[0]
            : [`${notes.length} data files needed recovery.`, ...notes].join("\n");
        showNoticeRef.current("Data recovered", body, "failed", DATA_RECOVERED_SLOT);
      })
      .catch((err: unknown) => reportOnce("startupNotices", "Startup notices did not load", err));
  }, []);

  // Closing the window stops its agents and terminals, so ask first. A second
  // close request while the question is open is ignored.
  const closeAskingRef = useRef(false);
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    onWindowCloseRequested(async (event) => {
      if (closeAskingRef.current) {
        event.preventDefault();
        return;
      }
      const live = liveTabs(savedTabsRef.current);
      if (live.length === 0) return;
      closeAskingRef.current = true;
      try {
        const ok = await confirm({
          title: "Close window?",
          message:
            live.length === 1
              ? "1 running agent or terminal in this window will be stopped."
              : `${live.length} running agents or terminals in this window will be stopped.`,
          confirmLabel: "Close window",
          danger: true,
        });
        if (!ok) {
          event.preventDefault();
          return;
        }
        // The chat so far, as when the workspace is replaced.
        for (const t of live) {
          const rt = runtimesRef.current[t.id];
          if (t.kind !== "terminal" && rt && rt.segments.length > 0) {
            await transcriptSave(t.id, segmentsToPlainText(rt.segments), rt.session?.cwd ?? t.cwd).catch(
              (err: unknown) => reportOnce("transcriptSave", "Transcript not saved", err),
            );
          }
        }
      } finally {
        closeAskingRef.current = false;
      }
    })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((err: unknown) => reportOnce("closeRequested", "Close confirmation is off", err));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [confirm, reportOnce]);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      getClaudeUsage()
        .then((snap) => {
          if (cancelled) return;
          setUsageSnap(snap);
          // One heads-up per window: near the limit, then again if it is reached.
          for (const alert of limitAlerts(snap.windows)) {
            if (limitAlertedRef.current.has(alert.key)) continue;
            limitAlertedRef.current.add(alert.key);
            showNotice(alert.title, alert.body, alert.reached ? "failed" : "question");
          }
        })
        .catch((err: unknown) => reportOnce("usageLimits", "Usage limits did not load", err));
    };
    load();
    const timer = window.setInterval(load, 20_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const refreshApprovalMode = useCallback(() => {
    cursorApprovalMode()
      .then(setApprovalMode)
      .catch((err: unknown) => reportOnce("approvalMode", "Approval mode did not load", err));
  }, [reportOnce]);

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
    setHandoffTemplate(null);
    getRole(target)
      .then((loaded) => {
        setHandoffTemplate(loaded.templateText ?? null);
        setHandoffFields(handoffFieldsOf(loaded));
      })
      .catch((err: unknown) => {
        const message = errorText(err);
        setHandoffError(message);
      });
  }, []);

  /** Tabs that can join the grid (or start one with the active tab). */
  const gridCandidates = savedTabs.filter((tab) =>
    gridOpen(split) ? !(split.gridTabIds ?? []).includes(tab.id) : tab.id !== activeTabId,
  );

  /** Role terminal that can hand off: a plan, a report, a review, or finished work (selection or tail). */
  const isTerminalSource = (tab: TabSummary | null | undefined): boolean =>
    tab?.kind === "terminal" &&
    tab.terminalLaunch === "role" &&
    isHandoffSource(tab.roleId, roles, tab.chain ?? null);
  const isPlanTerminal = isTerminalSource(activeTabSummary);
  const planTerminalTargets: HandoffTargetId[] =
    isPlanTerminal && activeTabSummary
      ? handoffTargets(activeTabSummary.roleId, roles, activeTabSummary.chain ?? null)
      : [];

  /**
   * Reads a reviewer terminal's verdict: the session log's last reply, else
   * its selection, else its tail. `fresh` re-reads the log first.
   */
  const readTerminalVerdict = useCallback(
    (tabId: string | null | undefined, fresh = false) => {
      const tab = tabId ? savedTabsRef.current.find((item) => item.id === tabId) : undefined;
      if (!tab || tab.kind !== "terminal" || !isReviewerRole(tab.roleId, tab.chain?.kind)) return;
      const apply = (log: TerminalSessionLog | null | undefined) => {
        const verdict = terminalLogVerdict(
          log,
          terminalSelection(tab.id) || terminalTailText(tab.id),
        );
        setTerminalVerdict((prev) =>
          prev?.tabId === tab.id && prev.verdict === verdict ? prev : { tabId: tab.id, verdict },
        );
      };
      apply(sessionLogsRef.current[tab.id]);
      if (!fresh) return;
      const readAt = Date.now();
      void terminalSessionLog(tab.id)
        // intentionally silent: a polled status read; the next tick retries.
        .catch(() => null)
        .then((log) => {
          storeSessionLog(tab.id, log, readAt);
          apply(log);
        });
    },
    [storeSessionLog],
  );
  const activeTerminalBusy = !!activeTabId && terminalWorking(activeTabId);
  const activeLogReply = activeTabId ? sessionLogs[activeTabId]?.lastReply : undefined;
  useEffect(() => {
    if (isPlanTerminal && !activeTerminalBusy) readTerminalVerdict(activeTabId);
  }, [activeLogReply, activeTabId, activeTerminalBusy, isPlanTerminal, readTerminalVerdict]);
  const terminalRoute =
    isPlanTerminal && activeTabSummary
      ? handoffRoute({
          sourceRoleId: activeTabSummary.roleId,
          targets: planTerminalTargets,
          verdict: terminalVerdict?.tabId === activeTabSummary.id ? terminalVerdict.verdict : null,
          chain: activeTabSummary.chain ?? null,
          roles,
        })
      : null;

  const openTerminalHandoff = useCallback(
    async (target: HandoffTargetId, sourceTabId?: string) => {
      const tabId = sourceTabId ?? activeTabIdRef.current;
      if (!tabId) return;
      // A tab switch while the reads below run drops this dialog.
      const seen = tabSwitchesRef.current.watch();
      const captured = readTerminalHandoff(tabId);
      // The first start: a plan written before a Restart or Resume still counts.
      const started = livePty(tabId)?.planSince ?? Date.now();
      const tab = savedTabsRef.current.find((item) => item.id === tabId);
      const sourceRoleId = tab?.roleId ?? "";
      setHandoffError(null);
      confirmedClaimRef.current = null;
      const logReadAt = Date.now();
      const logRead = terminalSessionLog(tabId).catch(() => null);
      const answers = await getTab(tabId)
        .then(({ tab: record }) => ({ ...record.answers }))
        .catch(() => ({ cwd: tab?.cwd ?? "" }));
      let planFile: PlanFileInfo | null = null;
      let planError: string | null = null;
      // Reports never use a plan file: the plans folder is shared by every tab.
      if (isPlanSource(sourceRoleId, tab?.chain?.kind)) {
        try {
          // Read-only: ~/.cursor/plans, or <configDir>/plans for a Claude tab.
          // No plan file → the dialog defaults to the selection, then the tail.
          const file = await terminalPlanFile(
            started,
            tabId,
            terminalPlanNames(savedTabsRef.current, tabId, captured.scrollback),
          );
          if (file?.text.trim()) planFile = file;
        } catch (err: unknown) {
          planError = errorText(err);
        }
      }
      const log = await logRead;
      storeSessionLog(tabId, log, logReadAt);
      if (!seen.isCurrent()) return;
      if (planError) setHandoffError(planError);
      readTerminalVerdict(tabId);
      setTerminalCapture({
        tabId,
        selection: captured.selection,
        tail: captured.tail,
        scrollback: captured.scrollback,
        planFile,
        log,
        answers,
      });
      setHandoffSelection(captured.selection);
      setHandoffTarget(target);
      loadHandoffFields(target);
    },
    [loadHandoffFields, readTerminalVerdict, storeSessionLog],
  );

  const openHandoffDialog = useCallback(
    (target: HandoffTargetId) => {
      const summary = savedTabs.find((tab) => tab.id === activeTabIdRef.current);
      if (isTerminalSource(summary)) {
        void openTerminalHandoff(target);
        return;
      }
      setTerminalCapture(null);
      setChatPlanFile(null);
      const tabId = activeTabIdRef.current;
      const rt = tabId ? runtimesRef.current[tabId] : undefined;
      if (tabId && summary && isPlanSource(summary.roleId, summary.chain?.kind) && !rt?.plan && !rt?.lastPlanMarkdown) {
        // After a restart the plan lives only in the file Claude wrote. Use it
        // only when this tab's own tool calls name that file. A continued
        // session may replay only messages, so the saved transcript counts too.
        const written = [transcriptRef.current, ...(rt?.segments ?? []).map((s) => s.text)]
          .join("\n")
          .match(/[^\s`'"()]*\/plans\/[^\s`'"()]+\.md/g);
        const path = written?.[written.length - 1];
        if (path) {
          void terminalPlanFile(0, tabId)
            .then((file) => {
              if (file?.text.trim() && file.path === path) {
                setChatPlanFile({ tabId, text: file.text, name: file.name });
              }
            })
            // intentionally silent: the plan file preview is best effort.
            .catch(() => {});
        }
      }
      const screen =
        document.querySelector("[data-pane='primary'] [data-session-screen]") ??
        document.querySelector("[data-session-screen]");
      setHandoffSelection(selectionInside(screen instanceof HTMLElement ? screen : null));
      setHandoffError(null);
      confirmedClaimRef.current = null;
      setHandoffTarget(target);
      loadHandoffFields(target);
    },
    [loadHandoffFields, openTerminalHandoff, savedTabs, roles],
  );

  /** The hand-off source terminal's session log: live while the dialog is open. */
  const captureLog = terminalCapture
    ? (sessionLogs[terminalCapture.tabId] ?? terminalCapture.log)
    : null;
  const captureTabId = terminalCapture?.tabId ?? null;
  const captureKind = captureTabId ? terminalStates[captureTabId]?.kind : undefined;
  // The source's state changed (a turn ended, a prompt opened): re-read its
  // screen so the tail and scrollback match the live log.
  useEffect(() => {
    if (!captureTabId || !captureKind) return;
    const { tail, scrollback } = readTerminalHandoff(captureTabId);
    setTerminalCapture((capture) =>
      capture?.tabId === captureTabId && (capture.tail !== tail || capture.scrollback !== scrollback)
        ? { ...capture, tail, scrollback }
        : capture,
    );
  }, [captureKind, captureTabId]);

  const handoffSource = useMemo((): HandoffSource => {
    const captureTab = terminalCapture
      ? savedTabs.find((tab) => tab.id === terminalCapture.tabId)
      : undefined;
    if (terminalCapture && captureTab) {
      const file = terminalCapture.planFile;
      const captureState = terminalStates[captureTab.id];
      return {
        sourceRoleId: captureTab.roleId,
        sourceChainKind: captureTab.chain?.kind ?? null,
        sourceTabId: captureTab.id,
        sourceLabel: captureTab.label || roleDisplayName(captureTab.roleId, roles),
        cwd: captureTab.cwd || values.cwd || "",
        answers: terminalCapture.answers,
        sourceFields: role?.id === captureTab.roleId ? role.fields : undefined,
        // The poller keeps the log fresh: a turn that ends while the dialog
        // is open sends its new reply, not the one read when it opened.
        ...terminalLogFields(captureLog),
        plan: [],
        todos: [],
        selection: terminalCapture.selection,
        turnInFlight: captureState?.kind === "working" || captureState?.kind === "needs",
        terminalWorking: captureState?.kind === "working",
        terminalWaiting:
          captureState?.kind === "needs" ? terminalWaitingText(captureState.needs) : null,
        awaitingPlanApproval: captureState?.kind === "needs" && captureState.needs === "plan",
        fromTerminal: true,
        planFileText: file?.text ?? "",
        planFileName: file ? (file.truncated ? `${file.name}, first 8 MB` : file.name) : "",
        terminalTail: terminalCapture.tail,
        branch: captureTab.worktreeBranch ?? null,
        transcriptText: terminalCapture.scrollback,
      };
    }
    const cards = cardsByTab[activeTabId ?? ""] ?? emptySessionCards();
    return {
      sourceRoleId: roleId,
      sourceChainKind: activeTabSummary?.chain?.kind ?? null,
      sourceTabId: activeTabId ?? "",
      sourceLabel:
        savedTabs.find((tab) => tab.id === activeTabId)?.label ?? roleDisplayName(roleId, roles),
      cwd: session?.cwd || values.cwd || "",
      answers: values,
      sourceFields: role?.id === roleId ? role.fields : undefined,
      // An Implementer's summary is its last message; other roles' replies
      // may be split by tool calls, so their whole reply in this turn is read.
      latestMessage:
        roleBehaviour(roleId, activeTabSummary?.chain?.kind) === "implementer"
          ? latestAgentMessage(streamSegments)
          : latestReplyText(streamSegments),
      plan: cards.plan,
      todos: cards.todos,
      selection: handoffSelection,
      turnInFlight: !!promptInFlight,
      awaitingPlanApproval: !!runtimes[activeTabId ?? ""]?.plan,
      // The open card's plan, else the last one Claude submitted in this tab.
      planMarkdown: (
        runtimes[activeTabId ?? ""]?.plan?.markdown ||
        runtimes[activeTabId ?? ""]?.lastPlanMarkdown ||
        ""
      ).trim(),
      planMarkdownStale:
        !runtimes[activeTabId ?? ""]?.plan && !!runtimes[activeTabId ?? ""]?.planStale,
      planFileText: chatPlanFile?.tabId === activeTabId ? chatPlanFile.text : undefined,
      planFileName: chatPlanFile?.tabId === activeTabId ? chatPlanFile.name : undefined,
      branch: activeTabSummary?.worktreeBranch ?? null,
      transcriptText: streamSegments.map((segment) => segment.text).join("\n"),
    };
  }, [
    activeTabId,
    activeTabSummary,
    captureLog,
    cardsByTab,
    chatPlanFile,
    handoffSelection,
    promptInFlight,
    role,
    roleId,
    roles,
    runtimes,
    savedTabs,
    session?.cwd,
    streamSegments,
    terminalCapture,
    terminalStates,
    values,
  ]);

  const handoffBlock = handoffBlockReason({ ...handoffSource, selection: "" }, roles);
  // A reviewer's verdict picks the primary button; the user still sends.
  const sourceVerdict =
    isReviewerRole(handoffSource.sourceRoleId, handoffSource.sourceChainKind) && !handoffSource.turnInFlight
      ? handoffSource.fromTerminal
        ? terminalLogVerdict(
            captureLog,
            handoffSource.selection || (handoffSource.terminalTail ?? ""),
          )
        : parseReviewVerdict(handoffSource.latestMessage)
      : null;
  const offerTargets = handoffTargets(roleId, roles, activeTabSummary?.chain ?? null);
  const offerRoute = handoffRoute({
    sourceRoleId: roleId,
    targets: offerTargets,
    verdict: sourceVerdict,
    chain: activeTabSummary?.chain ?? null,
    roles,
  });
  const handoffOffer =
    session && isHandoffSource(roleId, roles, activeTabSummary?.chain ?? null)
      ? {
          enabled: handoffBlock === null,
          reason: handoffBlock,
          targets: offerTargets,
          primaryTarget: offerRoute.primaryTarget,
          primaryLabel: offerRoute.primaryLabel,
          completeNote: offerRoute.complete
            ? activeTabSummary?.chain
              ? "Chain complete: the PR Reviewer approved."
              : "Review approved: nothing left to hand off."
            : null,
          roleNames: roles,
          onSend: openHandoffDialog,
        }
      : null;

  /** Plan Reviewer → Planner or PR Reviewer → Implementer on the source's chain. */
  const handoffLoopBack = useMemo(() => {
    if (!handoffTarget) return null;
    const chain = savedTabs.find((tab) => tab.id === handoffSource.sourceTabId)?.chain;
    const next = chain ? loopBackChain(chain, handoffSource.sourceRoleId, handoffTarget) : null;
    if (!chain || !next) return null;
    const liveChat = (tab: TabSummary) => {
      const rt = runtimes[tab.id];
      return tab.kind !== "terminal" && !!rt?.session && !rt.agentExited;
    };
    // A running PTY takes the follow-up as a paste; an exited one does not.
    const liveTerminal = (tab: TabSummary) => {
      const pty = livePty(tab.id);
      return tab.kind === "terminal" && !!pty && !pty.exited;
    };
    const liveTarget = (tab: TabSummary) => liveChat(tab) || liveTerminal(tab);
    const tab = chainTabFor(savedTabs, chain, next.step, liveTarget);
    const live = !!tab && liveTarget(tab);
    const terminal = live && tab.kind === "terminal";
    const rt = tab && !terminal ? runtimes[tab.id] : undefined;
    const working = live && (terminal ? terminalWorking(tab.id) : !!rt?.promptInFlight);
    const termState = terminal ? terminalStates[tab.id] : undefined;
    // A turn held by a card never ends on its own: say what it waits for.
    const waitingOn = termState?.kind === "needs"
      ? null
      : rt?.plan
      ? "a plan card"
      : rt?.permission
        ? "a permission request"
        : rt?.question
          ? "a question"
          : null;
    const target: LoopBackTarget = {
      round: chainRound(chain),
      tabLabel: tab?.label ?? null,
      live,
      terminal,
      blocked: working
        ? termState?.kind === "needs"
          ? `The ${tab.label} tab is ${terminalWaitingText(termState.needs)}. Answer it in that tab, then send.`
          : waitingOn
          ? `The ${tab.label} tab is waiting on ${waitingOn}. Answer it in that tab, then send.`
          : `The ${tab.label} tab is still working. Wait for its turn to end.`
        : null,
    };
    return { chain, next, tab: live ? tab : null, terminal, target };
  }, [
    handoffSource.sourceRoleId,
    handoffSource.sourceTabId,
    handoffTarget,
    runtimes,
    savedTabs,
    terminalStates,
    terminalWorking,
  ]);

  const confirmHandoffNow = useCallback(
    async (scope: HandoffScope, surface: HandoffSurface) => {
      if (!handoffTarget || !handoffSource.sourceTabId) return;
      const loop = handoffLoopBack;
      const cancelPendingPlan = async () => {
        const pendingPlan = runtimesRef.current[handoffSource.sourceTabId]?.plan;
        if (pendingPlan?.markdown || pendingPlan?.keepOptionId) {
          // "Keep planning", never accept. The request may already be gone
          // (the turn ended or was cancelled); the hand-off still goes ahead.
          await respondPlanRequest(
            handoffSource.sourceTabId,
            pendingPlan.jsonRpcId,
            "cancelled",
            // intentionally silent: the request may already be gone; the hand-off goes ahead.
          ).catch(() => {});
          patchRuntime(handoffSource.sourceTabId, (rt) => ({ ...rt, plan: null }));
        }
      };
      // The source terminal's turn, so a reply autopilot already sent on is recognised.
      const sourceTurn =
        terminalCapture?.tabId === handoffSource.sourceTabId
          ? turnId(handoffSource.sourceTabId, captureLog)
          : null;
      /** Claims this chain hand-off; null (with the warning shown) when autopilot made it already. */
      const claimHandoff = async (kind: "advance" | "back") => {
        const claim = await claimManualHandoff({
          sourceTabId: handoffSource.sourceTabId,
          kind,
          turn: sourceTurn,
          confirmedKey: confirmedClaimRef.current,
        });
        if (!claim.ok) {
          confirmedClaimRef.current = claim.key;
          setHandoffError(claim.warning);
          return null;
        }
        confirmedClaimRef.current = null;
        return claim;
      };
      if (loop?.tab) {
        // The chain's tab is live: the findings go in as a follow-up there.
        const targetTab = loop.tab;
        const findings = composePlanText(handoffSource, scope).text;
        if (!findings.trim() || loop.target.blocked) {
          setHandoffError(loop.target.blocked ?? "That choice has no content.");
          return;
        }
        const text = loopBackMessage(
          handoffSource.sourceRoleId,
          findings,
          loop.target.round,
          roles,
          handoffSource.sourceChainKind,
        );
        setBusy(true);
        setHandoffError(null);
        let claim: Awaited<ReturnType<typeof claimHandoff>> = null;
        let sent = false;
        try {
          claim = await claimHandoff("back");
          if (!claim) return;
          if (loop.terminal) {
            // One paste and one Enter, like the terminal scratch pad's Send.
            notePtyInput(targetTab.id);
            await ptyWrite(
              targetTab.id,
              encodeTerminalPaste(text, {
                bracketedPaste: terminalBracketedPaste(targetTab.id),
                submit: true,
              }),
            );
          } else {
            // fromHandoff: keeps the target's draft and images, and stays out of history.
            const result = await dispatchText(targetTab.id, text, undefined, true);
            if (result === "error") {
              setHandoffError(
                runtimesRef.current[targetTab.id]?.promptError ?? "The follow-up was not sent.",
              );
              return;
            }
          }
          sent = true;
          // The follow-up is out: close the dialog first, so a failure below
          // cannot invite a second send of the same findings.
          setTerminalCapture(null);
          setHandoffTarget(null);
          try {
            await chainLoopBack(
              loopBackRecord(loop.chain, handoffSource.sourceRoleId, targetTab.id, sourceVerdict, text),
            );
          } catch (err: unknown) {
            showNotice(
              "Round not recorded",
              `The follow-up was sent, but the chain round was not saved: ${errorText(err)}`,
              "question",
            );
          }
          await cancelPendingPlan();
          await refreshTabs();
          await handleSelectTab(targetTab.id);
        } catch (err: unknown) {
          setHandoffError(errorText(err));
        } finally {
          if (claim && !sent) await claim.release();
          setBusy(false);
        }
        return;
      }
      setBusy(true);
      setHandoffError(null);
      let claim: Awaited<ReturnType<typeof claimHandoff>> = null;
      let opened = false;
      try {
        const sourceTab = savedTabs.find((tab) => tab.id === handoffSource.sourceTabId);
        const loopStep = loop ? { chainId: loop.chain.chainId, next: loop.next } : null;
        const prepared = await prepareHandoff({
          source: handoffSource,
          scope,
          surface,
          targetRoleId: handoffTarget,
          sourceChain: sourceTab?.chain ?? null,
          loopBack: loopStep,
          planFile: terminalCapture?.planFile ?? null,
          fallbackFields: handoffFields,
          fallbackTemplate: handoffTemplate,
          roles,
        });
        if (!prepared.ok) {
          setHandoffError(prepared.error);
          return;
        }
        // The next stage on the chain, or a round sent back: made once.
        if (loopStep || prepared.value.nextChain) {
          claim = await claimHandoff(loopStep ? "back" : "advance");
          if (!claim) return;
        }
        const { mapped } = prepared.value;
        const saved = await saveHandoff(prepared.value, scope);
        const attach = (tabId: string) =>
          attachHandoff({
            record: saved,
            tabId,
            prepared: prepared.value,
            loopBack: loopStep,
            verdict: sourceVerdict,
          });
        await cancelPendingPlan();
        const nextValues = { ...mapped.answers, cwd: handoffSource.cwd };
        const sourceProvider = providerOf(sourceTab ?? null);
        if (surface === "terminal") {
          const terminal = terminalHandoffInput(mapped);
          stashActiveTab();
          // Launched as the source's provider, not switched after the CLI started.
          const tabId = await startRoleTerminal({
            roleId: handoffTarget,
            values: { ...terminal.values, cwd: handoffSource.cwd },
            tabId: null,
            handoffPlan: terminal.handoffPlan,
            provider: sourceProvider,
            chain: prepared.value.nextChain,
          });
          if (!tabId) {
            setHandoffError("Terminal did not start.");
            return;
          }
          opened = true;
          const bound = await attach(tabId);
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
        opened = true;
        await setTabProvider(tab.id, sourceProvider);
        const bound = await attach(tab.id);
        await syncActiveTabForm(tab.id, handoffTarget, handoffSource.cwd, nextValues);
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
        const message = errorText(err);
        setHandoffError(message);
      } finally {
        if (claim && !opened) await claim.release();
        setBusy(false);
      }
    },
    [
      applyDraft,
      captureLog,
      dispatchText,
      handleSelectTab,
      handoffFields,
      handoffLoopBack,
      handoffTemplate,
      handoffSource,
      handoffTarget,
      patchRuntime,
      refreshTabs,
      roles,
      savedTabs,
      scratch,
      showNotice,
      sourceVerdict,
      startRoleTerminal,
      stashActiveTab,
      terminalCapture,
    ],
  );

  const confirmHandoff = useCallback(
    async (scope: HandoffScope, surface: HandoffSurface) => {
      if (handoffLockRef.current) return;
      handoffLockRef.current = true;
      try {
        await confirmHandoffNow(scope, surface);
      } finally {
        handoffLockRef.current = false;
      }
    },
    [confirmHandoffNow],
  );

  /** "Ask Claude to add them": one paste and one Enter into the source terminal. */
  const askForHandoffSections = useCallback(
    async (prompt: string) => {
      const tabId = terminalCapture?.tabId;
      if (!tabId) return;
      try {
        notePtyInput(tabId);
        await ptyWrite(
          tabId,
          encodeTerminalPaste(prompt, { bracketedPaste: terminalBracketedPaste(tabId), submit: true }),
        );
        setTerminalCapture(null);
        setHandoffTarget(null);
        window.requestAnimationFrame(focusActiveTerminal);
      } catch (err: unknown) {
        setHandoffError(errorText(err));
      }
    },
    [focusActiveTerminal, terminalCapture?.tabId],
  );

  const openSavedHandoff = useCallback((record: HandoffRecord, showText = false) => {
    if (!showText && savedTabs.some((tab) => tab.id === record.sourceTabId)) {
      void handleSelectTab(record.sourceTabId);
      return;
    }
    setSavedPlan(record);
    setSavedPlanLoading(true);
    setHandoffError(null);
    handoffGet(record.id)
      .then((full) => setSavedPlan(full))
      .catch((err: unknown) => {
        const message = errorText(err);
        setHandoffError(message);
      })
      .finally(() => setSavedPlanLoading(false));
  }, [handleSelectTab, savedTabs]);

  const openPaletteWith = (query: string) => {
    setPalettePrefill((current) => ({ query, key: current.key + 1 }));
    setPaletteOpen(true);
  };

  const paletteModel: PaletteModelOptions | null =
    activeTabSummary && tabHasModel(activeTabSummary) && modelsForTab(activeTabSummary).length > 0
      ? {
          current: activeTabSummary.model ?? null,
          inherited: inheritedModel(activeTabSummary),
          models: modelsForTab(activeTabSummary).map(({ id, label }) => ({ id, label })),
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
      case "sendPlanPlanReviewer":
        openHandoffDialog("role_plan_reviewer");
        return;
      case "sendPlanImplementer":
        openHandoffDialog("role_implementer");
        return;
      case "sendPlanDeveloper":
        openHandoffDialog("role_developer");
        return;
      case "sendToPlanner":
        openHandoffDialog("role_planner");
        return;
      case "addToGrid":
        setSplitPicker("grid");
        return;
      case "sendImplementerToReviewer":
        openHandoffDialog("role_pr_reviewer");
        return;
      case "startEagleEye1":
      case "startEagleEye2":
        startPipeline(id === "startEagleEye1" ? "eagle1" : "eagle2");
        return;
      case "openChainOverview":
        if (activeTabSummary?.chain) void openChainOverviewTab(activeTabSummary.chain.chainId);
        return;
      case "showLogs": {
        setLogDrawerOpen(true);
        void (async () => {
          const tabId = activeTabIdRef.current;
          if (!tabId) return;
          setLogBusy(true);
          try {
            const [agent, app] = await Promise.all([
              sessionAgentLogs(tabId).catch((err: unknown) => {
                showNotice("Agent log not read", errorText(err), "failed");
                return { stderr: "" };
              }),
              diagnosticsReadLog().catch((err: unknown) => {
                showNotice("App log not read", errorText(err), "failed");
                return { text: "", path: "" };
              }),
            ]);
            setLogDrawer({
              stderr: agent.stderr,
              appLog: app.text,
              logPath: app.path || null,
            });
          } finally {
            setLogBusy(false);
          }
        })();
        return;
      }
      case "openGithub":
        openGithub();
        return;
      case "openPreview":
        stashActiveTab();
        void openPreviewTab(DEFAULT_PREVIEW_URL)
          .then((snap) => {
            setSavedTabs(snap.tabs);
            setClosedTabs(snap.closedTabs ?? []);
            if (snap.activeTabId) setActiveTabId(snap.activeTabId);
          })
          .catch((err: unknown) =>
            showNotice("Could not open the preview", errorText(err), "failed"),
          );
        return;
      case "pipelineWorkspace":
        void createPipelineTabs()
          .then(async (snap) => {
            setSavedTabs(snap.tabs);
            setClosedTabs(snap.closedTabs ?? []);
            const overviewTab = snap.tabs.find((t) => t.kind === "pipeline_overview");
            const activeId =
              snap.activeTabId ?? overviewTab?.id ?? snap.tabs[snap.tabs.length - 1]?.id;
            if (activeId) {
              const summary = snap.tabs.find((t) => t.id === activeId);
              if (summary?.kind === "terminal" || summary?.kind === "pipeline_overview") {
                setActiveTabId(activeId);
                await selectActiveTab(activeId);
              } else {
                const { tab } = await selectActiveTab(activeId);
                loadTabIntoForm(tab);
              }
            }
            showNotice(
              "Pipeline workspace",
              "Eagle-eye tab plus Planner, Plan Reviewer, Implementer, and PR Reviewer.",
            );
          })
          .catch((err: unknown) =>
            showNotice(
              "Could not open pipeline",
              errorText(err),
              "failed",
            ),
          );
        return;
      case "executionPipelineWorkspace":
        void createExecutionPipelineTabs()
          .then(async (snap) => {
            setSavedTabs(snap.tabs);
            setClosedTabs(snap.closedTabs ?? []);
            const overviewTab = snap.tabs.find((t) => t.kind === "pipeline_overview");
            const activeId =
              snap.activeTabId ?? overviewTab?.id ?? snap.tabs[snap.tabs.length - 1]?.id;
            if (activeId) {
              const summary = snap.tabs.find((t) => t.id === activeId);
              if (summary?.kind === "terminal" || summary?.kind === "pipeline_overview") {
                setActiveTabId(activeId);
                await selectActiveTab(activeId);
              } else {
                const { tab } = await selectActiveTab(activeId);
                loadTabIntoForm(tab);
              }
            }
            showNotice(
              "Execution pipeline",
              "Eagle-eye tab plus Implementer and PR Reviewer. Promote your plan, then Start.",
            );
          })
          .catch((err: unknown) =>
            showNotice(
              "Could not open execution pipeline",
              errorText(err),
              "failed",
            ),
          );
        return;
      case "exportTranscript": {
        const tabId = activeTabIdRef.current;
        if (!tabId) return;
        void runTranscriptExport({ tabId, liveSegments: streamSegments }).then((result) => {
          if (result.ok) {
            showNotice("Transcript exported", result.path);
            return;
          }
          if (result.reason === "cancelled") return;
          showNotice(
            result.reason === "empty" ? "Nothing to export" : "Export failed",
            result.message,
            "question",
          );
        });
        return;
      }
      case "handoffHelp":
        showNotice(
          "Nothing to hand off",
          "Hand-off sends a plan from a Planner to a Plan Reviewer, Implementer, or Developer, and a reviewed plan from a Plan Reviewer to an Implementer. Open a Planner or Plan Reviewer chat or terminal that has a plan, then try again.",
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
              errorText(err),
              "failed",
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
        guardFileEdits(() => setSettingsOpen(true));
        return;
      case "toggleCapture":
        void diagnosticsSetCapture(!captureOn).then((status) => {
          setDiagnostics(status);
          setCaptureOn(status.capturePermissionPayloads);
        });
        return;
      case "clearScrollback": {
        const summary = savedTabs.find((tab) => tab.id === activeTabId);
        const id = summary?.kind === "terminal" ? summary.id : focusedTerminalId();
        if (id) clearTerminalScrollback(id);
        return;
      }
      case "firstRunSetup":
        setFirstRunOpen(true);
        return;
      case "toggleShortcutBar":
        uiSettings.update({ shortcutBar: !uiSettings.ui.shortcutBar });
        return;
      case "switchTheme": {
        const current = normalizeTheme(uiSettings.ui.theme);
        const index = THEME_CHOICES.findIndex((theme) => theme.id === current);
        uiSettings.update({ theme: THEME_CHOICES[(index + 1) % THEME_CHOICES.length].id });
        return;
      }
      case "workspaces":
      case "saveWorkspace":
        openWorkspaces(id === "saveWorkspace");
        return;
      case "promptLibrary":
        openPromptLibrary(false);
        return;
      case "replyTemplates":
        openPromptLibrary(false, "templates");
        return;
      case "savePrompt":
        openPromptLibrary(true);
        return;
      case "showChanges":
        if (activeTabId) setChangesTabId(activeTabId);
        return;
      case "showActivity":
        if (activeTabId) setActivityTabId(activeTabId);
        return;
      case "newWorktreeTab":
        setWorktreeDialogOpen(true);
        return;
      case "removeWorktree":
        void removeWorktreeFor(activeTabId);
        return;
      case "newWindow":
        requestNewWindow();
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
      case "toggleGrid":
      case "toggleFilePanel":
      case "find":
      case "searchChats":
      case "zoomIn":
      case "zoomOut":
      case "zoomReset":
      case "focusPad":
      case "focusInput":
      case "transferPad":
      case "send":
      case "shortcutsHelp":
      case "toggleTerminalView":
      case "roleLauncher":
        onShortcut({ action: id });
        return;
      default: {
        const unhandled: never = id;
        throw new Error(`Unhandled palette action: ${String(unhandled)}`);
      }
    }
  };

  /** A draft of the pipeline's first stage, tagged step 1, in the current tab's folder. */
  const startPipeline = (kind: string) => {
    const cwd = activeTabSummary?.cwd || values.cwd || "";
    const name = pipelineDef(kind)?.name ?? "The pipeline";
    if (!cwd.trim()) {
      showNotice("Pick a folder first", `${name} starts in the current tab's folder.`, "question");
      return;
    }
    setBusy(true);
    startEagleEye(kind, cwd)
      .then(async ({ tab }) => {
        setActiveTabId(tab.id);
        await refreshTabs();
      })
      .catch((err: unknown) => {
        showNotice(name, errorText(err), "failed");
      })
      .finally(() => setBusy(false));
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
    if (route.kind === "handoff") {
      openHandoffDialog(route.roleId);
      return;
    }
    if (route.kind === "pipeline") {
      startPipeline(route.pipelineId);
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
    setClearedForm(null);
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

  /** Replace the whole form (this tab's draft too) and drop a stale preview. */
  const replaceFormValues = (next: Record<string, string>) => {
    setValues(next);
    const tabId = activeTabIdRef.current;
    if (tabId) {
      const current = draftsRef.current[tabId] ?? captureDraft();
      draftsRef.current[tabId] = { ...current, values: next };
      previewsRef.current[tabId] = null;
    }
    setPreview(null);
  };

  const openNewSessionForm = () => {
    const tabId = activeTabIdRef.current;
    if (newSessionOpenRef.current) return;
    setNewSessionOpenState(true);
    setResendStartup(true);
    if (!tabId) return;
    // The new session starts with empty fields. The answers the tab last ran
    // with stay one click away ("Use the previous values").
    const current = draftsRef.current[tabId] ?? captureDraft();
    const previous = formTextOf(current.values);
    if (Object.keys(previous).length > 0) previousAnswersRef.current[tabId] = previous;
    const cleared = clearFormText(current.values);
    draftsRef.current[tabId] = {
      ...current,
      values: cleared,
      newSessionOpen: true,
      resendStartup: true,
    };
    setValues(cleared);
    setClearedForm(null);
  };

  const fillPreviousValues = () => {
    const tabId = activeTabIdRef.current;
    const previous = tabId ? previousAnswersRef.current[tabId] : undefined;
    if (!previous) return;
    replaceFormValues({ ...previous, cwd: valuesRef.current.cwd ?? "" });
    setClearedForm(null);
  };

  const clearForm = () => {
    const tabId = activeTabIdRef.current;
    if (!tabId) return;
    const text = formTextOf(valuesRef.current);
    if (Object.keys(text).length === 0) return;
    setClearedForm({ tabId, values: text });
    replaceFormValues(clearFormText(valuesRef.current));
  };

  const undoClearForm = () => {
    if (!clearedForm || clearedForm.tabId !== activeTabIdRef.current) return;
    replaceFormValues({ ...clearedForm.values, cwd: valuesRef.current.cwd ?? "" });
    setClearedForm(null);
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

  /** `provider`: the role launcher's pick, remembered for the role like the Start card chip. */
  const chooseRole = (id: string, provider?: ProviderId) => {
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
      // Start card chip: the role's remembered provider (else the default).
      const tab = savedTabs.find((t) => t.id === tabId);
      if (tab && tab.phase === "draft" && (provider || providers.view)) {
        const want = provider ?? providerForRole(providers.view?.settings ?? null, id);
        if (want !== providerOf(tab) || provider) {
          void setTabProvider(tabId, want, provider ? id : undefined)
            .then(() => refreshTabs())
            .then(() => (provider ? providers.refreshSettings() : undefined))
            .catch((err: unknown) => showNotice("Provider not changed", errorText(err), "failed"));
        }
      }
    }
  };

  /** A new draft tab, then the start screen's own role choice: role, provider, Open as. */
  const launchRole = (launch: RoleLaunch) => {
    setRoleLauncherOpen(false);
    // The launcher already chose the role, so it opens the start screen directly
    // instead of following the "New tab opens" setting.
    const openRoleTab = async (): Promise<string | null> => {
      const reuse = roleLauncherReuseRef.current;
      roleLauncherReuseRef.current = null;
      if (
        reuse &&
        reuse === activeTabIdRef.current &&
        savedTabsRef.current.some((tab) => tab.id === reuse && tab.phase === "draft")
      ) {
        return reuse;
      }
      const fileGuard = fileDiscardGuardRef.current;
      if (fileGuard?.dirty() && !(await fileGuard.confirm())) return null;
      return openStartScreenTab();
    };
    void openRoleTab()
      .then((tabId) => {
        if (tabId) setPendingLaunch({ ...launch, tabId });
      })
      .catch((err: unknown) => showNotice("Tab not opened", errorText(err), "failed"));
  };

  useEffect(() => {
    if (!pendingLaunch || activeTabId !== pendingLaunch.tabId) return;
    if (!savedTabs.some((tab) => tab.id === pendingLaunch.tabId && tab.phase === "draft")) return;
    setPendingLaunch(null);
    chooseRole(pendingLaunch.roleId, pendingLaunch.provider);
    rememberSurface(pendingLaunch.roleId, pendingLaunch.surface);
    // chooseRole and rememberSurface read this render's state; the launch runs once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingLaunch, activeTabId, savedTabs]);

  const modelForTab = (tab: TabSummary): string | null => {
    if (!tabHasModel(tab)) return null;
    return runtimes[tab.id]?.session?.model ?? tab.model ?? inheritedModel(tab);
  };

  /** Tabs whose turn ended: a chain chip shows a check mark. */
  const doneTabIds = savedTabs
    .filter((tab) => terminalStates[tab.id]?.kind === "idle" && !!sessionLogs[tab.id]?.turnDone)
    .map((tab) => tab.id);

  const tabBar = (
    <>
      <TabBar
        tabs={savedTabs}
        activeTabId={activeTabId}
        roleColors={roleColors}
        disableSwitch={busy && !session}
        disableNew={busy}
        statuses={tabStatuses}
        doneTabIds={doneTabIds}
        renamingTabId={renamingTabId}
        onRenameStart={setRenamingTabId}
        onRename={(tabId, label) => {
          void setTabLabel(tabId, label)
            .then(() => refreshTabs())
            .catch((err: unknown) => showNotice("Tab not renamed", errorText(err), "failed"));
        }}
        onRenameEnd={() => setRenamingTabId(null)}
        canReopen={closedTabs.length > 0}
        settingsOpen={settingsOpen}
        roleNames={roleNames}
        modelFor={modelForTab}
        providerFor={(tab) =>
          tabHasProvider(tab) ? providerTooltipLine(providerOf(tab), claudeInfo) : null
        }
        onSelect={handleSelectTab}
        onClose={handleCloseTab}
        onNew={handleNewTab}
        onNewWindow={requestNewWindow}
        newWindowTitle={`New window (${newWindowShortcutLabel(
          platform === "mac" ? "mac" : platform === "windows" ? "windows" : "other",
        )})`}
        onNewWorktree={() => setWorktreeDialogOpen(true)}
        onToggleGrid={toggleGrid}
        gridOpen={gridOpen(split)}
        onReopen={() => void reopenTab()}
        onSettings={() => guardFileEdits(() => setSettingsOpen((open) => toggleSettings(open)))}
        onColor={(tabId, color) => {
          void setTabColor(tabId, color).then(() => refreshTabs());
        }}
      />
      {startupFailure && (
        <InlineNotice
          tone="error"
          className="startup-step-notice"
          action={
            <>
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  setStartupFailure(null);
                  void startupFailure.retry().then(settleStartup);
                }}
              >
                Retry
              </button>
              <button type="button" className="link-button" onClick={() => setStartupFailure(null)}>
                Dismiss
              </button>
            </>
          }
        >
          {startupFailure.title}: {errorText(startupFailure.error)}
        </InlineNotice>
      )}
    </>
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
      onToggleCapture={(enabled) =>
        diagnosticsSetCapture(enabled).then((status) => {
          setDiagnostics(status);
          setCaptureOn(status.capturePermissionPayloads);
        })
      }
      terminalSettings={terminalSettings}
      onTerminalSettings={saveTerminalSettings}
      notificationSettings={notificationSettings}
      onNotificationSettings={updateNotificationSettings}
      uiSettings={uiSettings.ui}
      onUiSettings={uiSettings.updateChecked}
      onTestNotification={agentNotifications.sendTest}
      modelList={modelList}
      claudeModelList={claudeModelList}
      modelSettings={modelSettings}
      providers={providers}
      onRefreshRoles={onRefreshRoles}
      onPipelinesChanged={onPipelinesChanged}
      onModelSettings={(provider, next) => {
        setModelSettingsState((current) =>
          current
            ? { ...current, [provider]: next }
            : { cursor: next, claude: next, [provider]: next },
        );
        return setModelSettings(next, provider).then((saved) =>
          setModelSettingsState((current) =>
            current ? { ...current, [provider]: saved } : { cursor: saved, claude: saved },
          ),
        );
      }}
      modelsRefreshing={modelsRefreshing}
      onRefreshModels={() => {
        void refreshModelList().catch((err: unknown) =>
          showNotice("Could not refresh the model list", errorText(err), "failed"),
        );
      }}
      approvalMode={approvalMode}
      onUnsavedChange={onSettingsUnsaved}
      onClose={() => setSettingsOpen(false)}
    />
  );

  const changesTab = changesTabId ? savedTabs.find((tab) => tab.id === changesTabId) : undefined;
  const activityTab = activityTabId ? savedTabs.find((tab) => tab.id === activityTabId) : undefined;

  /** F8: setup finished: put the role and folder on the active draft tab, then Start. */
  const finishFirstRun = (choice: FirstRunFinish) => {
    setFirstRunOpen(false);
    // Setup starts its role in the launch draft; no new-tab step on top.
    firstRunLaunchRef.current = null;
    void firstRunComplete().catch((err: unknown) =>
      showNotice("Setup state not saved", errorText(err), "failed"),
    );
    chooseRole(choice.roleId);
    setField("cwd", choice.folder);
    setPendingStart(choice);
    rememberSurface(choice.roleId, choice.surface);
  };

  const skipFirstRun = () => {
    setFirstRunOpen(false);
    const draft = firstRunLaunchRef.current;
    firstRunLaunchRef.current = null;
    if (draft) void runNewTabLaunch(draft);
    void firstRunComplete().catch((err: unknown) =>
      showNotice("Setup state not saved", errorText(err), "failed"),
    );
  };

  /** F7: open the workspaces dialog (and push the active form to state.json). */
  function openWorkspaces(focusSave: boolean) {
    stashActiveTab();
    setWorkspacesOpen({ focusSave });
    setWorkspaceError(null);
    void workspacesList()
      .then(setWorkspaceList)
      .catch((err: unknown) =>
        setWorkspaceError(errorText(err)),
      );
  }

  const saveWorkspaceAs = async (name: string, replace: boolean) => {
    stashActiveTab();
    setWorkspaceList(await workspaceSave(name, replace));
  };

  /** F7: open a saved workspace as new tabs; `replace` closes the open ones. */
  const openWorkspace = async (id: string, replace: boolean) => {
    const fileGuard = fileDiscardGuardRef.current;
    if (fileGuard?.dirty() && !(await fileGuard.confirm())) return;
    const old = savedTabs;
    if (replace) {
      const live = liveTabs(old);
      if (
        live.length > 0 &&
        !(await confirm({
          title: "Replace the open tabs",
          message: `Replace the open tabs? ${live.length} running agent or terminal${
            live.length === 1 ? "" : "s"
          } will be stopped. Closed tabs stay in Reopen closed tab.`,
          confirmLabel: "Replace",
          danger: true,
        }))
      ) {
        return;
      }
      for (const t of old) {
        const rt = runtimes[t.id];
        if (rt && rt.segments.length > 0) {
          await transcriptSave(t.id, segmentsToPlainText(rt.segments), rt.session?.cwd ?? t.cwd).catch(
            (err: unknown) => reportOnce("transcriptSave", "Transcript not saved", err),
          );
        }
      }
    }
    scratch.flush();
    stashActiveTab();
    // The backend stops the old PTYs before this returns; that is not a crash.
    const replacing = replace ? old.map((t) => t.id) : [];
    for (const tabId of replacing) replacingTabs.current.add(tabId);
    let result: Awaited<ReturnType<typeof workspaceOpen>>;
    try {
      result = await workspaceOpen(id, replace);
    } finally {
      for (const tabId of replacing) replacingTabs.current.delete(tabId);
    }
    if (replace) {
      for (const t of old) {
        delete draftsRef.current[t.id];
        delete knownFoldersRef.current[t.id];
        delete scrollPositions.current[t.id];
        forgetComposerDraft(t.id);
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
    void getLayout()
      .then((layout) => {
        setSplit(splitFromLayout(layout));
        setFilePanelOpen(layout.filePanelOpen);
        setFilePanelWidth(layout.filePanelWidth);
      })
      .catch((err: unknown) => reportOnce("layoutLoad", "Layout did not load", err));
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
        setPromptLibraryError(errorText(err)),
      );

  /** F6: open the library; `save` starts "Save as prompt" with the pad (or its selection). */
  function openPromptLibrary(save: boolean, view: PromptLibraryView = "saved") {
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
    setPromptLibraryOpen({ saveDraft, view });
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
        // intentionally silent: the "last used" counter is cosmetic.
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
      const file = await transcriptLoad(hit.tabId).catch((err: unknown) => {
        showNotice("Transcript not loaded", errorText(err), "failed");
        return null;
      });
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
      showNotice("Could not open that chat", errorText(err), "failed");
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
          claudeStatus={() => providerStatus("claude")}
          saveClaudeFolder={async (dir) => {
            const view = providers.view;
            if (!view) return;
            await providers.save({
              ...view.settings,
              claude: { ...view.settings.claude, configDir: dir },
            });
          }}
          roles={roles}
          initialFolder={folderForTab(values.cwd)}
          onFinish={finishFirstRun}
          onSkip={skipFirstRun}
        />
      )}
      {chatHistoryOpen && (
        <ChatHistoryDialog
          folder={folderForTab(activeTabSummary?.cwd || values.cwd)}
          load={(folder) =>
            historyProvider === "claude"
              ? listClaudeHistory(folder).then((view) => view.entries)
              : listCursorCliHistory(folder)
          }
          busy={busy}
          onResume={(entry) => {
            setChatHistoryOpen(false);
            void resumeHistoryEntry(entry);
          }}
          onOpenCli={(entry) => {
            setChatHistoryOpen(false);
            void openCursorCli(entry.id, entry.cwd, entry.source);
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
          initialView={promptLibraryOpen.view}
          roleId={activeTabSummary?.roleId ?? null}
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
          onAccept={(key) => setAcceptedChanges((prev) => addAccepted(prev, changesTab.id, key))}
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
      {activityTab && (
        <ActivityPanel
          key={activityTab.id}
          tabId={activityTab.id}
          tabLabel={activityTab.label}
          busy={!!tabStatuses[activityTab.id]?.busy}
          terminal={activityTab.kind === "terminal"}
          onClose={() => setActivityTabId(null)}
        />
      )}
      {accountPickerOpen && (
        <Dialog title="New window" onClose={() => setAccountPickerOpen(false)}>
          <p className="hint">
            Claude tabs in the new window use the account you pick. Cursor tabs are unchanged.
          </p>
          <div className="button-row">
            {(providers.view ? claudeAccounts(providers.view.settings.claude) : []).map((account) => (
              <button
                key={account.id}
                type="button"
                className="secondary-button"
                onClick={() => launchAccountWindow(account.id)}
              >
                {account.name}
              </button>
            ))}
          </div>
        </Dialog>
      )}
      {newTab.picker}
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
      {logDrawerOpen && (
        <LogDrawer
          stderr={logDrawer.stderr}
          appLog={logDrawer.appLog}
          logPath={logDrawer.logPath}
          busy={logBusy}
          onRefresh={() => {
            const tabId = activeTabIdRef.current;
            if (!tabId) return;
            setLogBusy(true);
            void Promise.all([sessionAgentLogs(tabId), diagnosticsReadLog()])
              .then(([agent, app]) => {
                setLogDrawer({
                  stderr: agent.stderr,
                  appLog: app.text,
                  logPath: app.path || null,
                });
              })
              .catch((err: unknown) => showNotice("Could not read the logs", errorText(err), "failed"))
              .finally(() => setLogBusy(false));
          }}
          onClose={() => setLogDrawerOpen(false)}
        />
      )}
      {paletteOpen && (
        <CommandPalette
          tabs={savedTabs.map((tab) => ({ id: tab.id, label: tab.label, cwd: tab.cwd }))}
          canReopen={closedTabs.length > 0}
          splitOpen={splitOpen(split)}
          gridOpen={gridOpen(split)}
          canAddToGrid={gridCandidates.length > 0 && (!gridOpen(split) || (split.gridTabIds?.length ?? 0) < GRID_MAX_TABS)}
          canSendPlan={(isCaptureSource(roleId, activeTabSummary?.chain?.kind) && !!session) || !!isPlanTerminal}
          sendPlanTargets={
            isPlanTerminal
              ? planTerminalTargets
              : handoffTargets(roleId, roles, activeTabSummary?.chain ?? null)
          }
          handoffTargets={(isPlanTerminal ? planTerminalTargets : (handoffOffer?.targets ?? [])).map(
            (id) => ({ id, name: roleDisplayName(id, roles) }),
          )}
          canExportTranscript={
            !!activeTabSummary &&
            (activeTabSummary.hasTranscript ||
              segmentsToPlainText(streamSegments).trim().length > 0)
          }
          canSendImplementerToReviewer={
            (roleId === "role_implementer" && !!session) ||
            (isPlanTerminal && activeTabSummary?.roleId === "role_implementer")
          }
          canRemoveWorktree={!!activeTabSummary?.worktreePath}
          canOpenChainOverview={!!activeTabSummary?.chain}
          canSwitchTerminalView={
            !!activeTabSummary && activeTabSummary.kind === "terminal" && isClaudeTerminal(activeTabSummary)
          }
          model={paletteModel}
          initialQuery={palettePrefill.query}
          platform={platform}
          key={palettePrefill.key}
          onRun={runPalette}
          onClose={() => setPaletteOpen(false)}
        />
      )}
      {roleLauncherOpen && (
        <RoleLauncher
          roles={roles}
          providers={launchProviders(providers)}
          defaultProvider={providers.view?.settings.default ?? "claude"}
          onLaunch={launchRole}
          onClose={() => setRoleLauncherOpen(false)}
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
      {splitPicker === "grid" && (
        <TabSwitcher
          title="Add tab to grid"
          placeholder="Show which tab in the grid?"
          tabs={gridCandidates}
          onSelect={(tabId) => {
            setSplitPicker(null);
            setSplit((current) => addToGrid(current, tabId, activeTabIdRef.current));
          }}
          onClose={() => setSplitPicker(null)}
        />
      )}
      {splitPicker && splitPicker !== "grid" && (
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
          targetTemplate={handoffTemplate}
          folderWarning={folderStatusMessage(
            savedTabs.find((tab) => tab.id === activeTabId)?.folderStatus ?? "",
            handoffSource.cwd,
          )}
          busy={busy}
          error={handoffError}
          loopBack={handoffLoopBack?.target ?? null}
          chain={savedTabs.find((tab) => tab.id === handoffSource.sourceTabId)?.chain ?? null}
          chainFillsTaskType={
            !!savedTabs.find((tab) => tab.id === handoffSource.sourceTabId)?.chain
          }
          preferredSurface={rememberedSurface(handoffTarget)}
          roleNames={roles}
          onTarget={(target) => {
            setHandoffTarget(target);
            setHandoffError(null);
            loadHandoffFields(target);
          }}
          onConfirm={(scope, surface) => {
            void confirmHandoff(scope, surface);
          }}
          onAskForSections={
            handoffSource.fromTerminal ? (prompt) => void askForHandoffSections(prompt) : undefined
          }
          onClose={() => {
            if (!busy) {
              const fromTerminal = !!terminalCapture;
              setHandoffTarget(null);
              setTerminalCapture(null);
              if (fromTerminal) window.requestAnimationFrame(focusActiveTerminal);
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

  // The active tab always has a cell, so its full controls are never hidden.
  const showGrid =
    !settingsOpen && gridOpen(split) && !!activeTabId && (split.gridTabIds ?? []).includes(activeTabId);
  showGridRef.current = showGrid;
  // TerminalTabView shows the chat view on these same terms.
  chatViewShownRef.current =
    !settingsOpen &&
    !showGrid &&
    activeTabSummary?.kind === "terminal" &&
    isClaudeTerminal(activeTabSummary) &&
    terminalViewOf(terminalViews, activeTabSummary.id) === "chat" &&
    !!livePty(activeTabSummary.id);

  const secondaryTab =
    !settingsOpen && splitOpen(split) && split.secondaryTabId !== activeTabId
      ? savedTabs.find((tab) => tab.id === split.secondaryTabId)
      : undefined;

  const headerDeps: TerminalHeaderDeps = {
    roles,
    roleColors,
    controls,
    terminalStates,
    tabStatuses,
    workingSince,
    sessionLogs,
    terminalVerdict,
    isTerminalSource,
    busy,
    openTerminalHandoff,
    openChainOverviewTab,
    readTerminalVerdict,
    // Esc interrupts Claude Code's running turn.
    stopTerminalTurn: (tabId) => void pressStop(tabId),
    terminalViews,
    setTerminalView,
  };

  const panes = createPaneRenderers({
    onNotice: (title, body) => showNotice(title, body),
    runtimes,
    roles,
    busy,
    fontSize,
    controls,
    tabStatuses,
    focusedPane,
    setFocusedPane,
    setSplit,
    splitRef,
    activeTabIdRef,
    gridFocusRef,
    secondaryInputRef,
    findRequest,
    usageSnap,
    providerOf,
    isTerminalSource,
    imagesFor,
    handleSelectTab,
    swapPanes,
    setChatSearchQuery,
    openChainOverviewTab,
    openTerminalHandoff,
    respondPermissionFor,
    respondQuestionFor,
    cancelTurnFor,
    setFollowUpFor,
    sendFollowUpFor,
    requestStopSecondarySession,
    restartSecondarySession,
    headerDeps,
  });

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
            discardGuardRef={fileDiscardGuardRef}
          />
        ) : (
          <div className="file-panel">
            <p className="hint">Choose a working folder to see its files.</p>
          </div>
        )}
        <PanelResizer
          label="Resize file panel"
          value={filePanelWidth}
          min={160}
          max={900}
          onChange={setFilePanelWidth}
        />
      </div>
    ) : null;

  const activeStatus = ((): { tone: StatusTone; text: string } => {
    const tab = activeTabSummary;
    const marks = activeTabId ? tabStatuses[activeTabId] : undefined;
    if (!tab) return { tone: "idle", text: "No tab" };
    if (marks?.exitCode != null) return { tone: "error", text: tabStatusLabel(marks) };
    if (marks?.needsYou) return { tone: "needs", text: tabStatusLabel(marks) };
    if (tab.kind === "pipeline_overview") {
      return { tone: "ok", text: "Pipeline overview" };
    }
    if (tab.kind === "preview") return { tone: "ok", text: "Localhost preview" };
    if (tab.kind === "github") return { tone: "ok", text: "GitHub" };
    if (tab.kind === "terminal") {
      const kind =
        tab.terminalLaunch === "cursor-cli" || tab.terminalLaunch === "claude-cli"
          ? CLI_LABEL[tab.terminalLaunch]
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
      return chatSessionStatus({
        activity,
        waitingPermission: !!permissionRequest,
        promptError: activeRuntime.promptError,
        agentExited: activeRuntime.agentExited,
        accepting: activeRuntime.accepting,
        hasSession: true,
      });
    }
    if (activeRuntime.accepting && busy) return { tone: "busy", text: "Starting…" };
    return { tone: "idle", text: "Not started" };
  })();
  const providerNotice = activeTabSummary?.providerNotice?.trim() ?? "";
  const noticeAlreadyShown =
    !!providerNotice &&
    !!session &&
    (activeRuntime.folderWarning ?? "").includes(providerNotice);
  const statusMessages: StatusMessage[] = [
    ...(providerNotice && !noticeAlreadyShown
      ? [{
          id: "provider-notice",
          text: providerNotice,
          tone: "info" as const,
          onDismiss: () => {
            const tabId = activeTabSummary?.id;
            if (!tabId) return;
            void ackProviderNotice(tabId).then(() => refreshTabs());
          },
        }]
      : []),
    ...(session && activeRuntime.folderWarning
      ? [{ id: "folder", text: activeRuntime.folderWarning, tone: "warn" as const }]
      : []),
    // Other terminals waiting for the user, named, so a background or
    // detached tab is not missed.
    ...savedTabs
      .filter((tab) => tab.id !== activeTabId && terminalStates[tab.id]?.kind === "needs")
      .map((tab) => ({
        id: `needs-${tab.id}`,
        text: `${tab.label}: ${tabStatusLabel(tabStatuses[tab.id] ?? IDLE_STATUS)}`,
        tone: "warn" as const,
      })),
    ...(modelNotice
      ? [{ id: "model", text: modelNotice, tone: "info" as const, onDismiss: () => setModelNotice(null) }]
      : []),
  ];
  const statusBar = (
    <StatusBar
      status={activeStatus}
      model={activeTabSummary ? modelForTab(activeTabSummary) : null}
      provider={
        activeTabSummary && tabHasProvider(activeTabSummary)
          ? providerIndicator(activeProvider, claudeInfo)
          : null
      }
      folder={session?.cwd || activeTabSummary?.cwd || folderForTab(values.cwd) || null}
      branch={activeTabSummary?.worktreeBranch ?? null}
      permissions={
        activeTabSummary && tabHasProvider(activeTabSummary)
          ? {
              fallback: activeTabSummary.permissionNote ?? null,
              mode: activeTabSummary.permissionMode ?? null,
            }
          : null
      }
      usage={activeTabSummary && providerOf(activeTabSummary) === "claude" ? statusLimit(usageSnap?.windows ?? []) : null}
      messages={statusMessages}
      trailing={
        uiSettings.ui.shortcutBar ? (
          <ShortcutBar
            platform={platform}
            onRun={(action) => onShortcut({ action })}
            onHide={() => uiSettings.update({ shortcutBar: false })}
          />
        ) : null
      }
    />
  );
  const firstUseTip = shouldShowTip({
    loaded: uiSettings.loaded,
    tipsSeen: uiSettings.ui.tipsSeen,
    blocked: dialogOpen,
  }) ? (
    <FirstUseTip
      platform={platform}
      barOn={uiSettings.ui.shortcutBar}
      onShowBar={() => uiSettings.update({ shortcutBar: true })}
      onDismiss={() => uiSettings.markTipSeen(FIRST_USE_TIP_ID)}
    />
  ) : null;

  const shellProps = {
    tabBar,
    overlays,
    filePanel,
    firstUseTip,
    statusBar,
    showGrid,
    split,
    setSplit,
    activeTabId,
    activeTabSummary,
    savedTabs,
    secondaryTab,
    focusedPane,
    setFocusedPane,
    panes,
    renderPreview: (tabId: string) => (
      <PreviewTab
        tabId={tabId}
        url={savedTabs.find((tab) => tab.id === tabId)?.previewUrl}
        onNotice={(title, body) => showNotice(title, body, "failed")}
        onSaved={() => void refreshTabs()}
      />
    ),
  };
  const shell = (content: ReactNode) => <WorkspaceShell {...shellProps}>{content}</WorkspaceShell>;
  const settingsShell = () => <WorkspaceShell {...shellProps} settings={settingsPage} />;
  if (
    activeTabSummary?.kind === "pipeline_overview" &&
    !settingsOpen &&
    activeTabSummary.pipelineRunId
  ) {
    return shell(
      <section className="status-card status-card-session-full pipeline-overview-screen">
        <PipelineOverview
          runId={activeTabSummary.pipelineRunId}
          cwd={activeTabSummary.cwd}
          tabs={savedTabs}
          runtimes={runtimes}
          terminalStates={terminalStates}
          sessionLogs={sessionLogs}
          onJump={(tabId) => void handleSelectTab(tabId)}
          onWatch={(tabId) => {
            setSplit((current) => ({
              mode: "horizontal",
              secondaryTabId: tabId,
              primarySize: clampSplitSize(current.primarySize || 55),
            }));
          }}
          onRefreshTabs={refreshTabs}
          onNotice={(title, body) => showNotice(title, body)}
          onFanOut={fanOutRunOf}
          onStartLane={startLaneById}
          onApproveLane={approveLaneById}
          onApproveRun={(runId) => approveLaneById(runId, null)}
          onContinue={autopilot.continueRun}
          usageWindows={usageSnap?.windows ?? null}
        />
      </section>,
    );
  }

  if (activeTabSummary?.kind === "github" && !settingsOpen) {
    return shell(
      <div className="status-card status-card-session-full">
        <GitHubTab onNotice={(title, body) => showNotice(title, body)} />
      </div>,
    );
  }

  if (activeTabSummary?.kind === "preview" && !settingsOpen) {
    return shell(
      <div className="status-card status-card-session-full">
        <PreviewSlot tabId={activeTabSummary.id} />
      </div>,
    );
  }

  if (activeTabSummary?.kind === "terminal" && !settingsOpen) {
    return shell(
      <TerminalTabView
        activeTabId={activeTabId}
        activeTabSummary={activeTabSummary}
        handoffs={handoffs}
        roles={roles}
        promptFileTabs={promptFileTabs}
        terminalError={terminalError}
        isPlanTerminal={isPlanTerminal}
        terminalRoute={terminalRoute}
        fontSize={fontSize}
        header={terminalHeaderFor(headerDeps, activeTabSummary, { viewSwitch: true })}
        view={terminalViewOf(terminalViews, activeTabSummary.id)}
        needsYou={terminalHeaderState(headerDeps, activeTabSummary).header.tone === "needs"}
        working={terminalHeaderState(headerDeps, activeTabSummary).working}
        exited={ptyExitCode(activeTabSummary.id) != null}
        onShowTerminal={() => headerDeps.setTerminalView?.(activeTabSummary.id, "terminal")}
        composerRef={terminalComposerRef}
        inGrid={showGrid}
        scratch={scratch}
        platform={platform}
        padOpen={padOpen}
        uiSettings={uiSettings}
        padSizeProps={padSizeProps}
        terminalPadRef={terminalPadRef}
        openSavedHandoff={openSavedHandoff}
        readTerminalVerdict={readTerminalVerdict}
        openTerminalHandoff={openTerminalHandoff}
        notePadSelection={notePadSelection}
        openPromptLibrary={openPromptLibrary}
        focusActiveTerminal={focusActiveTerminal}
        onPadError={(message) => showNotice("Not sent to the terminal", message, "failed")}
      />,
    );
  }

  if (!role) {
    if (settingsOpen) {
      return settingsShell();
    }
    return shell(<p className="hint empty-state">Loading…</p>);
  }

  const activeHandoff = handoffs.find((item) => item.targetTabId === activeTabId) ?? null;
  const handoffBanner = activeHandoff ? (
    <HandoffBanner
      sourceRoleId={activeHandoff.sourceRoleId}
      title={activeHandoff.title}
      warning={activeHandoff.warning}
      roleNames={roles}
      onOpen={() => openSavedHandoff(activeHandoff)}
    />
  ) : null;

  if (session && !settingsOpen) {
    return shell(
      <ChatSessionView
        activeTabId={activeTabId}
        activeTabSummary={activeTabSummary}
        activeRuntime={activeRuntime}
        session={session}
        handoffBanner={handoffBanner}
        cardsByTab={cardsByTab}
        handoffOffer={handoffOffer}
        paneByTab={paneByTab}
        setPaneByTab={setPaneByTab}
        togglePane={togglePane}
        focusedPane={focusedPane}
        findRequest={findRequest}
        setChatSearchQuery={setChatSearchQuery}
        openChainOverviewTab={openChainOverviewTab}
        activeProvider={activeProvider}
        usageSnap={usageSnap}
        busy={busy}
        fontSize={fontSize}
        roleId={roleId}
        roleNames={roleNames}
        modelForTab={modelForTab}
        controls={controls}
        imagesFor={imagesFor}
        inputRef={inputRef}
        padRef={padRef}
        composerHistory={composerHistory}
        historyCursor={historyCursor}
        setHistoryCursor={setHistoryCursor}
        scratch={scratch}
        chain={chain}
        setChain={setChain}
        chainAbortRef={chainAbortRef}
        padOpen={padOpen}
        uiSettings={uiSettings}
        padSizeProps={padSizeProps}
        transcriptSaveError={transcriptSaveError}
        respondPlanFor={respondPlanFor}
        handlePermissionSelect={handlePermissionSelect}
        handlePermissionCancel={handlePermissionCancel}
        handleQuestionAnswer={handleQuestionAnswer}
        handleQuestionSkip={handleQuestionSkip}
        handleQuestionCancel={handleQuestionCancel}
        cancelTurn={cancelTurn}
        setFollowUp={setFollowUp}
        sendFollowUp={sendFollowUp}
        stopSession={requestStopSession}
        restartSession={restartSession}
        transferPad={transferPad}
        transferToTerminalNow={transferToTerminalNow}
        sendFromPad={sendFromPad}
        notePadSelection={notePadSelection}
        openPromptLibrary={openPromptLibrary}
      />,
    );
  }

  if (settingsOpen) {
    return settingsShell();
  }

  return shell(
    <StartScreen
      role={role}
      roles={roles}
      activeTabId={activeTabId}
      activeTabIdRef={activeTabIdRef}
      activeTabSummary={activeTabSummary}
      session={session}
      busy={busy}
      starting={busy && activeRuntime.accepting}
      cliFound={cliFound}
      providers={providers}
      activeProvider={activeProvider}
      modelList={modelList}
      claudeModelList={claudeModelList}
      modelSettings={modelSettings}
      setModelNotice={setModelNotice}
      refreshTabs={refreshTabs}
      values={values}
      formValues={formValues}
      setField={setField}
      errors={errors}
      surface={surface}
      newSessionOpen={newSessionOpen}
      openNewSessionForm={openNewSessionForm}
      canContinueSession={canContinueSession}
      savedTranscript={savedTranscript}
      focusedTranscript={focusedTranscript}
      transcriptFocus={transcriptFocus}
      preview={preview}
      previewBusy={previewBusy}
      runPreview={runPreview}
      resendStartup={resendStartup}
      setResendStartup={setResendStartup}
      draftsRef={draftsRef}
      previousAnswersRef={previousAnswersRef}
      clearedForm={clearedForm}
      fillPreviousValues={fillPreviousValues}
      clearForm={clearForm}
      undoClearForm={undoClearForm}
      roleId={roleId}
      pickedRoleId={pickedRoleId}
      setPickedRoleId={setPickedRoleId}
      chooseRole={chooseRole}
      launchChoice={launchChoice}
      setLaunchChoice={setLaunchChoice}
      rememberedSurface={rememberedSurface}
      rememberSurface={rememberSurface}
      eagleOn={eagleOn}
      setEagleOn={setEagleOn}
      eagleOnRef={eagleOnRef}
      startSession={startSession}
      startRoleTerminal={startRoleTerminal}
      startBlankTerminal={startBlankTerminal}
      activeHandoff={activeHandoff}
      handoffBanner={handoffBanner}
      scratch={scratch}
      historyFolder={historyFolder}
      historyProvider={historyProvider}
      setHistoryOverride={setHistoryOverride}
      historyEntries={historyEntries}
      historyError={historyError}
      historyLoading={historyLoading}
      historyReadFrom={historyReadFrom}
      resumeHistoryEntry={resumeHistoryEntry}
      openCursorCli={openCursorCli}
      cliLaunchNote={cliLaunchNote}
      terminalError={terminalError}
      transcriptSaveError={transcriptSaveError}
      emptyStateRef={emptyStateRef}
      ignoreScrollRef={ignoreScrollRef}
      scrollPositions={scrollPositions}
    />,
  );
}
