import { describe, expect, it, vi } from "vitest";
import type { HandoffRecord, PipelineRunView, Role } from "../bridge";
import type { ChainRef } from "./chains";
import {
  attachHandoff,
  prepareHandoff,
  saveHandoff,
  type HandoffIo,
  type PrepareRequest,
} from "./executor";
import type { HandoffSource } from "./map";

const PLAN = "# Fix the login handler\n\nCheck the token expiry path.";

function role(id: string, keys: string[], templateText = ""): Role {
  return {
    id,
    name: id,
    templateText,
    fields: keys.map((key) => ({ key, label: key, type: "multiline", required: false })),
  } as unknown as Role;
}

const ROLES: Record<string, Role> = {
  role_plan_reviewer: role("role_plan_reviewer", ["originalTask", "plan", "additionalContext"]),
  role_pr_reviewer: role("role_pr_reviewer", ["originalTask", "approvedPlan", "additionalContext"]),
  role_planner: role("role_planner", ["taskType", "title", "request", "additionalContext"]),
};

function io(overrides: Partial<HandoffIo> = {}): HandoffIo {
  return {
    getRole: vi.fn(async (id: string) => ROLES[id]),
    changesList: vi.fn(async () => ({ state: "none" }) as never),
    gitRepoInfo: vi.fn(async () => ({ currentBranch: "fix/login" }) as never),
    getPipelineRun: vi.fn(async () => null as unknown as PipelineRunView),
    terminalPlanFile: vi.fn(async () => null as never),
    validateAndPreview: vi.fn(async () => ({ errors: [] }) as never),
    handoffSave: vi.fn(async (input) => ({ ...input, id: "handoff-1" }) as unknown as HandoffRecord),
    handoffAttach: vi.fn(async (input) => ({
      record: { id: input.id, targetTabId: input.tabId } as HandoffRecord,
      chain: input.chain,
    })),
    ...overrides,
  };
}

function source(overrides: Partial<HandoffSource> = {}): HandoffSource {
  return {
    sourceRoleId: "role_planner",
    sourceTabId: "tab_planner",
    sourceLabel: "Planner · Login",
    cwd: "/repo",
    answers: { taskType: "Bug", title: "Login 500", request: "Expired tokens return 500." },
    latestMessage: PLAN,
    plan: [],
    todos: [],
    selection: "",
    turnInFlight: false,
    ...overrides,
  };
}

const chain = (step: number, round?: number): ChainRef => ({
  chainId: "ee_1",
  kind: "eagle1",
  step,
  total: 4,
  ...(round ? { round } : {}),
});

function request(overrides: Partial<PrepareRequest> = {}): PrepareRequest {
  return {
    source: source(),
    scope: "message",
    surface: "chat",
    targetRoleId: "role_plan_reviewer",
    sourceChain: chain(1),
    loopBack: null,
    ...overrides,
  };
}

describe("hand-off executor", () => {
  it("maps onto the target role as saved now and advances the chain one step", async () => {
    const fake = io();
    const out = await prepareHandoff(request(), fake);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(fake.getRole).toHaveBeenCalledWith("role_plan_reviewer");
    expect(out.value.mapped.planText).toContain("Check the token expiry path.");
    expect(out.value.nextChain).toEqual(chain(2));
  });

  it("a loop-back takes the reviewer's next-round chain, not the next step", async () => {
    const out = await prepareHandoff(
      request({
        source: source({ sourceRoleId: "role_plan_reviewer", sourceTabId: "tab_review" }),
        targetRoleId: "role_planner",
        sourceChain: chain(2),
        loopBack: { chainId: "ee_1", next: chain(1, 2) },
      }),
      io(),
    );
    expect(out.ok && out.value.nextChain).toEqual(chain(1, 2));
  });

  it("an off-chain target drops the chain tag", async () => {
    const out = await prepareHandoff(request({ targetRoleId: "role_pr_reviewer" }), io());
    expect(out.ok && out.value.nextChain).toBeNull();
  });

  it("an empty choice is refused before anything is written", async () => {
    const fake = io();
    const out = await prepareHandoff(
      request({ source: source({ latestMessage: "" }), scope: "selection" }),
      fake,
    );
    expect(out.ok).toBe(false);
    expect(fake.handoffSave).not.toHaveBeenCalled();
  });

  it("a terminal start is refused when the backend finds a missing field", async () => {
    const fake = io({
      validateAndPreview: vi.fn(async () => ({
        errors: [{ key: "originalTask", message: "Original Task is required" }],
      })) as never,
    });
    const out = await prepareHandoff(request({ surface: "terminal" }), fake);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toContain("Original Task is required");
  });

  it("an Implementer hand-off carries its branch and the findings it fixed", async () => {
    const run = {
      run: {
        handoffs: {
          role_implementer: {
            text: "Review findings from the PR Reviewer (round 1):\n\nPR1: guard the null token.",
          },
        },
      },
    } as unknown as PipelineRunView;
    const fake = io({ getPipelineRun: vi.fn(async () => run) });
    const out = await prepareHandoff(
      request({
        source: source({
          sourceRoleId: "role_implementer",
          sourceTabId: "tab_impl",
          latestMessage: "## HANDOFF: Implementation summary\nDone.",
        }),
        targetRoleId: "role_pr_reviewer",
        sourceChain: chain(3),
      }),
      fake,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.source.branch).toBe("fix/login");
    expect(out.value.source.previousReview).toEqual({
      round: 1,
      findings: "PR1: guard the null token.",
    });
    expect(out.value.nextChain).toEqual(chain(4));
  });

  it("saves, then attaches the chain step and binding in one call", async () => {
    const fake = io();
    const out = await prepareHandoff(request(), fake);
    if (!out.ok) throw new Error(out.error);
    const record = await saveHandoff(out.value, "message", fake);
    expect(fake.handoffSave).toHaveBeenCalledWith(
      expect.objectContaining({ targetRoleId: "role_plan_reviewer", chain: chain(2) }),
    );
    await attachHandoff(
      { record, tabId: "tab-2", prepared: out.value, loopBack: null, verdict: null },
      fake,
    );
    expect(fake.handoffAttach).toHaveBeenCalledWith({
      id: "handoff-1",
      tabId: "tab-2",
      chain: chain(2),
      loopBack: null,
      handoffText: out.value.mapped.planText,
    });
  });

  it("a loop-back attach records the reviewer's verdict instead of a chain step", async () => {
    const fake = io();
    const loopBack = { chainId: "ee_1", next: chain(1, 2) };
    const out = await prepareHandoff(
      request({
        source: source({ sourceRoleId: "role_plan_reviewer", sourceTabId: "tab_review" }),
        targetRoleId: "role_planner",
        sourceChain: chain(2),
        loopBack,
      }),
      fake,
    );
    if (!out.ok) throw new Error(out.error);
    const record = await saveHandoff(out.value, "message", fake);
    await attachHandoff(
      { record, tabId: "tab-3", prepared: out.value, loopBack, verdict: "REQUIRES REVISION" },
      fake,
    );
    expect(fake.handoffAttach).toHaveBeenCalledWith(
      expect.objectContaining({
        chain: null,
        loopBack: {
          chainId: "ee_1",
          reviewerRoleId: "role_plan_reviewer",
          verdict: "REQUIRES REVISION",
          lane: null,
        },
      }),
    );
  });
});
