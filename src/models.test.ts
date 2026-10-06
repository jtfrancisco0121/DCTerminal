import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_ID,
  defaultModelSettings,
  effectiveModel,
  filterModels,
  modelChangeNote,
  validModelId,
} from "./models";

const models = [
  { id: "composer-2.5", label: "Composer 2.5", fast: false },
  { id: "composer-2.5-fast", label: "Composer 2.5 Fast", fast: true },
  { id: "sonnet-4.5-thinking", label: "Claude Sonnet 4.5 Thinking", fast: false },
];

describe("models", () => {
  it("defaults to composer-2.5, not the fast variant", () => {
    expect(DEFAULT_MODEL_ID).toBe("composer-2.5");
    expect(effectiveModel(defaultModelSettings(), "role_planner")).toBe("composer-2.5");
    expect(effectiveModel(null, "role_planner")).toBe("composer-2.5");
  });

  it("prefers the tab, then the role, then the global default", () => {
    const settings = { defaultModel: "auto", roleModels: { role_planner: "gpt-5" } };
    expect(effectiveModel(settings, "role_general")).toBe("auto");
    expect(effectiveModel(settings, "role_planner")).toBe("gpt-5");
    expect(effectiveModel(settings, "role_planner", "sonnet-4.5")).toBe("sonnet-4.5");
    expect(effectiveModel(settings, "role_planner", "--yolo")).toBe("gpt-5");
  });

  it("searches id and label by every word", () => {
    expect(filterModels(models, "")).toHaveLength(3);
    expect(filterModels(models, "fast").map((m) => m.id)).toEqual(["composer-2.5-fast"]);
    expect(filterModels(models, "sonnet think").map((m) => m.id)).toEqual([
      "sonnet-4.5-thinking",
    ]);
    expect(filterModels(models, "COMPOSER")).toHaveLength(2);
  });

  it("rejects ids that could be flags", () => {
    expect(validModelId("composer-2.5")).toBe(true);
    expect(validModelId("-x")).toBe(false);
    expect(validModelId("a b")).toBe(false);
  });

  it("describes how a model change landed", () => {
    expect(modelChangeNote("gpt-5", null, false)).toContain("applies when");
    expect(modelChangeNote("gpt-5", "spawnFlag", true)).toContain("restarted");
    expect(modelChangeNote("gpt-5", "configOption", false)).toBe("Model set to gpt-5.");
  });
});
