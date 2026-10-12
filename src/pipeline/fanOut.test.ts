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
  handoffAttach,
  handoffGet,
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
    const note = laneNote(lanes[1], lanes, "ee_1-pr2");
    expect(note).toContain("only PR2 — Login screen");
    expect(note).toContain("`ee_1-pr2`");
    expect(note).toContain("PR1 — Token refresh; PR4 — Docs are built in other tabs");
    expect(note).toContain("It builds on PR1 — Token refresh, already approved");
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

  it("starting a waiting lane uses its filled form, the full saved plan when the form was cut, and marks it active", async () => {
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
    await startLane(
      run,
      { id: "pr2", title: "PR2", status: "waiting", stage: "implementer", round: 1, tabIds: { role_implementer: "tab-2" } },
      "role_implementer",
      { startTerminal, refreshTabs: async () => {} },
    );
    expect(startTerminal).toHaveBeenCalledWith(
      "tab-2",
      "role_implementer",
      expect.objectContaining({ cwd: "/wt" }),
      "the whole plan",
    );
    expect(pipelineLaneStatus).toHaveBeenCalledWith("ee_1", "pr2", "active");
  });
});
