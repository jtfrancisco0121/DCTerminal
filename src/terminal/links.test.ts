import { describe, expect, it } from "vitest";
import { findBarePaths, findPathLinks, isLinkModifier, MAX_BARE_PER_LINE, relativeToCwd } from "./links";

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

describe("findBarePaths", () => {
  const paths = (text: string) => findBarePaths(text).map((item) => item.path);

  it("finds paths inside tool calls, quotes and sentences", () => {
    expect(paths("Write(docs/plan.md)")).toEqual(["docs/plan.md"]);
    expect(paths("Saved report to ./out/report.pdf.")).toEqual(["./out/report.pdf"]);
    expect(paths("edit `README.md`, then src/lib")).toEqual(["README.md", "src/lib"]);
    expect(paths("/work/app/src/main.rs is new")).toEqual(["/work/app/src/main.rs"]);
  });

  it("gives offsets that cover only the path", () => {
    const text = "Write(docs/plan.md)";
    const [item] = findBarePaths(text);
    expect(text.slice(item.start, item.end)).toBe("docs/plan.md");
  });

  it("leaves path:line to findPathLinks", () => {
    expect(paths("error in src/app.ts:12:5 and lib/x.rs")).toEqual(["lib/x.rs"]);
  });

  it("skips URLs, flags, versions, home paths and plain words", () => {
    expect(paths("see https://example.com/a.html")).toEqual([]);
    expect(paths("--out=dist/x.js -v @scope/pkg")).toEqual([]);
    expect(paths("version 1.2.3 and v2.0")).toEqual([]);
    expect(paths("~/notes.md hello world .. ./")).toEqual([]);
  });

  it("caps the candidates per line", () => {
    const line = Array.from({ length: 40 }, (_, i) => `f${i}.ts`).join(" ");
    expect(findBarePaths(line)).toHaveLength(MAX_BARE_PER_LINE);
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
