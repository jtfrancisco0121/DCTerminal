/**
 * Every keystroke the chat view of a Claude terminal tab sends to its PTY:
 * a composer message, Stop (Esc) and a permission answer (the option's
 * digit). One place, so each write is noted as user input (busy tracking and
 * the permission dialog detector see it) the same way the terminal notes it.
 */
import { ptyWrite } from "../bridge";
import { notePtyInput } from "./live";
import { encodeTerminalPaste } from "./paste";
import { dialogDetector, type DialogDetector, type DialogOption } from "./permissionDialog";
import { reportError } from "../uiErrors";

export type PtyAnswerDeps = {
  write: (tabId: string, data: string) => Promise<void>;
  /** Note user input; `data` as the terminal would (absent: a paste ending in Enter). */
  note: (tabId: string, data?: string) => void;
  detector: Pick<DialogDetector, "isVisible" | "prompt" | "subscribe" | "hiddenUnconfirmed">;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
};

const defaultDeps: PtyAnswerDeps = {
  write: ptyWrite,
  note: notePtyInput,
  detector: dialogDetector,
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Esc: Claude Code stops the running turn. */
export const STOP_KEY = "\x1b";

/**
 * A composer message as one bracketed paste and one Enter, like the scratch
 * pad's Send. Always bracketed: Claude Code turns bracketed paste on when it
 * starts, but the parked xterm only tracks that mode while it is on screen,
 * and the chat view keeps it off screen. Null for blank text.
 */
export function composerPayload(text: string): string | null {
  if (!text.trim()) return null;
  return encodeTerminalPaste(text, { bracketedPaste: true, submit: true });
}

/** Sends a composer message. False when there was nothing to send. */
export async function sendComposerText(
  tabId: string,
  text: string,
  deps: Pick<PtyAnswerDeps, "write" | "note"> = defaultDeps,
): Promise<boolean> {
  const payload = composerPayload(text);
  if (payload === null) return false;
  deps.note(tabId);
  await deps.write(tabId, payload);
  return true;
}

/** Stop: Esc interrupts the running turn. */
export async function stopTurn(
  tabId: string,
  deps: Pick<PtyAnswerDeps, "write" | "note"> = defaultDeps,
): Promise<void> {
  deps.note(tabId, STOP_KEY);
  await deps.write(tabId, STOP_KEY);
}

/** The header's Stop button: a user action, so a failed write is shown. */
export async function pressStop(
  tabId: string,
  deps: Pick<PtyAnswerDeps, "write" | "note"> = defaultDeps,
): Promise<void> {
  try {
    await stopTurn(tabId, deps);
  } catch (err) {
    reportError("Could not stop the turn", err, { notify: true });
  }
}

/** The key that picks a permission option: its single digit, else null. */
export function permissionKey(option: DialogOption): string | null {
  return /^[1-9]$/.test(option.key) ? option.key : null;
}

/**
 * How long to wait for the dialog to go. The detector hides a dialog 3 s
 * after an answer key unless Claude Code draws it again, so a shorter wait
 * could not tell a closed dialog from one still up.
 */
export const ANSWER_CONFIRM_MS = 3500;

export type AnswerResult = "closed" | "stuck" | "unconfirmed";

/**
 * Presses `option`'s digit, then watches the detector: "closed" once the
 * dialog is gone (or another dialog replaced it), "stuck" when the same
 * dialog is still up after `ANSWER_CONFIRM_MS`, "unconfirmed" when it went
 * only by the detector's timer with no PTY output since the key (Claude Code
 * may have ignored it and drawn nothing). Rejects when the write fails.
 */
export async function answerPermission(
  tabId: string,
  option: DialogOption,
  deps: PtyAnswerDeps = defaultDeps,
  confirmMs = ANSWER_CONFIRM_MS,
): Promise<AnswerResult> {
  const key = permissionKey(option);
  if (key === null) throw new Error(`Option "${option.label}" has no number key.`);
  const before = deps.detector.prompt(tabId);
  deps.note(tabId, key);
  await deps.write(tabId, key);
  const gone = () => !deps.detector.isVisible(tabId) || deps.detector.prompt(tabId) !== before;
  const outcome = (): AnswerResult =>
    !deps.detector.isVisible(tabId) && deps.detector.hiddenUnconfirmed(tabId) ? "unconfirmed" : "closed";
  if (gone()) return outcome();
  return new Promise<AnswerResult>((resolve) => {
    let settled = false;
    const finish = (result: AnswerResult) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      deps.clearTimer(timer);
      resolve(result);
    };
    const unsubscribe = deps.detector.subscribe((id) => {
      if (id === tabId && gone()) finish(outcome());
    });
    const timer = deps.setTimer(() => finish(gone() ? outcome() : "stuck"), confirmMs);
  });
}
