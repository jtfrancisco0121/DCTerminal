/** Which surface the active tab shows. Settings is an app route, not a tab. */

import { folderForTab } from "./projectsView";

export const APP_VERSION = "0.1.0";

/** Form state that belongs to one tab and must not leak into another. */
export type TabDraft = {
  roleId: string;
  pickedRoleId: string | null;
  values: Record<string, string>;
  transcript: string;
  newSessionOpen: boolean;
  resendStartup: boolean;
};

export function tabFormFromRecord(tab: {
  roleId: string;
  cwd: string;
  answers: Record<string, string>;
  transcript?: string | null;
}): TabDraft {
  const cwd = folderForTab(tab.cwd) || folderForTab(tab.answers.cwd);
  const transcript = tab.transcript?.trim() ?? "";
  const fresh = !cwd && !transcript;
  return {
    roleId: tab.roleId,
    pickedRoleId: fresh ? null : tab.roleId,
    values: { ...tab.answers, cwd },
    transcript,
    newSessionOpen: false,
    resendStartup: false,
  };
}

/** Keep a tab's own edits. Fill a blank folder from the saved record. */
export function mergeTabDraft(cached: TabDraft | undefined, incoming: TabDraft): TabDraft {
  if (!cached) return incoming;
  const cachedFolder = folderForTab(cached.values.cwd);
  const incomingFolder = folderForTab(incoming.values.cwd);
  return {
    ...incoming,
    ...cached,
    transcript: cached.transcript.trim() || incoming.transcript,
    values: {
      ...incoming.values,
      ...cached.values,
      cwd: cachedFolder || incomingFolder,
    },
    pickedRoleId: cached.pickedRoleId ?? incoming.pickedRoleId,
    roleId: cached.roleId || incoming.roleId,
  };
}

/**
 * Store the tab being left, then show the tab being opened.
 * The opened tab keeps the draft already stored for its id.
 */
export function switchTabForm(
  forms: Record<string, TabDraft>,
  fromId: string | null,
  fromSnapshot: TabDraft | null,
  toId: string,
  incoming: TabDraft,
): { forms: Record<string, TabDraft>; active: TabDraft } {
  const next = { ...forms };
  if (fromId && fromSnapshot && fromId !== toId) next[fromId] = fromSnapshot;
  const active = next[toId] ?? incoming;
  next[toId] = active;
  return { forms: next, active };
}

/** Never replace a known folder with a blank value from a stale render. */
export function folderToWrite(known: string, next: string): string {
  return folderForTab(next) || folderForTab(known);
}

/**
 * Continue calls session/load. A restored tab with only local text, or a
 * role tab that never started, has no session id and cannot be continued.
 */
export function canContinueStoredSession(
  tab: { phase: string; acpSessionId: string | null } | null,
): boolean {
  return !!tab && tab.phase === "awaitingInput" && !!tab.acpSessionId;
}

export function showStartupFields(input: {
  surface: TabSurface;
  newSessionOpen: boolean;
}): boolean {
  if (input.surface === "compose") return true;
  if (input.surface === "restore" && input.newSessionOpen) return true;
  return false;
}

export function scrollForTab(positions: Record<string, number>, tabId: string): number {
  return positions[tabId] ?? 0;
}

export function rememberScroll(
  positions: Record<string, number>,
  tabId: string,
  top: number,
): Record<string, number> {
  return { ...positions, [tabId]: top };
}

export type AppRoute = "workspace" | "settings";

export type TabSurface = "session" | "restore" | "compose" | "pick";

export function appRoute(settingsOpen: boolean): AppRoute {
  return settingsOpen ? "settings" : "workspace";
}

export function toggleSettings(open: boolean): boolean {
  return !open;
}

/**
 * A blank tab stays on the role-and-folder picker until both are chosen.
 * Saved history stays inside that tab. A live session fills the tab.
 */
export function tabSurface(input: {
  sessionActive: boolean;
  hasSavedHistory: boolean;
  roleChosen: boolean;
  folder: string;
}): TabSurface {
  if (input.sessionActive) return "session";
  if (input.hasSavedHistory) return "restore";
  if (input.roleChosen && input.folder.trim().length > 0) return "compose";
  return "pick";
}

/** Short permission line for the settings role list. Every role allows once. */
export function rolePermissionSummary(_roleId: string): string {
  return "Full access";
}
