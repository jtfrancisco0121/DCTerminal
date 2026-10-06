import type { SessionUpdateEvent } from "./bridge";

export type TranscriptLine = {
  id: string;
  kind: "agent" | "tool" | "thought" | "system" | "other";
  label: string;
  text: string;
};

export type StreamSegmentKind = "agent" | "user" | "tool" | "thought" | "system";

export type StreamSegment = {
  id: string;
  kind: StreamSegmentKind;
  text: string;
};

export const MAX_STREAM_CHARS = 500_000;

let lineSeq = 0;

function nextId(): string {
  lineSeq += 1;
  return `tl_${lineSeq}`;
}

function mapEventKind(kind: string): StreamSegmentKind {
  const k = kind.replace(/_/g, "").toLowerCase();
  if (k.includes("usermessage")) return "user";
  if (k.includes("agentmessage") || k === "text") return "agent";
  if (k.includes("toolcall") || k.includes("tool")) return "tool";
  if (k.includes("thought")) return "thought";
  if (k.includes("plan") || k.includes("mode")) return "system";
  return "agent";
}

/** ACP often sends `{ type, text }` blocks instead of plain strings. */
export function coerceDisplayText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(coerceDisplayText).filter(Boolean).join("");
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of ["text", "content", "delta", "message", "chunk", "value"]) {
      if (obj[key] !== undefined) {
        const part = coerceDisplayText(obj[key]);
        if (part) return part;
      }
    }
    if (Array.isArray(obj.parts)) {
      return obj.parts.map(coerceDisplayText).filter(Boolean).join("");
    }
  }
  return "";
}

function parseRawEventText(evt: SessionUpdateEvent): string {
  try {
    const raw = JSON.parse(evt.rawJson) as Record<string, unknown>;
    const update = (raw.update as Record<string, unknown>) ?? raw;
    const kind = mapEventKind(
      String(update.type ?? update.updateType ?? evt.kind),
    );
    if (kind === "tool") {
      return toolSummary(update);
    }
    return (
      coerceDisplayText(update.text) ||
      coerceDisplayText(update.content) ||
      coerceDisplayText(update.chunk) ||
      ""
    );
  } catch {
    return "";
  }
}

function toolSummary(raw: Record<string, unknown>): string {
  const name =
    (raw.toolName as string) ||
    (raw.name as string) ||
    ((raw.tool as Record<string, unknown>)?.name as string);
  const status =
    (raw.status as string) ||
    ((raw.toolCall as Record<string, unknown>)?.status as string);
  if (name && status) return `${name} (${status})`;
  if (name) return name;
  return "tool";
}

export function streamSegmentFromEvent(
  evt: SessionUpdateEvent,
): StreamSegment | null {
  const kind = mapEventKind(evt.kind);
  const text =
    coerceDisplayText(evt.textDelta) || parseRawEventText(evt);
  if (!text) return null;
  return { id: nextId(), kind, text };
}

export function appendStreamSegment(
  segments: StreamSegment[],
  seg: StreamSegment,
): StreamSegment[] {
  const prev = segments[segments.length - 1];
  const mergeable =
    seg.kind === "agent" || seg.kind === "user" || seg.kind === "thought";
  if (prev && prev.kind === seg.kind && mergeable) {
    const merged = {
      ...prev,
      text: trimStreamChars(prev.text + seg.text),
    };
    return [...segments.slice(0, -1), merged];
  }
  return [...segments, { ...seg, text: trimStreamChars(seg.text) }];
}

function trimStreamChars(text: string): string {
  if (text.length <= MAX_STREAM_CHARS) return text;
  return text.slice(text.length - MAX_STREAM_CHARS);
}

/** If live stream missed chunks, fold in the final `session/prompt` aggregate text. */
export function reconcileAgentStream(
  segments: StreamSegment[],
  agentText: string,
): StreamSegment[] {
  const trimmed = agentText.trim();
  if (!trimmed) return segments;

  const streamed = segments
    .filter((s) => s.kind === "agent")
    .map((s) => s.text)
    .join("");
  if (streamed.length >= trimmed.length * 0.85) {
    return segments;
  }

  const withoutAgent = segments.filter((s) => s.kind !== "agent");
  return [
    ...withoutAgent,
    { id: nextId(), kind: "agent", text: trimmed },
  ];
}

export function streamSegmentFromSystemMessage(text: string): StreamSegment {
  return { id: nextId(), kind: "system", text };
}

// --- legacy line helpers (tests / migration) ---

function normalizeKind(kind: string): TranscriptLine["kind"] {
  const mapped = mapEventKind(kind);
  if (mapped === "tool") return "tool";
  if (mapped === "thought") return "thought";
  if (mapped === "system") return "system";
  if (mapped === "user") return "other";
  return "agent";
}

export function sessionUpdateToLine(evt: SessionUpdateEvent): TranscriptLine {
  const seg = streamSegmentFromEvent(evt);
  if (!seg) {
    return {
      id: nextId(),
      kind: "other",
      label: evt.kind,
      text: "",
    };
  }
  return {
    id: seg.id,
    kind: normalizeKind(evt.kind),
    label: evt.kind,
    text: seg.text,
  };
}

export function coalesceAgentLines(lines: TranscriptLine[]): TranscriptLine[] {
  let segments: StreamSegment[] = [];
  for (const line of lines) {
    if (!line.text) continue;
    const seg: StreamSegment = {
      id: line.id,
      kind:
        line.kind === "tool"
          ? "tool"
          : line.kind === "thought"
            ? "thought"
            : line.kind === "system"
              ? "system"
              : "agent",
      text: line.text,
    };
    segments = appendStreamSegment(segments, seg);
  }
  return segments.map((s) => ({
    id: s.id,
    kind:
      s.kind === "tool"
        ? "tool"
        : s.kind === "thought"
          ? "thought"
          : s.kind === "system"
            ? "system"
            : "agent",
    label: s.kind,
    text: s.text,
  }));
}

export function linesToTerminalText(lines: TranscriptLine[]): string {
  const segments: StreamSegment[] = lines.map((line) => ({
    id: line.id,
    kind:
      line.kind === "tool"
        ? "tool"
        : line.kind === "thought"
          ? "thought"
          : line.kind === "system"
            ? "system"
            : "agent",
    text: line.text,
  }));
  return segmentsToPlainText(segments);
}

export function segmentsToPlainText(segments: StreamSegment[]): string {
  const chunks: string[] = [];
  for (const seg of segments) {
    if (!seg.text) continue;
    switch (seg.kind) {
      case "agent":
      case "user":
        chunks.push(seg.text);
        break;
      case "tool":
        chunks.push(`\n▸ ${seg.text}\n`);
        break;
      case "thought":
        chunks.push(`\n… ${seg.text}\n`);
        break;
      case "system":
        chunks.push(`\n# ${seg.text}\n`);
        break;
    }
  }
  return chunks.join("");
}
