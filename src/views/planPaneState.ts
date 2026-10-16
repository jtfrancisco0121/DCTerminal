/**
 * Which tabs have their docked plan pane open. A small UI-state store (not
 * settings): kept in localStorage per tab id so a reload keeps the pane where
 * you left it, and works without storage too.
 */
import { useSyncExternalStore } from "react";

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
