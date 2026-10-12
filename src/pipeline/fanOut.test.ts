import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../bridge", () => ({
  gitRepoInfo: vi.fn(async () => ({ mainRoot: "/repo", currentBranch: "main", branches: [], checkedOut: [], worktreesDir: "/repo-worktrees" })),
  getTab: vi.fn(),
  handoffGet: vi.fn(),
  handoffList: vi.fn(async () => []),
  pipelineFanOut: vi.fn(async () => {}),
  pipelineLaneStatus: vi.fn(async () => {}),
  worktreeTabNew: vi.fn(async (input: { branch: string }) => ({
    tab: { id: `tab-${input.branch}`, cwd: `/repo-worktrees/${input.branch}`, answers: {} },
  })),
  // HandoffIo
  getRole: vi.fn(async (id: string) => ({
    id,
    name: id,
    templateText: "",
    fields: ["taskType", "title", "description", "approvedPlan", "additionalContext"].map((key) => ({
      key,
      label: key,
      type: "multiline",
      required: false,
    })),
  })),
  changesList: vi.fn(async () => ({ state: "none" })),
  getPipelineRun: vi.fn(async () => null),
  terminalPlanFile: vi.fn(async () => null),
  validateAndPreview: vi.fn(async () => ({ errors: [] })),
  handoffSave: vi.fn(async (input: Record<string, unknown>) => ({ ...input, id: `h-${String(input.chain && (input.chain as { lane?: string }).lane)}` })),
  handoffAttach: vi.fn(async (input: { id: string; tabId: string }) => ({
    record: { id: input.id, targetTabId: input.tabId },
    chain: null,
  })),
}));

import {
  getPipelineRun,
  handoffAttach,
  handoffGet,
  handoffSave,
  handoffList,
  getTab,
  pipelineFanOut,
  pipelineLaneStatus,
  worktreeTabNew,
  type PipelineRun,
} from "../bridge";
import type { HandoffSource } from "../handoff/map";
import { pipelineDef } from "./defs";
import {
  fanOutRun,
  laneBranch,
  laneNote,
  lanesFromReply,
  parsePullRequestPlan,
  startLane,
} from "./fanOut";

const LIST = [
  "* `PR1 — Token refresh`: repo `api`, steps 1–3, `Depends on: none`",
  "* `PR2 — Login screen`: repo `web`, steps 4–5,",
  "  `Depends on: PR1`",
  "* `PR3 — Release v2`: `Manual step`, `Depends on: PR2`",
  "- PR4: Docs, Depends on: PR3 and PR9",
].join("\n");

const REVIEW = `## HANDOFF: Verdict\nAPPROVED\n\n## HANDOFF: Reviewed plan\n1. Add refresh.\n2. Add the screen.\n\n## HANDOFF: Pull requests\n${LIST}\n\n## HANDOFF: Review notes\nNone.`;

describe("pull-request plan", () => {
  it("reads titles, dependencies across lines, and manual steps", () => {
    expect(parsePullRequestPlan(LIST)).toEqual([
      { id: "pr1", title: "PR1 — Token refresh", dependsOn: [], manual: false },
      { id: "pr2", title: "PR2 — Login screen", dependsOn: ["pr1"], manual: false },
      { id: "pr3", title: "PR3 — Release v2", dependsOn: ["pr2"], manual: true },
      { id: "pr4", title: "PR4 — Docs", dependsOn: ["pr3", "pr9"], manual: false },
    ]);
    expect(parsePullRequestPlan("One pull request.")).toEqual([]);
  });

  it("lanes skip manual steps and dependencies that are not lanes", () => {
    expect(lanesFromReply(REVIEW).map((l) => [l.id, l.dependsOn])).toEqual([
      ["pr1", []],
      ["pr2", ["pr1"]],
      ["pr4", []],
    ]);
    expect(lanesFromReply("## HANDOFF: Pull requests\nOne pull request.")).toEqual([]);
  });

  it("a lane note names the lane, the others, and what it builds on", () => {
    const lanes = lanesFromReply(REVIEW);
    const note = laneNote(lanes[1], lanes, "ee_1");
    expect(note).toContain("only PR2 — Login screen");
    expect(note).toContain("on branch `ee_1-pr2`");
    expect(note).toContain("PR1 — Token refresh; PR4 — Docs are built in other tabs");
    expect(note).toContain("It builds on PR1 — Token refresh, already approved: start from branch `ee_1-pr1`");
    const both = laneNote({ ...lanes[1], dependsOn: ["pr1", "pr4"] }, lanes, "ee_1");
    expect(both).toContain("start from branch `ee_1-pr1` and merge in `ee_1-pr4`");
    expect(laneNote(lanes[0], lanes, "ee_1")).not.toContain("builds on");
    expect(laneBranch("ee_17", "pr1")).toBe("ee_17-pr1");
  });
});

describe("fan out", () => {
  beforeEach(() => vi.clearAllMocks());

  const run: PipelineRun = {
    id: "ee_1",
    kind: "full",
    cwd: "/repo",
    stage: "implementer",
    overviewTabId: "",
    tabIds: { role_plan_reviewer: "rev" },
    createdAt: "x",
    chainId: "ee_1",
  };
  const source: HandoffSource = {
    sourceRoleId: "role_plan_reviewer",
    sourceTabId: "rev",
    sourceLabel: "Plan Reviewer",
    cwd: "/repo",
    answers: { originalTask: "Login" },
    latestMessage: REVIEW,
    plan: [],
    todos: [],
    selection: "",
    turnInFlight: false,
  };

  it("records the lanes, makes a worktree per lane, starts the free ones and fills the rest", async () => {
    const startTerminal = vi.fn(
      async (tabId: string, _roleId: string, _values: Record<string, string>, _plan: string | null) =>
        tabId,
    );
    const syncForm = vi.fn(async () => {});
    const stage = pipelineDef("eagle1")!.stages[2];
    const result = await fanOutRun(
      { run, stage, source, sourceChain: { chainId: "ee_1", kind: "eagle1", step: 2, total: 4 } },
      { startTerminal, syncForm, refreshTabs: async () => {}, roles: null },
    );
    expect(result).toEqual({ started: ["pr1", "pr4"], waiting: ["pr2"] });
    expect(vi.mocked(pipelineFanOut).mock.calls[0]).toEqual([
      "ee_1",
      "implementer",
      [
        { id: "pr1", title: "PR1 — Token refresh", dependsOn: [] },
        { id: "pr2", title: "PR2 — Login screen", dependsOn: ["pr1"] },
        { id: "pr4", title: "PR4 — Docs", dependsOn: [] },
      ],
    ]);
    expect(vi.mocked(worktreeTabNew).mock.calls.map((c) => c[0].branch)).toEqual([
      "ee_1-pr1",
      "ee_1-pr2",
      "ee_1-pr4",
    ]);
    const [tabId, roleId, values] = startTerminal.mock.calls[0];
    expect([tabId, roleId]).toEqual(["tab-ee_1-pr1", "role_implementer"]);
    expect(values.cwd).toBe("/repo-worktrees/ee_1-pr1");
    expect(values.additionalContext).toContain("only PR1 — Token refresh");
    expect(syncForm).toHaveBeenCalledWith(
      "tab-ee_1-pr2",
      "role_implementer",
      "/repo-worktrees/ee_1-pr2",
      expect.objectContaining({ cwd: "/repo-worktrees/ee_1-pr2" }),
    );
    // Worktrees and saved hand-offs come before the lanes are recorded; attach and start after.
    const order = (fn: unknown) => vi.mocked(fn as () => void).mock.invocationCallOrder;
    const recorded = order(pipelineFanOut)[0];
    expect(Math.max(...order(worktreeTabNew), ...order(handoffSave))).toBeLessThan(recorded);
    expect(Math.min(...order(handoffAttach), ...startTerminal.mock.invocationCallOrder)).toBeGreaterThan(recorded);
    expect(vi.mocked(handoffAttach).mock.calls.map((c) => c[0].chain)).toEqual([
      { chainId: "ee_1", kind: "eagle1", step: 3, total: 4, lane: "pr1" },
      { chainId: "ee_1", kind: "eagle1", step: 3, total: 4, lane: "pr2" },
      { chainId: "ee_1", kind: "eagle1", step: 3, total: 4, lane: "pr4" },
    ]);
  });

  it("refuses a plan with one pull request before touching git", async () => {
    await expect(
      fanOutRun(
        {
          run,
          stage: pipelineDef("eagle1")!.stages[2],
          source: { ...source, latestMessage: "## HANDOFF: Pull requests\nOne pull request." },
          sourceChain: { chainId: "ee_1", kind: "eagle1", step: 2, total: 4 },
        },
        { startTerminal: vi.fn(), syncForm: vi.fn(), refreshTabs: async () => {}, roles: null },
      ),
    ).rejects.toThrow("fewer than two");
    expect(pipelineFanOut).not.toHaveBeenCalled();
    expect(worktreeTabNew).not.toHaveBeenCalled();
  });

  const waitingLane = { id: "pr2", title: "PR2", status: "waiting", stage: "implementer", round: 1, tabIds: { role_implementer: "tab-2" } };
  const withLane = (status: string) => ({ run: { ...run, lanes: [{ ...waitingLane, status }] } }) as never;

  it("starting a waiting lane uses its filled form, the full saved plan when the form was cut, and marks it active", async () => {
    vi.mocked(getPipelineRun).mockResolvedValue(withLane("waiting"));
    vi.mocked(getTab).mockResolvedValue({
      tab: {
        cwd: "/wt",
        answers: { approvedPlan: "The full text (120,000 characters) follows this prompt." },
      },
    } as never);
    vi.mocked(handoffList).mockResolvedValue([{ id: "h2", targetTabId: "tab-2" }] as never);
    vi.mocked(handoffGet).mockResolvedValue({ planText: "the whole plan" } as never);
    const startTerminal = vi.fn(
      async (tabId: string, _roleId: string, _values: Record<string, string>, _plan: string | null) =>
        tabId,
    );
    const started = await startLane(run, waitingLane, "role_implementer", { startTerminal, refreshTabs: async () => {} });
    expect(started).toBe(true);
    expect(startTerminal).toHaveBeenCalledWith(
      "tab-2",
      "role_implementer",
      expect.objectContaining({ cwd: "/wt" }),
      "the whole plan",
    );
    expect(pipelineLaneStatus).toHaveBeenCalledWith("ee_1", "pr2", "active");
    // Claimed before the terminal starts.
    expect(vi.mocked(pipelineLaneStatus).mock.invocationCallOrder[0]).toBeLessThan(
      startTerminal.mock.invocationCallOrder[0],
    );
  });

  it("a lane no longer waiting is not started, and a lane started twice at once starts once", async () => {
    vi.mocked(getTab).mockResolvedValue({ tab: { cwd: "/wt", answers: {} } } as never);
    const startTerminal = vi.fn(async (tabId: string) => tabId);
    const deps = { startTerminal, refreshTabs: async () => {} };
    vi.mocked(getPipelineRun).mockResolvedValue(withLane("active"));
    expect(await startLane(run, waitingLane, "role_implementer", deps)).toBe(false);
    expect(startTerminal).not.toHaveBeenCalled();
    expect(pipelineLaneStatus).not.toHaveBeenCalled();
    vi.mocked(getPipelineRun).mockResolvedValue(withLane("waiting"));
    const both = await Promise.all([
      startLane(run, waitingLane, "role_implementer", deps),
      startLane(run, waitingLane, "role_implementer", deps),
    ]);
    expect(both.sort()).toEqual([false, true]);
    expect(startTerminal).toHaveBeenCalledTimes(1);
  });

  it("a lane whose terminal fails to start goes back to waiting", async () => {
    vi.mocked(getTab).mockResolvedValue({ tab: { cwd: "/wt", answers: {} } } as never);
    vi.mocked(getPipelineRun).mockResolvedValue(withLane("waiting"));
    await expect(
      startLane(run, waitingLane, "role_implementer", { startTerminal: async () => null, refreshTabs: async () => {} }),
    ).rejects.toThrow("did not start");
    expect(vi.mocked(pipelineLaneStatus).mock.calls).toEqual([
      ["ee_1", "pr2", "active"],
      ["ee_1", "pr2", "waiting"],
    ]);
  });

  it("a worktree that fails partway names the ones already made and records nothing", async () => {
    vi.mocked(worktreeTabNew)
      .mockResolvedValueOnce({ tab: { id: "t1", cwd: "/repo-worktrees/ee_1-pr1", answers: {} } } as never)
      .mockRejectedValueOnce(new Error("branch exists"));
    const startTerminal = vi.fn();
    const err = await fanOutRun(
      { run, stage: pipelineDef("eagle1")!.stages[2], source, sourceChain: { chainId: "ee_1", kind: "eagle1", step: 2, total: 4 } },
      { startTerminal, syncForm: vi.fn(async () => {}), refreshTabs: async () => {}, roles: null },
    ).catch((e: Error) => e);
    expect(String(err)).toContain("branch exists");
    expect(String(err)).toContain("/repo-worktrees/ee_1-pr1 (branch `ee_1-pr1`)");
    expect(pipelineFanOut).not.toHaveBeenCalled();
    expect(handoffAttach).not.toHaveBeenCalled();
    expect(startTerminal).not.toHaveBeenCalled();
  });

  it("a free lane that fails to start after recording goes back to waiting and is named", async () => {
    const startTerminal = vi.fn(async (tabId: string) => (tabId === "tab-ee_1-pr4" ? null : tabId));
    await expect(
      fanOutRun(
        { run, stage: pipelineDef("eagle1")!.stages[2], source, sourceChain: { chainId: "ee_1", kind: "eagle1", step: 2, total: 4 } },
        { startTerminal, syncForm: vi.fn(async () => {}), refreshTabs: async () => {}, roles: null },
      ),
    ).rejects.toThrow("PR4 — Docs (the terminal did not start) did not start");
    expect(pipelineLaneStatus).toHaveBeenCalledWith("ee_1", "pr4", "waiting");
    expect(handoffAttach).toHaveBeenCalledTimes(3);
  });
});
