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

const open = (name: string, id = "toolu_1", hint = "") => ({ id, name, title: `${name}: x`, hint });
const onScreen = (tool: ReturnType<typeof open>, prompt = "Do you want to proceed?") => ({ ...tool, prompt });
const base: TerminalStateInput = { log: null, dialogTool: null, ptyBusy: false, exitCode: null };
const derive = (over: Partial<TerminalStateInput>) => deriveTerminalState({ ...base, ...over });

describe("deriveTerminalState", () => {
  it("is exited first, whatever the log or dialog say", () => {
    expect(
      derive({
        exitCode: 2,
        log: { turnDone: false, openTool: open("ExitPlanMode") },
        dialogTool: onScreen(open("Bash")),
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
    expect(derive({ log, dialogTool: onScreen(first) })).toEqual({
      kind: "needs",
      needs: "permission",
      toolId: "toolu_e1",
      toolTitle: "Edit: x",
      prompt: "Do you want to proceed?",
    });
    // A quiet long-running tool: working, never needs you.
    expect(derive({ log, dialogTool: null, ptyBusy: false })).toEqual({ kind: "working" });
  });

  it("ignores the dialog after the turn or without a log", () => {
    expect(
      derive({ log: { turnDone: true, openTool: open("Bash") }, dialogTool: onScreen(open("Bash")) }),
    ).toEqual({ kind: "idle" });
    expect(derive({ log: null, dialogTool: onScreen(open("Bash")), ptyBusy: false })).toEqual({ kind: "idle" });
  });

  it("a permission dialog on screen wins over a question queued behind it", () => {
    const bash = open("Bash", "toolu_b");
    const log = {
      turnDone: false,
      openTool: open("AskUserQuestion", "toolu_q"),
      pendingTools: [bash, open("AskUserQuestion", "toolu_q")],
    };
    expect(derive({ log, dialogTool: onScreen(bash) })).toMatchObject({ needs: "permission", toolId: "toolu_b" });
    expect(derive({ log, dialogTool: null })).toMatchObject({ needs: "question" });
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
    expect(sameTerminalState({ ...a, prompt: "rm a" }, { ...a, prompt: "rm b" })).toBe(false);
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
  type Tool = ReturnType<typeof open>;
  const owner = (
    toolId: string | null,
    opts: { since?: number; fresh?: boolean; prompt?: string; shownPrompt?: string } = {},
  ) => {
    const prompt = opts.prompt ?? "Do you want to proceed?";
    return { since: opts.since ?? 100, prompt, toolId, shownPrompt: opts.shownPrompt ?? prompt, fresh: opts.fresh ?? false };
  };
  const log = (pending: (string | Tool)[], turnDone = false) => {
    const tools = pending.map((item) => (typeof item === "string" ? open("Bash", item) : item));
    return { turnDone, openTool: tools[tools.length - 1] ?? null, pendingTools: tools };
  };
  const read = (o: ReturnType<typeof owner> | undefined, l: ReturnType<typeof log> | null, at = 150, answering = false) =>
    dialogAfterRead(o, l, at, answering);
  const shown = (o: ReturnType<typeof owner> | undefined, l: ReturnType<typeof log>) =>
    dialogToolFor(o, l)?.id ?? null;
  const drawn = (prompt = "Do you want to proceed?", prev?: ReturnType<typeof owner>, at = 100) =>
    dialogDrawn(prev, at, prompt);

  it("adopts the oldest unanswered call from the first read after the draw", () => {
    expect(read(drawn(), log(["toolu_b"]))).toEqual({ owner: owner("toolu_b"), clear: false });
  });

  it("skips calls that show their own prompt", () => {
    const l = log([open("AskUserQuestion", "toolu_q"), "toolu_b"]);
    expect(read(drawn(), l).owner?.toolId).toBe("toolu_b");
  });

  it("does not show or clear a new dialog because an earlier call was still open", () => {
    // Call A (no dialog) was open at the last read; B's dialog was drawn since.
    expect(shown(drawn(), log(["toolu_a"]))).toBe(null);
    const next = read(drawn(), log(["toolu_b"]));
    expect(next.clear).toBe(false);
    expect(shown(next.owner, log(["toolu_b"]))).toBe("toolu_b");
  });

  it("parallel calls: the dialog is for the call its text names", () => {
    const w1 = open("WebFetch", "toolu_w1", "docs.example.com");
    const w2 = open("WebFetch", "toolu_w2", "api.other.dev");
    const prompt = "Fetch\nhttps://api.other.dev/v1\nDo you want to allow Claude to fetch this content?";
    expect(read(drawn(prompt), log([w1, w2])).owner?.toolId).toBe("toolu_w2");
    // Nothing named: the oldest, as Claude Code asks oldest first.
    expect(read(drawn(), log(["toolu_e1", "toolu_e2"])).owner?.toolId).toBe("toolu_e1");
  });

  it("an earlier parallel call finishing without input moves the dialog, never hides it", () => {
    const tied = owner("toolu_a1");
    expect(read(tied, log(["toolu_a1", "toolu_a2"]), 200).clear).toBe(false);
    expect(read(tied, log(["toolu_a2"]), 200)).toEqual({ owner: owner("toolu_a2"), clear: false });
  });

  it("its call leaving after the user typed hides it", () => {
    expect(read(owner("toolu_b"), log([]), 200, true)).toEqual({ owner: undefined, clear: true });
    expect(read(owner("toolu_b"), log(["toolu_c"]), 200, true).clear).toBe(true);
  });

  it("its call leaving with nothing else open hides it (answered elsewhere)", () => {
    expect(read(owner("toolu_b"), log([]), 200)).toEqual({ owner: undefined, clear: true });
  });

  it("after an answer, a redrawn dialog keeps what it showed until the next read", () => {
    const redrawn = drawn("Do you want to make this edit to b.ts?", owner("toolu_a"), 200);
    expect(dialogToolFor(redrawn, log(["toolu_a"]))).toMatchObject({
      id: "toolu_a",
      prompt: "Do you want to proceed?",
    });
    expect(read(redrawn, log(["toolu_b"]), 250).owner).toEqual(
      owner("toolu_b", { since: 200, prompt: "Do you want to make this edit to b.ts?" }),
    );
  });

  it("a subagent's next prompt under the same call shows the new text", () => {
    const first = owner("toolu_agent", { prompt: "rm a" });
    const redrawn = drawn("rm b", first, 300);
    const next = read(redrawn, log(["toolu_agent"]), 350).owner;
    expect(next).toMatchObject({ toolId: "toolu_agent", shownPrompt: "rm b" });
    expect(dialogToolFor(next, log(["toolu_agent"]))?.prompt).toBe("rm b");
  });

  it("waits while the dialog's call is not in the log yet", () => {
    expect(read(drawn(), log([]))).toEqual({ owner: owner(null, { fresh: true }), clear: false });
  });

  it("ignores reads that started before the dialog was drawn, and failed reads", () => {
    expect(read(drawn(), log(["toolu_a"]), 90)).toEqual({ owner: drawn(), clear: false });
    expect(read(owner("toolu_b"), null, 200)).toEqual({ owner: owner("toolu_b"), clear: false });
  });

  it("the turn ending hides it", () => {
    expect(read(drawn(), log([], true), 200).clear).toBe(true);
  });

  it("falls back to the open tool on older backends", () => {
    const old = { turnDone: false, openTool: open("Bash", "toolu_x") };
    expect(dialogAfterRead(drawn(), old, 150, false).owner?.toolId).toBe("toolu_x");
  });

  it("does nothing while no dialog is shown", () => {
    expect(read(undefined, log([]), 200)).toEqual({ owner: undefined, clear: false });
    expect(shown(undefined, log(["toolu_a"]))).toBe(null);
  });
});
