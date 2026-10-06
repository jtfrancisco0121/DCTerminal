import { describe, expect, it } from "vitest";
import { folderPickFillsField, normalizeFolderPath, projectRowLabel } from "./projectsView";

describe("folder picker selection", () => {
  it("fills the working-folder field and does not start a session", () => {
    expect(folderPickFillsField("C:\\Repos\\Demo")).toEqual({
      cwd: "C:\\Repos\\Demo",
      startsSession: false,
    });
  });

  it("marks a missing folder as unavailable", () => {
    expect(projectRowLabel("C:\\missing", false)).toContain("unavailable");
    expect(projectRowLabel("C:\\ok", true)).toBe("C:\\ok");
  });

  it("treats Windows paths as equal when only slash and case differ", () => {
    expect(normalizeFolderPath("C:\\Repos\\Demo")).toBe(normalizeFolderPath("c:/repos/demo"));
  });
});
