import { describe, expect, it } from "vitest";
import { findPathLinks, isLinkModifier, relativeToCwd } from "./links";

describe("findPathLinks", () => {
  it("finds path:line and path:line:col with offsets", () => {
    const text = "error in src/app.ts:12:5 and ./lib/x.rs:7";
    const links = findPathLinks(text);
    expect(links.map((l) => [l.path, l.line, l.column])).toEqual([
      ["src/app.ts", 12, 5],
      ["./lib/x.rs", 7, null],
    ]);
    expect(text.slice(links[0].start, links[0].end)).toBe("src/app.ts:12:5");
    expect(links[0].text).toBe("src/app.ts:12:5");
  });

  it("finds a path at the start of a line and in parentheses", () => {
    expect(findPathLinks("a.py:3: bad")[0].path).toBe("a.py");
    expect(findPathLinks("(src/a.tsx:9)")[0].path).toBe("src/a.tsx");
    expect(findPathLinks("C:\\work\\a.cs:4")[0].path).toBe("C:\\work\\a.cs");
  });

  it("does not take URLs, times or versions for files", () => {
    expect(findPathLinks("see http://example.com:8080/x")).toEqual([]);
    expect(findPathLinks("at 12:30:45 today")).toEqual([]);
    expect(findPathLinks("version 1.2:3")).toEqual([]);
    expect(findPathLinks("file.ts without a line")).toEqual([]);
    expect(findPathLinks("src/a.ts:0")).toEqual([]);
  });
});

describe("relativeToCwd", () => {
  it("keeps relative paths and drops ./", () => {
    expect(relativeToCwd("./src/a.ts", "/work/app")).toBe("src/a.ts");
    expect(relativeToCwd("src/a/../b.ts", "/work/app")).toBe("src/b.ts");
  });
  it("strips the folder from absolute paths inside it", () => {
    expect(relativeToCwd("/work/app/src/a.ts", "/work/app/")).toBe("src/a.ts");
    expect(relativeToCwd("C:\\Work\\app\\a.ts", "c:\\work\\app")).toBe("a.ts");
  });
  it("refuses paths outside the folder", () => {
    expect(relativeToCwd("/etc/hosts", "/work/app")).toBeNull();
    expect(relativeToCwd("/work/application/a.ts", "/work/app")).toBeNull();
    expect(relativeToCwd("../x.ts", "/work/app")).toBeNull();
    expect(relativeToCwd("~/x.ts", "/work/app")).toBeNull();
  });
});

describe("isLinkModifier", () => {
  it("is Cmd on macOS and Ctrl elsewhere", () => {
    expect(isLinkModifier({ metaKey: true, ctrlKey: false }, "mac")).toBe(true);
    expect(isLinkModifier({ metaKey: false, ctrlKey: true }, "mac")).toBe(false);
    expect(isLinkModifier({ metaKey: false, ctrlKey: true }, "linux")).toBe(true);
    expect(isLinkModifier({ metaKey: true, ctrlKey: false }, "windows")).toBe(false);
  });
});
