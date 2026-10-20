import { describe, expect, it, vi } from "vitest";
import { actorRunFor, showActorOutcome } from "./actorSend";

describe("showActorOutcome", () => {
  it("lists the tabs, then switches to the terminal the actor opened", async () => {
    const calls: string[] = [];
    const deps = {
      refreshTabs: vi.fn(async () => void calls.push("refresh")),
      selectTab: vi.fn(async (id: string) => void calls.push(`select ${id}`)),
    };
    await showActorOutcome({ tabId: "tab_new" }, deps);
    expect(calls).toEqual(["refresh", "select tab_new"]);
  });

  it("falls back to the tab it sent into, and selects nothing when there is none", async () => {
    const deps = { refreshTabs: vi.fn(async () => {}), selectTab: vi.fn(async () => {}) };
    await showActorOutcome({}, deps, "tab_planner");
    expect(deps.selectTab).toHaveBeenCalledWith("tab_planner");
    deps.selectTab.mockClear();
    await showActorOutcome({ tabId: null }, deps);
    expect(deps.refreshTabs).toHaveBeenCalledTimes(2);
    expect(deps.selectTab).not.toHaveBeenCalled();
  });
});

describe("actorRunFor", () => {
  const bridged = { chain: { chainId: "ee_1" }, bridge: { runId: "ee_1" } };
  it("sends a terminal hand-off on an engine-2 run to its actor", () => {
    expect(actorRunFor("terminal", bridged, 2)).toBe("ee_1");
    // An unbridged tab of an engine-2 run too: the run decides, not the tab.
    expect(actorRunFor("terminal", { chain: { chainId: "ee_1" }, bridge: null }, 2)).toBe("ee_1");
  });

  it("a still-bridged tab of a run switched to engine 1 hands on the engine-1 way", () => {
    expect(actorRunFor("terminal", bridged, 1)).toBeNull();
    expect(actorRunFor("terminal", bridged, null)).toBeNull();
    expect(actorRunFor("chat", bridged, 2)).toBeNull();
    expect(actorRunFor("terminal", { chain: null, bridge: null }, 2)).toBeNull();
  });
});
