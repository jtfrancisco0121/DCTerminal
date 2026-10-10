import type {
  DevPromptResult,
  DevSessionInfo,
  PermissionAutoEvent,
  PermissionRequestEvent,
  PlanRequestEvent,
  QuestionRequestEvent,
  PromptFinishedEvent,
  RoleSessionStartResult,
  SessionUpdateEvent,
} from "./bridge";
import {
  appendStreamSegment,
  finalizeInFlightTools,
  reconcileAgentStream,
  streamSegmentFromEvent,
  streamSegmentFromSystemMessage,
  type StreamSegment,
} from "./transcript";
import { parseAvailableCommands, type SlashCommand } from "./composer/slashCommands";

export type TabRuntime = {
  session: DevSessionInfo | null;
  segments: StreamSegment[];
  promptInFlight: boolean;
  permission: PermissionRequestEvent | null;
  plan: PlanRequestEvent | null;
  /** The last plan Claude submitted ("Ready to code?"), kept after the card closes. */
  lastPlanMarkdown: string;
  question: QuestionRequestEvent | null;
  promptError: string | null;
  lastResult: DevPromptResult | null;
  startResult: RoleSessionStartResult | null;
  folderWarning: string | null;
  agentExited: boolean;
  /** True while Start is in flight so early ACP events are not dropped. */
  accepting: boolean;
  followUp: string;
  /** Latest `available_commands_update` list (Claude commands and skills). */
  slashCommands: SlashCommand[];
};

export function emptyRuntime(): TabRuntime {
  return {
    session: null,
    segments: [],
    promptInFlight: false,
    permission: null,
    plan: null,
    lastPlanMarkdown: "",
    question: null,
    promptError: null,
    lastResult: null,
    startResult: null,
    folderWarning: null,
    agentExited: false,
    accepting: false,
    followUp: "",
    slashCommands: [],
  };
}

export function runtimeFor(
  runtimes: Record<string, TabRuntime>,
  tabId: string | null,
): TabRuntime {
  if (!tabId || !runtimes[tabId]) return emptyRuntime();
  return runtimes[tabId];
}

function sameSession(rt: TabRuntime, sessionId: string): boolean {
  if (!rt.session) return rt.accepting;
  if (!sessionId) return true;
  return rt.session.sessionId === sessionId;
}

export function applySessionUpdate(
  rt: TabRuntime,
  evt: SessionUpdateEvent,
): TabRuntime {
  if (!sameSession(rt, evt.sessionId)) return rt;
  const commands = parseAvailableCommands(evt);
  if (commands) return { ...rt, slashCommands: commands };
  const seg = streamSegmentFromEvent(evt);
  if (!seg) return rt;
  return { ...rt, segments: appendStreamSegment(rt.segments, seg) };
}

export function applyPromptFinished(
  rt: TabRuntime,
  evt: PromptFinishedEvent,
): TabRuntime {
  if (!sameSession(rt, evt.sessionId)) return rt;
  if (evt.success && evt.result) {
    return {
      ...rt,
      promptInFlight: false,
      permission: null,
      plan: null,
      question: null,
      promptError: null,
      agentExited: false,
      accepting: false,
      lastResult: evt.result,
      segments: finalizeInFlightTools(
        reconcileAgentStream(rt.segments, evt.result.agentText ?? ""),
        "completed",
      ),
      startResult: rt.startResult
        ? { ...rt.startResult, startupInjected: true }
        : rt.startResult,
    };
  }
  return {
    ...rt,
    promptInFlight: false,
    permission: null,
    plan: null,
    question: null,
    promptError: evt.error,
    agentExited: evt.agentExited,
    accepting: false,
    segments: finalizeInFlightTools(rt.segments, "cancelled"),
  };
}

export function applyPermission(
  rt: TabRuntime,
  evt: PermissionRequestEvent,
): TabRuntime {
  if (!sameSession(rt, evt.sessionId)) return rt;
  return { ...rt, permission: evt };
}

export function applyPlan(rt: TabRuntime, evt: PlanRequestEvent): TabRuntime {
  if (!sameSession(rt, evt.sessionId)) return rt;
  const markdown = (evt.markdown ?? "").trim();
  return { ...rt, plan: evt, lastPlanMarkdown: markdown || rt.lastPlanMarkdown };
}

export function clearPlan(rt: TabRuntime): TabRuntime {
  return { ...rt, plan: null };
}

export function applyQuestion(
  rt: TabRuntime,
  evt: QuestionRequestEvent,
): TabRuntime {
  if (!sameSession(rt, evt.sessionId)) return rt;
  return { ...rt, question: evt };
}

export function clearQuestion(rt: TabRuntime): TabRuntime {
  return { ...rt, question: null };
}

export function applyAutoPermission(
  rt: TabRuntime,
  evt: PermissionAutoEvent,
): TabRuntime {
  if (!sameSession(rt, evt.sessionId)) return rt;
  return {
    ...rt,
    segments: appendStreamSegment(
      rt.segments,
      streamSegmentFromSystemMessage(evt.line),
    ),
  };
}

export function clearLiveSession(rt: TabRuntime): TabRuntime {
  return { ...emptyRuntime(), followUp: rt.followUp };
}

export function attentionTabIds(runtimes: Record<string, TabRuntime>): string[] {
  return Object.entries(runtimes)
    .filter(
      ([, rt]) =>
        rt.permission !== null ||
        rt.plan !== null ||
        rt.question !== null ||
        rt.agentExited,
    )
    .map(([id]) => id);
}

export function folderStatusMessage(status: string, cwd: string): string | null {
  if (status === "ok" || status === "" || status === "empty") return null;
  if (!cwd.trim()) return null;
  if (status === "not-a-directory") {
    return `Working folder is a file, not a directory: ${cwd}`;
  }
  if (status === "unreadable") {
    return `Working folder is not readable: ${cwd}`;
  }
  return `Working folder was not found (it may have been moved or deleted): ${cwd}`;
}

/**
 * Folder line for the open tab. An empty path is "Choose a folder", never
 * the not-found error. A status computed for a different path is ignored.
 */
export function folderTabNotice(input: {
  status: string;
  savedCwd: string;
  displayedCwd: string;
}): { tone: "hint" | "error"; text: string } | null {
  const displayed = input.displayedCwd.trim();
  const saved = input.savedCwd.trim();
  if (!displayed) {
    if (saved) return { tone: "hint", text: "Choose a folder" };
    if (input.status === "ok" || input.status === "") return null;
    return { tone: "hint", text: "Choose a folder" };
  }
  if (saved !== displayed) return null;
  const message = folderStatusMessage(input.status, displayed);
  if (!message) return null;
  return { tone: "error", text: message };
}
