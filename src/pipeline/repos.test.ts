import { describe, expect, it } from "vitest";
import { findRepo, laneFolders, MAX_REPO_NAME_CHARS, repoNameProblem } from "./repos";

const REPOS = [
  { name: "backend", folder: "/src/backend" },
  { name: "engine", folder: "/src/engine" },
];

describe("Settings › Repos (L1)", () => {
  it("names are one word of letters, digits, - and _, used once in any case", () => {
    expect(repoNameProblem("backend", [])).toBeNull();
    expect(repoNameProblem(" web_2-app ", ["backend"])).toBeNull();
    expect(repoNameProblem("  ", [])).toContain("Give the repo a name");
    expect(repoNameProblem("my repo", [])).toContain("only letters, digits, - and _");
    expect(repoNameProblem("../x", [])).toContain("only letters");
    expect(repoNameProblem("a".repeat(MAX_REPO_NAME_CHARS + 1), [])).toContain("longer than 40");
    expect(repoNameProblem("Backend", ["backend"])).toBe("There is already a repo named Backend.");
  });

  it("finds a repo in any case", () => {
    expect(findRepo(REPOS, " Engine ")?.folder).toBe("/src/engine");
    expect(findRepo(REPOS, "web")).toBeNull();
  });

  it("each lane's folder is its repo's, or the run's own when it names none", () => {
    const lanes = [
      { id: "pr1", title: "PR1 — API", dependsOn: [], manual: false, repo: "Backend" },
      { id: "pr2", title: "PR2 — Client", dependsOn: ["pr1"], manual: false, repo: "engine" },
      { id: "pr3", title: "PR3 — Docs", dependsOn: [], manual: false },
    ];
    expect(laneFolders(lanes, REPOS, "/home/run")).toEqual({
      folders: [
        { laneId: "pr1", repo: "backend", folder: "/src/backend" },
        { laneId: "pr2", repo: "engine", folder: "/src/engine" },
        { laneId: "pr3", repo: null, folder: "/home/run" },
      ],
    });
    // A repo removed from Settings after the plan: no folder is guessed.
    expect(laneFolders(lanes, REPOS.slice(0, 1), "/home/run")).toEqual({
      error: 'PR2 — Client is in the repo "engine", which is not in Settings › Repos. Add it there, or ask the Planner to leave its repo out.',
    });
  });
});
