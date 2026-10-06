import { describe, expect, it } from "vitest";
import {
  CHOOSE_FOLDER_PROMPT,
  folderForTab,
  folderName,
  folderPickFillsField,
  nativeDialogPath,
  normalizeFolderPath,
  pastedFolderPath,
  projectRowLabel,
} from "./projectsView";

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

  it("starts a new tab empty and keeps a restored tab's folder", () => {
    expect(folderForTab(null)).toBe("");
    expect(folderForTab("   ")).toBe("");
    expect(folderForTab("C:\\Repos\\Demo")).toBe("C:\\Repos\\Demo");
    expect(CHOOSE_FOLDER_PROMPT).toBe("Choose a folder");
  });

  it("shows the folder name separately from the full path", () => {
    expect(folderName("C:\\Users\\user\\Documents\\Projects\\DCTerminal")).toBe(
      "DCTerminal",
    );
    expect(folderName("C:\\Repos\\Demo\\")).toBe("Demo");
    expect(folderName("\\\\server\\share\\proj")).toBe("proj");
    expect(folderName("")).toBe("");
  });

  it("reads a native dialog result and ignores cancel", () => {
    expect(nativeDialogPath("D:\\Work\\App")).toBe("D:\\Work\\App");
    expect(nativeDialogPath(["D:\\Work\\App"])).toBe("D:\\Work\\App");
    expect(nativeDialogPath(null)).toBeNull();
    expect(nativeDialogPath("  ")).toBeNull();
  });

  it("rejects a blank pasted path before validation", () => {
    expect(pastedFolderPath("  ")).toBeNull();
    expect(pastedFolderPath("D:\\Work\\App")).toBe("D:\\Work\\App");
  });
});
