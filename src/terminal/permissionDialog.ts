// Spots Claude Code's permission dialog ("Do you want to proceed?" + numbered
// Yes/No options) in the raw PTY byte stream. Background tabs don't feed
// xterm, so we can't read a rendered screen; instead we turn escape codes and
// cursor moves into rough plain lines and pattern-match those.
//
// Claude Code v2.1.287 draws the dialog with cursor moves rather than plain
// text: words are placed with CHA (`ESC[nG`), lines are stepped with
// `CR ESC[1B` or `CR CR LF`, indents use `ESC[nC`, and the bold file name in
// an edit question is wrapped in SGR. See fixtures/claude-2.1.287-*.bin.

export type DialogDetector = {
  /** Feed raw PTY bytes. */
  feed(id: string, bytes: Uint8Array, now?: number): void;
  /**
   * The user typed into this terminal. `kind` (default "key"): an `answer`
   * key (Enter, Esc, a digit) or a `press` (mouse click) may answer the
   * dialog. A click starts no hide timer: only a log read or a new draw
   * settles it.
   */
  input(id: string, now?: number, kind?: "answer" | "key" | "press"): void;
  isVisible(id: string, now?: number): boolean;
  /**
   * The visible dialog's text: the question and the lines above it (tool,
   * command, file). Tells one prompt from the next. "" when none is shown.
   */
  prompt(id: string): string;
  /** The user typed or clicked since the dialog was last drawn (it may be answered). */
  answering(id: string): boolean;
  /** The last full draw came after an answer key or click: maybe the next call's dialog. */
  drawnAfterAnswer(id: string): boolean;
  /**
   * Explicitly hide (e.g. the log's open tool was answered). `keepPartial`
   * keeps a question whose options have not arrived yet, so the next
   * dialog, half drawn at that moment, is still seen.
   */
  clear(id: string, opts?: { keepPartial?: boolean }): void;
  /** Drop all state for this id (process exited / tab closed). */
  forget(id: string): void;
  /**
   * Called with the id whenever isVisible(id) flips (including the debounce
   * expiring), and when a whole dialog is drawn again after user input.
   * Returns unsubscribe.
   */
  subscribe(listener: (id: string) => void): () => void;
};

type DetectorOptions = {
  debounceMs?: number;
  windowChars?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
};

const ESC = "\x1b";
/** Longest incomplete escape we carry to the next chunk before giving up on it. */
const MAX_PENDING = 4096;
/** Cap for a single cursor-forward expansion. */
const MAX_FORWARD = 256;
/** How many non-empty lines after the question the "1. Yes" option may sit. */
const OPTION_LINES = 12;

const QUESTION_RE = /Do you want to/;
const YES_RE = /^\s*([❯›>]\s*)?1\.\s*Yes/;
const NO_RE = /^\s*([❯›>]\s*)?\d+\.\s*No\b/;

/** Normalize raw terminal text (escape codes, cursor moves, frames) to plain lines. */
export function normalizeTerminalText(raw: string): string {
  let s = raw;
  // OSC (title etc.), terminated by BEL or ST.
  s = s.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "");
  // DCS / SOS / PM / APC strings, terminated by ST.
  s = s.replace(/\x1b[PX^_][\s\S]*?\x1b\\/g, "");
  // CSI sequences.
  s = s.replace(
    /\x1b\[([0-?]*)([ -/]*)([@-~])/g,
    (_m, params: string, inter: string, final: string) => {
      if (inter || /^[<=>?]/.test(params)) return ""; // private / intermediates
      const n = parseInt(params, 10);
      switch (final) {
        case "C": // cursor forward
          return " ".repeat(Math.min(Math.max(Number.isNaN(n) ? 1 : n, 1), MAX_FORWARD));
        case "G": // cursor horizontal absolute: Claude Code places words with it
        case "`":
          return " ";
        case "A": // cursor up / down / next line / previous line
        case "B":
        case "E":
        case "F":
        case "d": // vertical position absolute
        case "H": // cursor position
        case "f":
          return "\n";
        default: // SGR, erase (K/J), cursor back, scroll region, queries...
          return "";
      }
    },
  );
  // Remaining two/three-char escapes (ESC 7, ESC 8, ESC ( B, ESC =, ...).
  s = s.replace(/\x1b[ -/]*[0-~]/g, "");
  s = s.replace(/\x1b/g, "");
  // Line breaks.
  s = s.replace(/\r\n|\r|\n/g, "\n");
  s = s.replace(/\t/g, " ");
  // Other C0 / C1 controls.
  s = s.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "");
  // Box drawing, block elements and similar frame chars, NBSP.
  s = s.replace(/[\u2500-\u259f\u00a0\u23bf]/g, " ");
  return s;
}

function plainLines(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const t = line.replace(/\s+/g, " ").trim();
    if (t) out.push(t);
  }
  return out;
}

/** "1. Yes" followed (within a few lines) by "N. No", starting at line `from`. */
function optionsFrom(lines: string[], from: number, limit: number): boolean {
  const end = Math.min(lines.length, from + limit);
  for (let j = from; j < end; j++) {
    if (!YES_RE.test(lines[j])) continue;
    const stop = Math.min(lines.length, j + 1 + OPTION_LINES);
    for (let k = j + 1; k < stop; k++) {
      if (NO_RE.test(lines[k])) return true;
    }
  }
  return false;
}

/** Lines above the question kept as the prompt's text (tool, command, file). */
const PROMPT_LINES = 10;

/** The newest permission dialog in this normalized text: its question and the lines above. */
export function findPermissionDialog(text: string): string | null {
  if (!QUESTION_RE.test(text)) return null;
  const lines = plainLines(text);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (QUESTION_RE.test(lines[i]) && optionsFrom(lines, i + 1, OPTION_LINES)) {
      return lines.slice(Math.max(0, i - PROMPT_LINES), i + 1).join("\n");
    }
  }
  return null;
}

/** Does this normalized text contain the permission dialog? */
export function matchPermissionDialog(text: string): boolean {
  return findPermissionDialog(text) !== null;
}

/**
 * The newest question and the lines above it (tool, command, file), up to
 * an earlier dialog's question or "No" option. "" without a question.
 */
function partialDialog(window: string): string {
  const at = window.lastIndexOf("Do you want to");
  if (at < 0) return "";
  const above = window.slice(0, at).split("\n");
  // The question's own line starts mid-way in the last element.
  const kept: string[] = [above.pop() ?? ""];
  let lines = 0;
  while (above.length > 0 && lines < PROMPT_LINES) {
    const line = above.pop() ?? "";
    if (QUESTION_RE.test(line) || NO_RE.test(line)) break;
    kept.unshift(line);
    if (line.trim()) lines += 1;
  }
  return kept.join("\n") + window.slice(at);
}

/** Just the option list ("1. Yes" ... "N. No"), e.g. a redraw after an arrow key. */
function matchOptionList(text: string): boolean {
  if (!/Yes/.test(text)) return false;
  const lines = plainLines(text);
  return optionsFrom(lines, 0, lines.length);
}

/** Split off a trailing escape sequence that isn't complete yet. */
function splitIncompleteEscape(s: string): [string, string] {
  const i = s.lastIndexOf(ESC);
  if (i < 0) return [s, ""];
  const tail = s.slice(i);
  if (tail.length > MAX_PENDING) return [s, ""];
  let incomplete: boolean;
  if (tail.length === 1) incomplete = true;
  else {
    const c = tail[1];
    if (c === "[") incomplete = /^\x1b\[[0-?]*[ -/]*$/.test(tail);
    else if (c === "]") incomplete = !tail.includes("\x07");
    else if (c === "P" || c === "X" || c === "^" || c === "_") incomplete = true; // no ST after last ESC
    else incomplete = /^\x1b[ -/]+$/.test(tail);
  }
  return incomplete ? [s.slice(0, i), tail] : [s, ""];
}

type TermState = {
  decoder: TextDecoder;
  pending: string;
  window: string;
  visible: boolean;
  /** Text of the dialog last drawn in full. */
  prompt: string;
  /** A click since the last full draw (no hide timer for those). */
  pressed: boolean;
  /** An answer key or click since the last full draw. */
  answered: boolean;
  /** The last full draw followed an answer key or click. */
  drawAfterAnswer: boolean;
  /** When the hide debounce expires (set by input while visible). */
  hideAt: number | null;
  timer: unknown;
  hasTimer: boolean;
};

export function createDialogDetector(opts: DetectorOptions = {}): DialogDetector {
  const debounceMs = opts.debounceMs ?? 3000;
  const windowChars = opts.windowChars ?? 16384;
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer =
    opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const states = new Map<string, TermState>();
  const listeners = new Set<(id: string) => void>();

  const ignored = (id: string) => id.includes("::");

  const notify = (id: string) => {
    for (const l of [...listeners]) {
      try {
        l(id);
      } catch (e) {
        console.error("permission dialog listener failed", e);
      }
    }
  };

  const state = (id: string): TermState => {
    let s = states.get(id);
    if (!s) {
      s = {
        decoder: new TextDecoder("utf-8"),
        pending: "",
        window: "",
        visible: false,
        prompt: "",
        pressed: false,
        answered: false,
        drawAfterAnswer: false,
        hideAt: null,
        timer: undefined,
        hasTimer: false,
      };
      states.set(id, s);
    }
    return s;
  };

  const cancelHide = (s: TermState) => {
    if (s.hasTimer) clearTimer(s.timer);
    s.hasTimer = false;
    s.timer = undefined;
    s.hideAt = null;
  };

  const hide = (id: string, s: TermState) => {
    cancelHide(s);
    s.window = "";
    s.prompt = "";
    s.pressed = false;
    s.answered = false;
    s.drawAfterAnswer = false;
    if (s.visible) {
      s.visible = false;
      notify(id);
    }
  };

  return {
    feed(id, bytes) {
      if (ignored(id)) return;
      const s = state(id);
      const decoded = s.pending + s.decoder.decode(bytes, { stream: true });
      const [complete, rest] = splitIncompleteEscape(decoded);
      s.pending = rest;
      if (!complete) return;
      s.window += normalizeTerminalText(complete);
      if (s.window.length > windowChars) s.window = s.window.slice(-windowChars);
      const found = findPermissionDialog(s.window);
      const full = found !== null;
      if (!full && !(s.visible && matchOptionList(s.window))) return;
      // A whole question drawn after input may be the next tool's dialog.
      const redrawn = full && s.visible && (s.hideAt !== null || s.pressed);
      if (found !== null) {
        s.prompt = found;
        if (redrawn || !s.visible) s.drawAfterAnswer = s.answered;
        s.answered = false;
        s.pressed = false;
      }
      // A fresh draw after the last input: the dialog is still up.
      cancelHide(s);
      if (!s.visible) {
        s.visible = true;
        notify(id);
      } else if (redrawn) {
        notify(id);
      }
    },

    input(id, now, kind = "key") {
      if (ignored(id)) return;
      const s = states.get(id);
      if (!s) return;
      // Stale dialog text from before the answer must not re-match.
      s.window = "";
      if (!s.visible) return;
      if (kind !== "key") s.answered = true;
      if (kind === "press") {
        s.pressed = true;
        return;
      }
      cancelHide(s);
      s.hideAt = (now ?? Date.now()) + debounceMs;
      s.hasTimer = true;
      s.timer = setTimer(() => {
        if (states.get(id) !== s || !s.hasTimer) return;
        s.hasTimer = false;
        s.timer = undefined;
        s.hideAt = null;
        if (s.visible) {
          s.visible = false;
          s.prompt = "";
          s.pressed = false;
          s.answered = false;
          notify(id);
        }
      }, debounceMs);
    },

    isVisible(id, now) {
      const s = states.get(id);
      if (!s || !s.visible) return false;
      if (s.hideAt !== null && (now ?? Date.now()) >= s.hideAt) return false;
      return true;
    },

    prompt(id) {
      const s = states.get(id);
      return s?.visible ? s.prompt : "";
    },

    answering(id) {
      const s = states.get(id);
      return !!s?.visible && (s.hideAt !== null || s.pressed);
    },

    drawnAfterAnswer(id) {
      const s = states.get(id);
      return !!s?.visible && s.drawAfterAnswer;
    },

    clear(id, opts) {
      const s = states.get(id);
      if (!s) return;
      const partial = opts?.keepPartial ? partialDialog(s.window) : "";
      hide(id, s);
      // A whole dialog left here is the answered one: never keep that.
      if (partial && !matchPermissionDialog(partial)) s.window = partial;
    },

    forget(id) {
      const s = states.get(id);
      if (!s) return;
      cancelHide(s);
      states.delete(id);
      if (s.visible) notify(id);
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** App-wide detector instance. */
export const dialogDetector: DialogDetector = createDialogDetector();
