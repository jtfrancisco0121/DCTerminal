import { describe, expect, it } from "vitest";
import {
  acceptNewWindowRequest,
  isNewWindowShortcut,
  newWindowShortcutLabel,
  shortcutPlatform,
} from "./windowScope";

const key = (patch: Partial<{ key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }>) => ({
  key: "n",
  metaKey: false,
  ctrlKey: false,
  shiftKey: true,
  altKey: false,
  ...patch,
});

describe("new window shortcut", () => {
  it("uses Command on Mac and Control on Windows", () => {
    expect(isNewWindowShortcut(key({ metaKey: true }), "mac")).toBe(true);
    expect(isNewWindowShortcut(key({ ctrlKey: true }), "mac")).toBe(false);
    expect(isNewWindowShortcut(key({ ctrlKey: true, metaKey: true }), "mac")).toBe(false);
    expect(isNewWindowShortcut(key({ ctrlKey: true }), "windows")).toBe(true);
    expect(isNewWindowShortcut(key({ metaKey: true }), "windows")).toBe(false);
    expect(isNewWindowShortcut(key({ ctrlKey: true }), "other")).toBe(true);
  });

  it("requires shift and ignores alt and other keys", () => {
    expect(isNewWindowShortcut(key({ metaKey: true, shiftKey: false }), "mac")).toBe(false);
    expect(isNewWindowShortcut(key({ metaKey: true, altKey: true }), "mac")).toBe(false);
    expect(isNewWindowShortcut(key({ metaKey: true, key: "N" }), "mac")).toBe(true);
    expect(isNewWindowShortcut(key({ ctrlKey: true, key: "t" }), "windows")).toBe(false);
  });

  it("labels the shortcut for the menu and the button", () => {
    expect(newWindowShortcutLabel("mac")).toBe("⌘⇧N");
    expect(newWindowShortcutLabel("windows")).toBe("Ctrl+Shift+N");
  });

  it("ignores a second request while the picker is open or inside the gap", () => {
    expect(acceptNewWindowRequest(0, 500, false)).toBe(true);
    expect(acceptNewWindowRequest(1000, 1200, false)).toBe(false);
    expect(acceptNewWindowRequest(1000, 1600, false)).toBe(true);
    expect(acceptNewWindowRequest(0, 5000, true)).toBe(false);
  });

  it("reads Mac and Windows from the navigator", () => {
    expect(shortcutPlatform({ platform: "MacIntel", userAgent: "" } as Navigator)).toBe("mac");
    expect(shortcutPlatform({ platform: "Win32", userAgent: "" } as Navigator)).toBe("windows");
    expect(shortcutPlatform({ platform: "Linux x86_64", userAgent: "" } as Navigator)).toBe("other");
  });
});
