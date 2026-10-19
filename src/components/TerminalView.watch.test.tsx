// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type KeyHandler = (event: KeyboardEvent) => boolean;
let keyHandler: KeyHandler | null = null;
let dataHandler: ((data: string) => void) | null = null;

vi.mock("../bridge", () => ({
  ptyOpen: vi.fn(() => Promise.resolve()),
  ptyResize: vi.fn(() => Promise.resolve()),
  ptyWrite: vi.fn(() => Promise.resolve()),
  terminalSessionLog: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));

vi.mock("../terminal/live", () => ({
  beginLivePty: vi.fn(),
  clearPtyOpening: vi.fn(),
  isPtyOpening: vi.fn(() => false),
  livePty: vi.fn(() => ({ exitCode: null, exited: false, buffer: { attach: () => () => {} } })),
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
    ensureParkedTerminal: vi.fn(() => ({ host: document.createElement("div"), term, fit: { fit: vi.fn() } })),
    blurParkedTerminal: vi.fn(),
    copyTerminalSelection: vi.fn(),
    focusParkedTerminal: vi.fn(),
    isParkedHost: vi.fn(() => false),
    pasteIntoTerminal: vi.fn(),
    pasteTerminalText: vi.fn(),
    releaseParkedTerminal: vi.fn(),
    setTerminalRefitter: vi.fn(() => () => {}),
    setTerminalSearchOpener: vi.fn(() => () => {}),
    terminalScrollbackText: vi.fn(() => ""),
    terminalSelection: vi.fn(() => ""),
    terminalTailText: vi.fn(() => ""),
  };
});

import { ptyWrite } from "../bridge";
import { TerminalView, type StageWatch } from "./TerminalView";

class NoopResizeObserver {
  observe() {}
  disconnect() {}
}

function view(watch: StageWatch | null) {
  return <TerminalView ptyId="stage-1" cwd="/repo" launch="role" fontSize={13} claudeSession watch={watch} />;
}

const shiftEnter = (type: string) =>
  ({ type, key: "Enter", code: "Enter", shiftKey: true, ctrlKey: false, metaKey: false, altKey: false, repeat: false }) as unknown as KeyboardEvent;

describe("TerminalView watching a pipeline stage (V5, D27)", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", NoopResizeObserver);
    vi.mocked(ptyWrite).mockClear();
    keyHandler = null;
    dataHandler = null;
  });

  it("sends no keystrokes while autopilot drives the stage, and offers Take over", () => {
    const onTakeOver = vi.fn();
    render(view({ canType: false, takenOver: false, onTakeOver }));
    act(() => dataHandler!("y"));
    expect(keyHandler!(shiftEnter("keydown"))).toBe(false);
    expect(ptyWrite).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toMatch(/read-only/i);
    fireEvent.click(screen.getByRole("button", { name: "Take over" }));
    expect(onTakeOver).toHaveBeenCalledTimes(1);
  });

  it("takes keystrokes while the stage needs you", () => {
    const { rerender } = render(view({ canType: false, takenOver: false }));
    act(() => dataHandler!("y"));
    expect(ptyWrite).not.toHaveBeenCalled();
    // A permission dialog came up: the same view takes the answer.
    rerender(view({ canType: true, takenOver: false }));
    act(() => dataHandler!("1"));
    expect(ptyWrite).toHaveBeenCalledWith("stage-1", "1");
    expect(screen.queryByRole("button", { name: "Take over" })).toBeNull();
  });

  it("takes keystrokes once you took the stage over, and offers Hand back", () => {
    const onHandBack = vi.fn();
    render(view({ canType: true, takenOver: true, onHandBack }));
    act(() => dataHandler!("hello"));
    expect(ptyWrite).toHaveBeenCalledWith("stage-1", "hello");
    fireEvent.click(screen.getByRole("button", { name: "Hand back" }));
    expect(onHandBack).toHaveBeenCalledTimes(1);
  });

  it("leaves every other terminal as it was", () => {
    render(view(null));
    act(() => dataHandler!("ls\r"));
    expect(ptyWrite).toHaveBeenCalledWith("stage-1", "ls\r");
    expect(screen.queryByRole("button", { name: "Take over" })).toBeNull();
  });
});
