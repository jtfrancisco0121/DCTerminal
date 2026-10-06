import { describe, expect, it } from "vitest";
import { folderName, searchTabs } from "./tabSearch";

const tabs = [
  { id: "1", label: "Planner · UI Overhaul", cwd: "/Users/jt/Projects/Koneksi", phase: "running" },
  { id: "2", label: "Developer · Encryptor", cwd: "C:\\Users\\jt\\Projects\\Encryptor", phase: "draft" },
  { id: "3", label: "Shell", cwd: "/Users/jt/Projects/koneksi-api", phase: "terminal" },
  { id: "4", label: "Reviewer · PR 12", cwd: "/Users/jt/DCTerminal", phase: "running" },
];

describe("folderName", () => {
  it("takes the last path part on any OS", () => {
    expect(folderName("/Users/jt/Projects/Koneksi/")).toBe("Koneksi");
    expect(folderName("C:\\Users\\jt\\Encryptor")).toBe("Encryptor");
    expect(folderName("")).toBe("");
  });
});

describe("searchTabs", () => {
  it("returns every tab in order for an empty query", () => {
    expect(searchTabs(tabs, "  ").map((t) => t.id)).toEqual(["1", "2", "3", "4"]);
  });

  it("finds tabs by name", () => {
    expect(searchTabs(tabs, "review").map((t) => t.id)).toEqual(["4"]);
  });

  it("finds tabs by folder, ranking the folder name above the full path", () => {
    expect(searchTabs(tabs, "koneksi").map((t) => t.id)).toEqual(["1", "3"]);
    expect(searchTabs(tabs, "encryptor").map((t) => t.id)).toEqual(["2"]);
    expect(searchTabs(tabs, "projects").map((t) => t.id)).toEqual(["1", "2", "3"]);
  });

  it("ranks a name prefix above a match inside the name", () => {
    const list = [
      { id: "a", label: "Fix developer docs", cwd: "/x", phase: "" },
      { id: "b", label: "Developer · App", cwd: "/y", phase: "" },
    ];
    expect(searchTabs(list, "dev").map((t) => t.id)).toEqual(["b", "a"]);
  });

  it("needs every word to match somewhere", () => {
    expect(searchTabs(tabs, "planner koneksi").map((t) => t.id)).toEqual(["1"]);
    expect(searchTabs(tabs, "planner encryptor")).toEqual([]);
  });

  it("can match status words passed in as extra text", () => {
    expect(
      searchTabs(tabs, "needs", (tab) => (tab.id === "4" ? "Needs you" : "")).map((t) => t.id),
    ).toEqual(["4"]);
  });
});
