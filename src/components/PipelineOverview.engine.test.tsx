// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import type { RateWindow } from "../usage/limits";
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

function show(
  view: PipelineRun,
  runtimes: Record<string, TabRuntime> = {},
  usageWindows: RateWindow[] | null = null,
) {
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
      usageWindows={usageWindows}
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

  it("names why the run stopped with its reason code's plain-English line", async () => {
    show(
      run({
        status: "waiting",
        stopReason: "usage_limit",
        autopilot: { enabled: true, waiting: "Implementer hit a Claude usage limit: resets 3pm." },
      }),
    );
    const panel = await screen.findByRole("region", { name: "Autopilot" });
    expect(within(panel).getByRole("status").textContent).toBe(
      "Waiting for you: Claude's usage limit was reached. Implementer hit a Claude usage limit: resets 3pm.",
    );
  });

  it("shows the engine note: Claude Code version not yet verified, or why the run uses engine 1", async () => {
    const note = "Claude Code version not yet verified: 2.1.300 is newer than 2.1.287, the version pipeline v2 was checked against.";
    show(run({ engine: 2, engineNote: note, autopilot: { enabled: false } }));
    const panel = await screen.findByRole("region", { name: "Autopilot" });
    expect(within(panel).getByTestId("engine-note").textContent).toBe(note);
    cleanup();
    show(run({ engine: 2, autopilot: { enabled: true } }));
    await screen.findByRole("region", { name: "Autopilot" });
    expect(screen.queryByTestId("engine-note")).toBeNull();
  });

  it("says when Claude usage is unknown, never 0%, and what autopilot does about it", async () => {
    show(run({ autopilot: { enabled: true } }), {}, []);
    const panel = await screen.findByRole("region", { name: "Autopilot" });
    const usage = within(panel).getByTestId("autopilot-usage");
    expect(usage.textContent).toBe(
      "Claude usage: unknown. Autopilot keeps going, and stops if Claude reports a usage limit.",
    );
    expect(usage.textContent).not.toContain("0%");
    cleanup();
    const later = Math.floor(Date.now() / 1000) + 3600;
    show(run({ autopilot: { enabled: true } }), {}, [
      { rateLimitType: "five_hour", label: "5h", utilization: 42, resetsAt: later, status: "allowed", seenAtMs: Date.now() },
    ]);
    const known = await screen.findByTestId("autopilot-usage");
    expect(known.textContent).toBe("Claude usage: 42% (autopilot pauses at 90%).");
  });

  it("the timeline shows each stop's reason line", async () => {
    show(
      run({
        events: [
          {
            at: "2026-10-13T10:00:00Z",
            kind: "stop",
            stageId: "pr_reviewer",
            round: 3,
            summary: "Round cap reached (3 of 3): PR Reviewer still asks for changes.",
            outcome: "round_cap",
          },
          { at: "2026-10-13T10:01:00Z", kind: "autopilot", round: 3, summary: "Autopilot off", outcome: "paused_by_you" },
        ],
      }),
    );
    const timeline = await screen.findByRole("region", { name: "Timeline" });
    const items = within(timeline).getAllByRole("listitem");
    expect(items.map((item) => item.querySelector(".pipeline-event-reason")?.textContent ?? null)).toEqual([
      "You turned autopilot off.",
      "The review reached its round cap.",
    ]);
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
        // The plan was sent back once: run round 2, but the PR Reviewer's own edge is on round 1.
        verdicts: [{ roleId: "role_plan_reviewer", round: 1, verdict: "REQUEST CHANGES", at: "then" }],
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
    expect(within(reviewer).getByText("Round 1")).toBeTruthy();
    const planReviewer = screen.getByRole("article", { name: "Plan Reviewer" });
    expect(within(planReviewer).getByText("Round 2")).toBeTruthy();
    fireEvent.click(within(lane).getByRole("button", { name: "Run checks" }));
    await waitFor(() =>
      expect(pipelineRunGates).toHaveBeenCalledWith("ee_1", "implementer", "/worktree", [
        "https://github.com/jt/app/pull/7",
      ]),
    );
  });

  it("shows a round cap only when the pipeline sets one, and never a round above it as within it", async () => {
    setPipelineDefs([
      {
        id: "capped",
        name: "Capped",
        stages: [
          { id: "fix", roleId: "role_implementer", title: "Implementer" },
          {
            id: "review",
            roleId: "role_pr_reviewer",
            title: "PR Reviewer",
            loopBack: { to: "fix", maxRounds: 3 },
          },
        ],
      },
    ]);
    show(
      run({
        kind: "capped",
        stage: "fix",
        round: 3,
        verdicts: [
          { roleId: "role_pr_reviewer", round: 1, verdict: "REQUEST CHANGES", at: "then" },
          { roleId: "role_pr_reviewer", round: 2, verdict: "REQUEST CHANGES", at: "then" },
        ],
      }),
    );
    const reviewer = await screen.findByRole("article", { name: "PR Reviewer" });
    expect(within(reviewer).getByText("Round 3 of at most 3")).toBeTruthy();
    // Built-ins have no cap: the hint says rounds go on until approved.
    cleanup();
    show(run({ autopilot: { enabled: true } }));
    const panel = await screen.findByRole("region", { name: "Autopilot" });
    expect(panel.textContent).toContain("Rounds go back until the reviewer approves");
    expect(panel.textContent).not.toContain("at the round cap");
  });

  it("says why the plan cannot be promoted: no Implementer tab yet, or it already started", async () => {
    // Autopilot waits at the checkpoint before the Implementer: no tab exists.
    show(run({ stage: "plan_reviewer", tabIds: {}, autopilot: { enabled: true, waiting: "Checkpoint before Implementer" } }));
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "There is no Implementer tab yet. Use Hand off on the Plan Reviewer tab to start it.",
      ),
    );
    expect(document.body.textContent).not.toContain("already started");
    cleanup();
    // The chain's Implementer runs already.
    show(run());
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "The Implementer tab already started. Use Hand off on the Plan Reviewer tab.",
      ),
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

  it("offers a fan-out when the plan ships as several pull requests, and lists the lanes after", async () => {
    const review = {
      ...emptyRuntime(),
      segments: [
        {
          id: "s1",
          kind: "agent",
          text: "## HANDOFF: Verdict\nAPPROVED\n\n## HANDOFF: Pull requests\n* `PR1 — API`: Depends on: none\n* `PR2 — UI`: Depends on: PR1",
        } as TabRuntime["segments"][number],
      ],
    };
    const onFanOut = vi.fn(async () => {});
    vi.mocked(getPipelineRun).mockResolvedValue({
      run: run({ stage: "plan_reviewer", tabIds: { role_plan_reviewer: "rev" } }),
    });
    const { unmount } = render(
      <PipelineOverview
        runId="ee_1"
        cwd="/p"
        tabs={[{ ...tab("rev", "role_plan_reviewer") }]}
        runtimes={{ rev: review }}
        onJump={() => {}}
        onWatch={() => {}}
        onRefreshTabs={async () => {}}
        onNotice={() => {}}
        terminalReader={noTerminal}
        onFanOut={onFanOut}
        onStartLane={async () => {}}
      />,
    );
    const panel = await screen.findByRole("region", { name: "Fan out" });
    expect(panel.textContent).toContain("PR2 — UI · after PR1");
    fireEvent.click(within(panel).getByRole("button", { name: "Fan out into 2 Implementers" }));
    await waitFor(() => expect(onFanOut).toHaveBeenCalledWith("ee_1"));
    unmount();

    const onStartLane = vi.fn(async () => {});
    vi.mocked(getPipelineRun).mockResolvedValue({
      run: run({
        lanes: [
          { id: "pr1", title: "PR1 — API", status: "active", stage: "implementer", round: 1, tabIds: { role_implementer: "impl" } },
          { id: "pr2", title: "PR2 — UI", status: "waiting", dependsOn: ["pr1"], stage: "implementer", round: 1, tabIds: {} },
        ],
      }),
    });
    render(
      <PipelineOverview
        runId="ee_1"
        cwd="/p"
        tabs={[tab("impl", "role_implementer")]}
        runtimes={{}}
        onJump={() => {}}
        onWatch={() => {}}
        onRefreshTabs={async () => {}}
        onNotice={() => {}}
        terminalReader={noTerminal}
        onFanOut={onFanOut}
        onStartLane={onStartLane}
      />,
    );
    const lanes = await screen.findByRole("region", { name: "Pull requests" });
    expect(screen.queryByRole("region", { name: "Fan out" })).toBeNull();
    const pr2 = within(lanes).getByRole("listitem", { name: "PR2 — UI" });
    expect(pr2.textContent).toContain("waiting");
    fireEvent.click(within(pr2).getByRole("button", { name: "Start anyway" }));
    await waitFor(() => expect(onStartLane).toHaveBeenCalledWith("ee_1", "pr2"));
  });

  it("marks an active pull request approved by hand", async () => {
    const onApproveLane = vi.fn(async () => {});
    vi.mocked(getPipelineRun).mockResolvedValue({
      run: run({
        lanes: [
          {
            id: "pr1",
            title: "PR1 — API",
            status: "active",
            stage: "pr_reviewer",
            round: 2,
            tabIds: { role_implementer: "impl" },
            verdicts: [{ roleId: "role_pr_reviewer", round: 1, verdict: "REQUEST CHANGES", at: "then" }],
          },
          { id: "pr2", title: "PR2 — UI", status: "waiting", dependsOn: ["pr1"], stage: "implementer", round: 1, tabIds: {} },
        ],
        fanOutStage: "implementer",
        verdicts: [{ roleId: "role_plan_reviewer", round: 1, verdict: "REQUEST CHANGES", at: "then" }],
      }),
    });
    render(
      <PipelineOverview
        runId="ee_1"
        cwd="/p"
        tabs={[tab("impl", "role_implementer")]}
        runtimes={{}}
        onJump={() => {}}
        onWatch={() => {}}
        onRefreshTabs={async () => {}}
        onNotice={() => {}}
        terminalReader={noTerminal}
        onStartLane={async () => {}}
        onApproveLane={onApproveLane}
      />,
    );
    const lanes = await screen.findByRole("region", { name: "Pull requests" });
    const pr2 = within(lanes).getByRole("listitem", { name: "PR2 — UI" });
    // Only an active lane can be marked approved.
    expect(within(pr2).queryByRole("button", { name: "Mark approved" })).toBeNull();
    const pr1 = within(lanes).getByRole("listitem", { name: "PR1 — API" });
    // Past the fan-out, rounds are per lane: in the lane, not on the stage.
    expect(pr1.textContent).toContain("PR Reviewer · round 2 · last verdict");
    expect(pr2.textContent).toContain("Implementer · round 1");
    const reviewer = screen.getByRole("article", { name: "PR Reviewer" });
    expect(within(reviewer).queryByText(/^Round \d/)).toBeNull();
    const planReviewer = screen.getByRole("article", { name: "Plan Reviewer" });
    expect(within(planReviewer).getByText("Round 2")).toBeTruthy();
    fireEvent.click(within(pr1).getByRole("button", { name: "Mark approved" }));
    await waitFor(() => expect(onApproveLane).toHaveBeenCalledWith("ee_1", "pr1"));
  });

  it("marks a run without lanes complete when autopilot waits at its last stage", async () => {
    const onApproveRun = vi.fn(async () => {});
    const waiting = run({
      stage: "pr_reviewer",
      autopilot: { enabled: true, waiting: "Send it back, or press Mark complete in the chain overview." },
    });
    vi.mocked(getPipelineRun).mockResolvedValue({ run: waiting });
    const { unmount } = render(
      <PipelineOverview
        runId="ee_1"
        cwd="/p"
        tabs={[tab("impl", "role_implementer")]}
        runtimes={{}}
        onJump={() => {}}
        onWatch={() => {}}
        onRefreshTabs={async () => {}}
        onNotice={() => {}}
        terminalReader={noTerminal}
        onApproveRun={onApproveRun}
      />,
    );
    const panel = await screen.findByRole("region", { name: "Autopilot" });
    fireEvent.click(within(panel).getByRole("button", { name: "Mark complete" }));
    await waitFor(() => expect(onApproveRun).toHaveBeenCalledWith("ee_1"));
    unmount();

    // Not waiting, not at the last stage, or a run with lanes (approved per
    // lane): no run-level button.
    for (const view of [
      run({ stage: "pr_reviewer", autopilot: { enabled: true } }),
      run({ stage: "implementer", autopilot: { enabled: true, waiting: "Implementer is a chat tab." } }),
      run({
        stage: "pr_reviewer",
        autopilot: { enabled: true, waiting: "stopped" },
        lanes: [{ id: "pr1", title: "PR1", status: "active", stage: "pr_reviewer", round: 1, tabIds: {} }],
      }),
    ]) {
      vi.mocked(getPipelineRun).mockResolvedValue({ run: view });
      const { unmount: done } = render(
        <PipelineOverview
          runId="ee_1"
          cwd="/p"
          tabs={[]}
          runtimes={{}}
          onJump={() => {}}
          onWatch={() => {}}
          onRefreshTabs={async () => {}}
          onNotice={() => {}}
          terminalReader={noTerminal}
          onApproveRun={onApproveRun}
        />,
      );
      await screen.findByRole("region", { name: "Autopilot" });
      expect(screen.queryByRole("button", { name: "Mark complete" })).toBeNull();
      done();
    }
  });

  it("offers Continue only on a run waiting after a restart, and reports a refused one", async () => {
    const onContinue = vi.fn(async () => {});
    const onNotice = vi.fn();
    const restarted = run({
      status: "waiting",
      stopReason: "app_restarted",
      autopilot: {
        enabled: true,
        waiting: "Implementer finished while the app was closed. Press Continue to let autopilot act on it.",
      },
    });
    const view = (r: PipelineRun) => (
      <PipelineOverview
        runId="ee_1"
        cwd="/p"
        tabs={[tab("impl", "role_implementer")]}
        runtimes={{}}
        onJump={() => {}}
        onWatch={() => {}}
        onRefreshTabs={async () => {}}
        onNotice={onNotice}
        terminalReader={noTerminal}
        onContinue={onContinue}
        key={r.stopReason ?? "none"}
      />
    );
    vi.mocked(getPipelineRun).mockResolvedValue({ run: restarted });
    const { unmount } = render(view(restarted));
    const panel = await screen.findByRole("region", { name: "Autopilot" });
    expect(within(panel).getByRole("status").textContent).toContain("finished while the app was closed");
    fireEvent.click(within(panel).getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(onContinue).toHaveBeenCalledWith("ee_1"));
    expect(onNotice).not.toHaveBeenCalled();

    onContinue.mockRejectedValueOnce(new Error("This run is not waiting after a restart."));
    fireEvent.click(within(panel).getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(onNotice).toHaveBeenCalledWith("Run not continued", "This run is not waiting after a restart."),
    );
    unmount();

    // Stalled, or waiting for another reason: no Continue (you hand on, or turn autopilot off and on).
    for (const other of [
      run({ status: "waiting", stopReason: "stalled", autopilot: { enabled: true, waiting: "quiet" } }),
      run({ status: "waiting", stopReason: "checkpoint", autopilot: { enabled: true, waiting: "Checkpoint" } }),
      run({ status: "running", autopilot: { enabled: true } }),
    ]) {
      vi.mocked(getPipelineRun).mockResolvedValue({ run: other });
      const { unmount: done } = render(view(other));
      await screen.findByRole("region", { name: "Autopilot" });
      expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
      done();
    }
  });
});
