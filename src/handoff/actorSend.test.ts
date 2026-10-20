import { describe, expect, it, vi } from "vitest";
import { actorRunFor, recordRunFor, recordYourHandoff, releaseYourHandoff, showActorOutcome } from "./actorSend";

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

describe("a hand-off you make yourself on an engine-2 run (a Chat tab)", () => {
  const bridged = { chain: { chainId: "ee_1" }, bridge: { runId: "ee_1" } };
  it("is recorded on its run when the run is on engine 2, on any surface", () => {
    expect(recordRunFor(bridged, 2)).toBe("ee_1");
    expect(recordRunFor(bridged, 1)).toBeNull();
    expect(recordRunFor(bridged, null)).toBeNull();
    expect(recordRunFor({ chain: null }, 2)).toBeNull();
  });

  it("asks the actor to record it, returns autopilot's warning, and releases it after a failure", async () => {
    const message = vi.fn(async () => ({ warning: "Autopilot already handed this turn on (10:02)." }));
    const claim = { sourceTabId: "tab_1", back: false, force: false };
    expect(await recordYourHandoff("ee_1", claim, message)).toBe("Autopilot already handed this turn on (10:02).");
    expect(message).toHaveBeenCalledWith("ee_1", { kind: "recordHandoff", sourceTabId: "tab_1", back: false, force: false });
    message.mockResolvedValueOnce({} as never);
    expect(await recordYourHandoff("ee_1", { ...claim, back: true, force: true }, message)).toBeNull();
    await releaseYourHandoff("ee_1", { ...claim, back: true }, message);
    expect(message).toHaveBeenLastCalledWith("ee_1", { kind: "releaseHandoff", sourceTabId: "tab_1", back: true });
    // No run (engine 1): nothing to record or release.
    message.mockClear();
    expect(await recordYourHandoff(null, claim, message)).toBeNull();
    await releaseYourHandoff(null, claim, message);
    expect(message).not.toHaveBeenCalled();
    // A record the actor refuses (a tab it does not place) does not block the hand-off.
    message.mockRejectedValueOnce(new Error("That tab is not on this run."));
    expect(await recordYourHandoff("ee_1", claim, message)).toBeNull();
    // A release that fails is silent: the record only adds a warning later.
    message.mockRejectedValueOnce(new Error("gone"));
    await expect(releaseYourHandoff("ee_1", claim, message)).resolves.toBeUndefined();
  });
});
