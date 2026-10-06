import type { SessionUpdateEvent } from "./bridge";
import {
  appendStreamSegment,
  streamSegmentFromEvent,
  streamSegmentFromSystemMessage,
  type StreamSegment,
} from "./transcript";

export type CursorHistorySource = "acp" | "cli";

export type CursorHistoryEntry = {
  id: string;
  source: CursorHistorySource | string;
  cwd: string;
  title: string;
  updatedAt: string | null;
};

export function historySourceLabel(source: string): string {
  if (source === "cli") return "CLI chat";
  if (source === "acp") return "ACP session";
  return source;
}

/** `agent --resume` opens chats under `chats/`. It does not open ACP sessions. */
export function canOpenInCursorCli(source: string): boolean {
  return source === "cli";
}

/** ACP sessions resume in DCTerminal with `session/load`. */
export function canResumeInApp(source: string): boolean {
  return source === "acp";
}

export const OPEN_IN_CURSOR_CLI_TITLE =
  "Open this CLI chat with agent --resume in Windows Terminal or PowerShell. ACP sessions stay in DCTerminal: the 2026.10.01 probe showed agent --resume cannot open them.";

export const RESUME_ACP_TITLE =
  "Resume this ACP session in DCTerminal with session/load. agent --resume does not open ACP sessions.";

/**
 * Which ACP session id a start should load.
 * Continue uses the id stored on the tab. Start new session always creates one.
 * A history pick passes an explicit id and wins over the stored tab id.
 */
export function resumeIdForStart(input: {
  explicitSessionId?: string | null;
  storedSessionId?: string | null;
  resumeStored?: boolean;
  forceResend?: boolean;
}): string | null {
  const explicit = input.explicitSessionId?.trim();
  if (explicit) return explicit;
  if (input.resumeStored && !input.forceResend) {
    const stored = input.storedSessionId?.trim();
    return stored || null;
  }
  return null;
}

/** Opening lines while Start/Continue is in flight. Continue does not paste scrollback. */
export function segmentsWhileStarting(input: {
  continuing: boolean;
  sessionId: string | null;
  savedTranscript: string;
  existing: StreamSegment[];
}): StreamSegment[] {
  if (input.continuing && input.sessionId) {
    return [
      streamSegmentFromSystemMessage(
        `Resuming ACP session ${input.sessionId} via session/load…`,
      ),
    ];
  }
  const prior =
    input.existing.length > 0
      ? input.existing
      : input.savedTranscript
        ? [
            {
              id: "saved_transcript",
              kind: "agent" as const,
              text: input.savedTranscript,
            },
          ]
        : [];
  return [
    ...prior,
    streamSegmentFromSystemMessage(
      input.continuing
        ? "Reconnecting to agent (startup prompt skipped). Send a follow-up below to continue."
        : "Connecting to agent and sending startup prompt…",
    ),
  ];
}

/**
 * Apply `session/load` replay. Local scrollback is shown only when the CLI
 * did not replay message text, and it is labeled as a local copy.
 */
export function segmentsAfterResume(input: {
  segments: StreamSegment[];
  loaded: boolean;
  replay: SessionUpdateEvent[];
  replayMessageCount: number;
  savedTranscript: string;
  folderWarning: string | null;
}): StreamSegment[] {
  let segments = input.segments.filter(
    (segment) =>
      segment.kind !== "system" ||
      (!segment.text.includes("Resuming ACP session") &&
        !segment.text.includes("Connecting to agent")),
  );
  if (input.loaded) {
    for (const event of input.replay) {
      const segment = streamSegmentFromEvent(event);
      if (segment) segments = appendStreamSegment(segments, segment);
    }
    if (input.replayMessageCount === 0 && input.savedTranscript.trim()) {
      segments = appendStreamSegment(segments, {
        id: "saved_transcript",
        kind: "agent",
        text: input.savedTranscript,
      });
      segments = appendStreamSegment(
        segments,
        streamSegmentFromSystemMessage(
          "Loaded the ACP session, but the CLI did not replay message text. The scrollback above is the local copy. Send a follow-up to continue the same thread.",
        ),
      );
    }
  }
  if (input.folderWarning) {
    segments = appendStreamSegment(
      segments,
      streamSegmentFromSystemMessage(input.folderWarning),
    );
  }
  return segments;
}
