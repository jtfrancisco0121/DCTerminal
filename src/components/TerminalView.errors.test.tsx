// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type KeyHandler = (event: KeyboardEvent) => boolean;
let keyHandler: KeyHandler | null = null;
let dataHandler: ((data: string) => void) | null = null;
let live: { exitCode: number | null; exited: boolean; buffer: { attach: () => () => void } } | undefined;
const dropError = new Error("drag-drop listen denied");

// The real reporter behind a spy, so its once-keys are exercised too.
vi.mock("../uiErrors", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../uiErrors")>();
  return { ...actual, reportError: vi.fn(actual.reportError) };
});

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
import { clearUiErrors, reportError, setErrorNotifier, uiErrors } from "../uiErrors";
import { KEYSTROKE_SETTLE_MS, TerminalView } from "./TerminalView";

class NoopResizeObserver {
  observe() {}
  disconnect() {}
}

const flush = () => act(async () => {});
/** Past the window in which a just-died PTY's exit event can still arrive. */
const settle = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(KEYSTROKE_SETTLE_MS);
  });

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
    clearUiErrors();
    vi.mocked(ptyWrite).mockReset();
    vi.mocked(ptyWrite).mockImplementation(() => Promise.reject(writeError));
    live = { exitCode: null, exited: false, buffer: { attach: () => () => {} } };
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setErrorNotifier(null);
  });

  it("a keystroke (or drop-paste) the PTY rejects is shown, once per terminal", async () => {
    vi.useFakeTimers();
    mount();
    dataHandler!("a");
    dataHandler!("b");
    await flush();
    // Not yet: the PTY may have just died and its exit event be on the way.
    expect(reportError).not.toHaveBeenCalledWith("Keystrokes not sent", expect.anything(), expect.anything());
    await settle();
    expect(reportError).toHaveBeenCalledWith("Keystrokes not sent", writeError, {
      notify: true,
      once: "Keystrokes not sent:pty-1",
    });
  });

  it("a Shift+Enter the PTY rejects is shown too", async () => {
    vi.useFakeTimers();
    mount();
    keyHandler!(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", shiftKey: true }));
    await settle();
    expect(reportError).toHaveBeenCalledWith("Keystrokes not sent", writeError, {
      notify: true,
      once: "Keystrokes not sent:pty-1",
    });
  });

  it("a rejected keystroke is shown once per terminal, not once per window", async () => {
    vi.useFakeTimers();
    const notify = vi.fn();
    setErrorNotifier(notify);
    mount({ ptyId: "pty-1" });
    const typeInFirst = dataHandler!;
    mount({ ptyId: "pty-2" });
    const typeInSecond = dataHandler!;
    typeInFirst("a");
    typeInFirst("b");
    typeInSecond("c");
    typeInSecond("d");
    await settle();
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenNthCalledWith(1, "Keystrokes not sent", "no terminal: pty-1");
    expect(notify).toHaveBeenNthCalledWith(2, "Keystrokes not sent", "no terminal: pty-1");
    expect(uiErrors().filter((entry) => entry.source === "Keystrokes not sent")).toHaveLength(2);
  });

  it("typing into an exited terminal is not an error", async () => {
    vi.useFakeTimers();
    live = { exitCode: 0, exited: true, buffer: { attach: () => () => {} } };
    mount();
    dataHandler!("a");
    await settle();
    // Only the report is held back; the write still goes to the PTY.
    expect(ptyWrite).toHaveBeenCalledWith("pty-1", "a");
    expect(reportError).not.toHaveBeenCalledWith("Keystrokes not sent", expect.anything(), expect.anything());
  });

  it("a write the PTY rejects because it just died is not an error once its exit event lands", async () => {
    vi.useFakeTimers();
    mount();
    dataHandler!("a");
    await flush();
    // The exit event arrives inside the settle window.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(KEYSTROKE_SETTLE_MS / 2);
    });
    live!.exitCode = 1;
    live!.exited = true;
    await settle();
    expect(ptyWrite).toHaveBeenCalledWith("pty-1", "a");
    expect(reportError).not.toHaveBeenCalledWith("Keystrokes not sent", expect.anything(), expect.anything());
  });

  it("a write the PTY rejects while it stays live past the settle window is shown once", async () => {
    vi.useFakeTimers();
    const notify = vi.fn();
    setErrorNotifier(notify);
    mount();
    dataHandler!("a");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(KEYSTROKE_SETTLE_MS - 1);
    });
    expect(notify).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    dataHandler!("b");
    await settle();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("Keystrokes not sent", "no terminal: pty-1");
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
