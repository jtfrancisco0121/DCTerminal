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
  roleName?: string | null;
  userText?: string | null;
};

const PROMPT_HEADINGS: { role: string; heading: string }[] = [
  { role: "Developer", heading: "senior software engineer" },
  { role: "General", heading: "general-purpose project lead" },
];

function loose(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

/** Cursor names some sessions from the first line of the role prompt. */
export function promptHeadingRole(title: string): string | null {
  const text = loose(title);
  if (text.length < 8) return null;
  for (const item of PROMPT_HEADINGS) {
    if (item.heading.startsWith(text) || text.startsWith(item.heading)) return item.role;
  }
  return null;
}

function clip(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (one.length <= 80) return one;
  return `${one.slice(0, 79).trimEnd()}…`;
}

/** Role plus the user's title, or the first thing they typed. */
export function presentHistoryTitle(entry: CursorHistoryEntry): string {
  const role = entry.roleName?.trim() || promptHeadingRole(entry.title) || "";
  const heading = promptHeadingRole(entry.title) !== null;
  const typed = entry.userText?.trim() || (heading ? "" : entry.title.trim());
  if (role && typed && loose(typed) !== loose(role)) return `${role} · ${clip(typed)}`;
  if (role) return role;
  if (heading) return "Saved session";
  return entry.title.trim() || "Saved session";
}

/** Local, relative time. A raw UTC timestamp is not shown. */
export function formatHistoryTime(iso: string | null, now = new Date()): string {
  if (!iso) return "";
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const delta = now.getTime() - then.getTime();
  if (delta < 0) {
    return then.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }
  const seconds = Math.round(delta / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return then.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function historySourceLabel(source: string): string {
  if (source === "cli") return "Chat";
  if (source === "acp") return "Session";
  return source;
}

/** A terminal reopen: Cursor chats, or any Claude session (`claude --resume`). */
export function canOpenInCursorCli(source: string): boolean {
  return source === "cli" || source === "claude";
}

/** ACP and Claude sessions resume in DCTerminal with `session/load`. */
export function canResumeInApp(source: string): boolean {
  return source === "acp" || source === "claude";
}

export function historyOpenLabel(source: string): string {
  return source === "claude" ? "Open in Claude Code" : "Open in Cursor CLI";
}

export const OPEN_IN_CURSOR_CLI_TITLE =
  "Opens this chat in a terminal tab.";

export const RESUME_ACP_TITLE = "Continues this session in DCTerminal.";

export const HISTORY_HINT = "Saved sessions for this folder.";

export const HISTORY_TOOLTIP =
  "Resume continues a session here. Open in Cursor CLI opens a chat in the terminal.";

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
        "Continuing this session…",
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
      (!segment.text.includes("Continuing this session") &&
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
          "This session opened, but earlier messages were not replayed. The scrollback above is the local copy. Send a follow-up to continue.",
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
