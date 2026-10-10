// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../bridge", () => ({
  activityList: vi.fn(),
  activityClear: vi.fn(),
  terminalSessionLog: vi.fn(),
}));

import {
  activityClear,
  activityList,
  terminalSessionLog,
  type ActivityEntry,
  type TerminalSessionLog,
  type TerminalToolCall,
} from "../bridge";
import { ACTIVITY_POLL_MS, ActivityPanel } from "./ActivityPanel";
import { ActivityButton } from "./ActivityButton";

const row = (over: Partial<ActivityEntry>): ActivityEntry => ({
  id: "t1",
  tabId: "t1",
  time: "2026-10-10T10:00:00Z",
  updatedAt: "2026-10-10T10:00:05Z",
  kind: "shell",
  title: "",
  summary: "npm test",
  decision: "none",
  network: false,
  status: "completed",
  ...over,
});

const sample = [
  row({ id: "a", kind: "shell", summary: "npm test" }),
  row({ id: "b", kind: "write", summary: "src/new.ts", decision: "auto_allow" }),
  row({ id: "c", kind: "fetch", summary: "https://example.com", network: true }),
  row({ id: "d", kind: "edit", summary: "src/app.ts", decision: "user_reject", status: "failed" }),
];

const call = (over: Partial<TerminalToolCall>): TerminalToolCall => ({
  id: "c1",
  name: "Bash",
  kind: "execute",
  title: "Run tests",
  status: "completed",
  at: "2026-10-10T10:00:00Z",
  ...over,
});

const sessionLog = (toolCalls: TerminalToolCall[]): TerminalSessionLog => ({
  sessionId: "s1",
  path: "/tmp/s1.jsonl",
  turnDone: true,
  lastReply: "",
  plan: null,
  planAt: null,
  lastPromptAt: null,
  toolCalls,
});

const terminalCalls = [
  call({ id: "x", name: "Bash", kind: "execute", command: "npm test" }),
  call({ id: "y", name: "Read", kind: "read", path: "src/a.ts" }),
  call({ id: "z", name: "Edit", kind: "edit", path: "src/b.ts", status: "failed" }),
  call({ id: "w", name: "WebFetch", kind: "fetch", url: "https://example.com", status: "pending" }),
];

const bodyRows = () =>
  within(screen.getByRole("table", { name: "Agent activity" }))
    .getAllByRole("row")
    .slice(1);

describe("ActivityPanel", () => {
  beforeEach(() => {
    vi.mocked(activityList).mockReset().mockResolvedValue(sample);
    vi.mocked(activityClear).mockReset().mockResolvedValue(undefined);
    vi.mocked(terminalSessionLog).mockReset().mockResolvedValue(null);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows counts per kind and rows newest first", async () => {
    render(<ActivityPanel tabId="t1" tabLabel="Dev" busy={false} onClose={() => {}} />);
    await screen.findByRole("table", { name: "Agent activity" });
    expect(vi.mocked(activityList)).toHaveBeenCalledWith("t1");
    expect(screen.getByTestId("activity-counts").textContent).toBe(
      "shell 1 · write 1 · edit 1 · fetch 1 · mcp 0 · rejected 1",
    );
    const rows = bodyRows();
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("src/app.ts"),
      expect.stringContaining("https://example.com"),
      expect.stringContaining("src/new.ts"),
      expect.stringContaining("npm test"),
    ]);
    expect(rows[0].textContent).toContain("you rejected");
    expect(rows[0].textContent).toContain("failed");
    expect(rows[1].querySelector(".activity-network")).not.toBeNull();
    expect(rows[2].textContent).toContain("auto");
    expect(rows[3].textContent).toContain("no ask");
  });

  it("filters by a kind chip and toggles back to all", async () => {
    render(<ActivityPanel tabId="t1" tabLabel="Dev" busy={false} onClose={() => {}} />);
    await screen.findByRole("table", { name: "Agent activity" });
    const chips = screen.getByRole("group", { name: "Filter by kind" });
    expect(within(chips).getByRole("button", { name: "mcp 0" })).toHaveProperty("disabled", true);
    fireEvent.click(within(chips).getByRole("button", { name: "network 1" }));
    expect(bodyRows()).toHaveLength(1);
    expect(bodyRows()[0].textContent).toContain("https://example.com");
    fireEvent.click(within(chips).getByRole("button", { name: "rejected 1" }));
    expect(bodyRows()[0].textContent).toContain("src/app.ts");
    fireEvent.click(within(chips).getByRole("button", { name: "rejected 1" }));
    expect(bodyRows()).toHaveLength(4);
  });

  it("polls while the tab is busy", async () => {
    vi.useFakeTimers();
    render(<ActivityPanel tabId="t1" tabLabel="Dev" busy onClose={() => {}} />);
    await act(async () => {});
    expect(vi.mocked(activityList)).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(ACTIVITY_POLL_MS * 2);
    });
    expect(vi.mocked(activityList)).toHaveBeenCalledTimes(3);
  });

  it("explains an empty terminal tab and clears after confirming", async () => {
    vi.mocked(activityList).mockResolvedValue([]);
    const { unmount } = render(
      <ActivityPanel tabId="t1" tabLabel="Term" busy={false} terminal onClose={() => {}} />,
    );
    expect(await screen.findByText(/Terminal tabs run the CLI directly/)).toBeTruthy();
    unmount();

    vi.mocked(activityList).mockResolvedValue(sample);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<ActivityPanel tabId="t1" tabLabel="Dev" busy={false} onClose={() => {}} />);
    await screen.findByRole("table", { name: "Agent activity" });
    vi.mocked(activityList).mockResolvedValue([]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Clear…" }));
    });
    expect(confirm).toHaveBeenCalled();
    expect(vi.mocked(activityClear)).toHaveBeenCalledWith("t1");
    expect(await screen.findByText(/No tool calls yet/)).toBeTruthy();
    confirm.mockRestore();
  });

  it("shows a terminal tab's session-log tool calls, read-only", async () => {
    vi.mocked(terminalSessionLog).mockResolvedValue(sessionLog(terminalCalls));
    render(<ActivityPanel tabId="t1" tabLabel="Term" busy={false} terminal onClose={() => {}} />);
    await screen.findByRole("table", { name: "Agent activity" });
    expect(vi.mocked(terminalSessionLog)).toHaveBeenCalledWith("t1");
    expect(vi.mocked(activityList)).not.toHaveBeenCalled();
    expect(screen.getByTestId("activity-counts").textContent).toBe(
      "shell 1 · write 0 · edit 1 · fetch 1 · mcp 0 · read 1 · rejected 0",
    );
    const rows = bodyRows();
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("https://example.com"),
      expect.stringContaining("src/b.ts"),
      expect.stringContaining("src/a.ts"),
      expect.stringContaining("npm test"),
    ]);
    expect(rows[0].textContent).toContain("pending");
    expect(rows[0].querySelector(".activity-network")).not.toBeNull();
    expect(rows[1].textContent).toContain("failed");
    expect(rows[3].textContent).toContain("no ask");
    expect(screen.queryByRole("button", { name: "Clear…" })).toBeNull();
    const chips = screen.getByRole("group", { name: "Filter by kind" });
    fireEvent.click(within(chips).getByRole("button", { name: "shell 1" }));
    expect(bodyRows()).toHaveLength(1);
    expect(bodyRows()[0].textContent).toContain("npm test");
  });

  it("says when a Claude terminal has made no tool calls yet", async () => {
    vi.mocked(terminalSessionLog).mockResolvedValue(sessionLog([]));
    render(<ActivityPanel tabId="t1" tabLabel="Term" busy={false} terminal onClose={() => {}} />);
    expect(await screen.findByText(/No tool calls yet in this Claude session/)).toBeTruthy();
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(<ActivityPanel tabId="t1" tabLabel="Dev" busy={false} onClose={onClose} />);
    const dialog = await screen.findByRole("dialog", { name: "Activity in Dev" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});

describe("ActivityButton", () => {
  beforeEach(() => {
    vi.mocked(activityList).mockReset().mockResolvedValue(sample);
    vi.mocked(terminalSessionLog).mockReset().mockResolvedValue(null);
  });

  it("counts a terminal tab's session-log tool calls", async () => {
    vi.mocked(terminalSessionLog).mockResolvedValue(sessionLog(terminalCalls.slice(0, 2)));
    render(<ActivityButton tabId="t1" busy={false} terminal onOpen={() => {}} />);
    expect(await screen.findByRole("button", { name: "Activity (2)" })).toBeTruthy();
    expect(vi.mocked(activityList)).not.toHaveBeenCalled();
  });

  it("shows the row count and opens the panel", async () => {
    const onOpen = vi.fn();
    render(<ActivityButton tabId="t1" busy={false} onOpen={onOpen} />);
    const button = await screen.findByRole("button", { name: "Activity (4)" });
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalled();
  });
});
