// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  ACCEPTED_PER_TAB,
  ACCEPTED_STORAGE_KEY,
  ACCEPTED_TABS,
  addAccepted,
  loadAccepted,
  mergeAccepted,
  sanitizeAccepted,
  saveAccepted,
} from "./acceptedStore";

describe("accepted changes store", () => {
  beforeEach(() => {
    window.localStorage.removeItem(ACCEPTED_STORAGE_KEY);
  });

  it("round-trips through local storage", () => {
    const marks = addAccepted(addAccepted({}, "t1", "a.ts@1"), "t2", "b.ts@2");
    saveAccepted(marks);
    expect(loadAccepted()).toEqual({ t1: ["a.ts@1"], t2: ["b.ts@2"] });
  });

  it("starts empty when storage is missing or corrupt", () => {
    expect(loadAccepted()).toEqual({});
    window.localStorage.setItem(ACCEPTED_STORAGE_KEY, "{not json");
    expect(loadAccepted()).toEqual({});
  });

  it("drops bad shapes and caps each tab", () => {
    const many = Array.from({ length: ACCEPTED_PER_TAB + 5 }, (_, i) => `f${i}`);
    const clean = sanitizeAccepted({ t1: many, t2: "nope", t3: [1, "", "ok"], t4: [] });
    expect(clean.t1).toHaveLength(ACCEPTED_PER_TAB);
    expect(clean.t1[0]).toBe("f5");
    expect(clean.t3).toEqual(["ok"]);
    expect(clean.t2).toBeUndefined();
    expect(clean.t4).toBeUndefined();
    expect(sanitizeAccepted([])).toEqual({});
  });

  it("does not add a key twice", () => {
    const once = addAccepted({}, "t1", "a@1");
    expect(addAccepted(once, "t1", "a@1")).toBe(once);
  });

  it("merges with another window's saves instead of overwriting them", () => {
    saveAccepted({ other: ["x@1"] });
    saveAccepted({ mine: ["y@1"] });
    expect(loadAccepted()).toEqual({ other: ["x@1"], mine: ["y@1"] });
    saveAccepted({ mine: ["y@1", "z@2"] });
    expect(loadAccepted().mine).toEqual(["y@1", "z@2"]);
  });

  it("keeps only the most recently used tabs", () => {
    let marks = {};
    for (let i = 0; i < ACCEPTED_TABS + 3; i += 1) marks = mergeAccepted(marks, { [`t${i}`]: ["k"] });
    const tabs = Object.keys(marks);
    expect(tabs).toHaveLength(ACCEPTED_TABS);
    expect(tabs[0]).toBe("t3");
    expect(tabs[tabs.length - 1]).toBe(`t${ACCEPTED_TABS + 2}`);
  });
});
