/**
 * Single IPC surface for the UI (ADR-002: keeps Electron swap possible).
 * Add commands here as Rust handlers land — see blueprint §16.3.
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type CliDetectResult = {
  found: boolean;
  path: string | null;
  version: string | null;
  error: string | null;
};

export async function detectCli(): Promise<CliDetectResult> {
  return invoke<CliDetectResult>("detect_cli");
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
  /** "" | "shell" | "cursor-cli" | "role" */
  terminalLaunch?: string;
  acpSessionId: string | null;
  /** CLI chat id when this tab runs `agent --resume`. */
  resumeSessionId?: string | null;
  /** Per-tab model override. Missing means the role or global default. */
  model?: string | null;
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
};

export async function getAppState(): Promise<AppStateSnapshot> {
  return invoke<AppStateSnapshot>("get_app_state");
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
  return invoke<AppStateSnapshot>("close_tab", { tabId });
}

export async function newDraftTab(
  roleId: string,
  cwd: string,
): Promise<{ tab: TabRecord }> {
  return invoke<{ tab: TabRecord }>("new_draft_tab", { roleId, cwd });
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
  });
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

export async function devSessionSend(
  prompt: string,
  tabId?: string | null,
): Promise<PromptDispatchResult> {
  return invoke<PromptDispatchResult>("dev_session_send", {
    prompt,
    tabId: tabId ?? null,
  });
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
  options: PermissionOption[];
  rawParams: string;
};

export type PermissionAutoEvent = {
  tabId: string;
  sessionId: string;
  jsonRpcId: number;
  title: string;
  toolClass: string;
  decision: string;
  line: string;
};

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

export async function scratchLoad(): Promise<{ pads: ScratchPadEntry[] }> {
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

export async function reopenClosedTab(): Promise<{ tab: TabRecord }> {
  return invoke("reopen_closed_tab");
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
};

export async function handoffSave(input: HandoffSaveInput): Promise<HandoffRecord> {
  return invoke<HandoffRecord>("handoff_save", { input });
}

export async function handoffBindTab(id: string, tabId: string): Promise<HandoffRecord> {
  return invoke<HandoffRecord>("handoff_bind_tab", { id, tabId });
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

export type TerminalLaunch = "shell" | "cursor-cli" | "role";

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
  launch: "shell" | "cursor-cli";
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

export async function terminalPlanFile(startedAtMs: number): Promise<PlanFileInfo | null> {
  return invoke<PlanFileInfo | null>("terminal_plan_file", { startedAtMs });
}

export type ModelEntry = {
  id: string;
  label: string;
  fast: boolean;
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

export async function listModels(refresh = false): Promise<ModelList> {
  return invoke<ModelList>("list_models", { refresh });
}

export async function getModelSettings(): Promise<ModelSettings> {
  return invoke<ModelSettings>("get_model_settings");
}

export async function setModelSettings(models: ModelSettings): Promise<ModelSettings> {
  return invoke<ModelSettings>("set_model_settings", { models });
}

/** Per-tab override. `null` clears it. Returns the effective model. */
export async function setTabModel(tabId: string, model: string | null): Promise<string> {
  return invoke<string>("set_tab_model", { tabId, model });
}

/** Change a running chat tab's model (in place, or restart + session/load). */
export async function acpSetModel(tabId: string, model: string | null): Promise<SetModelResult> {
  return invoke<SetModelResult>("acp_set_model", { tabId, model });
}

export type LayoutState = {
  /** "single" | "horizontal" | "vertical" */
  splitMode: string;
  secondaryTabId: string | null;
  /** Main pane size in percent. */
  primarySize: number;
  filePanelOpen: boolean;
  filePanelWidth: number;
};

export async function getLayout(): Promise<LayoutState> {
  return invoke<LayoutState>("get_layout");
}

export async function setLayout(layout: LayoutState): Promise<LayoutState> {
  return invoke<LayoutState>("set_layout", { layout });
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
