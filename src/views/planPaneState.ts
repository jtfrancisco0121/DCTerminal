/**
 * Which tabs have their docked plan pane open. A small UI-state store (not
 * settings): kept in localStorage per tab id so a reload keeps the pane where
 * you left it, and works without storage too. Ids of tabs that close are
 * pruned (`usePrunePlanPanes`), like the Terminal/Chat choice.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import { closedSince } from "../terminal/terminalViews";

const KEY = "dcterminal.planPaneOpen";
const listeners = new Set<() => void>();
let open: ReadonlySet<string> = load();

function load(): ReadonlySet<string> {
  try {
    const raw = JSON.parse(window.localStorage.getItem(KEY) ?? "[]");
    return new Set(Array.isArray(raw) ? raw.filter((id) => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function save() {
  try {
    window.localStorage.setItem(KEY, JSON.stringify([...open]));
  } catch {
    // Private mode or storage disabled: the pane still toggles for this session.
  }
}

export function planPaneOpen(tabId: string): boolean {
  return open.has(tabId);
}

export function setPlanPaneOpen(tabId: string, value: boolean) {
  if (open.has(tabId) === value) return;
  const next = new Set(open);
  if (value) next.add(tabId);
  else next.delete(tabId);
  open = next;
  save();
  listeners.forEach((listener) => listener());
}

/** Forget the panes of tabs that closed. */
export function forgetPlanPanes(tabIds: readonly string[]) {
  if (!tabIds.some((id) => open.has(id))) return;
  const next = new Set(open);
  for (const id of tabIds) next.delete(id);
  open = next;
  save();
  listeners.forEach((listener) => listener());
}

/**
 * Prunes the panes of this window's tabs as they close. `openIds` are the
 * window's tabs; only tabs seen open are pruned, so other windows' stay.
 */
export function usePrunePlanPanes(openIds: readonly string[]) {
  const seen = useRef(new Set<string>());
  const key = openIds.join("\n");
  useEffect(() => {
    const ids = key ? key.split("\n") : [];
    const closed = closedSince(seen.current, ids);
    for (const id of closed) seen.current.delete(id);
    for (const id of ids) seen.current.add(id);
    forgetPlanPanes(closed);
  }, [key]);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePlanPaneOpen(tabId: string): boolean {
  return useSyncExternalStore(subscribe, () => open.has(tabId));
}

/** Tests: forget every tab's choice. */
export function resetPlanPaneState() {
  open = new Set();
  save();
  listeners.forEach((listener) => listener());
}
