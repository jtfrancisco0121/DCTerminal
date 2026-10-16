// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { forgetPlanPanes, planPaneOpen, resetPlanPaneState, setPlanPaneOpen, usePrunePlanPanes } from "./planPaneState";

const stored = () => JSON.parse(window.localStorage.getItem("dcterminal.planPaneOpen") ?? "[]");

describe("planPaneState", () => {
  beforeEach(() => resetPlanPaneState());

  it("forgets the panes of tabs that closed, in storage too", () => {
    setPlanPaneOpen("a", true);
    setPlanPaneOpen("b", true);
    forgetPlanPanes(["a", "gone"]);
    expect(planPaneOpen("a")).toBe(false);
    expect(planPaneOpen("b")).toBe(true);
    expect(stored()).toEqual(["b"]);
  });

  it("prunes only tabs this window saw open and then close", () => {
    setPlanPaneOpen("a", true);
    setPlanPaneOpen("b", true);
    // "other" is another window's tab: never seen here, never pruned.
    setPlanPaneOpen("other", true);
    const { rerender } = renderHook(({ ids }) => usePrunePlanPanes(ids), { initialProps: { ids: ["a", "b"] } });
    expect(stored().sort()).toEqual(["a", "b", "other"]);
    rerender({ ids: ["b"] });
    expect(planPaneOpen("a")).toBe(false);
    expect(stored().sort()).toEqual(["b", "other"]);
  });
});
