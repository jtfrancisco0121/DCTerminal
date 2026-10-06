import { describe, expect, it } from "vitest";
import { createActivityTracker, isUserInput } from "./activity";

describe("terminal activity tracker", () => {
  it("is busy while output keeps streaming after the last keystroke", () => {
    const t = createActivityTracker({ quietMs: 3000, echoMs: 500 });
    t.input("tab", 1000);
    t.output("tab", 1100); // echo of the keystroke
    expect(t.isBusy("tab", 1200)).toBe(false);
    t.output("tab", 1800);
    expect(t.isBusy("tab", 1900)).toBe(true);
    expect(t.isBusy("tab", 4700)).toBe(true);
    expect(t.isBusy("tab", 4900)).toBe(false);
  });

  it("reports busy-to-quiet transitions once", () => {
    const t = createActivityTracker({ quietMs: 3000, echoMs: 500 });
    t.input("a", 0);
    t.input("b", 0);
    t.output("a", 1000);
    t.output("b", 1000);
    expect(t.sweep(1500)).toEqual({ busy: ["a", "b"], settled: [] });
    t.output("b", 3000);
    expect(t.sweep(4100)).toEqual({ busy: ["b"], settled: ["a"] });
    expect(t.sweep(4200)).toEqual({ busy: ["b"], settled: [] });
    expect(t.sweep(6100)).toEqual({ busy: [], settled: ["b"] });
  });

  it("does not call startup output a finished result before the user typed", () => {
    const t = createActivityTracker({ quietMs: 3000, echoMs: 500 });
    t.output("a", 1000);
    expect(t.sweep(1500)).toEqual({ busy: ["a"], settled: [] });
    expect(t.sweep(4100)).toEqual({ busy: [], settled: [] });
  });

  it("ignores the shell pane on a chat tab and forgets dropped tabs", () => {
    const t = createActivityTracker({ quietMs: 3000, echoMs: 500 });
    t.output("tab::pane", 1000);
    expect(t.isBusy("tab::pane", 1100)).toBe(false);
    t.output("x", 1000);
    t.forget("x");
    expect(t.sweep(1100)).toEqual({ busy: [], settled: [] });
  });
});

describe("isUserInput", () => {
  it("skips the terminal's own replies to cursor and device queries", () => {
    expect(isUserInput("\x1b[12;1R")).toBe(false);
    expect(isUserInput("\x1b[?1;2c")).toBe(false);
    expect(isUserInput("\x1b[0n")).toBe(false);
    expect(isUserInput("\x1b[I")).toBe(false);
    expect(isUserInput("\x1b[O")).toBe(false);
    expect(isUserInput("")).toBe(false);
  });

  it("counts typing, Enter, and arrow keys", () => {
    expect(isUserInput("l")).toBe(true);
    expect(isUserInput("\r")).toBe(true);
    expect(isUserInput("\x1b[A")).toBe(true);
    expect(isUserInput("fix the bug\r")).toBe(true);
  });
});
