/** Which surface the active tab shows. Settings is an app route, not a tab. */

export const APP_VERSION = "0.1.0";

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

/** Short permission line for the settings role list. Matches the Rust policy. */
export function rolePermissionSummary(roleId: string): string {
  const id = roleId.trim().toLowerCase().replace(/-/g, "_");
  if (id.includes("implementer") || id.includes("developer")) {
    return "Auto-allow write, shell, and MCP (allow-once).";
  }
  if (id.includes("review")) {
    return "Allow shell and MCP. Deny file writes. Ask when a request is ambiguous.";
  }
  if (id.includes("planner") || id.includes("general")) {
    return "Deny write and shell. Allow MCP. Ask when a request is ambiguous.";
  }
  return "Ask for every permission.";
}
