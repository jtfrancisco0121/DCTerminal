/**
 * What a new tab opens, and in which folder. The app is terminal-first:
 * ⌘/Ctrl+T asks (or, by setting, goes straight to) Claude or a shell in the
 * folder you are working in.
 *
 * Design after ADE (better-agentic-ide) src/lib/newTab.ts and
 * src/components/NewTabDialog.tsx, MIT License, (c) 2025-2026 Alvin Reyes.
 */
import { homeDir } from "@tauri-apps/api/path";
import { projectsList, type ListedProject, type NewTabOpens, type TabSummary } from "./bridge";

/** Recent projects the picker lists (keys 1–9). */
export const MAX_PICKER_RECENTS = 9;

/** Unknown or missing values read as `ask`, like the Rust side. */
export function newTabMode(value: string | null | undefined): NewTabOpens {
  return value === "claude" || value === "shell" || value === "start" ? value : "ask";
}

/**
 * The folder a new terminal opens in: the active tab's folder, else the most
 * recent project, else the home folder.
 */
export function pickNewTabFolder(input: {
  activeCwd: string | null | undefined;
  recent: string[];
  home: string | null;
}): string | null {
  const active = input.activeCwd?.trim();
  if (active) return active;
  const recent = input.recent.find((path) => path.trim());
  if (recent) return recent;
  return input.home?.trim() || null;
}

/** Usable recent project folders, newest first, without duplicates. */
export function recentProjectPaths(recent: ListedProject[], max = MAX_PICKER_RECENTS): string[] {
  const out: string[] = [];
  for (const project of recent) {
    const path = project.path.trim();
    if (!project.available || !path || out.includes(path)) continue;
    out.push(path);
    if (out.length >= max) break;
  }
  return out;
}

/** The active tab's folder, when it has one. */
export function activeTabFolder(tabs: TabSummary[], activeTabId: string | null): string | null {
  const tab = activeTabId ? tabs.find((item) => item.id === activeTabId) : undefined;
  return tab?.cwd?.trim() || null;
}

/** `/Users/me/code/app` → `~/code/app`, for display only. */
export function tildePath(path: string, home: string | null): string {
  const root = home?.replace(/[\\/]+$/, "");
  if (!root) return path;
  if (path === root) return "~";
  if (path.startsWith(`${root}/`) || path.startsWith(`${root}\\`)) {
    return `~${path.slice(root.length)}`;
  }
  return path;
}

/** The last part of a folder path, for a short label. */
export function folderName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export type NewTabContext = {
  /** Where "Claude here" and "Shell here" open. Null when nothing is known. */
  folder: string | null;
  recents: string[];
  home: string | null;
};

/** The home folder, or null when the path API is not available. */
export async function homeFolder(): Promise<string | null> {
  try {
    return await homeDir();
  } catch {
    // intentionally silent: the home folder is only the last fallback.
    return null;
  }
}

/** Reads recent projects and the home folder, then applies the folder rule. */
export async function loadNewTabContext(activeCwd: string | null): Promise<NewTabContext> {
  const [listed, home] = await Promise.all([
    projectsList().catch(() => {
      // intentionally silent: without recents the rule falls back to home.
      return { favorites: [], recent: [] };
    }),
    homeFolder(),
  ]);
  const recents = recentProjectPaths(listed.recent);
  return { folder: pickNewTabFolder({ activeCwd, recent: recents, home }), recents, home };
}

/** What a key press in the picker does. */
export type PickerKeyAction =
  | { kind: "claude" }
  | { kind: "shell" }
  | { kind: "role" }
  | { kind: "github" }
  | { kind: "open" }
  | { kind: "recent"; index: number };

/** Maps a plain key (no modifiers) to a picker action, or null. */
export function pickerKeyAction(
  key: string,
  recentCount: number,
): PickerKeyAction | null {
  const lower = key.toLowerCase();
  if (lower === "c") return { kind: "claude" };
  if (lower === "s") return { kind: "shell" };
  if (lower === "r") return { kind: "role" };
  if (lower === "g") return { kind: "github" };
  if (lower === "o") return { kind: "open" };
  if (/^[1-9]$/.test(key)) {
    const index = Number(key) - 1;
    return index < recentCount ? { kind: "recent", index } : null;
  }
  return null;
}
