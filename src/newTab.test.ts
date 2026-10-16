import { beforeEach, describe, expect, it, vi } from "vitest";

const projectsList = vi.fn();
const homeDir = vi.fn();
vi.mock("./bridge", () => ({ projectsList: () => projectsList() }));
vi.mock("@tauri-apps/api/path", () => ({ homeDir: () => homeDir() }));

import {
  activeTabFolder,
  folderName,
  loadNewTabContext,
  newTabMode,
  pickerKeyAction,
  pickNewTabFolder,
  recentProjectPaths,
  tildePath,
} from "./newTab";
import type { TabSummary } from "./bridge";

const project = (path: string, available = true) => ({ path, available, favorite: false });

describe("new tab folder rule", () => {
  it("prefers the active tab's folder", () => {
    expect(pickNewTabFolder({ activeCwd: "/w/app", recent: ["/w/other"], home: "/h" })).toBe("/w/app");
  });

  it("falls back to the most recent project, then home", () => {
    expect(pickNewTabFolder({ activeCwd: "  ", recent: ["/w/other", "/w/x"], home: "/h" })).toBe("/w/other");
    expect(pickNewTabFolder({ activeCwd: null, recent: [], home: "/h" })).toBe("/h");
    expect(pickNewTabFolder({ activeCwd: null, recent: [], home: null })).toBeNull();
  });

  it("lists available recents once, at most nine", () => {
    const many = Array.from({ length: 12 }, (_, i) => project(`/p/${i}`));
    expect(recentProjectPaths([project("/a"), project("/gone", false), project("/a"), project(" ")])).toEqual(["/a"]);
    expect(recentProjectPaths(many)).toHaveLength(9);
  });

  it("reads the active tab's folder", () => {
    const tabs = [{ id: "t1", cwd: "/w/app" }, { id: "t2", cwd: "" }] as TabSummary[];
    expect(activeTabFolder(tabs, "t1")).toBe("/w/app");
    expect(activeTabFolder(tabs, "t2")).toBeNull();
    expect(activeTabFolder(tabs, null)).toBeNull();
  });
});

describe("loadNewTabContext", () => {
  beforeEach(() => {
    projectsList.mockReset();
    homeDir.mockReset();
  });

  it("uses the recent projects and the home folder", async () => {
    projectsList.mockResolvedValue({ favorites: [], recent: [project("/w/recent")] });
    homeDir.mockResolvedValue("/home/me");
    expect(await loadNewTabContext(null)).toEqual({
      folder: "/w/recent",
      recents: ["/w/recent"],
      home: "/home/me",
    });
    expect((await loadNewTabContext("/w/active")).folder).toBe("/w/active");
  });

  it("falls back to home when the project list fails", async () => {
    projectsList.mockRejectedValue(new Error("nope"));
    homeDir.mockResolvedValue("/home/me");
    expect((await loadNewTabContext(null)).folder).toBe("/home/me");
  });

  it("copes without a home folder", async () => {
    projectsList.mockResolvedValue({ favorites: [], recent: [] });
    homeDir.mockRejectedValue(new Error("no path api"));
    expect(await loadNewTabContext(null)).toEqual({ folder: null, recents: [], home: null });
  });
});

describe("new tab helpers", () => {
  it("reads unknown settings as ask", () => {
    expect(newTabMode("claude")).toBe("claude");
    expect(newTabMode("shell")).toBe("shell");
    expect(newTabMode("start")).toBe("start");
    expect(newTabMode("rocket")).toBe("ask");
    expect(newTabMode(undefined)).toBe("ask");
  });

  it("maps picker keys", () => {
    expect(pickerKeyAction("c", 0)).toEqual({ kind: "claude" });
    expect(pickerKeyAction("S", 0)).toEqual({ kind: "shell" });
    expect(pickerKeyAction("r", 0)).toEqual({ kind: "role" });
    expect(pickerKeyAction("o", 0)).toEqual({ kind: "open" });
    expect(pickerKeyAction("2", 3)).toEqual({ kind: "recent", index: 1 });
    expect(pickerKeyAction("4", 3)).toBeNull();
    expect(pickerKeyAction("0", 3)).toBeNull();
    expect(pickerKeyAction("x", 3)).toBeNull();
  });

  it("shortens paths under home", () => {
    expect(tildePath("/Users/me/code/app", "/Users/me")).toBe("~/code/app");
    expect(tildePath("/Users/me", "/Users/me/")).toBe("~");
    expect(tildePath("/Users/meme/x", "/Users/me")).toBe("/Users/meme/x");
    expect(tildePath("/x", null)).toBe("/x");
    expect(folderName("/Users/me/code/app/")).toBe("app");
    expect(folderName("C:\\work\\api")).toBe("api");
  });
});
