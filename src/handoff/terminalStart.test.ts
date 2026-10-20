import { describe, expect, it } from "vitest";
import type { PreparedHandoff } from "./executor";
import { handoffTerminalStart } from "./terminalStart";

const prepared = {
  source: {},
  target: {},
  mapped: { answers: { request: "Ship it" }, planField: null, inlinePlan: "", usesScratchPad: false },
  nextChain: { chainId: "ee_1", kind: "copies", step: 1, total: 4 },
} as unknown as PreparedHandoff;

describe("handoffTerminalStart", () => {
  it("starts the target in a new tab, as the source's provider, with the chain it joins", () => {
    const start = handoffTerminalStart(prepared, "role_custom_1", "/repo", "claude");
    expect(start).toMatchObject({
      roleId: "role_custom_1",
      tabId: null,
      provider: "claude",
      // Its stage kind sets the permission mode: a copied Planner plans.
      chain: { chainId: "ee_1", kind: "copies", step: 1 },
    });
    expect(start.values.cwd).toBe("/repo");
    expect(start.values.request).toBe("Ship it");
  });

  it("passes no chain off a pipeline", () => {
    expect(handoffTerminalStart({ ...prepared, nextChain: null }, "role_custom_1", "/repo", "claude").chain).toBeNull();
  });
});
