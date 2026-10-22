/**
 * Single IPC surface for the UI (ADR-002: keeps Electron swap possible).
 * Add commands here as Rust handlers land — see blueprint §16.3.
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow, type CloseRequestedEvent } from "@tauri-apps/api/window";
import { ensureWindow } from "./windowScope";
import type { IntakeRef as ClickUpIntakeRefIn, RefProblem as ClickUpRefProblemIn } from "./clickup/intakeRefs";
import type { NotificationSettings } from "./notify/agentNotify";
import type { CustomColors } from "./theme";
import type {
  GithubFeed,
  GithubFilters,
  GithubStatus,
  PushCommits,
} from "./github/githubTypes";
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

/** File > Reopen Closed Window: rebuilds the newest closed window with its
 * tabs and account. Resolves its label, or null when none is kept. */
export async function reopenClosedWindow(): Promise<string | null> {
  return invoke<string | null>("reopen_closed_window");
}

/** This window's close button. The window closes after `handler` resolves
 * unless it called `event.preventDefault()`. */
export function onWindowCloseRequested(
  handler: (event: CloseRequestedEvent) => Promise<void>,
): Promise<UnlistenFn> {
  return getCurrentWindow().onCloseRequested(handler);
}

/** macOS File > New Window (and its shortcut) asks this webview to open one.
 * The backend sends it to the focused window only; a global `listen` would
 * hear it in every window, so each open window would open one. */
export function listenNewWindow(handler: () => void): Promise<UnlistenFn> {
  return getCurrentWebviewWindow().listen("new-window", () => handler());
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
  isBuiltIn?: boolean;
  /** Missing: the built-in transition table applies (`handoff/transitions.ts`). */
  handoffTargets?: string[];
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
  /** Missing: the built-in transition table applies (`handoff/transitions.ts`). */
  handoffTargets?: string[];
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
  /** "role", "terminal", "preview" or "github". Missing on older snapshots means a role tab. */
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
  /**
   * `--permission-mode` a Claude role terminal launched with ("auto", or
   * "plan" for the Planner). Missing on chat, Cursor, plain and resume tabs.
   */
  permissionMode?: string | null;
  /** Address a localhost preview tab (kind "preview") shows. */
  previewUrl?: string | null;
  /**
   * The bridged pipeline stage this terminal launched as (ADR-015): its turn
   * ends and results go to the run actor in Rust (`src-tauri/src/run_actor`),
   * not through its log.
   */
  bridge?: BridgeTag | null;
};

/** A terminal's bridged stage: `runs/<runId>/stages/<stage>` in app data. */
export type BridgeTag = { runId: string; stage: string };

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
  /** Eagle-Eye chain this run follows. Missing on palette preset runs. */
  chainId?: string | null;
  /** Role id → text a hand-off along the chain sent into that stage. */
  handoffs?: Record<string, { text: string; at: string }>;
  updatedAt?: string | null;
  /** Chain round; missing means 1. */
  round?: number;
  /** Reviewer verdicts recorded as each round was sent back, oldest first. */
  verdicts?: { roleId: string; round: number; verdict?: string | null; at: string }[];
  /** The run ledger, oldest first (ADR-014). */
  events?: RunEvent[];
  /** Latest gate results per stage id. */
  gates?: Record<string, { round: number; at: string; results: GateResult[] }>;
  /** Opt-in autopilot; missing or off means manual. */
  autopilot?: RunAutopilot | null;
  /** One lane per pull request once the run fanned out. */
  lanes?: RunLane[];
  /** The stage where the lanes start (the Implementer's). */
  fanOutStage?: string | null;
  /** Hand-offs on and send-backs made, so none is made twice. */
  claims?: HandoffClaim[];
  /** Where the run stands (Track H2). Missing on runs from older builds. */
  status?: RunStatus;
  /** Why the run is waiting, or `paused_by_you` when you turned autopilot off. */
  stopReason?: StopReason | null;
  /**
   * Pipeline engine: 2 on new runs whose every stage reports through the
   * bridge (ADR-015); the Rust run actor drives those, and your buttons on
   * them are its messages (`pipelineActorMessage`). 1 (or missing) on older
   * runs, and on runs of a pipeline the bridge does not cover whole.
   */
  engine?: number;
  /** Stage tabs you took over (V5): autopilot leaves them alone until you hand them back. */
  takenOver?: string[];
  /** The engine line on the overview (D24): why the run uses engine 1, or "Claude Code version not yet verified". */
  engineNote?: string | null;
  /** A Restart or Resume switched this run from the bridge to engine 1 mid-run: manual for good, autopilot cannot be turned on. */
  manualOnly?: boolean;
  /** L2: your answers to verify gates, oldest first, one per answer. A lane is verified when its latest says so. */
  verifications?: VerifyRecord[];
  /** F3: the size picked at start (S, M or L), for a run of a sized pipeline. */
  size?: "S" | "M" | "L" | null;
  /** L3: one record per story of each pull request built in stories, in order (a lane's, or the run's own with no lane). */
  stories?: RunStory[];
};

/** L3: where a story stands. */
export type StoryStatus = "pending" | "active" | "checking" | "failed" | "waiting" | "verifying" | "done" | "skipped";

/** L3: one story of a pull request built in stories, as the run records it. */
export type RunStory = {
  /** The lane (pull request); absent for the run's own Implementer. */
  lane?: string | null;
  /** The task (`pr1`) it belongs to. */
  task?: string;
  /** `s1`. */
  id: string;
  title: string;
  tickets?: string[];
  doneWhen?: string[];
  plannedTests?: string[];
  /** What you do and report before the next story. */
  checkpoint?: string | null;
  status?: StoryStatus;
  /** Failed check rounds of this story so far. */
  attempt?: number;
  /** The decided turn that reported it. */
  turn?: string | null;
  /** What the Implementer reported for it. */
  summary?: string | null;
  /** Your note at its checkpoint, passed on to the next story. */
  note?: string | null;
  /** You added it at a checkpoint. */
  added?: boolean;
  at?: string | null;
};

/** L3: the checkpoint story a run waits on (`autopilot.storyWait`), while it waits with `checkpoint`. */
export type StoryWait = {
  stageId: string;
  lane?: string | null;
  story: string;
  checkpoint: string;
  turn?: string | null;
  at: string;
};

/** F1: the artifact stage a run waits on (`autopilot.artifactWait`): `partial` with open questions, or `blocked` with a reason. */
export type ArtifactWait = {
  stageId: string;
  stageTitle: string;
  status: "partial" | "blocked";
  questions?: string[];
  reason?: string | null;
  /** The documents it reported so far, relative to the run folder. */
  artifacts?: string[];
  turn?: string | null;
  at: string;
};

/** L2: the verify gate a run waits on (`autopilot.verify`), while it waits with `checkpoint`. */
export type VerifyWait = {
  stageId: string;
  /** The lane (pull request); absent for a run that did not fan out. */
  lane?: string | null;
  /** `verify`, or `backend verify` for a repo's steps. */
  label: string;
  steps: string;
  /** The decided turn the answer is for. */
  turn?: string | null;
  /** The pull requests the stage reported that turn. */
  prs?: string[];
  at: string;
};

/** L2: one answer to a verify gate. */
export type VerifyRecord = {
  stageId: string;
  lane?: string | null;
  repo?: string | null;
  round: number;
  /** Counts the answers in that round from 1. */
  attempt: number;
  label: string;
  steps: string;
  result: "verified" | "failed";
  note?: string | null;
  /** `you`. */
  by: string;
  at: string;
  prs?: string[];
};

/**
 * `running`: autopilot acts on each finished turn. `waiting`: it stopped for
 * you (see `stopReason`) and leaves turns alone until you act. `stopped`:
 * autopilot is off. `complete`: done; later turns are ignored.
 */
export type RunStatus = "running" | "waiting" | "complete" | "stopped";

/** Why a run stopped: every stop carries one. */
export type StopReason =
  | "checkpoint"
  | "gate_failed"
  | "no_check_found"
  | "no_result"
  | "no_verdict"
  | "blocking_findings"
  | "round_cap"
  | "usage_limit"
  | "stalled"
  | "app_restarted"
  | "carry_out_failed"
  | "taken_over"
  | "paused_by_you";

export type RunLane = {
  id: string;
  title: string;
  dependsOn?: string[];
  /** `waiting` (for its dependencies), `active`, `approved`. */
  status: string;
  stage: string;
  round: number;
  tabIds: Record<string, string>;
  handoffs?: Record<string, { text: string; at: string }>;
  verdicts?: { roleId: string; round: number; verdict?: string | null; at: string }[];
  /** L1: the Settings › Repos name its worktree was made in; absent for the run's own folder. */
  repo?: string | null;
};

export type RunEvent = {
  at: string;
  /** `handoff`, `loopBack`, `gate`, `autopilot`, `stop`, `complete`, `note`, `turn`. */
  kind: string;
  stageId?: string | null;
  roleId?: string | null;
  round: number;
  summary: string;
  detail?: string | null;
  /**
   * A gate's `passed`/`failed`/`skipped`, an autopilot decision's action,
   * a turn's verdict, `planApproved` on a promoted plan, a stop's reason
   * code (`stop` events, and `paused_by_you` on "Autopilot off"). Missing on
   * older events.
   */
  outcome?: string | null;
  /** The fanned-out pull request (lane) the event is about. Missing on older events. */
  laneId?: string | null;
};

export type GateResult = {
  /** `command`, `pullRequest`, `contract` or (L2) `verify`. */
  kind: string;
  /** What ran; `backend check: <command>` for a repo's check (L2). */
  label: string;
  /** `passed`, `failed` or `skipped`; a verify gate is `waiting` until you answer it, and its summary is its steps (L2). */
  status: string;
  summary: string;
  output?: string;
  durationMs: number;
  /** The gate is marked optional: an `auto` check with nothing to run was skipped, not a stop. */
  optional?: boolean;
};

export type RunAutopilot = {
  enabled: boolean;
  /** Why autopilot is waiting for you, if it is. */
  waiting?: string | null;
  passedCheckpoints?: string[];
  gateRetries?: Record<string, number>;
  /** Turns already decided on. */
  decided?: string[];
  /** L2: the verify gate the run waits on, while it does. */
  verify?: VerifyWait | null;
  /** L3: the checkpoint story the run waits on, while it does. */
  storyWait?: StoryWait | null;
  /** F1: the artifact stage whose questions (or block) the run waits on. */
  artifactWait?: ArtifactWait | null;
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
  /** Text a hand-off along the chain sent into this tab (kept on the chain's run). */
  handoffText?: string | null,
): Promise<void> {
  return invoke("set_tab_chain", { tabId, chain, handoffText: handoffText ?? null });
}

/**
 * A chain reviewer sends its round back to `tabId` (the earlier stage's tab,
 * reused or just opened). Records the verdict and starts the next round.
 * Returns the tab's new chain tag. Sends nothing.
 */
export async function chainLoopBack(input: {
  chainId: string;
  reviewerRoleId: string;
  tabId: string;
  verdict: string | null;
  handoffText: string | null;
  /** The fanned-out pull request whose round goes back. */
  lane?: string | null;
}): Promise<import("./handoff/chains").ChainRef> {
  // `lane` only when there is one: a missing key reads as no lane.
  const { lane, ...rest } = input;
  return invoke("chain_loop_back", lane ? { ...rest, lane } : rest);
}

/** Shows (or opens) the overview tab of an Eagle-Eye chain. Starts nothing. */
export async function openChainOverview(
  chainId: string,
): Promise<{ tabId: string; state: AppStateSnapshot }> {
  return invoke("open_chain_overview", { chainId, windowId: await windowId() });
}

/** Opens a draft of the pipeline's first stage (Planner for eagle1), tagged step 1. */
export async function startEagleEye(
  kind: string,
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

/** `ownFolderOnly` reads only the folder's own project directory (quick pass). */
export async function listClaudeHistory(
  cwd: string,
  ownFolderOnly = false,
): Promise<ClaudeHistoryView> {
  return invoke("list_claude_history", { cwd, windowId: await windowId(), ownFolderOnly });
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

/** A session still running in the backend, for reattaching after a webview reload. */
export type LiveSessionInfo = DevSessionInfo & {
  roleId: string;
  promptInFlight: boolean;
  exited: boolean;
};

export async function devSessionLive(tabId: string): Promise<LiveSessionInfo | null> {
  return invoke("dev_session_live", { tabId });
}

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

export type DroppedImage = { name: string; mime: string; data: string };

/** Read an image file dropped on the chat (the native drop handler hides the DOM drop). */
export async function attachmentReadFile(path: string): Promise<DroppedImage> {
  return invoke<DroppedImage>("attachment_read_file", { path });
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
  // With a tab, this also saves that tab's transcript: keep it in save order.
  const stop = () =>
    invoke<void>("dev_session_stop", {
      transcript: transcript ?? null,
      tabId: tabId ?? null,
    });
  return tabId ? inTabSaveOrder(tabId, stop) : stop();
}

export async function devSessionCancel(tabId?: string | null): Promise<void> {
  return invoke("dev_session_cancel", { tabId: tabId ?? null });
}

/** An agent request's JSON-RPC id, a number or a string, echoed back as sent. */
export type JsonRpcId = number | string;

export type PermissionOption = {
  id: string;
  label: string;
};

export type PermissionRequestEvent = {
  tabId: string;
  sessionId: string;
  jsonRpcId: JsonRpcId;
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
  jsonRpcId: JsonRpcId;
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
  jsonRpcId: JsonRpcId,
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
  /** Set when this tool call writes a plan file (`<configDir>/plans/*.md`). */
  planPath?: string | null;
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

export type ScratchSaveOutcome = {
  /** False when the stored pad is newer; adopt `pad` instead. */
  applied: boolean;
  /** The pad as stored after the call. */
  pad: ScratchPadEntry;
};

/** `updatedAt` (ISO) is when this copy was edited; omitted means now.
 * Resolves null from mocks and older backends: treat that as applied. */
export async function scratchSave(
  tabId: string,
  content: string,
  history: string[],
  updatedAt?: string,
): Promise<ScratchSaveOutcome | null> {
  return invoke("scratch_save", { tabId, content, history, updatedAt });
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

/**
 * The tail of each tab's transcript-save chain. The save commands are async
 * on the Rust side, so two saves for one tab could otherwise reach the file
 * out of order and leave the older text on disk.
 */
const tabSaveChains = new Map<string, Promise<void>>();

/** Runs `save` after the tab's previous save settles. A failed save rejects
 *  only its own caller; the chain goes on. The entry is dropped once the
 *  newest save settles, so the map holds only tabs with a save in flight. */
function inTabSaveOrder<T>(tabId: string, save: () => Promise<T>): Promise<T> {
  const previous = tabSaveChains.get(tabId) ?? Promise.resolve();
  const result = previous.then(save);
  const link = result.then(
    () => undefined,
    () => undefined,
  );
  tabSaveChains.set(tabId, link);
  void link.then(() => {
    if (tabSaveChains.get(tabId) === link) tabSaveChains.delete(tabId);
  });
  return result;
}

export async function transcriptSave(
  tabId: string,
  text: string,
  cwd: string,
): Promise<void> {
  return inTabSaveOrder(tabId, () => invoke<void>("transcript_save", { tabId, text, cwd }));
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
  crashLogPath: string;
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

/** One line per data file moved aside at startup; only the first call gets them. */
export async function startupNotices(): Promise<string[]> {
  return invoke("startup_notices");
}

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
  /** Replaces the role's hand-off targets. Omitted leaves them unchanged. */
  handoffTargets?: string[];
};

export async function saveRole(input: SaveRoleInput): Promise<Role> {
  return invoke("save_role", { input });
}

export type TemplatePreview = {
  /** Form fields the template would have after Save. */
  fields: RoleField[];
  /** Why Save would be refused, if it would. */
  error: string | null;
};

/** Settings > Roles live preview. Nothing is saved. */
export async function previewRoleTemplate(
  roleId: string,
  templateText: string,
): Promise<TemplatePreview> {
  return invoke("preview_role_template", { roleId, templateText });
}

export async function createRole(name: string): Promise<Role> {
  return invoke("create_role", { name });
}

/** `handoffTargets`: the source's list as the editor shows it. */
export async function duplicateRole(roleId: string, handoffTargets?: string[]): Promise<Role> {
  return invoke("duplicate_role", { roleId, handoffTargets: handoffTargets ?? null });
}

/** Custom roles only. Refused while an open tab uses the role. */
export async function deleteRole(roleId: string): Promise<void> {
  return invoke("delete_role", { roleId });
}

/** Reads a role file the user picked and adds it as a new custom role. */
export async function importRole(path: string): Promise<Role> {
  return invoke("import_role", { path });
}

export async function exportRole(roleId: string, path: string): Promise<void> {
  return invoke("export_role", { roleId, path });
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

/** Opens a localhost preview tab and makes it active. */
export async function openPreviewTab(url: string): Promise<AppStateSnapshot> {
  return invoke("open_preview_tab", { windowId: await windowId(), url });
}

/** Whether gh is installed and signed in, and the saved GitHub filters. */
export function githubStatus(): Promise<GithubStatus> {
  return invoke("github_status");
}

/** Polls whatever is due and returns the GitHub feed. Read-only. */
export function githubFeed(): Promise<GithubFeed> {
  return invoke("github_feed");
}

/** The commits of one push, loaded when its row is expanded. */
export function githubPushCommits(
  repo: string,
  before: string,
  head: string,
): Promise<PushCommits> {
  return invoke("github_push_commits", { repo, before, head });
}

/**
 * Of `ids`, the ones nobody was told about yet; all are marked seen. The first
 * call only sets the baseline and returns nothing.
 */
export function githubClaimNotifications(ids: string[]): Promise<string[]> {
  return invoke("github_claim_notifications", { ids });
}

export function githubSaveFilters(filters: GithubFilters): Promise<GithubFilters> {
  return invoke("github_save_filters", { filters });
}

/** Where an account's ClickUp token comes from. `env` is `DCT_CLICKUP_TOKEN`. */
export type ClickUpTokenSource = "keychain" | "env" | "none";

/** One Claude account's ClickUp setup. The token itself is never sent to the UI. */
export type ClickUpAccountStatus = {
  accountId: string;
  accountName: string;
  configured: boolean;
  source: ClickUpTokenSource;
  workspaceId?: string;
  workspaceName?: string;
  /** DCT_CLICKUP_TOKEN was set at startup but was not a token, so it is not used. */
  envRejected?: boolean;
};

export type ClickUpWorkspaceOption = { id: string; name: string };

export type ClickUpTestResult = {
  status: ClickUpAccountStatus;
  workspaces: ClickUpWorkspaceOption[];
};

/** Every Claude account's ClickUp setup, in account order. */
export function clickupStatus(): Promise<ClickUpAccountStatus[]> {
  return invoke("clickup_status");
}

/** Saves an account's ClickUp token in the system keychain. It cannot be read back. */
export function clickupTokenSet(accountId: string, token: string): Promise<ClickUpAccountStatus> {
  return invoke("clickup_token_set", { accountId, token });
}

/** Removes an account's ClickUp token from the keychain, and its workspace. */
export function clickupTokenClear(accountId: string): Promise<ClickUpAccountStatus> {
  return invoke("clickup_token_clear", { accountId });
}

/**
 * Checks an account's token against ClickUp and saves its workspace:
 * `workspaceId` when given, else the saved one, else the first.
 */
export function clickupTest(accountId: string, workspaceId?: string): Promise<ClickUpTestResult> {
  return invoke("clickup_test", { accountId, workspaceId: workspaceId ?? null });
}

/** C2: whether this window's Claude account can take tickets from ClickUp. Never the token. */
export type ClickUpIntakeStatus = {
  accountId: string;
  accountName: string;
  /** A token and a workspace are both set. */
  configured: boolean;
  workspaceName?: string;
};

export type { IntakeRef as ClickUpIntakeRef, RefProblem as ClickUpRefProblem } from "./clickup/intakeRefs";

export type ClickUpPriority = "urgent" | "high" | "normal" | "low" | "none";

/**
 * Which tickets a round takes. Closed and done tickets are always left out.
 * Each empty list keeps everything: `statuses` match a ticket's status name
 * (any case), `tags` keep a ticket with any of them.
 */
export type ClickUpIntakeFilters = { priorities: ClickUpPriority[]; statuses: string[]; tags: string[] };

export type ClickUpTicketRow = {
  id: string;
  customId?: string;
  title: string;
  priority: ClickUpPriority | string;
  status: string;
  /** ClickUp's status type: `open`, `custom`, `done` or `closed`. */
  statusType: string;
  url: string;
};

export type ClickUpExcludedTicket = ClickUpTicketRow & { reason: string };

export type ClickUpIntakeParent = {
  kind: "task" | "list";
  id: string;
  title: string;
  url: string;
  tickets: number;
};

/** What Fetch found: the parents, the tickets a round takes and the ones it leaves out. */
export type ClickUpIntakePreview = {
  parents: ClickUpIntakeParent[];
  tickets: ClickUpTicketRow[];
  excluded: ClickUpExcludedTicket[];
  problems: ClickUpRefProblemIn[];
  /** The open statuses the fetched tickets are in, for the status filter. */
  seenStatuses: string[];
  /** The tags the fetched tickets carry, for the tag filter. */
  seenTags: string[];
  /**
   * More tickets matched than one intake takes (100): how many. `tickets`
   * and `excluded` are then empty; narrow the filters and Fetch again.
   */
  overCap?: number;
};

/** A snapshot Start fetched, waiting for the start that passes its `intakeId`. */
export type ClickUpIntakeStaged = {
  intakeId: string;
  tickets: number;
  excluded: number;
  problems: ClickUpRefProblemIn[];
};

export type ClickUpChangedTicket = {
  id: string;
  title: string;
  dateUpdated?: string;
  /** ClickUp no longer has it, or this account cannot see it. */
  missing?: boolean;
};

/** The tickets ClickUp edited since a run's intake. */
export type ClickUpIntakeCheck = {
  checkedAt: string;
  tickets: number;
  changed: ClickUpChangedTicket[];
};

/** C2: whether this window's Claude account has ClickUp set up (Settings › Integrations). */
export async function clickupIntakeStatus(): Promise<ClickUpIntakeStatus> {
  return invoke("clickup_intake_status", { windowId: await windowId() });
}

/** C2 Fetch: what the pasted refs hold, read with this window's account only. No comments yet. */
export async function clickupIntakePreview(
  refs: ClickUpIntakeRefIn[],
  filters: ClickUpIntakeFilters,
): Promise<ClickUpIntakePreview> {
  return invoke("clickup_intake_preview", { windowId: await windowId(), refs, filters });
}

/**
 * C2 Start: reads the ticked tickets again with their comments and keeps the
 * snapshot for the start that passes its `intakeId` (`roleTerminalStart`).
 * `ticketIds` null keeps every ticket the filters keep.
 */
export async function clickupIntakeSnapshot(
  refs: ClickUpIntakeRefIn[],
  filters: ClickUpIntakeFilters,
  ticketIds: string[] | null,
): Promise<ClickUpIntakeStaged> {
  return invoke("clickup_intake_snapshot", { windowId: await windowId(), refs, filters, ticketIds });
}

/** C2: the tickets ClickUp edited since the run's intake (at most one ClickUp check every 5 minutes); null when the run did not start from ClickUp. */
export function clickupIntakeCheck(runId: string): Promise<ClickUpIntakeCheck | null> {
  return invoke("clickup_intake_check", { runId });
}

/** C2 Pull again: re-reads those tickets into the run's `tickets.json` and notes it on the Timeline. Running stages are not prompted. */
export function clickupIntakePull(runId: string, ticketIds: string[]): Promise<ClickUpIntakeCheck> {
  return invoke("clickup_intake_pull", { runId, ticketIds });
}

/** C3: the ClickUp list a ticket is in. */
export type ClickUpTicketList = { id: string; name: string };

/** C3: what was sent for a write-back row, and when. */
/** What ClickUp has from the row: the last comment posted (none when only a status went) and the last status set. */
export type ClickUpSent = { at: string; comment?: string; status?: string };

/** C3: one ticket's proposed ClickUp update. Never sent without `ticked`. */
export type ClickUpProposal = {
  ticket: { id: string; customId?: string; title: string; url: string; list?: ClickUpTicketList };
  /** The lanes it was matched to (`pr1`); empty: the run's own stages. */
  lanes?: string[];
  comment: string;
  /** The status to move the ticket to; absent: no status change. */
  status?: string;
  /** Why no status change is proposed. */
  statusNote?: string;
  verified: boolean;
  ticked: boolean;
  edited: boolean;
  statusEdited?: boolean;
  skipped?: boolean;
  /** A follow-up to an update already sent: a later verification added to it. */
  followUp?: boolean;
  sent?: ClickUpSent;
  /** The last comment POST timed out, so ClickUp may have it; ticking again needs `confirmResend`. */
  sentMaybe?: boolean;
  /** The last send's plain-English error. */
  error?: string;
};

/** C3: one list's "verified" status mapping. */
export type ClickUpListMapping = { id: string; name: string; verified?: string };

/** C3: the chain overview's "ClickUp updates". */
export type ClickUpWritebackView = {
  runId: string;
  /** The Claude account the tickets were taken with; sends use it. */
  accountId: string;
  accountName: string;
  proposals: ClickUpProposal[];
  lists: ClickUpListMapping[];
  sending?: boolean;
};

/** C3: one change to a row. `setStatus` with no `status` means no status change. */
export type ClickUpRowEdit = {
  comment?: string;
  setStatus?: boolean;
  status?: string | null;
  ticked?: boolean;
  skipped?: boolean;
  /** You checked the ticket after a timed-out send and want it sent again. */
  confirmResend?: boolean;
};

/** C3: one row you ticked, as you saw it. The backend sends it only if writeback.json still says exactly this. */
export type ClickUpSendRow = { ticketId: string; comment: string; status: string | null };

export type ClickUpWritebackSent = {
  view: ClickUpWritebackView;
  sent: number;
  failed: number;
  /** Ticked rows that were not sent, and why (no call was made). */
  notSent: { ticketId: string; reason: string }[];
};

export type ClickUpListStatus = { status: string; kind: string; color?: string };
export type ClickUpListStatuses = { id: string; name: string; statuses: ClickUpListStatus[] };
export type ClickUpAccountMappings = { accountId: string; accountName: string; lists: ClickUpListMapping[] };

/** C3: the run's ClickUp updates; null when it has none (no tickets.json, or nothing verified or complete yet). */
export function clickupWritebackLoad(runId: string): Promise<ClickUpWritebackView | null> {
  return invoke("clickup_writeback_load", { runId });
}

/** C3: ticks, skips or edits one row. */
export function clickupWritebackEdit(
  runId: string,
  ticketId: string,
  edit: ClickUpRowEdit,
): Promise<ClickUpWritebackView> {
  return invoke("clickup_writeback_edit", { runId, ticketId, edit });
}

/** C3 Send ticked: posts only `rows`, each as you saw it, with the account the tickets were taken with. */
export async function clickupWritebackSend(runId: string, rows: ClickUpSendRow[]): Promise<ClickUpWritebackSent> {
  return invoke("clickup_writeback_send", { windowId: await windowId(), runId, rows });
}

/** C3: a ClickUp list's real statuses, read with that account's token. */
export function clickupListStatuses(accountId: string, listId: string): Promise<ClickUpListStatuses> {
  return invoke("clickup_list_statuses", { accountId, listId });
}

/** C3: maps a list's "verified" status (checked against its real statuses), or with null forgets it. */
export function clickupStatusMapSet(
  accountId: string,
  listId: string,
  verified: string | null,
): Promise<ClickUpListMapping[]> {
  return invoke("clickup_status_map_set", { accountId, listId, verified });
}

/** C3: every Claude account's list mappings. */
export function clickupStatusMaps(): Promise<ClickUpAccountMappings[]> {
  return invoke("clickup_status_maps");
}

/** Opens the window's GitHub tab, or focuses it when one is already open. */
export async function openGithubTab(): Promise<AppStateSnapshot> {
  return invoke("open_github_tab", { windowId: await windowId() });
}

/** Saves the address a preview tab shows. */
export async function setPreviewUrl(tabId: string, url: string): Promise<void> {
  return invoke("set_preview_url", { tabId, url });
}

export type PipelineRunView = {
  run: PipelineRun;
  /** Step-1 form task type, for stages whose source form has none. */
  taskType?: string | null;
};

export async function getPipelineRun(runId: string): Promise<PipelineRunView> {
  return invoke("get_pipeline_run", { runId });
}

export type ChainRunUpdatedEvent = { chainId: string };

/** A chain run (or pipeline run) changed; open overviews refetch it. */
export function listenChainRunUpdated(
  handler: (event: ChainRunUpdatedEvent) => void,
): Promise<UnlistenFn> {
  return listen<ChainRunUpdatedEvent>("chain-run-updated", (e) => {
    handler(e.payload);
  });
}

/** Built-in pipelines, then your own (`docs/pipelines`, Settings › Pipelines). */
export async function pipelineDefsList(): Promise<import("./pipeline/defs").PipelineDef[]> {
  return invoke("pipeline_defs_list");
}

/** Replaces your own pipelines. Returns every pipeline. */
export async function pipelineDefsSave(
  pipelines: import("./pipeline/defs").PipelineDef[],
): Promise<import("./pipeline/defs").PipelineDef[]> {
  return invoke("pipeline_defs_save", { pipelines });
}

/** Runs a stage's gates in `cwd` (else the run's folder) and keeps the results on the run. */
export async function pipelineRunGates(
  runId: string,
  stageId: string,
  cwd: string | null,
  prUrls: string[],
  lane: string | null = null,
  /** The round the checks are for: results that arrive in a later round are not kept. */
  round: number | null = null,
): Promise<GateResult[]> {
  return invoke("pipeline_run_gates", { runId, stageId, lane, cwd, prUrls, round });
}

/** Splits a run into one lane per pull request at `stageId` (the Implementer's). */
export async function pipelineFanOut(
  runId: string,
  stageId: string,
  lanes: { id: string; title: string; dependsOn: string[]; repo?: string | null }[],
): Promise<void> {
  return invoke("pipeline_fan_out", { runId, stageId, lanes });
}

export async function pipelineLaneStatus(
  runId: string,
  lane: string,
  status: "waiting" | "active" | "approved",
): Promise<void> {
  return invoke("pipeline_lane_status", { runId, lane, status });
}

/** What approving a lane (or a run without lanes) by hand did. */
export type ApproveResult = {
  /** Every pull request (or the run) is approved: the run is complete. */
  complete: boolean;
  /** Waiting lanes whose dependencies are now all approved. */
  unblocked: string[];
};

/** Approve a lane by hand, or with `lane` null a run without lanes. */
export async function pipelineApprove(runId: string, lane: string | null): Promise<ApproveResult> {
  return invoke("pipeline_approve", { runId, lane });
}

export async function pipelineSetAutopilot(runId: string, enabled: boolean): Promise<void> {
  return invoke("pipeline_set_autopilot", { runId, enabled });
}

/**
 * A button on an engine-2 run, as a message to its Rust run actor (V3):
 * Send (hand a stage's turn on), Send back (a reviewer's round), Approve (a
 * lane, or with `lane` null the run), Continue (after a restart). `values`
 * and `handoffPlan` are the hand-off form as you left it; left out, the
 * actor fills it from the run folder. `force` makes a hand-off autopilot
 * made already. Prefill (V4, D20) changes nothing: it returns the next
 * stage's form as the run folder's files fill it. Take over and Hand back
 * (V5) move a stage between you and autopilot.
 */
export type ActorAction =
  | {
      kind: "send";
      sourceTabId: string;
      targetRoleId: string;
      values?: Record<string, string> | null;
      handoffPlan?: string | null;
      handoffText?: string | null;
      force?: boolean;
    }
  | {
      kind: "sendBack";
      sourceTabId: string;
      targetRoleId: string;
      text: string;
      verdict?: string | null;
      values?: Record<string, string> | null;
      handoffPlan?: string | null;
      force?: boolean;
    }
  | { kind: "approve"; lane: string | null }
  | { kind: "continue" }
  | { kind: "prefill"; sourceTabId: string; targetRoleId: string }
  /** You drive the stage now (V5, D28): no enforcement, no decisions, and its Watch view takes keystrokes. */
  | { kind: "takeOver"; tabId: string }
  /** Autopilot drives it again, deciding at once when its current turn already has a result. */
  | { kind: "handBack"; tabId: string }
  /** Record a hand-off you make yourself outside the actor (to a Chat tab); warns like Send when autopilot made it first. */
  | { kind: "recordHandoff"; sourceTabId: string; back: boolean; force?: boolean }
  /** Drop that record after the hand-off failed. */
  | { kind: "releaseHandoff"; sourceTabId: string; back: boolean }
  /** L2: answer the verify gate the run waits on: verified passes it; failed sends `note` back to the stage as a round. */
  | { kind: "verify"; stageId: string; lane: string | null; verified: boolean; note?: string | null }
  /** L3: Continue after a checkpoint story: `note` goes on to the next story; `add` holds stories to add after it, one per line. */
  | { kind: "storyContinue"; lane: string | null; story: string; note?: string | null; add?: string | null }
  /** L3: send the current story again to a run stopped mid-loop. */
  | { kind: "storyResend"; lane: string | null }
  /** F1: answer an artifact stage's open questions (or continue it after a block, `answer` as the note). */
  | { kind: "artifactAnswer"; stageId: string; answer?: string | null };

/** What a button did on an engine-2 run. */
export type ActorOutcome = {
  /** The terminal it opened or sent into. */
  tabId?: string | null;
  /** Nothing was done: autopilot made this hand-off already; send again with `force` to make it anyway. */
  warning?: string | null;
  /** Approve: the run is complete. */
  complete?: boolean;
  /** Approve: the lanes it started. */
  started?: string[];
  /** Prefill: the next stage's form values (no `cwd`) and the text recorded as the hand-off. */
  prefill?: { values: Record<string, string>; handoffText: string } | null;
};

export async function pipelineActorMessage(runId: string, action: ActorAction): Promise<ActorOutcome> {
  return invoke<ActorOutcome>("pipeline_actor_message", { runId, action });
}

/**
 * The run actor opened a stage terminal (engine 2), or resumed one: list
 * the tab. The stage runs hidden until a view watches it (V5).
 */
export type StageOpenedEvent = { runId: string; tabId: string };

export function listenStageOpened(handler: (event: StageOpenedEvent) => void): Promise<UnlistenFn> {
  return listen<StageOpenedEvent>("pipeline-stage-opened", (e) => {
    handler(e.payload);
  });
}

/** Something the run actor tells you (the run is complete). */
export type PipelineNoticeEvent = { runId: string; title: string; body: string };

export function listenPipelineNotice(handler: (event: PipelineNoticeEvent) => void): Promise<UnlistenFn> {
  return listen<PipelineNoticeEvent>("pipeline-notice", (e) => {
    handler(e.payload);
  });
}

/** One finding a reviewer reported through `submit_result` (plan "Result schemas"). */
export type BridgeFinding = {
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";
  summary: string;
  pr?: string;
  file?: string;
  regression?: boolean;
};

/** A reviewer's `submit_result`, already checked by the bridge. */
export type BridgeReviewResult = {
  schema: number;
  verdict: "APPROVED" | "APPROVED_WITH_CHANGES" | "CHANGES_REQUIRED";
  findings: BridgeFinding[];
};

/** One task of the Planner's plan (its fenced JSON block, plan "Result schemas"). */
export type PlannedTask = {
  /** `pr1`, `pr2`, … */
  id: string;
  title: string;
  dependsOn: string[];
  /** A release, deploy or config change, not a pull request. */
  manual: boolean;
  summary: string;
  /** L1: a Settings › Repos name; absent for the run's own folder. */
  repo?: string | null;
  /** L3: the stories its one pull request is built in, in order. */
  stories?: { id: string; title: string; tickets?: string[]; doneWhen?: string[]; plannedTests?: string[]; checkpoint?: string | null }[];
};

/** The Planner's result: the tasks the bridge took from its ExitPlanMode plan. */
export type BridgePlanResult = { schema: number; tasks: PlannedTask[] };

/** An Implementer's `submit_result`, already checked by the bridge. */
export type BridgeImplementerResult = {
  schema: number;
  prs: { url: string; branch: string; title: string; lane?: string }[];
  summary: string;
  checks?: { command: string; passed: boolean }[];
  /** Final Status BLOCKED: why it could not finish (its pull requests may be none). */
  blocked?: string;
  /** L3: the story this turn finished, when the pull request is built in stories. */
  story?: string;
};

/** The run's `tasks.json`: its Planner's latest tasks, which fan-out reads. */
export type RunTasks = {
  schema: number;
  runId: string;
  stageKey: string;
  turn: string;
  at: string;
  tasks: PlannedTask[];
};

/**
 * A bridged stage's finished turn (ADR-015), as the Stop hook drops it in
 * the run's inbox for the run actor.
 * `no_result`: the turn ended without `submit_result`, after one block on autopilot.
 */
export type BridgeTurn = {
  schema: number;
  runId: string;
  stageKey: string;
  stageId: string;
  roleId: string;
  lane?: string | null;
  tabId: string;
  /** Claude's `prompt_id`. */
  turn: string;
  outcome: "result" | "no_result";
  endedAt: string;
  lastAssistantMessage: string;
  /** Reviewers: verdict and findings; the Planner: its tasks; the Implementer: its pull requests. */
  result?: BridgeReviewResult | BridgePlanResult | BridgeImplementerResult | null;
  /** The bridge blocked one stop of this turn before it ended. */
  blocked: boolean;
};

/**
 * A bridged stage is waiting on a permission dialog (D22): from the
 * PermissionRequest hook at once, or the `permission_prompt` Notification
 * as the backup. Live as `pipeline-bridge-needs`.
 */
export type BridgeNeeds = {
  schema: number;
  runId: string;
  stageKey: string;
  stageId: string;
  roleId: string;
  lane?: string | null;
  tabId: string;
  /** Claude's `prompt_id` ("" when unknown). */
  turn: string;
  source: "permission_request" | "permission_prompt";
  /** The tool the dialog asks about (PermissionRequest only). */
  tool?: string | null;
  message?: string;
  at: string;
};

export function listenBridgeNeeds(handler: (event: BridgeNeeds) => void): Promise<UnlistenFn> {
  return listen<BridgeNeeds>("pipeline-bridge-needs", (e) => {
    handler(e.payload);
  });
}

/** The run's Planner tasks (`tasks.json`); null before a bridged Planner handed a plan over. */
export async function pipelineRunTasks(runId: string): Promise<RunTasks | null> {
  return invoke<RunTasks | null>("pipeline_run_tasks", { runId });
}

/** R1: what a plan of a QA round is. */
export type RoundPlanStatus = "active" | "deferred" | "parked";

/** R1: one plan of a QA round (`round.json`). */
export type RoundPlan = {
  id: string;
  title: string;
  tickets: string[];
  repos: string[];
  status: RoundPlanStatus;
  reason?: string | null;
  wave?: number | null;
  summary: string;
};

/** R1: a Triage run's `round.json`. */
export type RunRound = {
  schema: number;
  runId: string;
  stageKey: string;
  turn: string;
  at: string;
  plans: RoundPlan[];
  waves: { n: number; why: string }[];
  /** Plan ids per repo, in merge order. */
  mergeOrder: Record<string, string[]>;
  excluded: { ticket: string; reason: string }[];
};

/** R1: a Triage run's round and its round document (`round.md`). */
export type RunRoundView = {
  round: RunRound;
  markdown: string;
  markdownPath: string;
};

/** R1: the round a Triage run handed over; null for any other run. */
export async function pipelineRunRound(runId: string): Promise<RunRoundView | null> {
  return invoke<RunRoundView | null>("pipeline_run_round", { runId });
}

/** R2: where a plan of a running round stands. */
export type PlanRunState = "ready" | "running" | "done" | "stopped" | "parked" | "deferred";

/** R2: one plan of a round and its run. */
export type RoundPlanRun = {
  planId: string;
  title: string;
  wave?: number | null;
  state: PlanRunState;
  runId?: string | null;
  /** Why it stopped, or what its run waits for. */
  note?: string | null;
};

/** R2: a QA round, as `state.json` lists it. */
export type QaRound = {
  id: string;
  triageRunId: string;
  title: string;
  cwd: string;
  windowId?: string | null;
  /** The pipeline each plan runs. */
  pipeline: string;
  runsAtOnce: number;
  commitUpToWave: number;
  waves: number;
  plans: RoundPlanRun[];
  createdAt: string;
  updatedAt?: string | null;
};

/** R2: a plan as the round view shows it. */
export type RoundPlanView = RoundPlanRun & {
  /** Why a ready plan has not started. */
  waiting?: string | null;
  tickets: string[];
  repos: string[];
};

/** R2: a plan run waiting at its plan checkpoint; Approve is your Send to its actor. */
export type PlanCheckpoint = {
  planId: string;
  runId: string;
  stageTitle: string;
  sourceTabId: string;
  targetRoleId: string;
  waiting: string;
};

/** R2: a round and what its view shows. */
export type RoundView = {
  round: QaRound;
  plans: RoundPlanView[];
  checkpoints: PlanCheckpoint[];
};

/** R2: a round button; the round runner carries it out. */
export type RoundAction =
  | { kind: "start"; triageRunId: string; pipeline?: string | null; runsAtOnce?: number | null; commitUpToWave?: number | null }
  | { kind: "settings"; roundId: string; runsAtOnce?: number | null; commitUpToWave?: number | null }
  | { kind: "unpark"; roundId: string; planId: string; wave?: number | null }
  | { kind: "retry"; roundId: string; planId: string };

/** R2: the round `key` names (its id, its Triage run or one of its plan runs); null when none. */
export async function roundGet(key: string): Promise<RoundView | null> {
  return invoke<RoundView | null>("round_get", { key });
}

/** R3: a place in a repo's merge queue. */
export type QueueState = "open" | "draft" | "merged" | "closed" | "missing" | "parked" | "unknown";

/** R3: one place in a repo's merge queue: a pull request, or a plan with none there yet. */
export type QueueEntry = {
  planId: string;
  wave?: number | null;
  lane?: string | null;
  url?: string | null;
  title: string;
  number?: number | null;
  state: QueueState;
  base?: string | null;
  /** The next pull request to merge in this repo (at most one). */
  next: boolean;
  warnings: string[];
  /** What it waits for before it is next. */
  waitsFor?: string | null;
};

export type RepoQueue = { repo: string; entries: QueueEntry[] };

/** R3: a round's merge queue, per repo. */
export type MergeQueueView = { roundId: string; repos: RepoQueue[]; checkedAt: string };

/** R3: the round's merge queue, read through your gh (read-only); null when `key` names no round. */
export async function roundMergeQueue(key: string): Promise<MergeQueueView | null> {
  return invoke<MergeQueueView | null>("round_merge_queue", { key });
}

/** R2: a round button, answered with the round as it is after it. */
export async function roundAction(action: RoundAction): Promise<RoundView> {
  return invoke<RoundView>("round_action", { action });
}

/** The core stopped a run by itself: a stall, or a turn that finished while the app was closed. */
export type AutopilotStoppedEvent = {
  runId: string;
  tabId: string;
  reason: StopReason;
  summary: string;
};

/**
 * Stops the core made before the frontend listened (the startup reconcile
 * runs while the window loads), on the given tabs (this window's). Call once
 * the `autopilot-stopped` listener is attached and the tab list has loaded;
 * each stop is handed over once, and stops on other tabs stay held.
 */
export async function autopilotPendingStops(tabIds: string[]): Promise<AutopilotStoppedEvent[]> {
  return invoke("autopilot_pending_stops", { tabIds });
}

export function listenAutopilotStopped(
  handler: (event: AutopilotStoppedEvent) => void,
): Promise<UnlistenFn> {
  return listen<AutopilotStoppedEvent>("autopilot-stopped", (e) => {
    handler(e.payload);
  });
}

/** A hand-off made once per stage and round (or source turn), by you or autopilot (the run actor keeps these). */
export type HandoffClaim = { key: string; turn?: string | null; by: "you" | "autopilot" | string; at: string };

/** A stage's terminal finished a turn: one `turn` line in the run's ledger (run lanes). */
export async function pipelineTurnFinished(
  runId: string,
  turn: { stageId: string; roleId: string; lane?: string | null; verdict?: string | null },
): Promise<void> {
  return invoke("pipeline_turn_finished", {
    runId,
    stageId: turn.stageId,
    roleId: turn.roleId,
    lane: turn.lane ?? null,
    verdict: turn.verdict ?? null,
  });
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
  jsonRpcId: JsonRpcId;
  title: string;
  entries: { content: string; status: string; priority?: string }[];
  /** Claude ExitPlanMode body. Absent on a Cursor plan card. */
  markdown?: string | null;
  /** Reject option. Present means Keep planning, never Accept. */
  keepOptionId?: string | null;
  /** Claude plan file behind this ExitPlanMode, when one is known. */
  planPath?: string | null;
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
  jsonRpcId: JsonRpcId,
  outcome: "accepted" | "cancelled",
): Promise<void> {
  return invoke("respond_plan_request", { tabId, jsonRpcId, outcome });
}

export type QuestionRequestEvent = {
  tabId: string;
  sessionId: string;
  jsonRpcId: JsonRpcId;
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
  jsonRpcId: JsonRpcId,
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

/** Binds a saved hand-off to the tab it opened, when something else recorded the chain step (the run actor). */
export async function handoffBindTab(id: string, tabId: string): Promise<HandoffRecord> {
  return invoke("handoff_bind_tab", { id, tabId });
}

/**
 * Binds a saved hand-off to the tab it opened and records that tab's chain
 * step, or the reviewer's loop-back round, in one backend call.
 */
export async function handoffAttach(input: {
  id: string;
  tabId: string;
  chain: import("./handoff/chains").ChainRef | null;
  loopBack: {
    chainId: string;
    reviewerRoleId: string;
    verdict: string | null;
    lane?: string | null;
  } | null;
  handoffText: string | null;
}): Promise<{ record: HandoffRecord; chain: import("./handoff/chains").ChainRef | null }> {
  return invoke("handoff_attach", { input });
}

/** F7: one tab of a saved workspace (no live session). */
export type WorkspaceTab = {
  label: string;
  customLabel: boolean;
  roleId: string;
  roleSnapshot: { name: string; templateVersion: number; mode: string; injection: string };
  cwd: string;
  /** "role" (chat) | "terminal" | "preview" (its address in answers.url) | "github" */
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
  /** Cut at 8 MB. */
  truncated?: boolean;
};

export type TerminalSettings = {
  shell: string;
  fontSize: number;
  /** macOS: Option acts as Meta in terminals. */
  optionAsMeta: boolean;
  /** Copy a finished terminal selection to the clipboard. */
  copyOnSelect: boolean;
  roleSurface: Record<string, string>;
  roleRunMode: Record<string, string>;
  /** What ⌘/Ctrl+T (and a launch with no saved tabs) opens. */
  newTabOpens: NewTabOpens;
};

/** `ask` shows the new-tab picker; `start` shows the start screen. */
export type NewTabOpens = "ask" | "claude" | "shell" | "start";

export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
  shell: "",
  fontSize: 14,
  optionAsMeta: true,
  copyOnSelect: false,
  roleSurface: {},
  roleRunMode: {},
  newTabOpens: "ask",
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
  /** Launch as this provider (a hand-off's new tab keeps its source's). Omitted: the tab's, or the window's default. */
  provider?: ProviderId | null;
  /** The chain tag the new tab is about to join (a hand-off's next stage): its stage kind sets the permission mode, and a bridged stage (Planner, reviewer, Implementer) of an engine-2 run launches with the bridge. */
  chain?: import("./handoff/chains").ChainRef | null;
  /**
   * Eagle mode: this start begins a chain of this kind. The core makes its
   * run before the launch, so the first stage launches with the bridge too.
   */
  startChain?: import("./pipeline/eagleStart").EagleChain | null;
  /**
   * C2: the ClickUp tickets Start fetched (`clickupIntakeSnapshot`). An
   * engine-2 run's first stage gets them as the run's `tickets.json`.
   */
  intakeId?: string | null;
  /** F3: the size (S, M or L) the start screen picked for the run `startChain` begins; kept on the run. */
  size?: import("./pipeline/sizes").RunSize | null;
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
      provider: input.provider ?? null,
      chain: input.chain ?? null,
      startChain: input.startChain ?? null,
      intakeId: input.intakeId ?? null,
      size: input.size ?? null,
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
  /** A view opening (not restarting) it: a stage terminal the run actor started is attached to, not started again. */
  attach?: boolean;
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
      attach: input.attach ?? false,
    },
    onOutput: input.onOutput,
  });
}

/** Tell the backend whether the app theme is light, so Claude terminals pick a matching palette. */
export async function ptySetScheme(light: boolean): Promise<void> {
  return invoke("pty_set_scheme", { light });
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

/**
 * Whether you may type into a terminal now (V5, D27). A bridged pipeline
 * stage on autopilot is watch-only, except while it needs you or you took
 * it over; every other terminal is always open.
 */
export type StageInput = {
  /** Keystrokes go through. */
  open: boolean;
  /** The terminal is a bridged pipeline stage. */
  stage: boolean;
  /** You took the stage over. */
  takenOver: boolean;
  /** It needs you now (a permission dialog or a question). */
  needs: boolean;
};

export async function ptyInputState(id: string): Promise<StageInput> {
  return invoke<StageInput>("pty_input_state", { id });
}

/** Tell the backend a bridged stage needs you, or no longer does; returns what typing allows now. */
export async function ptyStageNeeds(id: string, needs: boolean): Promise<StageInput> {
  return invoke<StageInput>("pty_stage_needs", { id, needs });
}

/** Which of these terminals run a program now, with a view or not (V5: hidden stages have none). */
export async function ptyRunning(ids: string[]): Promise<string[]> {
  return invoke<string[]>("pty_running", { ids });
}

/**
 * A Watch view closed (V5): the hidden stage keeps running and keeps its
 * output for the next view. False when the terminal is not a hidden stage
 * (it keeps streaming to this app).
 */
export async function ptyDetach(id: string): Promise<boolean> {
  return invoke<boolean>("pty_detach", { id });
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
/**
 * `mentioned`: plan file names this terminal printed (they win). `claimed`:
 * names other open terminals printed (never this tab's plan).
 */
export async function terminalPlanFile(
  startedAtMs: number,
  tabId?: string | null,
  names?: { mentioned: string[]; claimed: string[] },
): Promise<PlanFileInfo | null> {
  return invoke<PlanFileInfo | null>("terminal_plan_file", {
    startedAtMs,
    tabId: tabId ?? null,
    ...(names ? { mentioned: names.mentioned, claimed: names.claimed } : {}),
  });
}

export type SessionToolCallKind = "read" | "edit" | "execute" | "fetch" | "other";
export type SessionToolCallStatus = "pending" | "completed" | "failed";

export type SessionToolCall = {
  id: string;
  name: string;
  kind: SessionToolCallKind;
  /** Redacted. */
  title: string;
  path: string | null;
  /** Redacted. */
  command: string | null;
  /** Redacted. */
  url: string | null;
  status: SessionToolCallStatus;
  at: string | null;
};

/** A Claude terminal tab's own session log (read-only, last ~8 MB). */
export type TerminalSessionLog = {
  sessionId: string;
  path: string;
  /** The latest assistant message ended the turn and no tool call is open. */
  turnDone: boolean;
  /** Assistant text since the latest real user prompt. */
  lastReply: string;
  /** `input.plan` of the newest ExitPlanMode call. */
  plan: string | null;
  planAt: string | null;
  lastPromptAt: string | null;
  /** The turn ended because you interrupted it, not because Claude finished. Absent on older backends. */
  interrupted?: boolean;
  /** Oldest to newest, at most 500. */
  toolCalls: SessionToolCall[];
  /**
   * The current turn's unanswered tool (ExitPlanMode, then AskUserQuestion,
   * then the newest). Absent on older backends.
   */
  openTool?: { id: string; name: string; title: string } | null;
  /** The current turn's unanswered tools, oldest first. Absent on older backends. */
  pendingTools?: { id: string; name: string; title: string }[];
  /** `permissionMode` of the latest real prompt. */
  permissionMode?: string | null;
  /** The turn ended on a Claude rate-limit error (its text). Absent on older backends. */
  rateLimit?: string | null;
};

/** `null` until the tab has a pinned Claude session whose log exists. */
export async function terminalSessionLog(tabId: string): Promise<TerminalSessionLog | null> {
  return invoke<TerminalSessionLog | null>("terminal_session_log", { tabId });
}

/**
 * A chat entry's tool status. `running`: no result yet (a plan or question
 * is waiting for the user). `error`: failed, denied or rejected. `stopped`:
 * a later prompt started before any result came back.
 */
export type ChatEntryStatus = "running" | "done" | "error" | "stopped";

export type ChatQuestion = {
  header: string;
  question: string;
  /** Option labels. */
  options: string[];
  multiSelect: boolean;
};

/** Fields every chat entry has (src-tauri/src/claude_session_log/chat.rs). */
type ChatEntryBase = {
  /** Position in the session, ascending in file order. Stable across updates. */
  seq: number;
  /** Bumped whenever this entry is added or changed. */
  rev: number;
  /** The record's ISO timestamp; for a tool, when it was called. */
  at: string | null;
};

type ChatToolFields = {
  /** The `tool_use` id. */
  toolId: string;
  status: ChatEntryStatus;
  /** When its `tool_result` came back (or null). */
  endedAt: string | null;
};

/**
 * One entry of a Claude terminal tab's conversation, from its session log.
 * Thinking blocks and a sub-agent's own steps (sidechain records) are left out.
 */
export type ChatEntry = ChatEntryBase &
  (
    | { kind: "user"; text: string }
    | { kind: "assistant"; text: string }
    | (ChatToolFields & {
        kind: "tool";
        name: string;
        /** Redacted one-liner, e.g. "Bash: Run tests". */
        title: string;
        toolKind: SessionToolCallKind;
      })
    | (ChatToolFields & {
        /** A `tool_use` named Agent (older: Task): starts at `at`, ends at `endedAt`. */
        kind: "subAgent";
        description: string;
        agentType: string | null;
        /** Launched in the background: its result only says it started. */
        background: boolean;
      })
    | (ChatToolFields & { kind: "plan"; plan: string })
    | (ChatToolFields & { kind: "question"; questions: ChatQuestion[] })
  );

export type ChatEntriesUpdate = {
  sessionId: string;
  /** Pass back as `since` to get only later changes. */
  revision: number;
  /** True: `entries` is the whole list (replace). False: only new or changed entries (merge by `seq`). */
  reset: boolean;
  /** Entries below this `seq` were dropped (the backend keeps the newest 2000). */
  firstSeq: number;
  /** Ascending `seq`. */
  entries: ChatEntry[];
};

/** Entries changed after `since` (all, with `reset`, when omitted). `null` until the log exists. */
export async function terminalChatEntries(
  tabId: string,
  since?: number | null,
): Promise<ChatEntriesUpdate | null> {
  return invoke<ChatEntriesUpdate | null>("terminal_chat_entries", { tabId, since: since ?? null });
}

/**
 * Streams the tab's chat entries: what changed after `since` first, then each
 * change, until `terminalChatUnwatch`, the tab closes, or its PTY is killed.
 * One watch per tab; a new call replaces the old one. Prefer
 * `subscribeChatEntries` (src/terminal/chatEntriesStore.ts), which shares it.
 */
export async function terminalChatWatch(
  tabId: string,
  since: number | null,
  onUpdate: (update: ChatEntriesUpdate) => void,
): Promise<void> {
  const channel = new Channel<ChatEntriesUpdate>();
  channel.onmessage = onUpdate;
  return invoke("terminal_chat_watch", { tabId, since, onUpdate: channel });
}

export async function terminalChatUnwatch(tabId: string): Promise<void> {
  return invoke("terminal_chat_unwatch", { tabId });
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

/** Settings › Repos (L1): a named git repo a plan's lanes can be made in. */
export type RepoEntry = {
  /** `backend`: letters, digits, `-` and `_`. */
  name: string;
  folder: string;
  /** L2: the command that checks a lane in this repo; replaces the stage's command gates there. One line, at most 2000 characters. */
  check?: string | null;
  /** L2: steps you verify yourself for a lane in this repo, after its check passes. At most 2000 characters. */
  verify?: string | null;
};

export async function getReposSettings(): Promise<RepoEntry[]> {
  return invoke<RepoEntry[]>("get_repos_settings");
}

/** Checked in Rust (names, and each folder a git repo); rejects with the first problem. */
export async function setReposSettings(repos: RepoEntry[]): Promise<RepoEntry[]> {
  return invoke<RepoEntry[]>("set_repos_settings", { repos });
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
  /** #rrggbb overrides on top of the theme (Settings > Appearance). */
  customColors?: CustomColors;
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

// --- Agent activity log (app data `activity/<tabId>.jsonl`) ---

export type ActivityKind =
  | "shell"
  | "write"
  | "edit"
  | "delete"
  | "fetch"
  | "mcp"
  | "read"
  | "other";

export type ActivityEntry = {
  /** ACP toolCallId: later updates complete the same row. */
  id: string;
  tabId: string;
  /** RFC 3339, first seen. */
  time: string;
  updatedAt: string;
  kind: ActivityKind | string;
  title: string;
  /** Redacted command, path, or URL. */
  summary: string;
  /** auto_allow | user_allow | user_reject | cancelled | none */
  decision: string;
  network: boolean;
  /** pending | in_progress | completed | failed */
  status: string | null;
};

/** Tool calls the tab's agent made, oldest first. */
export async function activityList(tabId: string, limit?: number): Promise<ActivityEntry[]> {
  return invoke<ActivityEntry[]>("activity_list", { tabId, limit: limit ?? null });
}

export async function activityClear(tabId: string): Promise<void> {
  return invoke("activity_clear", { tabId });
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

/**
 * The subset of `paths` that name existing files inside the tab's folder.
 * Relative paths resolve against the folder; absolute ones must lie inside it.
 */
export async function filesResolve(tabId: string, paths: string[]): Promise<string[]> {
  return invoke<string[]>("files_resolve", { tabId, paths });
}

export async function filesRead(tabId: string, path: string): Promise<FileContent> {
  return invoke<FileContent>("files_read", { tabId, path });
}

/**
 * An image a rendered Markdown file shows (`src` relative to `docPath`, or
 * to the folder when it starts with `/`), as a `data:` URL. Same rules as
 * the Files panel; image files up to 5 MB only.
 */
export async function filesMarkdownImage(tabId: string, docPath: string, src: string): Promise<string> {
  return invoke<string>("files_markdown_image", { tabId, docPath, src });
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
