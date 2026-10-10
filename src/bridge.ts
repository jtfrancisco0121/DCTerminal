/**
 * Single IPC surface for the UI (ADR-002: keeps Electron swap possible).
 * Add commands here as Rust handlers land — see blueprint §16.3.
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ensureWindow } from "./windowScope";
import type { NotificationSettings } from "./notify/agentNotify";
import type {
  ProviderId,
  ProviderReport,
  ProviderSettingsView,
  ProvidersSettings,
} from "./provider/types";

export type { ProviderId, ProviderReport, ProviderSettingsView, ProvidersSettings };

/** Settings > Providers: saved settings plus the resolved Claude config folder. */
export async function getProviderSettings(): Promise<ProviderSettingsView> {
  return invoke<ProviderSettingsView>("get_provider_settings");
}

export async function setProviderSettings(
  providers: ProvidersSettings,
): Promise<ProviderSettingsView> {
  return invoke<ProviderSettingsView>("set_provider_settings", { providers });
}

/** Detection + sign-in for one provider (read-only CLI calls). */
export async function providerStatus(provider: ProviderId): Promise<ProviderReport> {
  return invoke<ProviderReport>("provider_status", { provider });
}

export type ClaudeAccountLogin = {
  id: string;
  name: string;
  config: import("./provider/types").ConfigDirInfo;
  login: LoginStatus;
};

/** Sign-in for every Claude account. Missing folders are not created. */
export async function claudeAccountLogins(): Promise<ClaudeAccountLogin[]> {
  return invoke<ClaudeAccountLogin[]>("claude_account_logins");
}

/** Open a window bound to one Claude account. */
export async function openAccountWindow(accountId: string): Promise<string> {
  return invoke<string>("open_account_window", { accountId });
}

/** macOS File > New Window (and its shortcut) asks this webview to open one. */
export function listenNewWindow(handler: () => void): Promise<UnlistenFn> {
  return listen("new-window", () => handler());
}

/**
 * Start card chip: this tab's provider. With `roleId`, the choice is also
 * remembered for that role (`providers.roleProvider`).
 */
export async function setTabProvider(
  tabId: string,
  provider: ProviderId,
  roleId?: string | null,
): Promise<void> {
  return invoke("set_tab_provider", { tabId, provider, roleId: roleId ?? null });
}

export type CliDetectResult = {
  found: boolean;
  path: string | null;
  version: string | null;
  error: string | null;
};

export async function detectCli(): Promise<CliDetectResult> {
  return invoke<CliDetectResult>("detect_cli");
}

/**
 * F8: sign-in state from the CLI's own check (`agent status`, or
 * `claude auth status --json` run with `CLAUDE_CONFIG_DIR`). Display only.
 */
export type LoginStatus = {
  /** "loggedIn" | "loggedOut" | "unknown" | "noCli" | "noConfigDir" (Claude) */
  state: string;
  account: string | null;
  detail: string | null;
  /** CURSOR_API_KEY (Cursor) / ANTHROPIC_API_KEY (Claude) is set. */
  apiKeyEnv: boolean;
  /** Claude: login method and plan, e.g. "claude.ai · team". */
  method?: string | null;
  /** Claude: organization name. */
  organization?: string | null;
};

export async function cliLoginStatus(): Promise<LoginStatus> {
  return invoke<LoginStatus>("cli_login_status");
}

export type FirstRunStatus = { needed: boolean; completed: boolean };

/** F8: show first-run setup? Only on a fresh profile that has not finished it. */
export async function firstRunStatus(): Promise<FirstRunStatus> {
  return invoke<FirstRunStatus>("first_run_status");
}

export async function firstRunComplete(): Promise<void> {
  return invoke("first_run_complete");
}

export type AcpProbeResult = {
  success: boolean;
  agentPath: string | null;
  firstResponseLine: string | null;
  stderrTail: string | null;
  error: string | null;
};

export async function probeAcp(): Promise<AcpProbeResult> {
  return invoke<AcpProbeResult>("probe_acp");
}

export type HandshakeStepResult = {
  method: string;
  success: boolean;
  responseJson: string | null;
  error: string | null;
};

export type AcpHandshakeProbeResult = {
  success: boolean;
  agentPath: string | null;
  sessionId: string | null;
  modeId: string | null;
  steps: HandshakeStepResult[];
  error: string | null;
};

export async function probeAcpHandshake(): Promise<AcpHandshakeProbeResult> {
  return invoke<AcpHandshakeProbeResult>("probe_acp_handshake");
}

export type RoleSummary = {
  id: string;
  name: string;
  defaultMode: string;
  color: string;
  fieldCount: number;
};

export async function listRoles(): Promise<RoleSummary[]> {
  return invoke<RoleSummary[]>("list_roles");
}

export type FieldType = "text" | "multiline" | "select" | "folder";

export type ShowWhen = {
  fieldKey: string;
  equals: string[];
};

export type RoleField = {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  options?: string[];
  placeholderToken?: string;
  showWhen?: ShowWhen;
  emptyBehavior?: string;
  remember?: boolean;
};

export type Role = {
  id: string;
  name: string;
  templateText: string;
  templateVersion: number;
  templateHash: string;
  schemaTemplateHash: string;
  defaultMode: string;
  injection: string;
  color: string;
  isBuiltIn: boolean;
  fields: RoleField[];
  updatedAt?: string;
};

export async function getRole(roleId: string): Promise<Role> {
  return invoke<Role>("get_role", { roleId });
};

export type FieldError = {
  key: string;
  message: string;
};

export type MergedPreview = {
  text: string;
  chars: number;
  unresolved: string[];
};

export type ValidatePreviewResult = {
  errors: FieldError[];
  merged: MergedPreview | null;
};

export async function validateAndPreview(
  roleId: string,
  values: Record<string, string>,
): Promise<ValidatePreviewResult> {
  return invoke<ValidatePreviewResult>("validate_and_preview", {
    roleId,
    values,
  });
}

export type RoleSessionStartResult = {
  errors: FieldError[];
  session: DevSessionInfo | null;
  mergedChars: number | null;
  injectionStrategy: string | null;
  startupInjected: boolean;
  injectionInFlight: boolean;
  tabId: string | null;
  resumedSession: boolean;
  skippedStartupInjection: boolean;
  folderWarning: string | null;
  loadedViaSessionLoad: boolean;
  replayMessageCount: number;
  replayTruncated: boolean;
  replay: SessionUpdateEvent[];
  /** How the model reached the agent. Missing on older builds. */
  modelVia?: ModelVia | null;
};

export type PromptFinishedEvent = {
  sessionId: string;
  tabId: string | null;
  success: boolean;
  result: DevPromptResult | null;
  error: string | null;
  agentExited: boolean;
};

export type PromptDispatchResult = {
  dispatched: boolean;
};

export type TabSummary = {
  id: string;
  label: string;
  roleId: string;
  cwd: string;
  phase: string;
  mergedPromptChars: number;
  startupPromptSent: boolean;
  hasTranscript: boolean;
  folderStatus: string;
  color: string;
  /** "role" or "terminal". Missing on older snapshots means a role tab. */
  kind?: string;
  /** "" | "shell" | "cursor-cli" | "claude-cli" | "role" */
  terminalLaunch?: string;
  acpSessionId: string | null;
  /** CLI chat id when this tab runs `agent --resume`. */
  resumeSessionId?: string | null;
  /** Per-tab model override. Missing means the role or global default. */
  model?: string | null;
  /** F3: branch checked out in this tab's worktree. Missing on plain tabs. */
  worktreeBranch?: string | null;
  worktreePath?: string | null;
  pipelineRunId?: string | null;
  /** "claude" | "cursor". Tabs saved before providers report "cursor". */
  provider?: ProviderId;
  /** One-line notice (migration, or the Claude config folder changed). */
  providerNotice?: string | null;
  chain?: import("./handoff/chains").ChainRef | null;
  /** Set when Claude could not take the role's permission mode. */
  permissionNote?: string | null;
};

export type PipelineRun = {
  id: string;
  kind: string;
  cwd: string;
  stage: string;
  overviewTabId: string;
  tabIds: Record<string, string>;
  candidatePlan?: string | null;
  approvedPlan?: string | null;
  originalRequest?: string | null;
  createdAt: string;
};

export type ClosedTabSummary = {
  id: string;
  label: string;
  roleId: string;
  cwd: string;
  color: string;
};

export type AppStateSnapshot = {
  activeTabId: string | null;
  tabs: TabSummary[];
  closedTabs: ClosedTabSummary[];
};

export type TabRecord = {
  id: string;
  label: string;
  roleId: string;
  roleSnapshot: {
    name: string;
    templateVersion: number;
    mode: string;
    injection: string;
  };
  cwd: string;
  answers: Record<string, string>;
  mergedPrompt: string;
  mergedPromptHash: string;
  phase: string;
  order: number;
  createdAt: string;
  session?: {
    acpSessionId: string;
    modeId: string;
    injectionPending: boolean;
    injectedAt?: string;
  };
  transcript?: string | null;
  startupPromptSent?: boolean;
  kind?: string;
  terminalLaunch?: string;
  /** The user renamed this tab; form edits and starts keep the name. */
  customLabel?: boolean;
  worktree?: WorktreeRef | null;
};

async function windowId(): Promise<string> {
  return (await ensureWindow()).id;
}

export async function getAppState(): Promise<AppStateSnapshot> {
  return invoke<AppStateSnapshot>("get_app_state", { windowId: await windowId() });
}

export async function getTab(tabId: string): Promise<{ tab: TabRecord }> {
  return invoke<{ tab: TabRecord }>("get_tab", { tabId });
}

export async function selectActiveTab(
  tabId: string,
): Promise<{ tab: TabRecord }> {
  return invoke<{ tab: TabRecord }>("select_active_tab", { tabId });
}

export async function closeTab(tabId: string): Promise<AppStateSnapshot> {
  return invoke<AppStateSnapshot>("close_tab", { tabId, windowId: await windowId() });
}

export async function newDraftTab(
  roleId: string,
  cwd: string,
): Promise<{ tab: TabRecord }> {
  return invoke<{ tab: TabRecord }>("new_draft_tab", { roleId, cwd, windowId: await windowId() });
}

export async function ackProviderNotice(tabId: string): Promise<void> {
  return invoke("ack_provider_notice", { tabId });
}

export async function setTabChain(
  tabId: string,
  chain: import("./handoff/chains").ChainRef | null,
): Promise<void> {
  return invoke("set_tab_chain", { tabId, chain });
}

/** Opens a Planner (eagle1) or Implementer (eagle2) draft at step 1. */
export async function startEagleEye(
  kind: "eagle1" | "eagle2",
  cwd: string,
): Promise<{ tab: TabRecord }> {
  return invoke("start_eagle_eye", { kind, cwd, windowId: await windowId() });
}

export async function getFormRecall(
  roleId: string,
): Promise<{ cwd: string; values: Record<string, string> }> {
  return invoke("get_form_recall", { roleId });
}

export async function saveFormDraft(
  roleId: string,
  cwd: string,
  values: Record<string, string>,
): Promise<void> {
  return invoke("save_form_draft", { roleId, cwd, values });
}

export async function roleSessionStart(
  roleId: string,
  values: Record<string, string>,
  tabId?: string | null,
  resendStartup?: boolean,
  resumeSessionId?: string | null,
): Promise<RoleSessionStartResult> {
  return invoke<RoleSessionStartResult>("role_session_start", {
    roleId,
    values,
    tabId: tabId ?? null,
    resendStartup: resendStartup ?? false,
    resumeSessionId: resumeSessionId ?? null,
    windowId: await windowId(),
  });
}

export type ClaudeHistoryView = {
  entries: import("./cursorHistory").CursorHistoryEntry[];
  configDir: string;
  configDisplay: string;
  exists: boolean;
};

export async function listClaudeHistory(cwd: string): Promise<ClaudeHistoryView> {
  return invoke("list_claude_history", { cwd, windowId: await windowId() });
}

export async function listCursorCliHistory(
  cwd: string,
): Promise<import("./cursorHistory").CursorHistoryEntry[]> {
  return invoke("list_cursor_cli_history", { cwd });
}

export async function openInCursorCli(
  sessionId: string,
  cwd: string,
): Promise<string> {
  return invoke("open_in_cursor_cli", { sessionId, cwd });
}

export async function syncActiveTabForm(
  tabId: string,
  roleId: string,
  cwd: string,
  values: Record<string, string>,
): Promise<void> {
  return invoke("sync_active_tab_form", { tabId, roleId, cwd, values });
}

export type DevSessionInfo = {
  sessionId: string;
  modeId: string;
  cwd: string;
  /** Model the agent reported (or was started with). */
  model?: string | null;
  /** Claude reasoning effort, and the levels the session offers. */
  effort?: string | null;
  effortOptions?: string[];
  /** Claude session whose agent takes pasted images (`promptCapabilities.image`). */
  supportsImages?: boolean;
};

export type DevPromptResult = {
  stopReason: string | null;
  agentText: string;
  updateCount: number;
};

export async function devSessionStart(
  cwd: string,
  modeId?: string,
): Promise<DevSessionInfo> {
  return invoke<DevSessionInfo>("dev_session_start", { cwd, modeId });
}

/** `attachments` are ids from `attachmentAdd`; they go as ACP image blocks. */
export async function devSessionSend(
  prompt: string,
  tabId?: string | null,
  attachments?: string[],
): Promise<PromptDispatchResult> {
  return invoke<PromptDispatchResult>("dev_session_send", {
    prompt,
    tabId: tabId ?? null,
    attachments: attachments?.length ? attachments : null,
  });
}

export type StagedAttachment = { id: string; mime: string; bytes: number };

/** Stage a pasted image in app data for the tab's next send. `data` is plain base64. */
export async function attachmentAdd(
  tabId: string,
  mime: string,
  data: string,
): Promise<StagedAttachment> {
  return invoke<StagedAttachment>("attachment_add", { tabId, mime, data });
}

export async function attachmentRemove(tabId: string, id: string): Promise<void> {
  return invoke("attachment_remove", { tabId, id });
}

export function listenPromptFinished(
  handler: (event: PromptFinishedEvent) => void,
): Promise<UnlistenFn> {
  return listen<PromptFinishedEvent>("role_session/prompt-finished", (e) => {
    handler(e.payload);
  });
}

export async function devSessionStop(
  transcript?: string,
  tabId?: string | null,
): Promise<void> {
  return invoke("dev_session_stop", {
    transcript: transcript ?? null,
    tabId: tabId ?? null,
  });
}

export async function devSessionCancel(tabId?: string | null): Promise<void> {
  return invoke("dev_session_cancel", { tabId: tabId ?? null });
}

export type PermissionOption = {
  id: string;
  label: string;
};

export type PermissionRequestEvent = {
  tabId: string;
  sessionId: string;
  jsonRpcId: number;
  title: string;
  message: string;
  toolClass: string;
  displayKind: string;
  network: boolean;
  options: PermissionOption[];
  rawParams: string;
};

export type PermissionAutoEvent = {
  tabId: string;
  sessionId: string;
  jsonRpcId: number;
  title: string;
  toolClass: string;
  displayKind: string;
  network: boolean;
  decision: string;
  line: string;
};

export type ApprovalModeKind = "unrestricted" | "allowlist" | "other" | "unknown";

export type ApprovalModeStatus = {
  kind: ApprovalModeKind;
  approvalMode: string | null;
  configPath: string | null;
  roleRulesOff: boolean;
  note: string | null;
};

export async function cursorApprovalMode(): Promise<ApprovalModeStatus> {
  return invoke("cursor_approval_mode");
}

export function listenPermissionRequests(
  handler: (event: PermissionRequestEvent) => void,
): Promise<UnlistenFn> {
  return listen<PermissionRequestEvent>("acp/permission-request", (e) => {
    handler(e.payload);
  });
}

export async function respondPermissionRequest(
  tabId: string,
  jsonRpcId: number,
  outcome: "selected" | "cancelled",
  optionId?: string,
): Promise<void> {
  return invoke("respond_permission_request", {
    tabId,
    jsonRpcId,
    outcome,
    optionId: optionId ?? null,
  });
}

export function listenPermissionAuto(
  handler: (event: PermissionAutoEvent) => void,
): Promise<UnlistenFn> {
  return listen<PermissionAutoEvent>("acp/permission-auto", (e) => {
    handler(e.payload);
  });
}

export type SessionUpdateEvent = {
  tabId: string;
  sessionId: string;
  kind: string;
  textDelta: string | null;
  rawJson: string;
};

export function listenSessionUpdates(
  handler: (event: SessionUpdateEvent) => void,
): Promise<UnlistenFn> {
  return listen<SessionUpdateEvent>("acp/session-update", (e) => {
    handler(e.payload);
  });
}

export type ScratchPadEntry = {
  tabId: string;
  content: string;
  updatedAt: string;
  history: string[];
};

export async function scratchLoad(): Promise<{
  pads: ScratchPadEntry[];
  /** Open and closed tabs in every window (absent from older backends). */
  knownTabIds?: string[];
}> {
  return invoke("scratch_load");
}

export async function scratchSave(
  tabId: string,
  content: string,
  history: string[],
): Promise<void> {
  return invoke("scratch_save", { tabId, content, history });
}

export type ListedProject = {
  path: string;
  available: boolean;
  favorite: boolean;
};

export async function projectsList(): Promise<{
  favorites: ListedProject[];
  recent: ListedProject[];
}> {
  return invoke("projects_list");
}

export async function projectsRemember(path: string): Promise<void> {
  return invoke("projects_remember", { path });
}

export async function projectsToggleFavorite(path: string): Promise<boolean> {
  return invoke("projects_toggle_favorite", { path });
}

export async function projectsRemove(path: string, favorite: boolean): Promise<void> {
  return invoke("projects_remove", { path, favorite });
}

export async function checkWorkingFolder(path: string): Promise<string> {
  return invoke<string>("check_working_folder", { path });
}

export async function transcriptSave(
  tabId: string,
  text: string,
  cwd: string,
): Promise<void> {
  return invoke("transcript_save", { tabId, text, cwd });
}

export async function transcriptLoad(tabId: string): Promise<{
  text: string;
  cwd: string;
  readOnly: boolean;
  recoveredFromCorrupt: boolean;
}> {
  return invoke("transcript_load", { tabId });
}

/** Write an exported file to an absolute path chosen in the save dialog. */
export async function exportTextFile(path: string, text: string): Promise<void> {
  return invoke("export_text_file", { path, text });
}

export type DiagnosticsStatus = {
  capturePermissionPayloads: boolean;
  appDataDir: string;
  transcriptsDir: string;
  logPath: string;
  lastError: string | null;
};

export async function diagnosticsStatus(): Promise<DiagnosticsStatus> {
  return invoke("diagnostics_status");
}

export async function diagnosticsSetCapture(enabled: boolean): Promise<DiagnosticsStatus> {
  return invoke("diagnostics_set_capture", { enabled });
}

export type DiagnosticsLogTail = {
  text: string;
  path: string;
};

export async function diagnosticsReadLog(maxBytes?: number): Promise<DiagnosticsLogTail> {
  return invoke("diagnostics_read_log", { maxBytes });
}

export type StorageStatus = {
  appDataDir: string;
  bytes: number;
};

export type StorageCleanup = {
  bytesFreed: number;
  bytes: number;
};

/** Size of DCTerminal's own app data folder (Settings > Data). */
export async function storageStatus(): Promise<StorageStatus> {
  return invoke("storage_status");
}

/** Run the startup sweep now: orphan scratch pads, stale leftovers, log rotation. */
export async function storageCleanup(): Promise<StorageCleanup> {
  return invoke("storage_cleanup");
}

export type SessionAgentLogs = {
  stderr: string;
};

export async function sessionAgentLogs(tabId?: string): Promise<SessionAgentLogs> {
  return invoke("session_agent_logs", tabId ? { tabId } : {});
}

export type SaveRoleInput = {
  roleId: string;
  templateText: string;
  name?: string;
  color?: string;
  defaultMode?: string;
};

export async function saveRole(input: SaveRoleInput): Promise<Role> {
  return invoke("save_role", { input });
}

export async function resetBuiltinRole(roleId: string): Promise<Role> {
  return invoke("reset_builtin_role", { roleId });
}

export async function createPipelineTabs(): Promise<AppStateSnapshot> {
  return invoke("create_pipeline_tabs", { windowId: await windowId() });
}

export async function createExecutionPipelineTabs(): Promise<AppStateSnapshot> {
  return invoke("create_execution_pipeline_tabs", { windowId: await windowId() });
}

export async function getPipelineRun(runId: string): Promise<{ run: PipelineRun }> {
  return invoke("get_pipeline_run", { runId });
}

export async function pipelinePromotePlan(
  runId: string,
  approvedPlan: string,
): Promise<void> {
  return invoke("pipeline_promote_plan", { runId, approvedPlan });
}

export async function pipelineSetCandidatePlan(
  runId: string,
  candidatePlan: string,
): Promise<void> {
  return invoke("pipeline_set_candidate_plan", { runId, candidatePlan });
}

/** Reopen `tabId`, or the most recently closed tab when omitted. */
export async function reopenClosedTab(tabId?: string): Promise<{ tab: TabRecord }> {
  return invoke("reopen_closed_tab", {
    ...(tabId ? { tabId } : {}),
    windowId: await windowId(),
  });
}

/** F5: one match in saved chat text (open, closed, or archived tab). */
export type HistoryHit = {
  /** "open" | "closed" | "archived" */
  source: string;
  tabId: string;
  label: string;
  cwd: string;
  updatedAt: string | null;
  /** 0-based index of this match in the source text. */
  occurrence: number;
  totalInSource: number;
  before: string;
  matched: string;
  after: string;
};

export async function historySearch(query: string): Promise<HistoryHit[]> {
  return invoke<HistoryHit[]>("history_search", { query });
}

export async function setTabLabel(tabId: string, label: string): Promise<void> {
  return invoke("set_tab_label", { tabId, label });
}

export async function setTabColor(tabId: string, color: string): Promise<void> {
  return invoke("set_tab_color", { tabId, color });
}

export type PlanRequestEvent = {
  tabId: string;
  sessionId: string;
  jsonRpcId: number;
  title: string;
  entries: { content: string; status: string; priority?: string }[];
  /** Claude ExitPlanMode body. Absent on a Cursor plan card. */
  markdown?: string | null;
  /** Reject option. Present means Keep planning, never Accept. */
  keepOptionId?: string | null;
};

export function listenPlanRequests(
  handler: (event: PlanRequestEvent) => void,
): Promise<UnlistenFn> {
  return listen<PlanRequestEvent>("acp/plan-request", (e) => {
    handler(e.payload);
  });
}

export async function respondPlanRequest(
  tabId: string,
  jsonRpcId: number,
  outcome: "accepted" | "cancelled",
): Promise<void> {
  return invoke("respond_plan_request", { tabId, jsonRpcId, outcome });
}

export type QuestionRequestEvent = {
  tabId: string;
  sessionId: string;
  jsonRpcId: number;
  title: string;
  prompt: string;
  choices: { id: string; label: string }[];
};

export function listenQuestionRequests(
  handler: (event: QuestionRequestEvent) => void,
): Promise<UnlistenFn> {
  return listen<QuestionRequestEvent>("acp/question-request", (e) => {
    handler(e.payload);
  });
}

export async function respondQuestionRequest(
  tabId: string,
  jsonRpcId: number,
  outcome: "answered" | "skipped" | "cancelled",
  choiceId?: string,
): Promise<void> {
  return invoke("respond_question_request", {
    tabId,
    jsonRpcId,
    outcome,
    choiceId: choiceId ?? null,
  });
}

export type HandoffRecord = {
  id: string;
  createdAt: string;
  sourceTabId: string;
  sourceRoleId: string;
  sourceLabel: string;
  targetRoleId: string;
  targetTabId: string | null;
  title: string;
  cwd: string;
  scope: string;
  planText: string;
  truncated: boolean;
  warning: string | null;
  planFile: string | null;
  planField: string | null;
};

export type HandoffSaveInput = {
  sourceTabId: string;
  sourceRoleId: string;
  sourceLabel: string;
  targetRoleId: string;
  title: string;
  cwd: string;
  scope: string;
  planText: string;
  truncated: boolean;
  warning: string | null;
  planField: string | null;
  chain?: import("./handoff/chains").ChainRef | null;
};

export async function handoffSave(input: HandoffSaveInput): Promise<HandoffRecord> {
  return invoke<HandoffRecord>("handoff_save", { input });
}

export async function handoffBindTab(id: string, tabId: string): Promise<HandoffRecord> {
  return invoke<HandoffRecord>("handoff_bind_tab", { id, tabId });
}

/** F7: one tab of a saved workspace (no live session). */
export type WorkspaceTab = {
  label: string;
  customLabel: boolean;
  roleId: string;
  roleSnapshot: { name: string; templateVersion: number; mode: string; injection: string };
  cwd: string;
  /** "role" (chat) | "terminal" */
  kind: string;
  terminalLaunch: string;
  color: string | null;
  model: string | null;
  answers: Record<string, string>;
};

export type Workspace = {
  id: string;
  name: string;
  savedAt: string;
  tabs: WorkspaceTab[];
  activeIndex: number | null;
};

export type WorkspaceList = {
  workspaces: Workspace[];
  /** Absolute path of workspaces.json in DCTerminal's app data dir. */
  path: string;
};

export type WorkspaceOpened = {
  state: AppStateSnapshot;
  tabIds: string[];
  /** Labels of tabs left out because their role no longer exists. */
  skipped: string[];
};

export async function workspacesList(): Promise<WorkspaceList> {
  return invoke<WorkspaceList>("workspaces_list");
}

/** Save the open tabs under `name`; `replace` overwrites a workspace with that name. */
export async function workspaceSave(name: string, replace: boolean): Promise<WorkspaceList> {
  return invoke<WorkspaceList>("workspace_save", { name, replace });
}

export async function workspaceDelete(id: string): Promise<WorkspaceList> {
  return invoke<WorkspaceList>("workspace_delete", { id });
}

/** Open a workspace as new tabs; `replace` closes the tabs open now. */
export async function workspaceOpen(id: string, replace: boolean): Promise<WorkspaceOpened> {
  return invoke<WorkspaceOpened>("workspace_open", { id, replace, windowId: await windowId() });
}

/** F6: a named prompt in the library (`prompts.json` in app data). */
export type SavedPrompt = {
  id: string;
  name: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
};

/** F6: one sent prompt, newest first. */
export type RecentSend = {
  text: string;
  sentAt: string;
  /** "chat" | "terminal" */
  source: string;
};

export type PromptLibrary = {
  prompts: SavedPrompt[];
  recent: RecentSend[];
  /** Absolute path of prompts.json in DCTerminal's app data dir. */
  path: string;
};

export async function promptLibraryGet(): Promise<PromptLibrary> {
  return invoke<PromptLibrary>("prompt_library_get");
}

/** Create (id null) or edit a saved prompt. Names are unique. */
export async function promptSave(
  id: string | null,
  name: string,
  body: string,
): Promise<PromptLibrary> {
  return invoke<PromptLibrary>("prompt_save", { id, name, body });
}

export async function promptDelete(id: string): Promise<PromptLibrary> {
  return invoke<PromptLibrary>("prompt_delete", { id });
}

export async function promptMarkUsed(id: string): Promise<PromptLibrary> {
  return invoke<PromptLibrary>("prompt_mark_used", { id });
}

export async function promptRecordSend(text: string, source: "chat" | "terminal"): Promise<void> {
  return invoke("prompt_record_send", { text, source });
}

export async function promptClearRecent(): Promise<PromptLibrary> {
  return invoke<PromptLibrary>("prompt_clear_recent");
}

export async function handoffList(): Promise<HandoffRecord[]> {
  return invoke<HandoffRecord[]>("handoff_list");
}

export async function handoffGet(id: string): Promise<HandoffRecord> {
  return invoke<HandoffRecord>("handoff_get", { id });
}

export type PtyPacket = {
  kind: string;
  data: string;
  code: number | null;
};

export type TerminalStartResult = {
  errors: FieldError[];
  tabId: string | null;
  pid: number | null;
  usedPromptFile: boolean;
};

export type PlanFileInfo = {
  path: string;
  name: string;
  modifiedMs: number;
  text: string;
};

export type TerminalSettings = {
  shell: string;
  fontSize: number;
  roleSurface: Record<string, string>;
  roleRunMode: Record<string, string>;
};

export type TerminalLaunch = "shell" | "cursor-cli" | "claude-cli" | "role";

export function createPtyChannel(
  onPacket: (packet: PtyPacket) => void,
): Channel<PtyPacket> {
  const channel = new Channel<PtyPacket>();
  channel.onmessage = onPacket;
  return channel;
}

export async function shellTerminalStart(input: {
  tabId?: string | null;
  cwd: string;
  launch: "shell" | "cursor-cli" | "claude-cli";
  resumeSessionId?: string | null;
  cols: number;
  rows: number;
  onOutput: Channel<PtyPacket>;
}): Promise<TerminalStartResult> {
  return invoke<TerminalStartResult>("shell_terminal_start", {
    input: {
      tabId: input.tabId ?? null,
      cwd: input.cwd,
      launch: input.launch,
      resumeSessionId: input.resumeSessionId ?? null,
      cols: input.cols,
      rows: input.rows,
      windowId: await windowId(),
    },
    onOutput: input.onOutput,
  });
}

export async function roleTerminalStart(input: {
  roleId: string;
  values: Record<string, string>;
  tabId?: string | null;
  handoffPlan?: string | null;
  cols: number;
  rows: number;
  onOutput: Channel<PtyPacket>;
}): Promise<TerminalStartResult> {
  return invoke<TerminalStartResult>("role_terminal_start", {
    input: {
      roleId: input.roleId,
      values: input.values,
      tabId: input.tabId ?? null,
      handoffPlan: input.handoffPlan ?? null,
      cols: input.cols,
      rows: input.rows,
      windowId: await windowId(),
    },
    onOutput: input.onOutput,
  });
}

export async function ptyOpen(input: {
  id: string;
  cwd: string;
  launch: TerminalLaunch;
  roleId?: string | null;
  prompt?: string | null;
  resumeSessionId?: string | null;
  cols: number;
  rows: number;
  onOutput: Channel<PtyPacket>;
}): Promise<number> {
  return invoke<number>("pty_open", {
    input: {
      id: input.id,
      cwd: input.cwd,
      launch: input.launch,
      roleId: input.roleId ?? null,
      prompt: input.prompt ?? null,
      resumeSessionId: input.resumeSessionId ?? null,
      cols: input.cols,
      rows: input.rows,
      windowId: await windowId(),
    },
    onOutput: input.onOutput,
  });
}

export async function ptyWrite(id: string, data: string): Promise<void> {
  return invoke("pty_write", { id, data });
}

export async function ptyResize(id: string, cols: number, rows: number): Promise<void> {
  return invoke("pty_resize", { id, cols, rows });
}

export async function ptyKill(id: string): Promise<void> {
  return invoke("pty_kill", { id });
}

export async function getTerminalSettings(): Promise<TerminalSettings> {
  return invoke<TerminalSettings>("get_terminal_settings");
}

export async function setTerminalSettings(
  terminal: TerminalSettings,
): Promise<TerminalSettings> {
  return invoke<TerminalSettings>("set_terminal_settings", { terminal });
}

/**
 * Newest plan file since the terminal started, read-only from the tab's
 * provider (`~/.cursor/plans`, or `<configDir>/plans` for Claude).
 */
export async function terminalPlanFile(
  startedAtMs: number,
  tabId?: string | null,
): Promise<PlanFileInfo | null> {
  return invoke<PlanFileInfo | null>("terminal_plan_file", { startedAtMs, tabId: tabId ?? null });
}

export type ModelEntry = {
  id: string;
  label: string;
  fast: boolean;
  /** Extra note, e.g. Fable's "may use usage credits". */
  badge?: string | null;
};

export type ModelList = {
  models: ModelEntry[];
  /** "cli" | "cache" | "fallback" */
  source: string;
  fetchedAtMs: number | null;
  error: string | null;
};

export type ModelSettings = {
  defaultModel: string;
  roleModels: Record<string, string>;
  /** Claude only: reasoning effort per role ("low" … "max"). No entry = account default. */
  roleEffort?: Record<string, string>;
};

export type ProviderModelSettings = {
  cursor: ModelSettings;
  claude: ModelSettings;
};

export type ModelVia =
  | "unchanged"
  | "configOption"
  | "setModel"
  | "spawnFlag"
  | "unsupported";

export type SetModelResult = {
  model: string;
  via: ModelVia | null;
  restarted: boolean;
};

export async function listModels(
  provider: "cursor" | "claude" = "cursor",
  refresh = false,
): Promise<ModelList> {
  return invoke<ModelList>("list_models", { provider, refresh });
}

export async function getModelSettings(): Promise<ProviderModelSettings> {
  return invoke<ProviderModelSettings>("get_model_settings");
}

export async function setModelSettings(
  models: ModelSettings,
  provider: "cursor" | "claude" = "cursor",
): Promise<ModelSettings> {
  return invoke<ModelSettings>("set_model_settings", { models, provider });
}

/** Per-tab override. `null` clears it. Returns the effective model. */
export async function setTabModel(tabId: string, model: string | null): Promise<string> {
  return invoke<string>("set_tab_model", { tabId, model });
}

/** Change a running chat tab's model (in place, or restart + session/load). */
export async function acpSetModel(tabId: string, model: string | null): Promise<SetModelResult> {
  return invoke<SetModelResult>("acp_set_model", { tabId, model });
}

/** Change a running Claude chat's reasoning effort. Returns the level now in use. */
export async function acpSetEffort(tabId: string, effort: string): Promise<string> {
  return invoke<string>("acp_set_effort", { tabId, effort });
}

export async function getNotificationSettings(): Promise<NotificationSettings> {
  return invoke<NotificationSettings>("get_notification_settings");
}

export async function setNotificationSettings(
  notifications: NotificationSettings,
): Promise<NotificationSettings> {
  return invoke<NotificationSettings>("set_notification_settings", { notifications });
}

/** U7/U8: colour theme, optional shortcut bar, dismissed one-time tips. */
export type UiSettings = {
  theme: string;
  shortcutBar: boolean;
  tipsSeen: string[];
  /** U2: scratch pad height in px; 0 = the 3-row default. */
  padHeight: number;
  /** U2: scratch pad hidden in chat and terminal tabs. */
  padHidden: boolean;
};

export const DEFAULT_UI_SETTINGS: UiSettings = {
  theme: "github-dark",
  shortcutBar: false,
  tipsSeen: [],
  padHeight: 0,
  padHidden: false,
};

export async function getUiSettings(): Promise<UiSettings> {
  return invoke<UiSettings>("get_ui_settings");
}

export async function setUiSettings(ui: UiSettings): Promise<UiSettings> {
  return invoke<UiSettings>("set_ui_settings", { ui });
}

export type WorktreeRef = {
  repoRoot: string;
  path: string;
  branch: string;
};

export type RepoInfo = {
  mainRoot: string;
  currentBranch: string | null;
  branches: string[];
  checkedOut: string[];
  worktreesDir: string;
};

export type WorktreeCheck = {
  worktree: WorktreeRef;
  branch: string | null;
  /** `git status --porcelain` lines. Removal is refused unless empty. */
  dirty: string[];
};

/** Read-only: branches and the sibling folder new worktrees go into. */
export async function gitRepoInfo(path: string): Promise<RepoInfo> {
  return invoke<RepoInfo>("git_repo_info", { path });
}

/** Runs `git worktree add` (user clicked Create), then opens a draft tab there. */
export async function worktreeTabNew(input: {
  roleId: string;
  repoPath: string;
  branch: string;
  createBranch: boolean;
  base: string | null;
}): Promise<{ tab: TabRecord }> {
  return invoke<{ tab: TabRecord }>("worktree_tab_new", {
    roleId: input.roleId,
    repoPath: input.repoPath,
    branch: input.branch,
    createBranch: input.createBranch,
    base: input.base,
    windowId: await windowId(),
  });
}

export async function worktreeTabCheck(tabId: string): Promise<WorktreeCheck> {
  return invoke<WorktreeCheck>("worktree_tab_check", { tabId });
}

/** `git worktree remove` (never forced) for a tab the user already closed. */
export async function worktreeTabRemove(tabId: string, confirmed: boolean): Promise<void> {
  return invoke("worktree_tab_remove", { tabId, confirmed });
}

// --- F4: changes since the turn (or tab) started ---

export type ChangeScope = "turn" | "tab";

export type ChangedFile = {
  /** Relative to the repository root. */
  path: string;
  /** Relative to the tab's folder (for the file panel), when inside it. */
  cwdPath: string | null;
  status: "added" | "modified" | "deleted" | "typeChanged" | string;
  oldBlob: string;
  newBlob: string;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
};

export type ChangeSet = {
  /** "ok" | "noRepo" | "noBaseline" */
  state: string;
  scope: ChangeScope;
  repoRoot: string | null;
  baseTree: string | null;
  nowTree: string | null;
  baselineAt: string | null;
  files: ChangedFile[];
};

export type FileDiff = { path: string; binary: boolean; text: string; truncated: boolean };

export type RevertOutcome = {
  reverted: string[];
  skipped: { path: string; reason: string }[];
};

export type UsageSnapshot = {
  configDir: string;
  windows: import("./usage/limits").RateWindow[];
  contextByTab: Record<string, { used: number; size: number }>;
};

export async function getClaudeUsage(): Promise<UsageSnapshot> {
  return invoke<UsageSnapshot>("get_claude_usage", { windowId: await windowId() });
}

export async function changesList(tabId: string, scope: ChangeScope): Promise<ChangeSet> {
  return invoke<ChangeSet>("changes_list", { tabId, scope });
}

/** Start a new "this turn" baseline now (snapshot kept in app data). */
export async function changesSnapshot(tabId: string): Promise<ChangeSet> {
  return invoke<ChangeSet>("changes_snapshot", { tabId });
}

export async function changesFileDiff(
  tabId: string,
  base: string,
  now: string,
  path: string,
): Promise<FileDiff> {
  return invoke<FileDiff>("changes_file_diff", { tabId, base, now, path });
}

/** Restores files to the baseline. Only after the user confirmed. */
export async function changesRevert(
  tabId: string,
  base: string,
  files: { path: string; newBlob: string }[],
  confirmed: boolean,
): Promise<RevertOutcome> {
  return invoke<RevertOutcome>("changes_revert", { tabId, base, files, confirmed });
}

export type LayoutState = {
  /** "single" | "horizontal" | "vertical" */
  splitMode: string;
  secondaryTabId: string | null;
  /** Main pane size in percent. */
  primarySize: number;
  /** Grid mode: the tabs on screen, in cell order. */
  gridTabIds?: string[];
  filePanelOpen: boolean;
  filePanelWidth: number;
};

export async function getLayout(): Promise<LayoutState> {
  return invoke<LayoutState>("get_layout", { windowId: await windowId() });
}

export async function setLayout(layout: LayoutState): Promise<LayoutState> {
  return invoke<LayoutState>("set_layout", { layout, windowId: await windowId() });
}

export type FileEntry = {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
};

export type DirListing = {
  root: string;
  path: string;
  entries: FileEntry[];
  truncated: boolean;
};

export type FileContent = {
  path: string;
  absPath: string;
  size: number;
  mtimeMs: number;
  /** "text" | "image" | "binary" | "tooLarge" */
  kind: string;
  text: string | null;
  dataBase64: string | null;
  mime: string | null;
};

export type FileWriteResult = {
  mtimeMs: number;
  size: number;
};

/** Paths are relative to the tab's working folder. */
export async function filesList(tabId: string, path = ""): Promise<DirListing> {
  return invoke<DirListing>("files_list", { tabId, path });
}

export async function filesRead(tabId: string, path: string): Promise<FileContent> {
  return invoke<FileContent>("files_read", { tabId, path });
}

export async function filesWrite(
  tabId: string,
  path: string,
  text: string,
  expectedMtimeMs: number | null,
  force = false,
): Promise<FileWriteResult> {
  return invoke<FileWriteResult>("files_write", { tabId, path, text, expectedMtimeMs, force });
}

export async function filesReveal(tabId: string, path: string): Promise<void> {
  return invoke("files_reveal", { tabId, path });
}
