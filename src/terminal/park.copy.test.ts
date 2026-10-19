// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let selectionChanged: (() => void) | null = null;

vi.mock("../uiErrors", () => ({ reportError: vi.fn() }));
vi.mock("../bridge", () => ({ ptySetScheme: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("./fileLinks", () => ({ existingPaths: vi.fn(async () => new Set()) }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
vi.mock("@xterm/addon-search", () => ({ SearchAddon: class {} }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options = {};
    loadAddon() {}
    registerLinkProvider() {}
    onSelectionChange(handler: () => void) {
      selectionChanged = handler;
    }
    hasSelection() {
      return true;
    }
    getSelection() {
      return "selected text";
    }
    open() {}
  },
}));

import { reportError } from "../uiErrors";
import { ensureParkedTerminal, setCopyOnSelect } from "./park";

describe("copy on select", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setCopyOnSelect(false);
  });

  it("a copy the clipboard rejects is shown, once per source", async () => {
    const error = new Error("clipboard denied");
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: vi.fn(() => Promise.reject(error)) } });
    setCopyOnSelect(true);
    ensureParkedTerminal("t1", 13);
    selectionChanged!();
    await vi.advanceTimersByTimeAsync(250);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("selected text");
    expect(reportError).toHaveBeenCalledWith("Copy on select failed", error, { notify: true, once: true });
  });
});
