import { describe, expect, it } from "vitest";
import {
  deriveTerminalState,
  dialogAfterRead,
  sameTerminalState,
  terminalNeedsMessage,
  terminalWaitingText,
  type TerminalStateInput,
} from "./claudeState";

const open = (name: string, id = "toolu_1") => ({ id, name, title: `${name}: x` });
const base: TerminalStateInput = { log: null, dialogVisible: false, ptyBusy: false, exitCode: null };
const derive = (over: Partial<TerminalStateInput>) => deriveTerminalState({ ...base, ...over });

describe("deriveTerminalState", () => {
  it("is exited first, whatever the log or dialog say", () => {
    expect(
      derive({
        exitCode: 2,
        log: { turnDone: false, openTool: open("ExitPlanMode") },
        dialogVisible: true,
        ptyBusy: true,
      }),
    ).toEqual({ kind: "exited", code: 2 });
    expect(derive({ exitCode: 0 })).toEqual({ kind: "exited", code: 0 });
  });

  it("needs you right away for a plan or a question", () => {
    expect(derive({ log: { turnDone: false, openTool: open("ExitPlanMode") } })).toMatchObject({
      kind: "needs",
      needs: "plan",
      toolId: "toolu_1",
    });
    expect(derive({ log: { turnDone: false, openTool: open("AskUserQuestion") } })).toMatchObject({
      kind: "needs",
      needs: "question",
    });
  });

  it("needs permission only while the dialog is on screen", () => {
    const log = { turnDone: false, openTool: open("Bash") };
    expect(derive({ log, dialogVisible: true })).toMatchObject({ kind: "needs", needs: "permission" });
    // A quiet long-running tool: working, never needs you.
    expect(derive({ log, dialogVisible: false, ptyBusy: false })).toEqual({ kind: "working" });
  });

  it("ignores the dialog without an open tool or after the turn", () => {
    expect(derive({ log: { turnDone: false, openTool: null }, dialogVisible: true })).toEqual({
      kind: "working",
    });
    expect(derive({ log: { turnDone: true, openTool: open("Bash") }, dialogVisible: true })).toEqual({
      kind: "idle",
    });
    expect(derive({ log: null, dialogVisible: true, ptyBusy: false })).toEqual({ kind: "idle" });
  });

  it("is working by the log when there is one, else by PTY output", () => {
    expect(derive({ log: { turnDone: false }, ptyBusy: false })).toEqual({ kind: "working" });
    expect(derive({ log: { turnDone: true }, ptyBusy: true })).toEqual({ kind: "idle" });
    expect(derive({ log: null, ptyBusy: true })).toEqual({ kind: "working" });
    expect(derive({ log: undefined, ptyBusy: false, exitCode: undefined })).toEqual({ kind: "idle" });
  });
});

describe("terminal state text", () => {
  it("compares states by value", () => {
    expect(sameTerminalState({ kind: "working" }, { kind: "working" })).toBe(true);
    expect(sameTerminalState({ kind: "exited", code: 1 }, { kind: "exited", code: 2 })).toBe(false);
    const a = { kind: "needs", needs: "permission", toolId: "a", toolTitle: "Bash" } as const;
    expect(sameTerminalState(a, { ...a })).toBe(true);
    expect(sameTerminalState(a, { ...a, toolId: "b" })).toBe(false);
    expect(sameTerminalState(undefined, undefined)).toBe(true);
  });

  it("says what the terminal waits for", () => {
    expect(terminalWaitingText("plan")).toBe("waiting for you on a plan to review");
    expect(terminalWaitingText("permission")).toBe("waiting for you on a permission request");
    expect(
      terminalNeedsMessage({ kind: "needs", needs: "plan", toolId: "t", toolTitle: "" }),
    ).toBe("Claude Code needs your approval for the plan");
    expect(
      terminalNeedsMessage({ kind: "needs", needs: "permission", toolId: "t", toolTitle: "Bash: ls" }),
    ).toBe("Claude Code needs your permission: Bash: ls");
  });
});

describe("dialogAfterRead", () => {
  const owner = (toolId: string | null, since = 100) => ({ since, toolId });
  const log = (openId: string | null, turnDone = false) => ({
    turnDone,
    openTool: openId ? open("Bash", openId) : null,
  });

  it("adopts the open tool from the first read after the dialog appeared", () => {
    expect(dialogAfterRead(owner(null), log("toolu_b"), 150)).toEqual({
      owner: owner("toolu_b"),
      clear: false,
    });
  });

  it("does not clear a new dialog because an earlier tool finished", () => {
    // Tool A was open at the last read; B's dialog was drawn since.
    expect(dialogAfterRead(owner(null), log("toolu_b"), 150).clear).toBe(false);
    expect(dialogAfterRead(owner("toolu_b"), log("toolu_b"), 200).clear).toBe(false);
  });

  it("ignores reads that started before the dialog was drawn", () => {
    expect(dialogAfterRead(owner(null, 100), log("toolu_a"), 90)).toEqual({
      owner: owner(null, 100),
      clear: false,
    });
  });

  it("ignores a failed read", () => {
    expect(dialogAfterRead(owner("toolu_b"), null, 200)).toEqual({
      owner: owner("toolu_b"),
      clear: false,
    });
  });

  it("clears once its own tool is answered or rejected, or the turn ends", () => {
    expect(dialogAfterRead(owner("toolu_b"), log(null), 200)).toEqual({ owner: undefined, clear: true });
    expect(dialogAfterRead(owner("toolu_b"), log("toolu_c"), 200).clear).toBe(true);
    expect(dialogAfterRead(owner(null), log(null, true), 200).clear).toBe(true);
  });

  it("does nothing while no dialog is shown", () => {
    expect(dialogAfterRead(undefined, log(null), 200)).toEqual({ owner: undefined, clear: false });
  });
});
