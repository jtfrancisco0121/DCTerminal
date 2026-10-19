// @vitest-environment jsdom
import { cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type KeyHandler = (event: KeyboardEvent) => boolean;
let keyHandler: KeyHandler | null = null;

vi.mock("../bridge", () => ({
  ptyOpen: vi.fn(() => Promise.resolve()),
  ptyResize: vi.fn(() => Promise.resolve()),
  ptyWrite: vi.fn(() => Promise.resolve()),
}));

vi.mock("../terminal/park", () => {
  const term = {
    cols: 80,
    rows: 24,
    options: {} as Record<string, unknown>,
    focus: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
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
    pasteTerminalText: vi.fn(),
    releaseParkedTerminal: vi.fn(),
    setTerminalRefitter: vi.fn(() => () => {}),
    setTerminalSearchOpener: vi.fn(() => () => {}),
    terminalScrollbackText: vi.fn(() => ""),
    terminalSelection: vi.fn(() => ""),
    terminalTailText: vi.fn(() => ""),
  };
});

import { ptyWrite, type TerminalLaunch } from "../bridge";
import { useAppShortcuts } from "../useAppShortcuts";
import { TerminalView } from "./TerminalView";

class NoopResizeObserver {
  observe() {}
  disconnect() {}
}

function shiftEnter(type: "keydown" | "keyup"): KeyboardEvent {
  return new KeyboardEvent(type, { key: "Enter", code: "Enter", shiftKey: true });
}

function mount(launch: TerminalLaunch) {
  keyHandler = null;
  render(<TerminalView ptyId={`pty-${launch}`} cwd="/tmp" launch={launch} fontSize={13} />);
  expect(keyHandler).not.toBeNull();
  return keyHandler!;
}

describe("TerminalView Shift+Enter", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", NoopResizeObserver);
    vi.mocked(ptyWrite).mockClear();
  });

  it.each(["role", "claude-cli"] as const)("sends ESC+CR to a %s terminal", (launch) => {
    const handler = mount(launch);
    expect(handler(shiftEnter("keydown"))).toBe(false);
    expect(handler(shiftEnter("keyup"))).toBe(false);
    expect(ptyWrite).toHaveBeenCalledTimes(1);
    expect(ptyWrite).toHaveBeenCalledWith(`pty-${launch}`, "\u001b\r");
  });

  it.each(["shell", "cursor-cli"] as const)("leaves Shift+Enter to xterm in a %s terminal", (launch) => {
    const handler = mount(launch);
    expect(handler(shiftEnter("keydown"))).toBe(true);
    expect(ptyWrite).not.toHaveBeenCalled();
  });
});

describe("TerminalView context menu dismiss button", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", NoopResizeObserver);
  });
  afterEach(cleanup);

  // Tab from the last menu item lands on the full-screen dismiss button, which
  // sits outside the menu root. Escape there closes the menu (the owner's
  // listener) and must not also cancel a running chat turn.
  it("leaves a running chat turn alone on Escape", () => {
    const onCancelTurn = vi.fn();
    renderHook(() =>
      useAppShortcuts({
        platform: "mac",
        dialogOpen: false,
        promptInFlight: true,
        onAction: () => {},
        onCancelTurn,
      }),
    );
    const { container } = render(<TerminalView ptyId="pty-menu" cwd="/tmp" launch="shell" fontSize={13} />);
    fireEvent.contextMenu(container.querySelector(".terminal-view")!);
    const dismiss = screen.getByRole("button", { name: "Close menu" });
    fireEvent.keyDown(dismiss, { key: "Escape" });
    expect(onCancelTurn).not.toHaveBeenCalled();
  });
});
