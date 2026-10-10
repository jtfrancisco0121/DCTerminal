/**
 * Files the user kept in the Changes panel, per tab. Each key is tied to the
 * file's content (`acceptKey`), so a later edit shows the file again. Kept
 * in local storage so a reload or restart does not lose it. Every window
 * shares the store: a save merges with what is stored, and only the most
 * recently used tabs are kept.
 */

export type AcceptedChanges = Record<string, string[]>;

export const ACCEPTED_STORAGE_KEY = "dct.changes.accepted";
/** Keys kept per tab; the oldest go first. */
export const ACCEPTED_PER_TAB = 500;
/** Tabs kept; the least recently used go first. */
export const ACCEPTED_TABS = 100;

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Keep only string lists, capped per tab. Anything else is dropped. */
export function sanitizeAccepted(value: unknown): AcceptedChanges {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: AcceptedChanges = {};
  for (const [tabId, keys] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(keys)) continue;
    const clean = keys.filter((key): key is string => typeof key === "string" && key.length > 0);
    if (clean.length > 0) out[tabId] = clean.slice(-ACCEPTED_PER_TAB);
  }
  return out;
}

/** Union per tab. Tabs in `newer` count as the most recently used. */
export function mergeAccepted(older: AcceptedChanges, newer: AcceptedChanges): AcceptedChanges {
  const out: AcceptedChanges = { ...older };
  for (const [tabId, keys] of Object.entries(newer)) {
    const merged = [...(out[tabId] ?? [])];
    for (const key of keys) if (!merged.includes(key)) merged.push(key);
    delete out[tabId];
    out[tabId] = merged.slice(-ACCEPTED_PER_TAB);
  }
  const tabs = Object.keys(out);
  for (const tabId of tabs.slice(0, Math.max(0, tabs.length - ACCEPTED_TABS))) delete out[tabId];
  return out;
}

export function loadAccepted(): AcceptedChanges {
  try {
    const raw = storage()?.getItem(ACCEPTED_STORAGE_KEY);
    return raw ? sanitizeAccepted(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

/** Merge into what is stored (another window may have saved since). */
export function saveAccepted(accepted: AcceptedChanges): void {
  try {
    const merged = mergeAccepted(loadAccepted(), accepted);
    storage()?.setItem(ACCEPTED_STORAGE_KEY, JSON.stringify(merged));
  } catch {
    // Storage full or disabled: the marks still work until the next reload.
  }
}

export function addAccepted(accepted: AcceptedChanges, tabId: string, key: string): AcceptedChanges {
  const current = accepted[tabId] ?? [];
  if (current.includes(key)) return accepted;
  return { ...accepted, [tabId]: [...current, key].slice(-ACCEPTED_PER_TAB) };
}
