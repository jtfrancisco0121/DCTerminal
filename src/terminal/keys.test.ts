import { describe, expect, it } from "vitest";
import { isShiftEnter, SHIFT_ENTER_SEQUENCE, shiftEnterSendsNewline } from "./keys";

const ev = (over: Partial<Parameters<typeof isShiftEnter>[0]> = {}) => ({
  type: "keydown",
  key: "Enter",
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...over,
});

describe("terminal Shift+Enter", () => {
  it("sends ESC then CR, the sequence Claude Code accepts as a new line", () => {
    expect(SHIFT_ENTER_SEQUENCE).toBe("\u001b\r");
  });

  it("matches Shift+Enter alone", () => {
    expect(isShiftEnter(ev({ shiftKey: true }))).toBe(true);
  });

  it("leaves plain Enter and other modified Enters to xterm", () => {
    expect(isShiftEnter(ev())).toBe(false);
    expect(isShiftEnter(ev({ shiftKey: true, ctrlKey: true }))).toBe(false);
    expect(isShiftEnter(ev({ shiftKey: true, altKey: true }))).toBe(false);
    expect(isShiftEnter(ev({ shiftKey: true, metaKey: true }))).toBe(false);
    expect(isShiftEnter(ev({ shiftKey: true, key: "a" }))).toBe(false);
  });

  it("ignores Enter that confirms an IME composition", () => {
    expect(isShiftEnter(ev({ shiftKey: true, isComposing: true }))).toBe(false);
  });

  it("rewrites Shift+Enter only for Claude Code terminals", () => {
    expect(shiftEnterSendsNewline("role")).toBe(true);
    expect(shiftEnterSendsNewline("claude-cli")).toBe(true);
    expect(shiftEnterSendsNewline("shell")).toBe(false);
    expect(shiftEnterSendsNewline("cursor-cli")).toBe(false);
  });
});
