import type { SessionUpdateEvent } from "./bridge";

export type TranscriptLine = {
  id: string;
  kind: "agent" | "tool" | "thought" | "system" | "other";
  label: string;
  text: string;
};

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
  if (evt.textDelta) {
    return {
      id: nextId(),
      kind: kind === "other" ? "agent" : kind,
      label: evt.kind,
      text: evt.textDelta,
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
      (update.text as string) ||
      (update.content as string) ||
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
  return out;
}
