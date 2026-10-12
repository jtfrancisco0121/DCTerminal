// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../bridge", () => ({
  getPipelineRun: vi.fn(),
  listenChainRunUpdated: vi.fn(async () => () => {}),
  pipelinePromotePlan: vi.fn(async () => {}),
  pipelineSetCandidatePlan: vi.fn(async () => {}),
  pipelineSetAutopilot: vi.fn(async () => {}),
  pipelineRunGates: vi.fn(async () => []),
  exportTextFile: vi.fn(async () => {}),
}));
vi.mock("../pipeline/terminalText", () => ({ liveTerminalReader: null }));

import type { PipelineRun, TabSummary } from "../bridge";
import { getPipelineRun, pipelineRunGates, pipelineSetAutopilot } from "../bridge";
import { emptyRuntime, type TabRuntime } from "../liveTabs";
import { setPipelineDefs } from "../pipeline/defs";
import type { TerminalReader } from "../pipeline/terminalText";
import { PipelineOverview } from "./PipelineOverview";

function tab(id: string, roleId: string): TabSummary {
  return {
    id,
    label: `Tab ${id}`,
    roleId,
    cwd: "/worktree",
    phase: "running",
    mergedPromptChars: 0,
    startupPromptSent: true,
    hasTranscript: false,
    folderStatus: "ok",
    color: "#fff",
    acpSessionId: null,
  };
}

const noTerminal: TerminalReader = { selection: () => "", tail: () => "", planFile: async () => "" };

function run(extra: Partial<PipelineRun> = {}): PipelineRun {
  return {
    id: "ee_1",
    kind: "full",
    cwd: "/p",
    stage: "implementer",
    overviewTabId: "ov",
    tabIds: { role_implementer: "impl" },
    createdAt: "2026-10-13T00:00:00Z",
    chainId: "ee_1",
    round: 2,
    ...extra,
  };
}

function show(view: PipelineRun, runtimes: Record<string, TabRuntime> = {}) {
  vi.mocked(getPipelineRun).mockResolvedValue({ run: view });
  render(
    <PipelineOverview
      runId={view.id}
      cwd="/p"
      tabs={[tab("impl", "role_implementer")]}
      runtimes={runtimes}
      onJump={() => {}}
      onWatch={() => {}}
      onRefreshTabs={async () => {}}
      onNotice={() => {}}
      terminalReader={noTerminal}
    />,
  );
}

describe("PipelineOverview: autopilot, checks and timeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPipelineDefs([]);
  });

  it("turns autopilot on and shows what it waits for", async () => {
    show(run({ autopilot: { enabled: true, waiting: "Checkpoint before Implementer" } }));
    const panel = await screen.findByRole("region", { name: "Autopilot" });
    expect(within(panel).getByRole("status").textContent).toBe(
      "Waiting for you: Checkpoint before Implementer",
    );
    fireEvent.click(within(panel).getByRole("checkbox"));
    await waitFor(() => expect(pipelineSetAutopilot).toHaveBeenCalledWith("ee_1", false));
  });

  it("shows a stage's checks and round cap, and runs them against the stage tab's folder", async () => {
    const reply = {
      ...emptyRuntime(),
      segments: [
        {
          id: "s1",
          kind: "agent",
          text: "## HANDOFF: Pull requests\nPR1 — https://github.com/jt/app/pull/7",
        } as TabRuntime["segments"][number],
      ],
    };
    show(
      run({
        gates: {
          implementer: {
            round: 2,
            at: "now",
            results: [
              {
                kind: "command",
                label: "npm run check",
                status: "failed",
                summary: "Failed (exit code 1).",
                output: "1 test failed",
                durationMs: 5,
              },
            ],
          },
        },
      }),
      { impl: reply },
    );
    const lane = await screen.findByRole("article", { name: "Implementer" });
    const checks = within(lane).getByRole("list", { name: "Implementer checks, round 2" });
    expect(checks.textContent).toContain("failed");
    expect(checks.textContent).toContain("npm run check");
    const reviewer = screen.getByRole("article", { name: "PR Reviewer" });
    expect(within(reviewer).getByText("Round 2 of at most 3")).toBeTruthy();
    fireEvent.click(within(lane).getByRole("button", { name: "Run checks" }));
    await waitFor(() =>
      expect(pipelineRunGates).toHaveBeenCalledWith("ee_1", "implementer", "/worktree", [
        "https://github.com/jt/app/pull/7",
      ]),
    );
  });

  it("lists the timeline newest first, and follow-ups", async () => {
    show(
      run({
        events: [
          { at: "2026-10-13T10:00:00Z", kind: "handoff", stageId: "implementer", round: 1, summary: "Handed to Implementer" },
          {
            at: "2026-10-13T11:00:00Z",
            kind: "complete",
            stageId: "pr_reviewer",
            round: 2,
            summary: "APPROVED: the run is complete.",
            detail: "[LOW] rename x",
          },
        ],
      }),
    );
    const timeline = await screen.findByRole("region", { name: "Timeline" });
    const items = within(timeline).getAllByRole("listitem");
    expect(items[0].textContent).toContain("APPROVED: the run is complete.");
    expect(items[1].textContent).toContain("Handed to Implementer");
    const later = screen.getByRole("region", { name: "Follow-ups" });
    expect(later.textContent).toContain("[LOW] rename x");
  });

  it("names a pipeline of your own and lists its stages", async () => {
    setPipelineDefs([
      {
        id: "bugfix",
        name: "Bug fix",
        stages: [
          { id: "fix", roleId: "role_implementer", title: "Fixer" },
          { id: "review", roleId: "role_pr_reviewer", title: "Reviewer", loopBack: { to: "fix" } },
        ],
      },
    ]);
    show(run({ kind: "bugfix", stage: "fix" }));
    expect(await screen.findByText("Bug fix overview")).toBeTruthy();
    expect(screen.getByText(/Fixer → Reviewer/)).toBeTruthy();
    expect(screen.getAllByRole("article").map((a) => a.getAttribute("aria-label"))).toEqual([
      "Fixer",
      "Reviewer",
    ]);
  });
});
