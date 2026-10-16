// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ChatEntry } from "../bridge";
import { EMPTY_CHAT, type ChatEntriesState } from "../terminal/chatEntries";

let state: ChatEntriesState = EMPTY_CHAT;
vi.mock("../terminal/chatEntriesStore", () => ({
  useChatEntries: () => state,
}));

const { SubAgentIndicator, TerminalChatView, TerminalViewSwitch } = await import("./TerminalChatView");

const AT = "2026-10-16T10:00:00.000Z";
const entries: ChatEntry[] = [
  { seq: 0, rev: 1, at: AT, kind: "user", text: "Plan the fix" },
  { seq: 1, rev: 2, at: AT, kind: "assistant", text: "Looking at **auth**." },
  {
    seq: 2, rev: 3, at: AT, kind: "tool", toolId: "r1", name: "Read", title: "Read: /repo/a.rs",
    toolKind: "read", status: "done", endedAt: "2026-10-16T10:00:01.000Z",
  },
  {
    seq: 3, rev: 4, at: AT, kind: "subAgent", toolId: "a1", description: "Explore auth",
    agentType: "Explore", background: false, status: "running", endedAt: null,
  },
  {
    seq: 4, rev: 5, at: AT, kind: "subAgent", toolId: "a2", description: "Scan tests",
    agentType: null, background: false, status: "done", endedAt: "2026-10-16T10:00:42.000Z",
  },
  { seq: 5, rev: 6, at: AT, kind: "plan", toolId: "p1", plan: "# Plan\n- step one", status: "running", endedAt: null },
  {
    seq: 6, rev: 7, at: AT, kind: "question", toolId: "q1", status: "done", endedAt: AT,
    questions: [{ header: "DB", question: "Which DB?", options: ["Postgres", "SQLite"], multiSelect: false }],
  },
];

describe("TerminalChatView", () => {
  it("renders prompts, replies, tools, sub-agents, the plan and a question", () => {
    state = { sessionId: "s1", revision: 7, entries };
    render(<TerminalChatView tabId="t1" needsYou={false} onShowTerminal={() => {}} />);
    expect(screen.getByText("Plan the fix")).toBeTruthy();
    expect(screen.getByText("auth").tagName).toBe("STRONG");
    expect(screen.getByText("Read: /repo/a.rs")).toBeTruthy();
    const agents = screen.getAllByTestId("terminal-chat-subagent");
    expect(agents).toHaveLength(2);
    expect(agents[0].textContent).toContain("Explore auth");
    expect(agents[0].textContent).toContain("Running");
    expect(agents[1].textContent).toContain("42s");
    const plan = screen.getByRole("region", { name: "Plan" });
    expect(plan.textContent).toContain("step one");
    expect(plan.textContent).toContain("Waiting for you in the terminal");
    expect(screen.getByRole("region", { name: "Question" }).textContent).toContain("Postgres");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the Needs you banner, whose button goes back to the terminal", () => {
    state = { sessionId: "s1", revision: 7, entries };
    const onShowTerminal = vi.fn();
    render(<TerminalChatView tabId="t1" needsYou onShowTerminal={onShowTerminal} />);
    expect(screen.getByRole("alert").textContent).toContain("Claude is waiting for you in the terminal");
    fireEvent.click(screen.getByRole("button", { name: "Show terminal" }));
    expect(onShowTerminal).toHaveBeenCalled();
  });

  it("says so when there is no conversation yet", () => {
    state = EMPTY_CHAT;
    render(<TerminalChatView tabId="t1" needsYou={false} onShowTerminal={() => {}} />);
    expect(screen.getByText(/No conversation yet/)).toBeTruthy();
  });
});

describe("header pieces", () => {
  it("counts running sub-agents and hides with none", () => {
    state = { sessionId: "s1", revision: 7, entries };
    const { container, rerender } = render(<SubAgentIndicator tabId="t1" />);
    expect(container.textContent).toBe("1 sub-agent running");
    state = { sessionId: "s1", revision: 8, entries: entries.slice(0, 3) };
    rerender(<SubAgentIndicator tabId="t2" />);
    expect(container.textContent).toBe("");
  });

  it("switches between Terminal and Chat", () => {
    const onChange = vi.fn();
    render(<TerminalViewSwitch tabId="t1" view="terminal" onChange={onChange} />);
    expect(screen.getByRole("radio", { name: "Terminal" })).toHaveProperty("checked", true);
    fireEvent.click(screen.getByRole("radio", { name: "Chat" }));
    expect(onChange).toHaveBeenCalledWith("chat");
  });
});
