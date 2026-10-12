import { describe, expect, it } from "vitest";
import {
  deriveTerminalState,
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
