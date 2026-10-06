import { describe, expect, it } from "vitest";
import { appendReference, atReference, formatSize, isSaveChord, joinRoot } from "./paths";

describe("file panel paths", () => {
  it("builds @file references", () => {
    expect(atReference("src/main.rs")).toBe("@src/main.rs");
    expect(atReference("docs/My Notes.md")).toBe('@"docs/My Notes.md"');
    expect(appendReference("", "a.ts")).toBe("@a.ts ");
    expect(appendReference("look at", "a.ts")).toBe("look at @a.ts ");
    expect(appendReference("look at ", "a.ts")).toBe("look at @a.ts ");
  });

  it("joins the root with the platform separator", () => {
    expect(joinRoot("/Users/jt/app", "src/a.ts")).toBe("/Users/jt/app/src/a.ts");
    expect(joinRoot("C:\\Work\\app", "src/a.ts")).toBe("C:\\Work\\app\\src\\a.ts");
    expect(joinRoot("/x/", "")).toBe("/x/");
  });

  it("uses Cmd+S on macOS and Ctrl+S elsewhere", () => {
    const base = { code: "KeyS", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
    expect(isSaveChord({ ...base, metaKey: true }, true)).toBe(true);
    expect(isSaveChord({ ...base, ctrlKey: true }, true)).toBe(false);
    expect(isSaveChord({ ...base, ctrlKey: true }, false)).toBe(true);
    expect(isSaveChord({ ...base, ctrlKey: true, shiftKey: true }, false)).toBe(false);
  });

  it("formats sizes", () => {
    expect(formatSize(10)).toBe("10 B");
    expect(formatSize(2048)).toBe("2.0 KB");
  });
});
