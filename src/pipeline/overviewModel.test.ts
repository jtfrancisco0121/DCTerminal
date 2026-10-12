import { describe, expect, it } from "vitest";
import type { PipelineRun, TabSummary } from "../bridge";
import type { TabRuntime } from "../liveTabs";
import { laneStatus, overviewStages } from "./overviewModel";
import type { TerminalReader } from "./terminalText";

const tab = (partial: Partial<TabSummary>): TabSummary => ({
  id: "tab_impl",
  label: "Implementer",
  roleId: "role_implementer",
  cwd: "/repo",
  phase: "running",
  mergedPromptChars: 0,
  startupPromptSent: true,
  hasTranscript: false,
  folderStatus: "ok",
  color: "",
  kind: "terminal",
  terminalLaunch: "role",
  acpSessionId: null,
  provider: "claude",
  ...partial,
});

const reader: TerminalReader = {
  tail: () => "",
  selection: () => "",
  planFile: async () => "",
};

describe("laneStatus with a terminal state", () => {
  const t = tab({});

  it("shows an exited terminal in red with its code", () => {
    expect(laneStatus(t, undefined, { kind: "exited", code: 137 })).toEqual({
      label: "Exited · code 137",
      tone: "error",
    });
  });

  it("names what the terminal needs", () => {
    const needs = (n: "plan" | "question" | "permission") =>
      laneStatus(t, undefined, { kind: "needs", needs: n, toolId: "t1", toolTitle: "x" });
    expect(needs("plan")).toEqual({ label: "Needs you: plan to review", tone: "needs" });
    expect(needs("question")).toEqual({ label: "Needs you: question", tone: "needs" });
    expect(needs("permission")).toEqual({ label: "Needs you: permission request", tone: "needs" });
  });

  it("shows working, and falls back to the tab when idle", () => {
    expect(laneStatus(t, undefined, { kind: "working" })).toEqual({
      label: "Working…",
      tone: "live",
    });
    expect(laneStatus(t, undefined, { kind: "idle" })).toEqual(laneStatus(t, undefined));
    expect(laneStatus(t, undefined, { kind: "idle" })).toEqual({
      label: "Session open",
      tone: "live",
    });
  });

  it("still reports a missing tab", () => {
    expect(laneStatus(undefined, undefined, { kind: "exited", code: 1 }).label).toBe("Missing tab");
  });
});

describe("overviewStages terminal states", () => {
  it("passes each stage's terminal state to its lane", () => {
    const run = {
      id: "run_1",
      kind: "execute",
      cwd: "/repo",
      stage: "implement",
      overviewTabId: "tab_ov",
      tabIds: { role_implementer: "tab_impl" },
      createdAt: "2026-10-12T00:00:00Z",
    } as PipelineRun;
    const runtimes: Record<string, TabRuntime> = {};
    const stages = overviewStages(run, [tab({})], runtimes, reader, {
      tab_impl: { kind: "exited", code: 2 },
    });
    const impl = stages.find((s) => s.tabId === "tab_impl")!;
    expect(impl.status).toEqual({ label: "Exited · code 2", tone: "error" });
    const without = overviewStages(run, [tab({})], runtimes, reader);
    expect(without.find((s) => s.tabId === "tab_impl")!.status.tone).toBe("live");
  });
});
