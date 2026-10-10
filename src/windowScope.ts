import { invoke } from "@tauri-apps/api/core";

export type WindowContext = {
  id: string;
  accountId: string;
  accountName: string;
  title: string;
  config: {
    path: string;
    display: string;
    source: "env" | "setting" | "default" | string;
    exists: boolean;
  };
};

const FALLBACK: WindowContext = {
  id: "main",
  accountId: "default",
  accountName: "Claude",
  title: "DCTerminal",
  config: { path: "", display: "~/.claude", source: "default", exists: false },
};

let pending: Promise<WindowContext> | null = null;

/** This webview's window label. Cached for the life of the page. */
export function ensureWindow(): Promise<WindowContext> {
  if (!pending) {
    pending = Promise.resolve()
      .then(() => invoke<WindowContext | null>("window_context"))
      .then((ctx) => (ctx?.id ? ctx : FALLBACK))
      .catch(() => FALLBACK);
  }
  return pending;
}

export type ShortcutPlatform = "mac" | "windows" | "other";

export function shortcutPlatform(nav = navigator): ShortcutPlatform {
  const platform = `${nav.platform ?? ""} ${nav.userAgent ?? ""}`;
  if (/Mac/i.test(platform)) return "mac";
  if (/Win/i.test(platform)) return "windows";
  return "other";
}

/** File > New Window: ⌘⇧N on Mac, Ctrl+Shift+N on Windows. */
export function newWindowShortcutLabel(platform: ShortcutPlatform): string {
  return platform === "mac" ? "⌘⇧N" : "Ctrl+Shift+N";
}

type ShortcutEvent = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
};

/**
 * Menu accelerator and the keydown listener can both fire. Ignore a second
 * request while the account picker is open, or inside `gapMs`.
 */
export function acceptNewWindowRequest(
  lastAt: number,
  now: number,
  pickerOpen: boolean,
  gapMs = 450,
): boolean {
  if (pickerOpen) return false;
  return now - lastAt >= gapMs;
}

/** True for the new-window shortcut on that platform, and not the other one's. */
export function isNewWindowShortcut(event: ShortcutEvent, platform: ShortcutPlatform): boolean {
  if (event.altKey || !event.shiftKey) return false;
  if (event.key.toLowerCase() !== "n") return false;
  if (platform === "mac") return event.metaKey && !event.ctrlKey;
  return event.ctrlKey && !event.metaKey;
}
