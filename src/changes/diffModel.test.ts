import { describe, expect, it } from "vitest";
import {
  acceptKey,
  parseUnifiedDiff,
  revertConfirmText,
  statusLetter,
  toSplitRows,
  unaccepted,
} from "./diffModel";

const patch = [
  "diff --git a/a.txt b/a.txt",
  "index 1111111..2222222 100644",
  "--- a/a.txt",
  "+++ b/a.txt",
  "@@ -1,4 +1,5 @@ fn main",
  " one",
  "-two",
  "-three",
  "+TWO",
  "+THREE",
  "+extra",
  " four",
  "\\ No newline at end of file",
  "@@ -10,2 +11,1 @@",
  " ten",
  "-eleven",
  "",
].join("\n");

const file = (path: string, newBlob = "b".repeat(40), status = "modified") => ({
  path,
  cwdPath: path,
  status,
  oldBlob: "a".repeat(40),
  newBlob,
  additions: 1,
  deletions: 0,
  binary: false,
});

describe("parseUnifiedDiff", () => {
  it("numbers lines per side and skips file headers", () => {
    const hunks = parseUnifiedDiff(patch);
    expect(hunks).toHaveLength(2);
    expect(hunks[0].header).toBe("@@ -1,4 +1,5 @@ fn main");
    expect(hunks[0].lines.map((l) => [l.kind, l.oldNo, l.newNo, l.text])).toEqual([
      ["context", 1, 1, "one"],
      ["del", 2, null, "two"],
      ["del", 3, null, "three"],
      ["add", null, 2, "TWO"],
      ["add", null, 3, "THREE"],
      ["add", null, 4, "extra"],
      ["context", 4, 5, "four"],
    ]);
    expect(hunks[1].lines[1]).toMatchObject({ kind: "del", oldNo: 11, newNo: null });
  });

  it("returns nothing for an empty or binary diff", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
    expect(parseUnifiedDiff("Binary files a/x.png and b/x.png differ\n")).toEqual([]);
  });
});

describe("toSplitRows", () => {
  it("pairs a removed block with the added block after it", () => {
    const rows = toSplitRows(parseUnifiedDiff(patch)[0]);
    expect(rows.map((r) => [r.left?.text ?? null, r.right?.text ?? null])).toEqual([
      ["one", "one"],
      ["two", "TWO"],
      ["three", "THREE"],
      [null, "extra"],
      ["four", "four"],
    ]);
  });
});

describe("helpers", () => {
  it("maps statuses to letters", () => {
    expect(["added", "modified", "deleted", "typeChanged"].map(statusLetter)).toEqual([
      "A",
      "M",
      "D",
      "T",
    ]);
  });

  it("accepting is tied to the content: a later edit is unaccepted again", () => {
    const accepted = new Set([acceptKey(file("a.txt"))]);
    expect(unaccepted([file("a.txt"), file("b.txt")], accepted).map((f) => f.path)).toEqual([
      "b.txt",
    ]);
    expect(unaccepted([file("a.txt", "c".repeat(40))], accepted)).toHaveLength(1);
  });

  it("explains what a revert does", () => {
    expect(revertConfirmText([file("new.rs", "b".repeat(40), "added")], 0)).toContain(
      "deletes new.rs",
    );
    expect(revertConfirmText([file("gone.md", "0".repeat(40), "deleted")], 0)).toContain(
      "brings back gone.md",
    );
    const many = revertConfirmText([file("a"), file("b"), file("c")], 2);
    expect(many).toContain("Revert 3 files");
    expect(many).toContain("2 accepted files are kept");
  });
});
