// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type KeyHandler = (event: KeyboardEvent) => boolean;
let keyHandler: KeyHandler | null = null;
let dataHandler: ((data: string) => void) | null = null;
let live: { exitCode: number | null; exited: boolean; buffer: { attach: () => () => void } } | undefined;
const dropError = new Error("drag-drop listen denied");

vi.mock("../uiErrors", () => ({ reportError: vi.fn() }));

vi.mock("../bridge", () => ({
  ptyOpen: vi.fn(() => Promise.resolve()),
  ptyResize: vi.fn(() => Promise.resolve()),
  ptyWrite: vi.fn(() => Promise.resolve()),
  terminalSessionLog: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.reject(dropError) }),
}));

vi.mock("../terminal/live", () => ({
  beginLivePty: vi.fn(),
  clearPtyOpening: vi.fn(),
  isPtyOpening: vi.fn(() => false),
  livePty: vi.fn(() => live),
  markPtyOpening: vi.fn(() => false),
  notePtyInput: vi.fn(),
  subscribeLivePty: vi.fn(() => () => {}),
}));

vi.mock("../terminal/park", () => {
  const term = {
    cols: 80,
    rows: 24,
    options: {} as Record<string, unknown>,
    focus: vi.fn(),
    onData: vi.fn((handler: (data: string) => void) => {
      dataHandler = handler;
      return { dispose: vi.fn() };
    }),
    write: vi.fn(),
    attachCustomKeyEventHandler: vi.fn((handler: KeyHandler) => {
      keyHandler = handler;
    }),
  };
  return {
    ensureParkedTerminal: vi.fn(() => ({
      host: document.createElement("div"),
      term,
      fit: { fit: vi.fn() },
    })),
    blurParkedTerminal: vi.fn(),
    copyTerminalSelection: vi.fn(),
    focusParkedTerminal: vi.fn(),
    isParkedHost: vi.fn(() => false),
    pasteIntoTerminal: vi.fn(),
    pasteTerminalText: vi.fn(),
    releaseParkedTerminal: vi.fn(),
    setTerminalRefitter: vi.fn(() => () => {}),
    setTerminalSearchOpener: vi.fn(() => () => {}),
    terminalScrollbackText: vi.fn(() => "last line"),
    terminalSelection: vi.fn(() => ""),
    terminalTailText: vi.fn(() => ""),
  };
});

import { ptyWrite } from "../bridge";
import { reportError } from "../uiErrors";
import { TerminalView } from "./TerminalView";

class NoopResizeObserver {
  observe() {}
  disconnect() {}
}

const flush = () => act(async () => {});

function mount(props: Partial<Parameters<typeof TerminalView>[0]> = {}) {
  keyHandler = null;
  dataHandler = null;
  render(<TerminalView ptyId="pty-1" cwd="/tmp" launch="role" fontSize={13} {...props} />);
}

describe("TerminalView reports failed writes and copies", () => {
  const writeError = new Error("no terminal: pty-1");
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", NoopResizeObserver);
    vi.mocked(reportError).mockClear();
    vi.mocked(ptyWrite).mockReset();
    vi.mocked(ptyWrite).mockImplementation(() => Promise.reject(writeError));
    live = { exitCode: null, exited: false, buffer: { attach: () => () => {} } };
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a keystroke (or drop-paste) the PTY rejects is shown, once per source", async () => {
    mount();
    dataHandler!("a");
    dataHandler!("b");
    await flush();
    expect(reportError).toHaveBeenCalledWith("Keystrokes not sent", writeError, { notify: true, once: true });
  });

  it("a Shift+Enter the PTY rejects is shown too", async () => {
    mount();
    keyHandler!(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", shiftKey: true }));
    await flush();
    expect(reportError).toHaveBeenCalledWith("Keystrokes not sent", writeError, { notify: true, once: true });
  });

  it("typing into an exited terminal is not an error", async () => {
    live = { exitCode: 0, exited: true, buffer: { attach: () => () => {} } };
    mount();
    dataHandler!("a");
    await flush();
    expect(reportError).not.toHaveBeenCalledWith("Keystrokes not sent", expect.anything(), expect.anything());
  });

  it("a file-drop listener that fails to start goes to the log once", async () => {
    mount();
    await flush();
    expect(reportError).toHaveBeenCalledWith("File drop unavailable", dropError, { once: true });
  });

  it("Copy last 50 lines that fails is shown", async () => {
    const copyError = new Error("clipboard denied");
    vi.stubGlobal("navigator", {
      ...navigator,
      platform: "MacIntel",
      clipboard: { writeText: vi.fn(() => Promise.reject(copyError)) },
    });
    live = { exitCode: 1, exited: true, buffer: { attach: () => () => {} } };
    mount({ claudeSession: true });
    fireEvent.click(await screen.findByRole("button", { name: "Copy last 50 lines" }));
    await flush();
    expect(reportError).toHaveBeenCalledWith("Copy failed", copyError, { notify: true });
  });
});
