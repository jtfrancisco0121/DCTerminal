/**
 * One PTY channel per terminal id. Bytes are buffered until xterm attaches,
 * so a late mount (or a StrictMode remount) does not drop the first output
 * or start a second process.
 */

import type { Channel } from "@tauri-apps/api/core";
import { createPtyChannel, type PtyPacket } from "../bridge";
import { createPtyBuffer, decodeBase64, type PtyBuffer } from "./buffer";
import { terminalActivity } from "./activity";

export type LivePty = {
  id: string;
  buffer: PtyBuffer;
  channel: Channel<PtyPacket>;
  startedAt: number;
  exitCode: number | null;
};

const sessions = new Map<string, LivePty>();
const opening = new Set<string>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function subscribeLivePty(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
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
  const buffer = createPtyBuffer();
  const live: LivePty = {
    id,
    buffer,
    channel: createPtyChannel(() => {}),
    startedAt: Date.now(),
    exitCode: null,
  };
  live.channel = createPtyChannel((packet) => {
    if (packet.kind === "exit") {
      live.exitCode = packet.code;
      buffer.pushExit(packet.code);
      return;
    }
    if (packet.data) {
      terminalActivity.output(live.id);
      buffer.pushData(decodeBase64(packet.data));
    }
  });
  sessions.set(id, live);
  opening.delete(id);
  notify();
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
  sessions.delete(tabId);
  sessions.delete(`${tabId}::pane`);
  opening.delete(tabId);
  opening.delete(`${tabId}::pane`);
}
