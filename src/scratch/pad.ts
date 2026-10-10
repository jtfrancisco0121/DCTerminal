/**
 * Scratch pad rules: transfer, `---` chaining, history, and crash-safe drafts.
 * Persistence I/O lives behind these pure functions so it can be tested
 * without Tauri.
 */

export const SCRATCH_DEBOUNCE_MS = 500;
export const HISTORY_LIMIT = 50;
/** Hard cap so a multi-megabyte paste cannot freeze the editor or the store. */
export const MAX_PAD_CHARS = 1_000_000;
export const LOCAL_DRAFT_KEY = "dcterminal.scratch.v1";

export type PadRecord = {
  content: string;
  updatedAt: number;
  history: string[];
};

export type DraftFile = {
  pads: Record<string, PadRecord>;
};

export type ChainPhase = "ready" | "inFlight" | "paused" | "done" | "stopped";

export type ChainCursor = {
  steps: string[];
  /** Index of the next step to send. The in-flight step is `nextIndex - 1`. */
  nextIndex: number;
  phase: ChainPhase;
  reason?: string;
};

export type TurnOutcome = "completed" | "error" | "cancelled";

export function clampPad(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_PAD_CHARS) {
    return { text, truncated: false };
  }
  return { text: text.slice(0, MAX_PAD_CHARS), truncated: true };
}

/**
 * Move the selection, or the whole pad when nothing is selected, into the
 * composer. A non-empty composer gets a blank-line separator. The pad itself
 * is kept (blueprint FR-053).
 */
export function transferToInput(
  input: string,
  pad: string,
  selection: string | null,
): string {
  const chunk = (selection && selection.length > 0 ? selection : pad).replace(
    /\s+$/,
    "",
  );
  if (!chunk.trim()) return input;
  if (!input.trim()) return chunk;
  return `${input.replace(/\s+$/, "")}\n\n${chunk}`;
}

/** The part of the pad that was sent: the selection when there is one. */
export type PadRange = { start: number; end: number } | null;

/** The selection of a pad editor, or null when nothing is selected. */
export function padSelection(field: HTMLTextAreaElement | null): PadRange {
  if (!field || field.selectionStart === field.selectionEnd) return null;
  return { start: field.selectionStart, end: field.selectionEnd };
}

/**
 * The pad after a send. Sending a selection cuts just that text out
 * (and the blank line it leaves); sending the whole pad empties it.
 */
export function padAfterSend(pad: string, sent: PadRange): string {
  if (!sent || sent.start >= sent.end) return "";
  const rawLeft = pad.slice(0, sent.start);
  const rawRight = pad.slice(sent.end);
  const wholeLines =
    rawLeft === "" || rawRight === "" || /\n[ \t]*$/.test(rawLeft) || /^[ \t]*\n/.test(rawRight);
  // Cut inside a line: just remove the text.
  if (!wholeLines) return rawLeft + rawRight;
  const left = rawLeft.replace(/\s+$/, "");
  const right = rawRight.replace(/^\s+/, "");
  if (!left) return right;
  if (!right) return left;
  // Keep one blank line where there was one, otherwise a plain line break.
  const blank = /\n[ \t]*\n\s*$/.test(rawLeft) || /^\s*\n[ \t]*\n/.test(rawRight);
  return `${left}${blank ? "\n\n" : "\n"}${right}`;
}

/** Split on lines that are only `---` (three or more dashes). */
export function splitChainSteps(pad: string): string[] {
  const steps: string[] = [];
  let buffer: string[] = [];
  const flush = () => {
    const text = buffer.join("\n").trim();
    if (text) steps.push(text);
    buffer = [];
  };
  for (const line of pad.split(/\r?\n/)) {
    if (/^\s*-{3,}\s*$/.test(line)) flush();
    else buffer.push(line);
  }
  flush();
  return steps;
}

export function chainStart(pad: string): ChainCursor | null {
  const steps = splitChainSteps(pad);
  if (steps.length === 0) return null;
  return { steps, nextIndex: 0, phase: "ready" };
}

export function chainStepToSend(cursor: ChainCursor): string | null {
  if (cursor.phase !== "ready") return null;
  return cursor.steps[cursor.nextIndex] ?? null;
}

export function chainMarkSent(cursor: ChainCursor): ChainCursor {
  if (cursor.phase !== "ready") return cursor;
  if (cursor.nextIndex >= cursor.steps.length) {
    return { ...cursor, phase: "done" };
  }
  return { ...cursor, nextIndex: cursor.nextIndex + 1, phase: "inFlight" };
}

/**
 * A permission (or any blocking agent request) means the turn has not ended.
 * The next `---` step must not be sent until that request settles.
 */
export function chainMarkBlocked(cursor: ChainCursor): ChainCursor {
  if (cursor.phase !== "inFlight") return cursor;
  return { ...cursor, phase: "paused", reason: "permission" };
}

export function chainMarkSettled(
  cursor: ChainCursor,
  outcome: TurnOutcome,
): ChainCursor {
  if (cursor.phase !== "inFlight" && cursor.phase !== "paused") return cursor;
  if (outcome === "cancelled") {
    return { ...cursor, phase: "stopped", reason: "cancelled" };
  }
  if (outcome === "error") {
    return { ...cursor, phase: "stopped", reason: "error" };
  }
  if (cursor.nextIndex >= cursor.steps.length) {
    return { ...cursor, phase: "done" };
  }
  return { ...cursor, phase: "ready" };
}

export function chainStop(cursor: ChainCursor): ChainCursor {
  if (cursor.phase === "done" || cursor.phase === "stopped") return cursor;
  return { ...cursor, phase: "stopped", reason: "cancelled" };
}

export function classifyTurn(evt: {
  success: boolean;
  stopReason?: string | null;
  error?: string | null;
}): TurnOutcome {
  const reason = (evt.stopReason ?? "").toLowerCase();
  const error = (evt.error ?? "").toLowerCase();
  if (reason.includes("cancel") || error.includes("cancel")) return "cancelled";
  if (!evt.success) return "error";
  if (
    reason.includes("error") ||
    reason.includes("fail") ||
    reason.includes("refusal")
  ) {
    return "error";
  }
  return "completed";
}

export function pushHistory(history: string[], prompt: string): string[] {
  const text = prompt.trim();
  if (!text) return history;
  const withoutDup = history.filter((item) => item !== text);
  return [text, ...withoutDup].slice(0, HISTORY_LIMIT);
}

/**
 * ArrowUp / ArrowDown history. Only moves when the caret is at the start
 * (older) or the draft is the one history inserted (newer), so multiline
 * editing keeps the arrow keys.
 */
export function historyNavigate(opts: {
  history: string[];
  cursor: number;
  direction: "older" | "newer";
  draft: string;
  caretAtStart: boolean;
}): { cursor: number; text: string; handled: boolean } {
  const { history, direction, draft, caretAtStart } = opts;
  if (history.length === 0) {
    return { cursor: opts.cursor, text: draft, handled: false };
  }
  if (direction === "older") {
    // Multiline drafts keep ArrowUp for caret movement until the caret is at the start.
    if (!caretAtStart) {
      return { cursor: opts.cursor, text: draft, handled: false };
    }
    const next = Math.min(opts.cursor + 1, history.length - 1);
    if (opts.cursor >= 0 && opts.cursor >= history.length - 1) {
      return {
        cursor: opts.cursor,
        text: history[opts.cursor] ?? draft,
        handled: true,
      };
    }
    return { cursor: next, text: history[next] ?? draft, handled: true };
  }
  if (opts.cursor < 0) {
    return { cursor: opts.cursor, text: draft, handled: false };
  }
  const next = opts.cursor - 1;
  if (next < 0) {
    return { cursor: -1, text: "", handled: true };
  }
  return { cursor: next, text: history[next] ?? draft, handled: true };
}

export function emptyDraftFile(): DraftFile {
  return { pads: {} };
}

export function readDraftBlob(raw: string | null): DraftFile | null {
  if (!raw || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as DraftFile;
    if (!parsed || typeof parsed !== "object" || !parsed.pads) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Newer `updatedAt` wins so a crash between disk flushes keeps the local draft. */
export function mergePads(
  local: PadRecord | null | undefined,
  disk: PadRecord | null | undefined,
): PadRecord | null {
  if (!local && !disk) return null;
  if (!local) return disk ?? null;
  if (!disk) return local;
  return local.updatedAt >= disk.updatedAt ? local : disk;
}

export function mergeDraftFiles(local: DraftFile | null, disk: DraftFile | null): DraftFile {
  const ids = new Set<string>([
    ...Object.keys(local?.pads ?? {}),
    ...Object.keys(disk?.pads ?? {}),
  ]);
  const pads: Record<string, PadRecord> = {};
  for (const id of ids) {
    const merged = mergePads(local?.pads[id], disk?.pads[id]);
    if (merged) pads[id] = merged;
  }
  return { pads };
}

/** Drop mirrored pads whose tab is neither open nor closed, so the WebView
 * copy cannot resurrect a deleted tab's draft into scratch.json. `null`
 * known ids (backend did not say) keeps everything. */
export function dropUnknownLocalPads(
  local: DraftFile | null,
  knownTabIds: readonly string[] | null | undefined,
): DraftFile | null {
  if (!local || !knownTabIds) return local;
  const known = new Set(knownTabIds);
  const pads: Record<string, PadRecord> = {};
  for (const [id, pad] of Object.entries(local.pads)) {
    if (known.has(id)) pads[id] = pad;
  }
  return { pads };
}

export type DraftStorage = {
  read(key: string): string | null;
  write(key: string, value: string): void;
};

export function loadLocalDrafts(storage: DraftStorage): DraftFile | null {
  try {
    return readDraftBlob(storage.read(LOCAL_DRAFT_KEY));
  } catch {
    return null;
  }
}

export function saveLocalDrafts(
  storage: DraftStorage,
  file: DraftFile,
): { ok: boolean; error?: string } {
  try {
    storage.write(LOCAL_DRAFT_KEY, JSON.stringify(file));
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message || "could not write scratch draft" };
  }
}

export function upsertPad(
  file: DraftFile,
  tabId: string,
  content: string,
  now: number,
): { file: DraftFile; truncated: boolean } {
  const clamped = clampPad(content);
  const prev = file.pads[tabId];
  return {
    truncated: clamped.truncated,
    file: {
      pads: {
        ...file.pads,
        [tabId]: {
          content: clamped.text,
          updatedAt: now,
          history: prev?.history ?? [],
        },
      },
    },
  };
}

export function rememberPrompt(
  file: DraftFile,
  tabId: string,
  prompt: string,
  now: number,
): DraftFile {
  const prev = file.pads[tabId] ?? { content: "", updatedAt: now, history: [] };
  return {
    pads: {
      ...file.pads,
      [tabId]: {
        ...prev,
        updatedAt: now,
        history: pushHistory(prev.history, prompt),
      },
    },
  };
}
