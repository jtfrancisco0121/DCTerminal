import { afterEach, describe, expect, it, vi } from "vitest";

const terminalPlanFile = vi.fn(async (_since: number, _tabId?: string | null) => ({ text: " # Plan \n" }));
vi.mock("../bridge", () => ({
  createPtyChannel: () => ({}),
  terminalPlanFile: (since: number, tabId?: string | null) => terminalPlanFile(since, tabId),
}));
vi.mock("../terminal/park", () => ({ terminalSelection: () => "", terminalTailText: () => "" }));

const { beginLivePty, dropLivePty, restartLivePty } = await import("../terminal/live");
const { liveTerminalReader } = await import("./terminalText");

afterEach(() => {
  dropLivePty("t1");
  terminalPlanFile.mockClear();
  vi.restoreAllMocks();
});

describe("liveTerminalReader.planFile", () => {
  it("looks for plan files since the tab's first start, across a restart", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    beginLivePty("t1");
    now.mockReturnValue(5_000);
    restartLivePty("t1");
    expect(await liveTerminalReader.planFile("t1")).toBe("# Plan");
    expect(terminalPlanFile).toHaveBeenCalledWith(1_000, "t1");
  });

  it("is empty with no terminal open", async () => {
    expect(await liveTerminalReader.planFile("t1")).toBe("");
    expect(terminalPlanFile).not.toHaveBeenCalled();
  });
});
