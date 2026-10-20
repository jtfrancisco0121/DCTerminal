/**
 * One PTY channel per terminal id. Bytes are buffered until xterm attaches,
 * so a late mount (or a StrictMode remount) does not drop the first output
 * or start a second process.
 */

import type { Channel } from "@tauri-apps/api/core";
import { createPtyChannel, type PtyPacket } from "../bridge";
import { createPtyBuffer, decodeBase64, type PtyBuffer } from "./buffer";
import { isUserInput, ptyInputKind, terminalActivity } from "./activity";
import { dialogDetector } from "./permissionDialog";

export type LivePty = {
  id: string;
  buffer: PtyBuffer;
  channel: Channel<PtyPacket>;
  /** When this process started: entries older than it belong to a dead one. */
  startedAt: number;
  /**
   * When the tab's run first started, kept across Restart and Resume: plan
   * files written since then still count as this tab's.
   */
  planSince: number;
  exitCode: number | null;
  /** The process exited (its code can be null after a signal). */
  exited: boolean;
};

const sessions = new Map<string, LivePty>();
const opening = new Set<string>();
const listeners = new Set<() => void>();
const exitListeners = new Set<(id: string, code: number) => void>();
/** Bumped on every change listeners hear about (a snapshot for React). */
let version = 0;

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/** Changes whenever a PTY starts, is rekeyed or exits. */
export function livePtyVersion(): number {
  return version;
}

export function subscribeLivePty(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Called once per process exit with the terminal id and exit code. */
export function subscribePtyExit(listener: (id: string, code: number) => void): () => void {
  exitListeners.add(listener);
  return () => exitListeners.delete(listener);
}

/**
 * Keystrokes or pasted text the user sent to a terminal. Every write that
 * comes from the user goes through here so busy tracking and the permission
 * dialog detector both see it.
 */
export function notePtyInput(id: string, data?: string): void {
  if (data !== undefined && !isUserInput(data)) return;
  terminalActivity.input(id);
  // Without data it is a pad send or hand-off paste, which ends with Enter.
  const kind = data === undefined ? "answer" : ptyInputKind(data);
  if (kind !== "pointer") dialogDetector.input(id, undefined, kind);
  if (kind === "answer") for (const listener of answerListeners) listener(id);
}

const answerListeners = new Set<(id: string) => void>();

/**
 * Called with the terminal id for each user key that may answer a
 * permission dialog (Enter, Esc, a digit; a pad send). Returns unsubscribe.
 */
export function subscribePtyAnswer(listener: (id: string) => void): () => void {
  answerListeners.add(listener);
  return () => answerListeners.delete(listener);
}

/** The exit code once the process exited (-1 after a signal), else null. */
export function ptyExitCode(id: string): number | null {
  const live = sessions.get(id);
  return live?.exited ? (live.exitCode ?? -1) : null;
}

export function livePty(id: string): LivePty | undefined {
  return sessions.get(id);
}

export function isPtyOpening(id: string): boolean {
  return opening.has(id);
}

export function markPtyOpening(id: string): boolean {
  if (opening.has(id) || sessions.has(id)) return false;
  opening.add(id);
  return true;
}

export function clearPtyOpening(id: string): void {
  opening.delete(id);
}

/** Fresh buffer and channel. Replaces any previous session for this id. */
export function beginLivePty(id: string): LivePty {
  // A restart starts fresh.
  terminalActivity.forget(id);
  dialogDetector.forget(id);
  const buffer = createPtyBuffer();
  const startedAt = Date.now();
  const live: LivePty = {
    id,
    buffer,
    channel: createPtyChannel(() => {}),
    startedAt,
    planSince: startedAt,
    exitCode: null,
    exited: false,
  };
  live.channel = createPtyChannel((packet) => {
    if (packet.kind === "exit") {
      live.exitCode = packet.code;
      live.exited = true;
      buffer.pushExit(packet.code);
      // A closed tab or a replaced (restarted) process is not news.
      if (sessions.get(live.id) !== live) return;
      terminalActivity.forget(live.id);
      dialogDetector.forget(live.id);
      for (const listener of exitListeners) listener(live.id, packet.code ?? -1);
      notify();
      return;
    }
    if (packet.data) {
      terminalActivity.output(live.id);
      const bytes = decodeBase64(packet.data);
      if (!live.id.endsWith("::pane")) dialogDetector.feed(live.id, bytes);
      buffer.pushData(bytes);
    }
  });
  sessions.set(id, live);
  opening.delete(id);
  notify();
  return live;
}

/**
 * Restart or Resume on the same tab: a fresh record that replaces the old one.
 * `startedAt` is the new process's, so a decision or sub-agent the dead one
 * left open is not the current run's; `planSince` stays the tab's first start.
 */
export function restartLivePty(id: string): LivePty {
  // Same tab, same run: plan files written before the restart still count.
  const planSince = sessions.get(id)?.planSince;
  const live = beginLivePty(id);
  if (planSince) live.planSince = planSince;
  return live;
}

/** The channel is opened before the tab id exists. Move the buffer onto the real id. */
export function rekeyLivePty(from: string, to: string): LivePty | undefined {
  const live = sessions.get(from);
  if (!live) return livePty(to);
  if (from === to) return live;
  sessions.delete(from);
  live.id = to;
  sessions.set(to, live);
  notify();
  return live;
}

export function dropLivePty(tabId: string): void {
  terminalActivity.forget(tabId);
  dialogDetector.forget(tabId);
  sessions.delete(tabId);
  sessions.delete(`${tabId}::pane`);
  opening.delete(tabId);
  opening.delete(`${tabId}::pane`);
}
