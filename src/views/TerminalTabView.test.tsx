// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TabSummary } from "../bridge";

vi.mock("../bridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../bridge")>()),
  // No Tauri bridge: a channel that never delivers.
  createPtyChannel: () => ({ onmessage: () => {} }),
}));
vi.mock("../components/TerminalView", () => ({
  TerminalView: () => <div data-testid="terminal-view" />,
}));
vi.mock("../components/TerminalScratchPad", () => ({ TerminalScratchPad: () => null }));
vi.mock("./TerminalChatView", () => ({
  TerminalChatView: () => <div data-testid="terminal-chat-view" />,
}));

const { beginLivePty, dropLivePty } = await import("../terminal/live");
const { TerminalTabView } = await import("./TerminalTabView");

const tab: TabSummary = {
  id: "restored",
  label: "Planner",
  roleId: "role_planner",
  cwd: "/repo",
  phase: "running",
  mergedPromptChars: 0,
  startupPromptSent: true,
  hasTranscript: false,
  folderStatus: "ok",
  color: "#58a6ff",
  kind: "terminal",
  terminalLaunch: "role",
  provider: "claude",
  acpSessionId: null,
};

describe("TerminalTabView", () => {
  it("shows a tab restored as Chat as the chat view once its PTY starts", () => {
    const props = {
      activeTabId: tab.id,
      activeTabSummary: tab,
      handoffs: [],
      roles: [],
      promptFileTabs: [],
      terminalError: null,
      isPlanTerminal: false,
      terminalRoute: null,
      fontSize: 13,
      header: null,
      inGrid: false,
      scratch: { history: [] },
      platform: "mac",
      padOpen: false,
      uiSettings: {},
      padSizeProps: {},
      terminalPadRef: { current: null },
      view: "chat",
    } as unknown as Parameters<typeof TerminalTabView>[0];
    render(<TerminalTabView {...props} />);
    // The terminal opens the PTY first.
    expect(screen.getByTestId("terminal-view")).toBeTruthy();
    expect(screen.queryByTestId("terminal-chat-view")).toBeNull();
    act(() => {
      beginLivePty(tab.id);
    });
    // No unrelated re-render needed.
    expect(screen.getByTestId("terminal-chat-view")).toBeTruthy();
    expect(screen.queryByTestId("terminal-view")).toBeNull();
    dropLivePty(tab.id);
  });
});
