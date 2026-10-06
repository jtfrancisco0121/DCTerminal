import { describe, expect, it } from "vitest";
import { findAll, highlightParts, searchSegments, snippet } from "./textSearch";

describe("findAll", () => {
  it("is case-insensitive and non-overlapping, like the Rust side", () => {
    expect(findAll("Foo foo FOO", "foo")).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
      { start: 8, end: 11 },
    ]);
    expect(findAll("aaaa", "aa")).toHaveLength(2);
    expect(findAll("héllo HÉLLO", "héllo")).toHaveLength(2);
    expect(findAll("abc", "")).toEqual([]);
    expect(findAll("abc", "  ")).toEqual([]);
  });
});

describe("snippet", () => {
  it("is one line with ellipses when cut", () => {
    const text = `${"x".repeat(100)}\nthe needle is here\n${"y".repeat(100)}`;
    const [range] = findAll(text, "NEEDLE");
    const s = snippet(text, range, 60);
    expect(s.match).toBe("needle");
    expect(s.before.startsWith("…")).toBe(true);
    expect(s.before.endsWith("the ")).toBe(true);
    expect(s.after.startsWith(" is here ")).toBe(true);
    expect(s.after.endsWith("…")).toBe(true);
  });
});

describe("searchSegments", () => {
  it("lists hits per segment in order and skips empty thoughts", () => {
    const hits = searchSegments(
      [
        { id: "s1", kind: "user", text: "Fix the login bug" },
        { id: "s2", kind: "thought", text: "" },
        { id: "s3", kind: "agent", text: "The login form and the LOGIN api" },
      ],
      "login",
    );
    expect(hits.map((h) => [h.segmentId, h.occurrence])).toEqual([
      ["s1", 0],
      ["s3", 0],
      ["s3", 1],
    ]);
    expect(hits[2].match).toBe("LOGIN");
  });
});

describe("highlightParts", () => {
  it("splits text into hits and plain parts and numbers the hits", () => {
    expect(highlightParts("a Cat and a cat", "cat")).toEqual([
      { text: "a ", hit: null },
      { text: "Cat", hit: 0 },
      { text: " and a ", hit: null },
      { text: "cat", hit: 1 },
    ]);
    expect(highlightParts("plain", "")).toEqual([{ text: "plain", hit: null }]);
  });
});
