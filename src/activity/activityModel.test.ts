import { describe, expect, it } from "vitest";
import type { ActivityEntry, SessionToolCall } from "../bridge";
import {
  countActivity,
  decisionLabel,
  matchesFilter,
  statusLabel,
  summaryLine,
  terminalActivityEntries,
} from "./activityModel";

function entry(over: Partial<ActivityEntry>): ActivityEntry {
  return {
    id: over.id ?? "t1",
    tabId: "tab_a",
    time: "2026-10-10T10:00:00Z",
    updatedAt: "2026-10-10T10:00:00Z",
    kind: "shell",
    title: "",
    summary: "ls",
    decision: "none",
    network: false,
    status: "completed",
    ...over,
  };
}

describe("activityModel", () => {
  const entries = [
    entry({ id: "a", kind: "shell" }),
    entry({ id: "b", kind: "shell", network: true, summary: "curl https://x" }),
    entry({ id: "c", kind: "write" }),
    entry({ id: "d", kind: "edit", decision: "user_reject" }),
    entry({ id: "e", kind: "fetch", network: true, decision: "auto_allow" }),
    entry({ id: "f", kind: "weird" }),
  ];

  it("counts per kind, rejected, and network", () => {
    const counts = countActivity(entries);
    expect(counts.shell).toBe(2);
    expect(counts.write).toBe(1);
    expect(counts.edit).toBe(1);
    expect(counts.fetch).toBe(1);
    expect(counts.mcp).toBe(0);
    expect(counts.other).toBe(1);
    expect(counts.rejected).toBe(1);
    expect(counts.network).toBe(2);
  });

  it("writes the header line with the headline kinds even at zero", () => {
    expect(summaryLine(countActivity(entries))).toBe(
      "shell 2 · write 1 · edit 1 · fetch 1 · mcp 0 · other 1 · rejected 1",
    );
    expect(summaryLine(countActivity([]))).toBe("shell 0 · write 0 · fetch 0 · mcp 0 · rejected 0");
  });

  it("filters by kind, network, and rejected", () => {
    const ids = (filter: Parameters<typeof matchesFilter>[1]) =>
      entries.filter((e) => matchesFilter(e, filter)).map((e) => e.id);
    expect(ids(null)).toHaveLength(6);
    expect(ids("shell")).toEqual(["a", "b"]);
    expect(ids("network")).toEqual(["b", "e"]);
    expect(ids("rejected")).toEqual(["d"]);
    expect(ids("other")).toEqual(["f"]);
  });

  it("labels decisions and statuses", () => {
    expect(decisionLabel("auto_allow")).toBe("auto");
    expect(decisionLabel("user_allow")).toBe("you allowed");
    expect(decisionLabel("none")).toBe("no ask");
    expect(statusLabel("completed")).toBe("done");
    expect(statusLabel(null)).toBe("");
  });
});

describe("terminalActivityEntries", () => {
  it("maps session-log tool calls to activity rows", () => {
    // The backend sends path, command, url and at as null when they are empty.
    const filled = (call: Partial<SessionToolCall>) =>
      ({ path: null, command: null, url: null, at: null, ...call }) as SessionToolCall;
    const rows = terminalActivityEntries("t1", ([
      { id: "a", name: "Bash", kind: "execute", title: "Run", command: "npm test", status: "completed", at: "2026-10-10T10:00:00Z" },
      { id: "b", name: "Read", kind: "read", title: "Read a.ts", path: "src/a.ts", status: "completed" },
      { id: "c", name: "Write", kind: "edit", title: "Write b.ts", path: "src/b.ts", status: "failed" },
      { id: "d", name: "WebFetch", kind: "fetch", title: "Fetch", url: "https://x.dev", status: "pending" },
      { id: "e", name: "mcp__github__get_issue", kind: "other", title: "get_issue", status: "completed" },
      { id: "f", name: "TodoWrite", kind: "other", title: "", status: "completed" },
    ] as Partial<SessionToolCall>[]).map(filled));
    expect(rows.map((row) => [row.kind, row.summary, row.network, row.status])).toEqual([
      ["shell", "npm test", false, "completed"],
      ["read", "src/a.ts", false, "completed"],
      ["edit", "src/b.ts", false, "failed"],
      ["fetch", "https://x.dev", true, "pending"],
      ["mcp", "get_issue", false, "completed"],
      ["other", "TodoWrite", false, "completed"],
    ]);
    expect(rows.every((row) => row.decision === "none" && row.tabId === "t1")).toBe(true);
    expect(rows[0].time).toBe("2026-10-10T10:00:00Z");
    expect(rows[1].time).toBe("");
    expect(summaryLine(countActivity(rows))).toBe(
      "shell 1 · write 0 · edit 1 · fetch 1 · mcp 1 · read 1 · other 1 · rejected 0",
    );
  });
});
