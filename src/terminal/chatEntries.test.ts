import { describe, expect, it } from "vitest";
import type { ChatEntriesUpdate, ChatEntry } from "../bridge";
import {
  applyChatUpdate,
  chatRows,
  decisionText,
  durationMs,
  EMPTY_CHAT,
  formatDuration,
  openDecision,
  runningSubAgents,
  subAgentText,
  terminalViewOf,
  toolGroupText,
} from "./chatEntries";

const user = (seq: number, text = `p${seq}`, rev = seq + 1): ChatEntry => ({
  seq,
  rev,
  at: null,
  kind: "user",
  text,
});

const tool = (seq: number, status: "running" | "done" | "error" = "done"): ChatEntry => ({
  seq,
  rev: seq + 1,
  at: "2026-10-16T10:00:00.000Z",
  kind: "tool",
  toolId: `t${seq}`,
  name: "Read",
  title: `Read: /a${seq}`,
  toolKind: "read",
  status,
  endedAt: null,
});

const agent = (seq: number, status: "running" | "done", description = `agent ${seq}`): ChatEntry => ({
  seq,
  rev: seq + 1,
  at: "2026-10-16T10:00:00.000Z",
  kind: "subAgent",
  toolId: `a${seq}`,
  description,
  agentType: "Explore",
  background: false,
  status,
  endedAt: status === "done" ? "2026-10-16T10:00:42.000Z" : null,
});

const update = (over: Partial<ChatEntriesUpdate>): ChatEntriesUpdate => ({
  sessionId: "s1",
  revision: 10,
  reset: false,
  firstSeq: 0,
  entries: [],
  ...over,
});

describe("applyChatUpdate", () => {
  it("replaces on a reset and merges a delta by seq", () => {
    const first = applyChatUpdate(EMPTY_CHAT, update({ reset: true, entries: [user(0), agent(1, "running")] }));
    expect(first.entries.map((e) => e.seq)).toEqual([0, 1]);
    expect(first.revision).toBe(10);
    const ended = applyChatUpdate(first, update({ revision: 12, entries: [agent(1, "done"), user(2)] }));
    expect(ended.entries.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(ended.entries[1]).toMatchObject({ kind: "subAgent", status: "done" });
    expect(ended.revision).toBe(12);
    const reset = applyChatUpdate(ended, update({ reset: true, revision: 20, entries: [user(0, "fresh")] }));
    expect(reset.entries).toEqual([user(0, "fresh")]);
  });

  it("drops entries the backend dropped and starts over for another session", () => {
    const state = applyChatUpdate(EMPTY_CHAT, update({ reset: true, entries: [user(0), user(1), user(2)] }));
    const trimmed = applyChatUpdate(state, update({ revision: 11, firstSeq: 2, entries: [user(3)] }));
    expect(trimmed.entries.map((e) => e.seq)).toEqual([2, 3]);
    const other = applyChatUpdate(trimmed, update({ sessionId: "s2", revision: 30, entries: [user(0, "new")] }));
    expect(other.sessionId).toBe("s2");
    expect(other.entries).toEqual([user(0, "new")]);
  });

  it("keeps the same state when nothing changed", () => {
    const state = applyChatUpdate(EMPTY_CHAT, update({ reset: true, entries: [user(0)] }));
    expect(applyChatUpdate(state, update({ revision: 10 }))).toBe(state);
    const bumped = applyChatUpdate(state, update({ revision: 11 }));
    expect(bumped.entries).toBe(state.entries);
    expect(bumped.revision).toBe(11);
  });
});

describe("sub-agents", () => {
  it("counts the running ones and words the header text", () => {
    const entries = [agent(0, "done"), agent(1, "running"), user(2), agent(3, "running")];
    expect(runningSubAgents(entries).map((a) => a.seq)).toEqual([1, 3]);
    expect(subAgentText(2)).toBe("2 sub-agents running");
    expect(subAgentText(1)).toBe("1 sub-agent running");
    expect(subAgentText(0)).toBeNull();
  });

  it("leaves out the ones an earlier PTY run left running", () => {
    const entries = [agent(0, "running"), { ...agent(1, "running"), at: "2026-10-16T10:05:00.000Z" }];
    const restartedAt = Date.parse("2026-10-16T10:01:00.000Z");
    expect(runningSubAgents(entries, restartedAt).map((a) => a.seq)).toEqual([1]);
    expect(runningSubAgents(entries, null).map((a) => a.seq)).toEqual([0, 1]);
  });
});

describe("open decisions", () => {
  const AT = "2026-10-16T10:00:00.000Z";
  const plan = (seq: number, status: "running" | "done", at: string | null = AT): ChatEntry => ({
    seq, rev: seq + 1, at, kind: "plan", toolId: `p${seq}`, plan: "# Plan", status, endedAt: null,
  });

  it("is the newest unanswered plan or question", () => {
    expect(openDecision([plan(0, "running"), user(1), plan(2, "done")], null)).toBeNull();
    expect(openDecision([plan(0, "done"), plan(1, "running")], Date.parse(AT))?.seq).toBe(1);
  });

  it("ignores one asked before this PTY started: Claude crashed, then --continue reopened the log", () => {
    const restartedAt = Date.parse("2026-10-16T10:01:00.000Z");
    expect(openDecision([plan(0, "running")], restartedAt)).toBeNull();
    // The new process asks again: that one is open.
    const again = plan(1, "running", "2026-10-16T10:02:00.000Z");
    expect(openDecision([plan(0, "running"), again], restartedAt)?.seq).toBe(1);
    // No time on the entry: still counted.
    expect(openDecision([plan(0, "running", null)], restartedAt)?.seq).toBe(0);
  });
});

describe("chatRows", () => {
  it("folds a run of three or more tool calls and keeps shorter runs as rows", () => {
    const rows = chatRows([user(0), tool(1), tool(2), user(3), tool(4), tool(5), tool(6, "running"), agent(7, "done")]);
    expect(rows.map((r) => r.kind)).toEqual(["entry", "entry", "entry", "entry", "tools", "entry"]);
    const group = rows[4];
    expect(group.kind === "tools" && group.tools.map((t) => t.seq)).toEqual([4, 5, 6]);
    expect(group.key).toBe("tools-4");
    expect(group.kind === "tools" && toolGroupText(group.tools)).toBe("3 tool calls · 1 running");
  });
});

describe("text helpers", () => {
  it("words plan and question outcomes", () => {
    expect(decisionText("plan", "running")).toBe("Waiting for you in the terminal");
    expect(decisionText("plan", "done")).toBe("Approved");
    expect(decisionText("plan", "error")).toBe("Not approved");
    expect(decisionText("question", "done")).toBe("Answered");
  });

  it("measures and formats durations", () => {
    expect(durationMs("2026-10-16T10:00:00Z", "2026-10-16T10:00:42Z")).toBe(42_000);
    expect(durationMs(null, "2026-10-16T10:00:42Z")).toBeNull();
    expect(durationMs("x", "y")).toBeNull();
    expect(formatDuration(1250)).toBe("1.3s");
    expect(formatDuration(42_000)).toBe("42s");
    expect(formatDuration(125_000)).toBe("2m 05s");
  });

  it("defaults a tab's view to Terminal", () => {
    expect(terminalViewOf({}, "t1")).toBe("terminal");
    expect(terminalViewOf({ t1: "chat" }, "t1")).toBe("chat");
    expect(terminalViewOf({ t1: "chat" }, null)).toBe("terminal");
  });
});
