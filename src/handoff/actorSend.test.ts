import { describe, expect, it, vi } from "vitest";
import { showActorOutcome } from "./actorSend";

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
