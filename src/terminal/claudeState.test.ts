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
const onScreen = (tool: ReturnType<typeof open>, promptKey = "1") => ({ ...tool, promptKey });
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
      promptKey: "1",
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
    expect(sameTerminalState({ ...a, promptKey: "1" }, { ...a, promptKey: "2" })).toBe(false);
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
  type Owner = Parameters<typeof dialogAfterRead>[0];
  const ASK = "Do you want to proceed?";
  const log = (pending: (string | Tool)[], turnDone = false) => {
    const tools = pending.map((item) => (typeof item === "string" ? open("Bash", item) : item));
    return { turnDone, openTool: tools[tools.length - 1] ?? null, pendingTools: tools };
  };
  const read = (o: Owner, l: ReturnType<typeof log> | null, at = 150, answering = false) =>
    dialogAfterRead(o, l, at, answering);
  const drawn = (context = ASK, prev?: Owner, at = 100) => dialogDrawn(prev, at, context);
  /** Drawn at `at`, then tied by a read to `toolId`. */
  const tied = (toolId: string, context = ASK, at = 100) =>
    read(drawn(context, undefined, at), log([toolId]), at + 50).owner;
  const shown = (o: Owner, l: ReturnType<typeof log>) => dialogToolFor(o, l);

  it("adopts the oldest unanswered call from the first read after the draw", () => {
    const next = read(drawn(), log(["toolu_b"]));
    expect(next.clear).toBe(false);
    expect(shown(next.owner, log(["toolu_b"]))).toMatchObject({ id: "toolu_b", promptKey: "100" });
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
    expect(shown(next.owner, log(["toolu_b"]))?.id).toBe("toolu_b");
  });

  it("parallel calls: the call named closest to the question, past transcript lines", () => {
    const w1 = open("WebFetch", "toolu_w1", "allowed.com");
    const w2 = open("WebFetch", "toolu_w2", "other.org");
    const context = [
      "⏺ Fetch(https://allowed.com/a)",
      "⎿ Fetching…",
      "⏺ Fetch(https://other.org/b)",
      "Fetch",
      "https://other.org/b",
      "Do you want to allow Claude to fetch this content?",
    ].join("\n");
    expect(read(drawn(context), log([w1, w2])).owner?.toolId).toBe("toolu_w2");
    // Nothing named: the oldest, as Claude Code asks oldest first.
    expect(read(drawn(), log(["toolu_e1", "toolu_e2"])).owner?.toolId).toBe("toolu_e1");
  });

  it("an earlier parallel call finishing without input moves the dialog as the same prompt", () => {
    const owner = tied("toolu_a1");
    const both = log(["toolu_a1", "toolu_a2"]);
    expect(read(owner, both, 200).clear).toBe(false);
    const moved = read(owner, log(["toolu_a2"]), 200);
    expect(moved.clear).toBe(false);
    expect(shown(moved.owner, log(["toolu_a2"]))).toMatchObject({ id: "toolu_a2", promptKey: "100" });
  });

  it("its call leaving after the user typed hides it", () => {
    expect(read(tied("toolu_b"), log([]), 200, true)).toEqual({ owner: undefined, clear: true });
    expect(read(tied("toolu_b"), log(["toolu_c"]), 200, true).clear).toBe(true);
  });

  it("its call leaving with nothing else open hides it (answered elsewhere)", () => {
    expect(read(tied("toolu_b"), log([]), 200)).toEqual({ owner: undefined, clear: true });
  });

  it("the same dialog redrawn after a key press stays the same prompt", () => {
    const owner = tied("toolu_a", "⏺ Bash(ls)\nBash command\nnpm test\nRun tests\n" + ASK);
    // The redraw-only window has no transcript above the box.
    const redrawn = drawn("Bash command\nnpm test\nRun tests\n" + ASK, owner, 200);
    expect(shown(redrawn, log(["toolu_a"]))?.promptKey).toBe("100");
    expect(shown(read(redrawn, log(["toolu_a"]), 250).owner, log(["toolu_a"]))?.promptKey).toBe("100");
  });

  it("after an answer, the next call's dialog is a new prompt, shown after the next read", () => {
    const owner = tied("toolu_a", "Bash command\nnpm test\n" + ASK);
    const redrawn = drawn("Edit file\n+ x\nDo you want to make this edit to b.ts?", owner, 200);
    expect(shown(redrawn, log(["toolu_a"]))).toMatchObject({ id: "toolu_a", promptKey: "100" });
    expect(shown(read(redrawn, log(["toolu_b"]), 250).owner, log(["toolu_b"]))).toMatchObject({
      id: "toolu_b",
      promptKey: "200",
    });
  });

  it("the same command asked again for a new call is a new prompt", () => {
    const owner = tied("toolu_a", "Bash command\nnpm test\n" + ASK);
    const again = drawn("Bash command\nnpm test\n" + ASK, owner, 200);
    expect(shown(read(again, log(["toolu_b"]), 250).owner, log(["toolu_b"]))?.promptKey).toBe("200");
  });

  it("parallel calls with the same dialog: the redraw after an answer is the next call's prompt", () => {
    const b = open("Bash", "toolu_b", "npm test");
    const b2 = open("Bash", "toolu_b2", "npm test");
    const body = "Bash command\nnpm test\n" + ASK;
    const first = read(drawn(body), log([b, b2])).owner;
    expect(first?.toolId).toBe("toolu_b");
    const again = read(drawn(body, first, 200), log([b, b2]), 250).owner;
    expect(shown(again, log([b, b2]))).toMatchObject({ id: "toolu_b2", promptKey: "200" });
  });

  it("a hint inside another call's hint does not win", () => {
    const readTool = open("Read", "toolu_r", "auth.ts");
    const wc = open("Bash", "toolu_wc", "wc -l auth.ts");
    const context = "Bash command\nwc -l auth.ts\n" + ASK;
    expect(read(drawn(context), log([readTool, wc])).owner?.toolId).toBe("toolu_wc");
  });

  it("a subagent's next prompt under the same call is a new prompt", () => {
    const owner = tied("toolu_agent", "Bash command\nrm a\n" + ASK);
    const next = drawn("Bash command\nrm b\n" + ASK, owner, 300);
    expect(shown(read(next, log(["toolu_agent"]), 350).owner, log(["toolu_agent"]))?.promptKey).toBe("300");
  });

  it("waits while the dialog's call is not in the log yet", () => {
    const next = read(drawn(), log([]));
    expect(next.clear).toBe(false);
    expect(next.owner).toMatchObject({ toolId: null, fresh: true });
  });

  it("ignores reads that started before the dialog was drawn, and failed reads", () => {
    expect(read(drawn(), log(["toolu_a"]), 90)).toEqual({ owner: drawn(), clear: false });
    const owner = tied("toolu_b");
    expect(read(owner, null, 200)).toEqual({ owner, clear: false });
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
