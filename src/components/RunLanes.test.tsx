// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ChatEntry, PipelineRun, TabSummary } from "../bridge";

const T0 = Date.parse("2026-10-16T10:00:00Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

const entries: Record<string, ChatEntry[]> = {
  "tab-impl": [
    {
      seq: 1,
      rev: 1,
      kind: "subAgent",
      toolId: "a",
      description: "Search the API",
      agentType: "Explore",
      background: false,
      status: "done",
      at: at(12),
      endedAt: at(14),
    },
  ],
};
vi.mock("../terminal/chatEntriesStore", () => ({
  useChatEntries: (tabId: string | null, enabled = true) => ({
    sessionId: null,
    revision: null,
    entries: enabled && tabId ? (entries[tabId] ?? []) : [],
  }),
}));

import { RunLanes } from "./RunLanes";

const tab = (id: string, roleId: string): TabSummary =>
  ({
    id,
    label: id,
    roleId,
    cwd: "/repo",
    kind: "terminal",
    terminalLaunch: "role",
    provider: "claude",
    phase: "terminal",
    acpSessionId: null,
  }) as TabSummary;

function run(patch: Partial<PipelineRun> = {}): PipelineRun {
  return {
    id: "ee_1",
    kind: "eagle1",
    cwd: "/repo",
    stage: "implementer",
    overviewTabId: "",
    tabIds: { role_implementer: "tab-impl" },
    createdAt: at(0),
    events: [
      { at: at(4), kind: "turn", stageId: "planner", round: 1, summary: "" },
      { at: at(5), kind: "handoff", stageId: "plan_reviewer", round: 1, summary: "" },
      { at: at(8), kind: "turn", stageId: "plan_reviewer", round: 1, summary: "", outcome: "APPROVED" },
      { at: at(9), kind: "stop", stageId: "implementer", round: 1, summary: "Checkpoint before Implementer" },
      { at: at(10), kind: "handoff", stageId: "implementer", round: 1, summary: "" },
      { at: at(18), kind: "gate", stageId: "implementer", round: 1, summary: "npm test: 2 failed", outcome: "failed" },
    ],
    ...patch,
  };
}

describe("RunLanes", () => {
  it("draws a row per stage with verdict tags, a legend, and a text list of every bar", () => {
    render(<RunLanes run={run()} tabs={[tab("tab-impl", "role_implementer")]} now={T0 + 20 * 60_000} />);
    const section = screen.getByRole("region", { name: "Run lanes" });
    for (const title of ["Planner", "Plan Reviewer", "Implementer", "PR Reviewer"]) {
      expect(within(section).getAllByText(title).length).toBeGreaterThan(0);
    }
    expect(within(section).getByText("APPROVED")).toBeTruthy();
    expect(within(screen.getByRole("list", { name: "Legend" })).getByText("Waiting for you")).toBeTruthy();
    const list = within(screen.getByRole("list", { name: "Run lanes as a list" }));
    expect(list.getByText("Planner round 1: worked 4m")).toBeTruthy();
    expect(list.getByText("Plan Reviewer round 1: worked 3m, approved")).toBeTruthy();
    expect(list.getByText("Implementer round 1: working for 10m")).toBeTruthy();
    expect(list.getByText(/Implementer: waited for you 1m\. Checkpoint before Implementer/)).toBeTruthy();
    expect(list.getByText("Implementer check failed: npm test: 2 failed")).toBeTruthy();
    expect(list.getByText("Implementer: Sub-agent (Explore): Search the API, took 2m")).toBeTruthy();
    expect(document.querySelector(".run-lane-bar-working")).toBeTruthy();
    expect(document.querySelector(".run-lane-bar-wait")).toBeTruthy();
    expect(document.querySelector(".run-lane-gate-failed")).toBeTruthy();
    expect(document.querySelector(".run-lane-bar-sub")).toBeTruthy();
    expect(document.querySelector(".run-lanes-now")).toBeTruthy();
    expect(screen.getByText("now")).toBeTruthy();
  });

  it("fanned-out lane tabs show their sub-agents too, each lane on its own track", () => {
    const fanned = run({
      tabIds: {},
      lanes: [
        { id: "pr1", title: "PR1 — API", status: "active", stage: "implementer", round: 1, tabIds: { role_implementer: "tab-impl" } },
        { id: "pr2", title: "PR2 — UI", status: "active", stage: "implementer", round: 1, tabIds: { role_implementer: "tab-impl-2" } },
      ],
    });
    entries["tab-impl-2"] = [{ ...(entries["tab-impl"][0] as Extract<ChatEntry, { kind: "subAgent" }>), toolId: "b", description: "Draw the UI" }];
    render(
      <RunLanes
        run={fanned}
        tabs={[tab("tab-impl", "role_implementer"), tab("tab-impl-2", "role_implementer")]}
        now={T0 + 20 * 60_000}
      />,
    );
    const list = within(screen.getByRole("list", { name: "Run lanes as a list" }));
    expect(list.getByText("Implementer (PR1 — API): Sub-agent (Explore): Search the API, took 2m")).toBeTruthy();
    expect(list.getByText("Implementer (PR2 — UI): Sub-agent (Explore): Draw the UI, took 2m")).toBeTruthy();
    const subs = [...document.querySelectorAll<HTMLElement>(".run-lanes-track-sub .run-lane-bar-sub")];
    expect(subs.map((el) => el.style.top)).toEqual(["0px", "18px"]);
    delete entries["tab-impl-2"];
  });

  it("keeps every axis label inside the chart, the last tick right-anchored at the edge", () => {
    // 30 minutes in: ticks every 5m, so "30m" sits at 100%.
    render(<RunLanes run={run()} tabs={[]} now={T0 + 30 * 60_000} />);
    const ticks = [...document.querySelectorAll<HTMLElement>(".run-lanes-tick")];
    expect(ticks.map((el) => [el.textContent, el.style.left, el.style.transform])).toEqual([
      ["0s", "0%", "translateX(-0%)"],
      ["5m", "16.666666666666664%", "translateX(-16.666666666666664%)"],
      ["10m", "33.33333333333333%", "translateX(-33.33333333333333%)"],
      ["15m", "50%", "translateX(-50%)"],
      ["20m", "66.66666666666666%", "translateX(-66.66666666666666%)"],
      ["25m", "83.33333333333334%", "translateX(-83.33333333333334%)"],
      ["30m", "100%", "translateX(-100%)"],
    ]);
  });

  it("a complete run has no now line", () => {
    const done = run();
    done.events = [...(done.events ?? []), { at: at(19), kind: "complete", round: 1, summary: "" }];
    render(<RunLanes run={done} tabs={[]} now={T0 + 30 * 60_000} />);
    expect(document.querySelector(".run-lanes-now")).toBeNull();
    expect(screen.queryByText("now")).toBeNull();
    // No Claude terminal for the stage: no sub-agent row.
    expect(document.querySelector(".run-lane-bar-sub:not(.run-lanes-swatch)")).toBeNull();
  });
});
