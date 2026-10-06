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
};

export type PromptFinishedEvent = {
  sessionId: string;
  tabId: string | null;
  success: boolean;
  result: DevPromptResult | null;
  error: string | null;
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
};

export type AppStateSnapshot = {
  activeTabId: string | null;
  tabs: TabSummary[];
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
  defaultCwd: string,
): Promise<{ cwd: string; values: Record<string, string> }> {
  return invoke("get_form_recall", { roleId, defaultCwd });
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
): Promise<RoleSessionStartResult> {
  return invoke<RoleSessionStartResult>("role_session_start", {
    roleId,
    values,
    tabId: tabId ?? null,
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
): Promise<PromptDispatchResult> {
  return invoke<PromptDispatchResult>("dev_session_send", { prompt });
}

export function listenPromptFinished(
  handler: (event: PromptFinishedEvent) => void,
): Promise<UnlistenFn> {
  return listen<PromptFinishedEvent>("role_session/prompt-finished", (e) => {
    handler(e.payload);
  });
}

export async function devSessionStop(transcript?: string): Promise<void> {
  return invoke("dev_session_stop", { transcript: transcript ?? null });
}

export async function devSessionCancel(): Promise<void> {
  return invoke("dev_session_cancel");
}

export type PermissionOption = {
  id: string;
  label: string;
};

export type PermissionRequestEvent = {
  sessionId: string;
  jsonRpcId: number;
  title: string;
  message: string;
  options: PermissionOption[];
  rawParams: string;
};

export function listenPermissionRequests(
  handler: (event: PermissionRequestEvent) => void,
): Promise<UnlistenFn> {
  return listen<PermissionRequestEvent>("acp/permission-request", (e) => {
    handler(e.payload);
  });
}

export async function respondPermissionRequest(
  outcome: "selected" | "cancelled",
  optionId?: string,
): Promise<void> {
  return invoke("respond_permission_request", { outcome, optionId });
}

export type SessionUpdateEvent = {
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
