import type { SessionUpdateEvent } from "./bridge";

export type TranscriptLine = {
  id: string;
  kind: "agent" | "tool" | "thought" | "system" | "other";
  label: string;
  text: string;
};

export type StreamSegmentKind = "agent" | "user" | "tool" | "thought" | "system";

export type ToolStatus =
  | "pending"
  | "in_progress"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

export type StreamSegment = {
  id: string;
  kind: StreamSegmentKind;
  text: string;
  /** Upsert key for `tool` segments (ACP tool call id or stable fallback). */
  toolKey?: string;
  toolStatus?: ToolStatus;
};

const TOOL_STATUS_LINE =
  /^(.*)\s+\((pending|in_progress|running|completed|failed|cancelled)\)\s*$/i;

export function normalizeToolStatus(raw: string | undefined): ToolStatus {
  if (!raw) return "unknown";
  const s = raw.toLowerCase().replace(/-/g, "_");
  if (s === "pending") return "pending";
  if (s === "in_progress" || s === "running") return "in_progress";
  if (s === "completed" || s === "complete" || s === "success") return "completed";
  if (s === "failed" || s === "error") return "failed";
  if (s === "cancelled" || s === "canceled") return "cancelled";
  return "unknown";
}

export function isActiveToolStatus(status?: ToolStatus): boolean {
  return (
    status === "pending" ||
    status === "in_progress" ||
    status === "running"
  );
}

export function parseToolStatusFromLabel(text: string): ToolStatus | undefined {
  const m = text.match(TOOL_STATUS_LINE);
  if (!m) return undefined;
  return normalizeToolStatus(m[2]);
}

export function toolLabelWithoutStatus(text: string): string {
  const m = text.match(TOOL_STATUS_LINE);
  if (m) return m[1].trim();
  return text.trim();
}

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

function toolArgumentsHint(
  source: Record<string, unknown> | undefined,
): string | undefined {
  if (!source) return undefined;
  const args =
    source.arguments ??
    source.args ??
    source.input ??
    source.parameters;
  if (!args || typeof args !== "object") return undefined;
  const argsObj = args as Record<string, unknown>;
  for (const key of [
    "path",
    "filePath",
    "file_path",
    "target",
    "command",
    "pattern",
    "query",
    "glob",
  ]) {
    const v = argsObj[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function toolNameFromUpdate(raw: Record<string, unknown>): string | undefined {
  const toolCall = raw.toolCall as Record<string, unknown> | undefined;

  for (const key of ["title", "displayTitle"] as const) {
    const t = (raw[key] as string) || (toolCall?.[key] as string);
    if (t?.trim()) return t.trim();
  }

  const name =
    (raw.toolName as string) ||
    (raw.name as string) ||
    (toolCall?.name as string) ||
    (toolCall?.toolName as string) ||
    (toolCall?.kind as string) ||
    ((raw.tool as Record<string, unknown>)?.name as string);

  if (name?.trim()) {
    const detail = toolArgumentsHint(toolCall ?? raw);
    return detail ? `${name.trim()} — ${detail}` : name.trim();
  }
  return undefined;
}

function toolStatusFromUpdate(raw: Record<string, unknown>): ToolStatus {
  const status =
    (raw.status as string) ||
    ((raw.toolCall as Record<string, unknown>)?.status as string);
  return normalizeToolStatus(status);
}

function toolKeyFromUpdate(raw: Record<string, unknown>, label: string): string {
  const toolCall = raw.toolCall as Record<string, unknown> | undefined;
  const candidates = [
    raw.toolCallId,
    raw.tool_call_id,
    raw.callId,
    toolCall?.toolCallId,
    toolCall?.id,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) {
      return `id:${c.trim()}`;
    }
    if (typeof c === "number") return `id:${c}`;
  }
  if (label && label !== "tool") return `label:${label}`;
  return `label:${label || "tool"}`;
}

function toolSummary(raw: Record<string, unknown>): string {
  const name = toolNameFromUpdate(raw);
  const status = toolStatusFromUpdate(raw);
  if (name && status !== "unknown") return `${name} (${status})`;
  if (name) return name;
  return "tool";
}

function parseUpdateObject(evt: SessionUpdateEvent): Record<string, unknown> | null {
  try {
    const raw = JSON.parse(evt.rawJson) as Record<string, unknown>;
    return (raw.update as Record<string, unknown>) ?? raw;
  } catch {
    return null;
  }
}

function preferToolLabel(existing: string, incoming: string): string {
  if (isGenericToolLabel(incoming) && !isGenericToolLabel(existing)) {
    return existing;
  }
  if (isGenericToolLabel(existing) && !isGenericToolLabel(incoming)) {
    return incoming;
  }
  return incoming.length >= existing.length ? incoming : existing;
}

function isGenericToolLabel(text: string): boolean {
  const t = text.trim().toLowerCase();
  return t === "tool" || t.startsWith("tool (");
}

function resolveToolDisplayText(
  evt: SessionUpdateEvent,
  update: Record<string, unknown> | null,
): string {
  const fromRaw = update ? toolSummary(update) : parseRawEventText(evt);
  const fromDelta = coerceDisplayText(evt.textDelta);
  if (fromDelta && !isGenericToolLabel(fromDelta)) {
    return fromDelta;
  }
  if (fromRaw && fromRaw !== "tool") return fromRaw;
  return fromDelta || fromRaw || "tool";
}

function enrichToolSegment(
  seg: StreamSegment,
  update: Record<string, unknown> | null,
): StreamSegment {
  const status =
    (update ? toolStatusFromUpdate(update) : undefined) ??
    parseToolStatusFromLabel(seg.text) ??
    "unknown";
  const label = toolLabelWithoutStatus(seg.text);
  const display =
    label && label !== "tool" ? label : toolNameFromUpdate(update ?? {}) ?? label;
  const toolKey = update
    ? toolKeyFromUpdate(update, display || label)
    : `label:${display || label || "tool"}`;
  return {
    ...seg,
    text: display || label || seg.text,
    toolKey,
    toolStatus: status,
  };
}

/** Drop tool-status lines agents often mirror into thought chunks. */
function stripToolStatusLinesFromThought(text: string): string {
  const lines = text.split("\n");
  const kept = lines.filter((line) => !TOOL_STATUS_LINE.test(line.trim()));
  const joined = kept.join("\n");
  return joined.trim() ? joined : "";
}

export function streamSegmentFromEvent(
  evt: SessionUpdateEvent,
): StreamSegment | null {
  const kind = mapEventKind(evt.kind);
  const update = parseUpdateObject(evt);
  let text =
    kind === "tool"
      ? resolveToolDisplayText(evt, update)
      : coerceDisplayText(evt.textDelta) || parseRawEventText(evt);
  if (!text) return null;
  if (kind === "thought") {
    text = stripToolStatusLinesFromThought(text);
    if (!text) return null;
  }
  const base: StreamSegment = { id: nextId(), kind, text };
  if (kind === "tool") {
    return enrichToolSegment(base, update);
  }
  return base;
}

export function appendStreamSegment(
  segments: StreamSegment[],
  seg: StreamSegment,
): StreamSegment[] {
  if (seg.kind === "tool" && seg.toolKey) {
    const idx = segments.findIndex(
      (s) => s.kind === "tool" && s.toolKey === seg.toolKey,
    );
    const nextSeg = {
      ...seg,
      id: idx >= 0 ? segments[idx].id : seg.id,
      // Keep the best label we have seen for this tool call.
      text: trimStreamChars(
        idx >= 0
          ? preferToolLabel(segments[idx].text, seg.text)
          : seg.text,
      ),
      toolStatus: seg.toolStatus ?? segments[idx]?.toolStatus,
    };
    if (idx >= 0) {
      const copy = [...segments];
      copy[idx] = nextSeg;
      return copy;
    }
    return [...segments, nextSeg];
  }

  if (seg.kind === "thought") {
    let thoughtIdx = -1;
    for (let i = segments.length - 1; i >= 0; i -= 1) {
      if (segments[i].kind === "thought") {
        thoughtIdx = i;
        break;
      }
    }
    if (thoughtIdx >= 0) {
      const prev = segments[thoughtIdx];
      let mergedText = stripToolStatusLinesFromThought(prev.text + seg.text);
      if (!mergedText.trim()) return segments;
      const merged = {
        ...prev,
        text: trimStreamChars(mergedText),
      };
      const copy = [...segments];
      copy[thoughtIdx] = merged;
      return copy;
    }
  }

  const prev = segments[segments.length - 1];
  if (
    seg.kind === "user" &&
    prev?.kind === "user" &&
    prev.text.trim() === seg.text.trim()
  ) {
    return segments;
  }
  const mergeable =
    seg.kind === "agent" || seg.kind === "user" || seg.kind === "thought";
  if (prev && prev.kind === seg.kind && mergeable) {
    let mergedText = prev.text + seg.text;
    if (seg.kind === "thought") {
      mergedText = stripToolStatusLinesFromThought(mergedText);
    }
    if (!mergedText.trim()) {
      return segments.slice(0, -1);
    }
    const merged = {
      ...prev,
      text: trimStreamChars(mergedText),
    };
    return [...segments.slice(0, -1), merged];
  }
  const trimmed =
    seg.kind === "thought"
      ? stripToolStatusLinesFromThought(seg.text)
      : seg.text;
  if (!trimmed.trim()) return segments;
  return [...segments, { ...seg, text: trimStreamChars(trimmed) }];
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

/** Local echo of what the user sent via `session/prompt` (ACP may not stream it back). */
export function streamSegmentFromUserMessage(text: string): StreamSegment {
  const trimmed = text.trim();
  return { id: nextId(), kind: "user", text: trimmed };
}

/** When a turn ends, stop showing tools as still running. */
export function finalizeInFlightTools(
  segments: StreamSegment[],
  finalStatus: "completed" | "cancelled" = "completed",
): StreamSegment[] {
  return segments.map((seg) => {
    if (seg.kind !== "tool" || !isActiveToolStatus(seg.toolStatus)) {
      return seg;
    }
    return { ...seg, toolStatus: finalStatus };
  });
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
        chunks.push(seg.text);
        break;
      case "user":
        chunks.push(`\nYou › ${seg.text}\n`);
        break;
      case "tool": {
        const status =
          seg.toolStatus && seg.toolStatus !== "unknown"
            ? ` (${seg.toolStatus})`
            : "";
        chunks.push(`\n▸ ${seg.text}${status}\n`);
        break;
      }
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
