// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../bridge", () => ({
  getPipelineRun: vi.fn(),
  listenChainRunUpdated: vi.fn(async () => () => {}),
  pipelinePromotePlan: vi.fn(async () => {}),
  pipelineSetCandidatePlan: vi.fn(async () => {}),
}));
vi.mock("../pipeline/terminalText", () => ({ liveTerminalReader: null }));

import type { PipelineRun, TabSummary } from "../bridge";
import { getPipelineRun } from "../bridge";
import { emptyRuntime, type TabRuntime } from "../liveTabs";
import type { TerminalReader } from "../pipeline/terminalText";
import { PipelineOverview } from "./PipelineOverview";

function tab(id: string, roleId: string, extra: Partial<TabSummary> = {}): TabSummary {
  return {
    id,
    label: `Tab ${id}`,
    roleId,
    cwd: "/p",
    phase: "running",
    mergedPromptChars: 0,
    startupPromptSent: true,
    hasTranscript: false,
    folderStatus: "ok",
    color: "#fff",
    acpSessionId: null,
    ...extra,
  };
}

function reply(text: string): TabRuntime {
  return {
    ...emptyRuntime(),
    segments: [{ id: "s1", kind: "agent", text } as TabRuntime["segments"][number]],
  };
}

const noTerminal: TerminalReader = {
  selection: () => "",
  tail: () => "",
  planFile: async () => "",
};

function renderOverview(
  run: PipelineRun,
  tabs: TabSummary[],
  runtimes: Record<string, TabRuntime> = {},
  reader: TerminalReader = noTerminal,
) {
  vi.mocked(getPipelineRun).mockResolvedValue({ run });
  const onNotice = vi.fn();
  const onJump = vi.fn();
  const onWatch = vi.fn();
  render(
    <PipelineOverview
      runId={run.id}
      cwd="/p"
      tabs={tabs}
      runtimes={runtimes}
      onJump={onJump}
      onWatch={onWatch}
      onRefreshTabs={async () => {}}
      onNotice={onNotice}
      terminalReader={reader}
    />,
  );
  return { onNotice, onJump, onWatch };
}

const baseRun = (extra: Partial<PipelineRun>): PipelineRun => ({
  id: "ee_1",
  kind: "full",
  cwd: "/p",
  stage: "planner",
  overviewTabId: "ov",
  tabIds: {},
  createdAt: "2026-10-10T00:00:00Z",
  chainId: "ee_1",
  ...extra,
});

describe("PipelineOverview", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows a 2-stage Eagle-Eye 2 chain with the hand-off and PR verdict", async () => {
    const run = baseRun({
      kind: "execute",
      stage: "pr_reviewer",
      tabIds: { role_implementer: "impl", role_pr_reviewer: "pr" },
      originalRequest: "Fix login\n\nUsers get logged out",
      handoffs: { role_pr_reviewer: { text: "Implementation report", at: "now" } },
    });
    const tabs = [tab("impl", "role_implementer"), tab("pr", "role_pr_reviewer")];
    const { onJump, onWatch } = renderOverview(run, tabs, {
      pr: reply("Found two bugs.\n\n## Verdict\nRequest changes"),
    });

    expect(await screen.findByText("Eagle-Eye 2 overview")).toBeTruthy();
    expect(screen.getByText(/Users get logged out/)).toBeTruthy();
    expect(screen.getAllByRole("article")).toHaveLength(2);
    const pr = screen.getByRole("article", { name: "PR Reviewer" });
    expect(within(pr).getByText("Tab pr")).toBeTruthy();
    expect(pr.querySelector(".pipeline-verdict")?.textContent).toBe("REQUEST CHANGES");
    expect(within(pr).getByText(/Handed in/)).toBeTruthy();
    expect(within(pr).getByText("Implementation report")).toBeTruthy();
    fireEvent.click(within(pr).getByText("Jump"));
    fireEvent.click(within(pr).getByText("Watch in split"));
    expect(onJump).toHaveBeenCalledWith("pr");
    expect(onWatch).toHaveBeenCalledWith("pr");
    expect(screen.queryByText("Pull from Planner")).toBeNull();
  });

  it("shows a 4-stage Eagle-Eye 1 chain, including stages not reached yet", async () => {
    const run = baseRun({
      stage: "plan_reviewer",
      tabIds: { role_planner: "plan", role_plan_reviewer: "rev" },
      handoffs: { role_plan_reviewer: { text: "The plan", at: "now" } },
    });
    renderOverview(run, [tab("plan", "role_planner"), tab("rev", "role_plan_reviewer")], {
      rev: reply("### Verdict\n\n**APPROVED WITH CHANGES**\n\n## Reviewed plan\nStep 1"),
    });

    expect(await screen.findByText("Eagle-Eye 1 overview")).toBeTruthy();
    const lanes = screen.getAllByRole("article");
    expect(lanes.map((lane) => lane.getAttribute("aria-label"))).toEqual([
      "Planner",
      "Plan Reviewer",
      "Implementer",
      "PR Reviewer",
    ]);
    const reviewer = screen.getByRole("article", { name: "Plan Reviewer" });
    expect(reviewer.className).toContain("pipeline-lane-current");
    expect(reviewer.querySelector(".pipeline-verdict")?.textContent).toBe(
      "APPROVED WITH CHANGES",
    );
    const implementer = screen.getByRole("article", { name: "Implementer" });
    expect(within(implementer).getByText("Not started")).toBeTruthy();
    expect(within(implementer).queryByText("Jump")).toBeNull();
    expect(screen.getByText(/Not filled in yet/)).toBeTruthy();
  });

  it("pulls the reviewed plan from the Plan Reviewer", async () => {
    const run = baseRun({
      stage: "plan_reviewer",
      tabIds: { role_planner: "plan", role_plan_reviewer: "rev" },
    });
    renderOverview(run, [tab("plan", "role_planner"), tab("rev", "role_plan_reviewer")], {
      rev: reply(
        "### Verdict\nAPPROVED\n\n## Reviewed plan\n1. Do it\n2. Test it\n\n## Review notes\nNone.",
      ),
    });
    fireEvent.click(await screen.findByText("Pull from Plan Reviewer"));
    const areas = screen.getAllByRole("textbox") as HTMLTextAreaElement[];
    expect(areas[1].value).toBe("1. Do it\n2. Test it");
  });

  it("pulls a terminal Planner's selection, and explains when nothing is readable", async () => {
    const run = baseRun({ tabIds: { role_planner: "plan" } });
    const planner = tab("plan", "role_planner", { kind: "terminal", terminalLaunch: "role" });
    const reader: TerminalReader = {
      selection: () => "",
      tail: () => "",
      planFile: async () => "# Plan from file",
    };
    renderOverview(run, [planner], {}, reader);
    fireEvent.click(await screen.findByText("Pull from Planner"));
    const areas = screen.getAllByRole("textbox") as HTMLTextAreaElement[];
    await vi.waitFor(() => expect(areas[0].value).toBe("# Plan from file"));
  });

  it("tells the user when a terminal Planner is not open", async () => {
    const run = baseRun({ tabIds: { role_planner: "plan" } });
    const planner = tab("plan", "role_planner", { kind: "terminal", terminalLaunch: "role" });
    const { onNotice } = renderOverview(run, [planner]);
    fireEvent.click(await screen.findByText("Pull from Planner"));
    await vi.waitFor(() =>
      expect(onNotice).toHaveBeenCalledWith(
        "Nothing to pull",
        expect.stringContaining("not open in this window"),
      ),
    );
  });
});
