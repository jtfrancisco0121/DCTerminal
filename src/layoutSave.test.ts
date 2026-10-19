import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./uiErrors", () => ({ reportError: vi.fn() }));

import { reportError } from "./uiErrors";
import { layoutToSave, saveLayout } from "./layoutSave";

describe("saveLayout", () => {
  beforeEach(() => vi.mocked(reportError).mockClear());

  it("saves the open split, clamped", async () => {
    const save = vi.fn(async () => {});
    await saveLayout({ mode: "vertical", secondaryTabId: "b", primarySize: 99 }, true, 320, save);
    expect(save).toHaveBeenCalledWith({
      splitMode: "vertical",
      secondaryTabId: "b",
      gridTabIds: [],
      primarySize: 85,
      filePanelOpen: true,
      filePanelWidth: 320,
    });
    expect(reportError).not.toHaveBeenCalled();
  });

  it("a closed split saves as single", () => {
    expect(layoutToSave({ mode: "horizontal", secondaryTabId: null }, false, 0).splitMode).toBe("single");
  });

  it("a failed save is reported, once per session, as a background call", async () => {
    const error = new Error("disk full");
    await saveLayout({ mode: "single", secondaryTabId: null }, false, 0, () => Promise.reject(error));
    expect(reportError).toHaveBeenCalledWith("Layout not saved", error, { notify: true, once: true });
  });
});
