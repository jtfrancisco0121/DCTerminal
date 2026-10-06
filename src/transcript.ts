import type { SessionUpdateEvent } from "./bridge";

export type TranscriptLine = {
  id: string;
  kind: "agent" | "tool" | "thought" | "system" | "other";
  label: string;
  text: string;
};

export const MAX_TRANSCRIPT_LINES = 400;

let lineSeq = 0;

function nextId(): string {
  lineSeq += 1;
  return `tl_${lineSeq}`;
}

function normalizeKind(kind: string): TranscriptLine["kind"] {
  const k = kind.replace(/_/g, "").toLowerCase();
  if (k.includes("agentmessage") || k === "text") return "agent";
  if (k.includes("tool")) return "tool";
  if (k.includes("thought")) return "thought";
  if (k.includes("plan") || k.includes("mode")) return "system";
  return "other";
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
    if (typeof obj.text === "string") return obj.text;
    if (obj.text !== undefined) return coerceDisplayText(obj.text);
    if (typeof obj.content === "string") return obj.content;
    if (obj.content !== undefined) return coerceDisplayText(obj.content);
    if (typeof obj.delta === "string") return obj.delta;
    if (obj.delta !== undefined) return coerceDisplayText(obj.delta);
  }
  return "";
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
  return "tool update";
}

export function sessionUpdateToLine(evt: SessionUpdateEvent): TranscriptLine {
  const kind = normalizeKind(evt.kind);
  const delta = coerceDisplayText(evt.textDelta);
  if (delta) {
    return {
      id: nextId(),
      kind: kind === "other" ? "agent" : kind,
      label: evt.kind,
      text: delta,
    };
  }

  try {
    const raw = JSON.parse(evt.rawJson) as Record<string, unknown>;
    const update = (raw.update as Record<string, unknown>) ?? raw;
    const innerKind = String(update.type ?? update.updateType ?? evt.kind);
    const nk = normalizeKind(innerKind);
    if (nk === "tool") {
      return {
        id: nextId(),
        kind: "tool",
        label: innerKind,
        text: toolSummary(update),
      };
    }
    const text =
      coerceDisplayText(update.text) ||
      coerceDisplayText(update.content) ||
      coerceDisplayText(update.chunk) ||
      JSON.stringify(update).slice(0, 200);
    return {
      id: nextId(),
      kind: nk,
      label: innerKind,
      text,
    };
  } catch {
    return {
      id: nextId(),
      kind: "other",
      label: evt.kind,
      text: evt.rawJson.slice(0, 160),
    };
  }
}

export function coalesceAgentLines(lines: TranscriptLine[]): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  for (const line of lines) {
    const prev = out[out.length - 1];
    if (
      line.kind === "agent" &&
      prev?.kind === "agent" &&
      prev.label === line.label
    ) {
      prev.text += line.text;
      continue;
    }
    out.push({ ...line });
  }
  return out.length > MAX_TRANSCRIPT_LINES
    ? out.slice(out.length - MAX_TRANSCRIPT_LINES)
    : out;
}
