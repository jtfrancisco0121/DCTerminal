// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A crash and "Reload this pane" around a terminal must reattach to the
// live PTY (parked xterm, same process), never open a second one.

vi.mock("../bridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../bridge")>()),
  ptyOpen: vi.fn(() => Promise.resolve()),
  ptyResize: vi.fn(() => Promise.resolve()),
  ptyWrite: vi.fn(() => Promise.resolve()),
  terminalSessionLog: vi.fn(() => Promise.resolve(null)),
  createPtyChannel: vi.fn(() => ({ onmessage: null })),
}));

const host = document.createElement("div");

vi.mock("../terminal/park", () => {
  const term = {
    cols: 80,
    rows: 24,
    options: {} as Record<string, unknown>,
    focus: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    write: vi.fn(),
    attachCustomKeyEventHandler: vi.fn(),
  };
  return {
    ensureParkedTerminal: vi.fn(() => ({ host, term, fit: { fit: vi.fn() } })),
    blurParkedTerminal: vi.fn(),
    clearTerminalScrollback: vi.fn(),
    copyTerminalSelection: vi.fn(),
    focusParkedTerminal: vi.fn(),
    isParkedHost: vi.fn(() => true),
    measuredTerminalSize: vi.fn(() => ({ cols: 80, rows: 24 })),
    noteTerminalSize: vi.fn(),
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

import { ptyOpen } from "../bridge";
import { dropLivePty, livePty } from "../terminal/live";
import { requestPaneCrash } from "./devPaneCrash";
import { PaneBoundary } from "./PaneBoundary";
import { TerminalView } from "./TerminalView";

class NoopResizeObserver {
  observe() {}
  disconnect() {}
}

describe("PaneBoundary around a terminal", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", NoopResizeObserver);
    vi.mocked(ptyOpen).mockClear();
    vi.spyOn(console, "error").mockImplementation(() => {});
    document.body.innerHTML = '<div id="terminal-park"></div>';
  });
  afterEach(() => {
    dropLivePty("pty-crash");
    vi.restoreAllMocks();
  });

  it("a crash parks the xterm and Reload reattaches it without a second ptyOpen", () => {
    render(
      <PaneBoundary label="Terminal view" paneId="pty-crash">
        {/* Same expression as the pane renderers: open only when no PTY is live. */}
        <TerminalView ptyId="pty-crash" cwd="/tmp" launch="shell" fontSize={13} autoOpen={!livePty("pty-crash")} />
      </PaneBoundary>,
    );
    expect(ptyOpen).toHaveBeenCalledTimes(1);
    const live = livePty("pty-crash");
    expect(live).toBeTruthy();

    act(() => requestPaneCrash("pty-crash"));
    expect(screen.getByRole("alert")).toBeTruthy();
    // The xterm host went back to the park, not away.
    expect(host.parentElement?.id).toBe("terminal-park");

    fireEvent.click(screen.getByRole("button", { name: "Reload this pane" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(host.parentElement?.id).not.toBe("terminal-park");
    expect(ptyOpen).toHaveBeenCalledTimes(1);
    expect(livePty("pty-crash")).toBe(live);
  });
});
