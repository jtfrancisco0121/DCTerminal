import { describe, expect, it } from "vitest";
import {
  bindingConflicts,
  defaultBindings,
  isImeEvent,
  isReservedForTerminal,
  matchShortcut,
  routeKey,
  shortcutRows,
  type KeyEventLike,
} from "./keymap";

function event(partial: Partial<KeyEventLike>): KeyEventLike {
  return {
    code: "Enter",
    key: "Enter",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...partial,
  };
}

describe("keymap", () => {
  it("has one binding per action and no conflicts with editing, IME, or system keys", () => {
    const bindings = defaultBindings();
    expect(bindingConflicts(bindings)).toEqual([]);
    const shifted = bindings.filter((b) => b.mod && b.shift);
    expect(shifted.every((b) => b.code === "Tab")).toBe(true);
    expect(shifted).toHaveLength(1);
    expect(shortcutRows("windows").length).toBeGreaterThan(8);
  });

  it("opens settings with Ctrl+, even while a dialog is open", () => {
    expect(
      matchShortcut(event({ code: "Comma", ctrlKey: true, key: "," }), {
        platform: "windows",
      })?.action,
    ).toBe("settings");
    expect(
      matchShortcut(event({ code: "Comma", ctrlKey: true, key: "," }), {
        platform: "windows",
        dialogOpen: true,
      })?.action,
    ).toBe("settings");
  });

  it("sends with Ctrl+Enter while focus is in a textarea", () => {
    const match = matchShortcut(
      event({ code: "Enter", ctrlKey: true, targetTag: "TEXTAREA" }),
      { platform: "windows" },
    );
    expect(match?.action).toBe("send");
  });

  it("leaves copy, paste, and undo to the text field", () => {
    for (const code of ["KeyC", "KeyV", "KeyX", "KeyZ", "KeyA"]) {
      expect(
        matchShortcut(event({ code, ctrlKey: true, key: code, targetTag: "INPUT" }), {
          platform: "windows",
        }),
      ).toBeNull();
    }
  });

  it("still runs app shortcuts that are not text-editing chords", () => {
    expect(
      matchShortcut(event({ code: "KeyT", ctrlKey: true, targetTag: "TEXTAREA" }), {
        platform: "windows",
      })?.action,
    ).toBe("newTab");
    expect(
      matchShortcut(event({ code: "Period", ctrlKey: true, targetTag: "TEXTAREA" }), {
        platform: "windows",
      })?.action,
    ).toBe("transferPad");
  });

  it("ignores key events while an IME composition is active", () => {
    expect(isImeEvent(event({ isComposing: true, keyCode: 229, key: "Process" }))).toBe(
      true,
    );
    expect(
      matchShortcut(
        event({ code: "Enter", ctrlKey: true, isComposing: true, targetTag: "TEXTAREA" }),
        { platform: "windows" },
      ),
    ).toBeNull();
    expect(
      matchShortcut(event({ code: "Enter", ctrlKey: true, keyCode: 229 }), {
        platform: "windows",
      }),
    ).toBeNull();
  });

  it("does not bind Windows system chords", () => {
    expect(
      matchShortcut(event({ code: "F4", altKey: true }), { platform: "windows" }),
    ).toBeNull();
    expect(
      matchShortcut(event({ code: "Escape", ctrlKey: true }), { platform: "windows" }),
    ).toBeNull();
    expect(
      matchShortcut(event({ code: "Tab", altKey: true }), { platform: "windows" }),
    ).toBeNull();
  });

  it("uses Cmd on macOS and Ctrl on Windows", () => {
    expect(
      matchShortcut(event({ code: "Enter", metaKey: true }), { platform: "mac" })?.action,
    ).toBe("send");
    expect(
      matchShortcut(event({ code: "Enter", ctrlKey: true }), { platform: "mac" }),
    ).toBeNull();
  });

  it("jumps to a tab with Ctrl+number", () => {
    expect(
      matchShortcut(event({ code: "Digit3", ctrlKey: true }), { platform: "windows" }),
    ).toEqual({ action: "goToTab", tabIndex: 2 });
  });

  it("closes dialogs on Escape and ignores other shortcuts while one is open", () => {
    expect(
      matchShortcut(event({ code: "KeyT", ctrlKey: true }), {
        platform: "windows",
        dialogOpen: true,
      }),
    ).toBeNull();
    expect(
      matchShortcut(event({ code: "Escape", key: "Escape" }), {
        platform: "windows",
        dialogOpen: true,
      })?.action,
    ).toBe("closeDialog");
  });

  it("cycles tabs with Ctrl+Tab and keeps Ctrl+Shift+Tab out of the terminal set", () => {
    expect(
      matchShortcut(event({ code: "Tab", ctrlKey: true }), { platform: "windows" })?.action,
    ).toBe("nextTab");
    expect(
      matchShortcut(event({ code: "Tab", ctrlKey: true, shiftKey: true }), {
        platform: "windows",
      })?.action,
    ).toBe("prevTab");
    expect(
      isReservedForTerminal({
        code: "KeyC",
        mod: true,
        shift: true,
        alt: false,
        meta: false,
      }),
    ).toBe(true);
    expect(
      isReservedForTerminal({
        code: "Tab",
        mod: true,
        shift: true,
        alt: false,
        meta: false,
      }),
    ).toBe(false);
  });

  it("sends terminal chords to the shell pane and leaves Ctrl+C with the shell", () => {
    const chat = { platform: "windows" as const, surface: "chat" as const };
    const term = { platform: "windows" as const, surface: "terminal" as const };
    expect(routeKey(event({ code: "Backquote", ctrlKey: true, shiftKey: true }), chat)).toEqual({
      kind: "terminal",
      action: "togglePane",
    });
    expect(routeKey(event({ code: "Period", ctrlKey: true, shiftKey: true }), chat)).toEqual({
      kind: "terminal",
      action: "transferToTerminal",
    });
    expect(routeKey(event({ code: "KeyC", ctrlKey: true, shiftKey: true }), chat).kind).toBe(
      "none",
    );
    expect(routeKey(event({ code: "KeyC", ctrlKey: true, shiftKey: true }), term)).toEqual({
      kind: "terminal",
      action: "copy",
    });
    expect(routeKey(event({ code: "KeyV", ctrlKey: true, shiftKey: true }), term).kind).toBe(
      "terminal",
    );
    expect(routeKey(event({ code: "KeyF", ctrlKey: true, shiftKey: true }), term)).toEqual({
      kind: "terminal",
      action: "search",
    });
    expect(routeKey(event({ code: "KeyC", ctrlKey: true }), term).kind).toBe("shell");
    expect(routeKey(event({ code: "Enter", ctrlKey: true }), term).kind).toBe("shell");
    expect(routeKey(event({ code: "KeyT", ctrlKey: true }), term)).toEqual({
      kind: "app",
      match: { action: "newTab" },
    });
    expect(routeKey(event({ code: "KeyW", ctrlKey: true }), term).kind).toBe("app");
    expect(routeKey(event({ code: "Digit1", ctrlKey: true }), term)).toEqual({
      kind: "app",
      match: { action: "goToTab", tabIndex: 0 },
    });
    expect(routeKey(event({ code: "Tab", ctrlKey: true }), term).kind).toBe("app");
    expect(
      routeKey(event({ code: "Tab", ctrlKey: true, shiftKey: true }), term),
    ).toEqual({ kind: "app", match: { action: "prevTab" } });
    expect(routeKey(event({ code: "KeyP", ctrlKey: true }), term).kind).toBe("app");
    expect(routeKey(event({ code: "Comma", ctrlKey: true, key: "," }), term).kind).toBe("app");
    expect(routeKey(event({ code: "KeyK", ctrlKey: true, key: "k" }), term)).toEqual({
      kind: "app",
      match: { action: "commandPalette" },
    });
    expect(routeKey(event({ code: "KeyC", ctrlKey: true }), term).kind).toBe("shell");
  });
});
