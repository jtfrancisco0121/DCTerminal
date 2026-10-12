import { describe, expect, it } from "vitest";
import {
  deriveTerminalState,
  dialogAfterRead,
  dialogDrawn,
  dialogToolFor,
  sameTerminalState,
  terminalNeedsMessage,
  terminalWaitingText,
  type TerminalStateInput,
} from "./claudeState";

const open = (name: string, id = "toolu_1") => ({ id, name, title: `${name}: x` });
const base: TerminalStateInput = { log: null, dialogTool: null, ptyBusy: false, exitCode: null };
const derive = (over: Partial<TerminalStateInput>) => deriveTerminalState({ ...base, ...over });

describe("deriveTerminalState", () => {
  it("is exited first, whatever the log or dialog say", () => {
    expect(
      derive({
        exitCode: 2,
        log: { turnDone: false, openTool: open("ExitPlanMode") },
        dialogTool: open("Bash"),
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

  it("needs permission only while the dialog is on screen, naming the dialog's tool", () => {
    const first = open("Edit", "toolu_e1");
    const log = { turnDone: false, openTool: open("Edit", "toolu_e2"), pendingTools: [first, open("Edit", "toolu_e2")] };
    expect(derive({ log, dialogTool: first })).toEqual({
      kind: "needs",
      needs: "permission",
      toolId: "toolu_e1",
      toolTitle: "Edit: x",
    });
    // A quiet long-running tool: working, never needs you.
    expect(derive({ log, dialogTool: null, ptyBusy: false })).toEqual({ kind: "working" });
  });

  it("ignores the dialog after the turn or without a log", () => {
    expect(derive({ log: { turnDone: true, openTool: open("Bash") }, dialogTool: open("Bash") })).toEqual({
      kind: "idle",
    });
    expect(derive({ log: null, dialogTool: open("Bash"), ptyBusy: false })).toEqual({ kind: "idle" });
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

describe("dialog owner", () => {
  const owner = (toolId: string | null, since = 100, fresh = false) => ({ since, toolId, fresh });
  const log = (pending: string[], turnDone = false) => ({
    turnDone,
    openTool: pending.length ? open("Bash", pending[pending.length - 1]) : null,
    pendingTools: pending.map((id) => open("Bash", id)),
  });
  const shown = (o: ReturnType<typeof owner> | undefined, l: ReturnType<typeof log>) =>
    dialogToolFor(o, l)?.id ?? null;

  it("adopts the oldest unanswered tool from the first read after the draw", () => {
    expect(dialogAfterRead(dialogDrawn(undefined, 100), log(["toolu_b"]), 150)).toEqual({
      owner: owner("toolu_b"),
      clear: false,
    });
  });

  it("skips tools that show their own prompt", () => {
    const l = {
      turnDone: false,
      openTool: open("AskUserQuestion", "toolu_q"),
      pendingTools: [open("AskUserQuestion", "toolu_q"), open("Bash", "toolu_b")],
    };
    expect(dialogAfterRead(owner(null), l, 150).owner?.toolId).toBe("toolu_b");
  });

  it("does not show or clear a new dialog because an earlier tool was still open", () => {
    // Tool A (no dialog) was open at the last read; B's dialog was drawn since.
    const drawn = dialogDrawn(undefined, 100);
    expect(shown(drawn, log(["toolu_a"]))).toBe(null);
    const read = dialogAfterRead(drawn, log(["toolu_b"]), 150);
    expect(read.clear).toBe(false);
    expect(shown(read.owner, log(["toolu_b"]))).toBe("toolu_b");
  });

  it("parallel calls: the dialog is for the oldest, and a later call appearing does not clear it", () => {
    const first = dialogAfterRead(owner(null), log(["toolu_e1", "toolu_e2"]), 150).owner;
    expect(first?.toolId).toBe("toolu_e1");
    expect(dialogAfterRead(owner("toolu_b1"), log(["toolu_b1", "toolu_b2"]), 200).clear).toBe(false);
    // e1 answered, e2's dialog drawn: the next read moves to e2.
    const redrawn = dialogDrawn(owner("toolu_e1"), 300);
    expect(dialogAfterRead(redrawn, log(["toolu_e2"]), 350).owner?.toolId).toBe("toolu_e2");
  });

  it("after an answer, a redrawn dialog keeps its tool on screen until the next read", () => {
    const redrawn = dialogDrawn(owner("toolu_a"), 200);
    expect(shown(redrawn, log(["toolu_a"]))).toBe("toolu_a");
    expect(dialogAfterRead(redrawn, log(["toolu_b"]), 250)).toEqual({
      owner: owner("toolu_b", 200),
      clear: false,
    });
  });

  it("waits while the dialog's tool is not in the log yet", () => {
    expect(dialogAfterRead(owner(null), log([]), 150)).toEqual({ owner: owner(null), clear: false });
  });

  it("ignores reads that started before the dialog was drawn", () => {
    expect(dialogAfterRead(owner(null, 100), log(["toolu_a"]), 90)).toEqual({
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
    expect(dialogAfterRead(owner("toolu_b"), log([]), 200)).toEqual({ owner: undefined, clear: true });
    expect(dialogAfterRead(owner("toolu_b"), log(["toolu_c"]), 200).clear).toBe(true);
    expect(dialogAfterRead(owner(null), log([], true), 200).clear).toBe(true);
  });

  it("falls back to the open tool on older backends", () => {
    const old = { turnDone: false, openTool: open("Bash", "toolu_x") };
    expect(dialogAfterRead(owner(null), old, 150).owner?.toolId).toBe("toolu_x");
  });

  it("does nothing while no dialog is shown", () => {
    expect(dialogAfterRead(undefined, log([]), 200)).toEqual({ owner: undefined, clear: false });
    expect(shown(undefined, log(["toolu_a"]))).toBe(null);
  });
});
