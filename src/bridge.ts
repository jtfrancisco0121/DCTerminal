/**
 * Single IPC surface for the UI (ADR-002: keeps Electron swap possible).
 * Add commands here as Rust handlers land — see blueprint §16.3.
 */
import { invoke } from "@tauri-apps/api/core";
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
): Promise<RoleSessionStartResult> {
  return invoke<RoleSessionStartResult>("role_session_start", {
    roleId,
    values,
    tabId: tabId ?? null,
    resendStartup: resendStartup ?? false,
  });
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
