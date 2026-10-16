// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  closedSince,
  parseTerminalViews,
  readTerminalViews,
  TERMINAL_VIEWS_KEY,
  toggledView,
  useTerminalViews,
  withoutTabs,
  withTerminalView,
} from "./terminalViews";

afterEach(() => localStorage.clear());

describe("terminal views", () => {
  it("keeps only Chat entries from storage and survives damage", () => {
    expect(parseTerminalViews('{"a":"chat","b":"terminal","c":7}')).toEqual({ a: "chat" });
    expect(parseTerminalViews("{not json")).toEqual({});
    expect(parseTerminalViews("[1]")).toEqual({});
    expect(parseTerminalViews(null)).toEqual({});
  });

  it("sets, clears and prunes ids", () => {
    expect(withTerminalView({}, "a", "chat")).toEqual({ a: "chat" });
    expect(withTerminalView({ a: "chat" }, "a", "terminal")).toEqual({});
    expect(withoutTabs({ a: "chat", b: "chat" }, ["a"])).toEqual({ b: "chat" });
    expect(closedSince(new Set(["a", "b"]), ["b", "c"])).toEqual(["a"]);
    expect(toggledView("chat")).toBe("terminal");
    expect(toggledView("terminal")).toBe("chat");
  });

  it("restores a tab's view after a restart and forgets it once the tab closes", () => {
    const first = renderHook(({ ids }) => useTerminalViews(ids), { initialProps: { ids: ["t1", "t2"] } });
    act(() => first.result.current.setView("t1", "chat"));
    expect(first.result.current.views).toEqual({ t1: "chat" });
    first.unmount();

    // A restart reads it back.
    const second = renderHook(({ ids }) => useTerminalViews(ids), { initialProps: { ids: ["t1", "t2"] } });
    expect(second.result.current.views).toEqual({ t1: "chat" });

    // t1 closes in this window.
    second.rerender({ ids: ["t2"] });
    expect(second.result.current.views).toEqual({});
    expect(readTerminalViews()).toEqual({});
  });

  it("leaves other windows' tabs alone", () => {
    localStorage.setItem(TERMINAL_VIEWS_KEY, JSON.stringify({ other: "chat" }));
    const { result, rerender } = renderHook(({ ids }) => useTerminalViews(ids), {
      initialProps: { ids: ["t1"] },
    });
    act(() => result.current.setView("t1", "chat"));
    rerender({ ids: [] });
    expect(readTerminalViews()).toEqual({ other: "chat" });
  });
});
