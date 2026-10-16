/**
 * Terminal or Chat per Claude terminal tab, kept across restarts. UI only:
 * localStorage, keyed by tab id. Every window shares the store, so each
 * change is a read-modify-write and a window prunes only tabs it saw close.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ensureWebStorage } from "../storage/webStorage";
import type { TerminalViewMode } from "./chatEntries";

export const TERMINAL_VIEWS_KEY = "dct.terminalViews";

export type TerminalViews = Record<string, TerminalViewMode>;

/** Only tabs shown as Chat are kept: Terminal is the default. */
export function parseTerminalViews(raw: string | null): TerminalViews {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: TerminalViews = {};
    for (const [id, view] of Object.entries(parsed as Record<string, unknown>)) {
      if (view === "chat") out[id] = "chat";
    }
    return out;
  } catch {
    // intentionally silent: a damaged entry means every tab starts as Terminal.
    return {};
  }
}

/** The stored views; null when storage cannot be read. */
export function readTerminalViews(): TerminalViews | null {
  try {
    return parseTerminalViews(ensureWebStorage().localStorage.getItem(TERMINAL_VIEWS_KEY));
  } catch {
    // intentionally silent: the caller keeps what it has in memory.
    return null;
  }
}

export function writeTerminalViews(views: TerminalViews): void {
  try {
    const kept = Object.fromEntries(Object.entries(views).filter(([, view]) => view === "chat"));
    const storage = ensureWebStorage().localStorage;
    if (Object.keys(kept).length === 0) storage.removeItem(TERMINAL_VIEWS_KEY);
    else storage.setItem(TERMINAL_VIEWS_KEY, JSON.stringify(kept));
  } catch {
    // intentionally silent: the choice still holds for this run.
  }
}

/** `views` with `tabId` set to `view` (Terminal is stored as no entry). */
export function withTerminalView(
  views: TerminalViews,
  tabId: string,
  view: TerminalViewMode,
): TerminalViews {
  const next = { ...views };
  if (view === "chat") next[tabId] = "chat";
  else delete next[tabId];
  return next;
}

/** `views` without `ids`. */
export function withoutTabs(views: TerminalViews, ids: readonly string[]): TerminalViews {
  const next = { ...views };
  for (const id of ids) delete next[id];
  return next;
}

/** Ids seen open before that are not open now: tabs this window closed. */
export function closedSince(seen: ReadonlySet<string>, openIds: readonly string[]): string[] {
  const open = new Set(openIds);
  return [...seen].filter((id) => !open.has(id));
}

export function toggledView(view: TerminalViewMode): TerminalViewMode {
  return view === "chat" ? "terminal" : "chat";
}

/** The per-tab views, saved on every change; `openIds` are this window's tabs. */
export function useTerminalViews(openIds: readonly string[]) {
  const [views, setViews] = useState<TerminalViews>(() => readTerminalViews() ?? {});
  const viewsRef = useRef(views);
  const seen = useRef(new Set<string>());

  const update = useCallback((change: (views: TerminalViews) => TerminalViews) => {
    // Read again first: another window may have changed its own tabs.
    const next = change(readTerminalViews() ?? viewsRef.current);
    writeTerminalViews(next);
    viewsRef.current = next;
    setViews(next);
  }, []);

  const key = openIds.join("\n");
  useEffect(() => {
    const ids = key ? key.split("\n") : [];
    const closed = closedSince(seen.current, ids);
    for (const id of closed) seen.current.delete(id);
    for (const id of ids) seen.current.add(id);
    if (closed.some((id) => id in viewsRef.current)) update((views) => withoutTabs(views, closed));
  }, [key, update]);

  const setView = useCallback(
    (tabId: string, view: TerminalViewMode) => update((views) => withTerminalView(views, tabId, view)),
    [update],
  );

  return { views, setView };
}
