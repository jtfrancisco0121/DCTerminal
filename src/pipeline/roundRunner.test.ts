import { describe, expect, it } from "vitest";
import type { RoundView } from "../bridge";
import { BUILT_IN_PIPELINES, type PipelineDef } from "./defs";
import { planPipelines, roundProgress, waveChoices } from "./roundRunner";

describe("round runner rules (R2)", () => {
  it("offers pipelines that build a plan on engine 2, not the round's own or a disabled one", () => {
    const parallel: PipelineDef = {
      id: "panel",
      name: "Panel",
      stages: [
        { id: "fix", roleId: "role_implementer", title: "Fix" },
        { id: "review", roleId: "role_pr_reviewer", title: "Review", loopBack: { to: "fix" }, alsoReviewers: ["role_sec"] },
      ],
    };
    const disabled: PipelineDef = { ...BUILT_IN_PIPELINES[1], id: "off", disabled: "A role is gone." };
    const ids = planPipelines([...BUILT_IN_PIPELINES, parallel, disabled]).map((def) => def.id);
    expect(ids).toEqual(["eagle1", "eagle2", "eagle-eye-l"]);
  });

  it("counts done plans against the plans in the round", () => {
    const view = {
      plans: [
        { state: "done" },
        { state: "running" },
        { state: "ready" },
        { state: "deferred" },
      ],
    } as unknown as RoundView;
    expect(roundProgress(view)).toBe("1 of 3 plans done · 1 running · 1 ready · 1 deferred");
  });

  it("lists the waves to pick from", () => {
    expect(waveChoices(3)).toEqual([1, 2, 3]);
    expect(waveChoices(0)).toEqual([]);
  });
});
