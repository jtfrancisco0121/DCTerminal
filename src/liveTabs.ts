import type {
  DevPromptResult,
  DevSessionInfo,
  PermissionAutoEvent,
  PermissionRequestEvent,
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

export type TabRuntime = {
  session: DevSessionInfo | null;
  segments: StreamSegment[];
  promptInFlight: boolean;
  permission: PermissionRequestEvent | null;
  promptError: string | null;
  lastResult: DevPromptResult | null;
  startResult: RoleSessionStartResult | null;
  folderWarning: string | null;
  agentExited: boolean;
  /** True while Start is in flight so early ACP events are not dropped. */
  accepting: boolean;
  followUp: string;
};

export function emptyRuntime(): TabRuntime {
  return {
    session: null,
    segments: [],
    promptInFlight: false,
    permission: null,
    promptError: null,
    lastResult: null,
    startResult: null,
    folderWarning: null,
    agentExited: false,
    accepting: false,
    followUp: "",
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
    .filter(([, rt]) => rt.permission !== null || rt.agentExited)
    .map(([id]) => id);
}

export function folderStatusMessage(status: string, cwd: string): string | null {
  if (status === "ok" || status === "") return null;
  if (status === "not-a-directory") {
    return `Working folder is a file, not a directory: ${cwd}`;
  }
  if (status === "unreadable") {
    return `Working folder is not readable: ${cwd}`;
  }
  return `Working folder was not found (it may have been moved or deleted): ${cwd}`;
}
