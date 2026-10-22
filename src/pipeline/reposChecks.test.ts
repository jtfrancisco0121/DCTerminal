import { describe, expect, it } from "vitest";
import { MAX_REPO_CHECK_CHARS, MAX_REPO_VERIFY_CHARS, repoCheckProblem, repoEntry, repoVerifyProblem } from "./repos";

describe("Settings › Repos checks and verify steps (L2)", () => {
  it("a check is one line of at most 2000 characters, and blank is none", () => {
    expect(repoCheckProblem("cd server && go test ./...")).toBeNull();
    expect(repoCheckProblem("   ")).toBeNull();
    expect(repoCheckProblem("  go test ./...\n")).toBeNull();
    expect(repoCheckProblem("go vet ./...\ngo test ./...")).toBe("The check is one line: no line breaks.");
    expect(repoCheckProblem("x".repeat(MAX_REPO_CHECK_CHARS))).toBeNull();
    expect(repoCheckProblem("x".repeat(MAX_REPO_CHECK_CHARS + 1))).toContain("longer than 2000");
  });

  it("verify steps may span lines, up to 2000 characters", () => {
    expect(repoVerifyProblem("Run qa128-ml.\nRead the log.")).toBeNull();
    expect(repoVerifyProblem("x".repeat(MAX_REPO_VERIFY_CHARS + 1))).toContain("longer than 2000");
  });

  it("saves the texts only when they hold something", () => {
    expect(repoEntry(" backend ", " /src/backend ", "  ", "")).toEqual({ name: "backend", folder: "/src/backend" });
    expect(Object.keys(repoEntry("backend", "/src/backend", "", ""))).toEqual(["name", "folder"]);
    expect(repoEntry("backend", "/src/backend", " cd server && go test ./... ", " Run it. ")).toEqual({
      name: "backend",
      folder: "/src/backend",
      check: "cd server && go test ./...",
      verify: "Run it.",
    });
  });
});
