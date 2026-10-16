/**
 * One backend watch per Claude terminal tab, shared by every view that reads
 * its chat entries (the chat view, the header's sub-agent count, later the
 * run lanes). The watch starts with the first subscriber and stops with the
 * last. The backend ends a watch when the tab's PTY is killed, so a tab whose
 * PTY was replaced (restart, resume) is watched again from the last revision.
 */
import { useCallback, useSyncExternalStore } from "react";
import { terminalChatUnwatch, terminalChatWatch, type ChatEntriesUpdate } from "../bridge";
import { applyChatUpdate, EMPTY_CHAT, type ChatEntriesState } from "./chatEntries";
import { livePty, subscribeLivePty, type LivePty } from "./live";

type Watched = {
  state: ChatEntriesState;
  listeners: Set<() => void>;
  /** The PTY session the current watch was started for. */
  pty: LivePty | undefined;
  /** Bumped per watch; updates from an older watch are dropped. */
  generation: number;
  /** Pending stop after the last subscriber left. */
  dropTimer: ReturnType<typeof setTimeout> | null;
};

/**
 * The watch outlives its last subscriber this long, so a remount (StrictMode,
 * a view switch, a tab switch and back) keeps it instead of racing an
 * unwatch against the next watch.
 */
const DROP_DELAY_MS = 1500;

const watched = new Map<string, Watched>();
let unsubscribeLive: (() => void) | null = null;

function startWatch(tabId: string, item: Watched): void {
  item.generation += 1;
  item.pty = livePty(tabId);
  const generation = item.generation;
  const onUpdate = (update: ChatEntriesUpdate) => {
    if (watched.get(tabId) !== item || item.generation !== generation) return;
    const next = applyChatUpdate(item.state, update);
    if (next === item.state) return;
    item.state = next;
    for (const listener of item.listeners) listener();
  };
  try {
    // intentionally silent: no backend (unit tests, plain browser) leaves the view empty.
    void terminalChatWatch(tabId, item.state.revision, onUpdate).catch(() => {});
  } catch {
    // Same: Channel needs the Tauri bridge.
  }
}

/** A tab's PTY changed (restart, resume): the backend stopped its watch, so start again. */
function onLiveChange(): void {
  for (const [tabId, item] of watched) {
    if (livePty(tabId) !== item.pty) startWatch(tabId, item);
  }
}

/** Calls `listener` whenever the tab's entries change. Returns the unsubscribe. */
export function subscribeChatEntries(tabId: string, listener: () => void): () => void {
  let item = watched.get(tabId);
  if (!item) {
    item = { state: EMPTY_CHAT, listeners: new Set(), pty: undefined, generation: 0, dropTimer: null };
    watched.set(tabId, item);
    unsubscribeLive ??= subscribeLivePty(onLiveChange);
    startWatch(tabId, item);
  }
  const current = item;
  if (current.dropTimer) {
    clearTimeout(current.dropTimer);
    current.dropTimer = null;
  }
  current.listeners.add(listener);
  return () => {
    current.listeners.delete(listener);
    if (current.listeners.size > 0 || current.dropTimer) return;
    current.dropTimer = setTimeout(() => {
      current.dropTimer = null;
      if (current.listeners.size > 0 || watched.get(tabId) !== current) return;
      watched.delete(tabId);
      // intentionally silent: the watch also ends when its channel is dropped.
      void terminalChatUnwatch(tabId).catch(() => {});
      if (watched.size === 0 && unsubscribeLive) {
        unsubscribeLive();
        unsubscribeLive = null;
      }
    }, DROP_DELAY_MS);
  };
}

export function chatEntriesSnapshot(tabId: string | null | undefined): ChatEntriesState {
  return (tabId && watched.get(tabId)?.state) || EMPTY_CHAT;
}

/** The tab's chat entries, live. `null` (or `enabled` false) subscribes to nothing. */
export function useChatEntries(tabId: string | null | undefined, enabled = true): ChatEntriesState {
  const id = enabled && tabId ? tabId : null;
  const subscribe = useCallback(
    (listener: () => void) => (id ? subscribeChatEntries(id, listener) : () => {}),
    [id],
  );
  return useSyncExternalStore(subscribe, () => chatEntriesSnapshot(id));
}
