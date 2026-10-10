import { describe, expect, it } from "vitest";
import {
  padAfterSend,
  chainMarkBlocked,
  chainMarkSent,
  chainMarkSettled,
  chainStart,
  chainStepToSend,
  chainStop,
  clampPad,
  dropUnknownLocalPads,
  firstChainStep,
  classifyTurn,
  HISTORY_LIMIT,
  historyNavigate,
  loadLocalDrafts,
  MAX_PAD_CHARS,
  mergeDraftFiles,
  mergePads,
  pushHistory,
  readDraftBlob,
  rememberPrompt,
  saveLocalDrafts,
  SCRATCH_DEBOUNCE_MS,
  splitChainSteps,
  transferToInput,
  upsertPad,
  type DraftStorage,
} from "./pad";

describe("scratch pad transfer", () => {
  it("replaces an empty input with the whole pad", () => {
    expect(transferToInput("", "draft line", null)).toBe("draft line");
  });

  it("appends the pad after a blank line when the input already has text", () => {
    expect(transferToInput("hello", "more", null)).toBe("hello\n\nmore");
  });

  it("transfers only the selection when one is present", () => {
    expect(transferToInput("hello", "keep the pad", "just this")).toBe(
      "hello\n\njust this",
    );
  });

  it("keeps the pad text available after transfer", () => {
    const pad = "still here";
    transferToInput("", pad, null);
    expect(pad).toBe("still here");
  });
});

describe("scratch pad chaining", () => {
  it("splits steps on a --- line", () => {
    expect(splitChainSteps("first\n---\nsecond\n\n---\nthird")).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("gives a terminal one --- step per send", () => {
    const pad = "---\none\n  ---  \r\ntwo\n---\nthree";
    const first = firstChainStep(pad)!;
    expect(first.text).toBe("one");
    const rest = padAfterSend(pad, first.range);
    expect(rest).toBe("two\n---\nthree");
    expect(firstChainStep(rest)!.text).toBe("two");
    expect(firstChainStep("only\n---\n")).toBeNull();
    expect(firstChainStep("no steps")).toBeNull();
  });

  it("sends the next step only after the previous turn completes", () => {
    const started = chainStart("one\n---\ntwo");
    expect(started).not.toBeNull();
    expect(chainStepToSend(started!)).toBe("one");
    const sent = chainMarkSent(started!);
    expect(chainStepToSend(sent)).toBeNull();
    const ready = chainMarkSettled(sent, "completed");
    expect(chainStepToSend(ready)).toBe("two");
  });

  it("does not send the next step while a permission is pending", () => {
    const sent = chainMarkSent(chainStart("one\n---\ntwo")!);
    const paused = chainMarkBlocked(sent);
    expect(paused.phase).toBe("paused");
    expect(chainStepToSend(paused)).toBeNull();
    const resumed = chainMarkSettled(paused, "completed");
    expect(chainStepToSend(resumed)).toBe("two");
  });

  it("stops the chain when the turn is cancelled or errors", () => {
    const sent = chainMarkBlocked(chainMarkSent(chainStart("one\n---\ntwo")!));
    expect(chainMarkSettled(sent, "cancelled").phase).toBe("stopped");
    expect(chainMarkSettled(sent, "error").reason).toBe("error");
    expect(chainStop(sent).phase).toBe("stopped");
  });

  it("classifies ACP turn endings from the real stop reason", () => {
    expect(classifyTurn({ success: true, stopReason: "end_turn" })).toBe("completed");
    expect(classifyTurn({ success: true, stopReason: "cancelled" })).toBe("cancelled");
    expect(classifyTurn({ success: false, error: "stdout closed" })).toBe("error");
  });
});

describe("scratch pad history and size", () => {
  it("keeps the newest prompts and drops duplicates", () => {
    let history: string[] = [];
    history = pushHistory(history, "first");
    history = pushHistory(history, "second");
    history = pushHistory(history, "first");
    expect(history).toEqual(["first", "second"]);
  });

  it("caps history", () => {
    let history: string[] = [];
    for (let i = 0; i < HISTORY_LIMIT + 5; i += 1) {
      history = pushHistory(history, `p${i}`);
    }
    expect(history).toHaveLength(HISTORY_LIMIT);
    expect(history[0]).toBe(`p${HISTORY_LIMIT + 4}`);
  });

  it("walks history with the caret at the start of the input", () => {
    const history = ["newer", "older"];
    const first = historyNavigate({
      history,
      cursor: -1,
      direction: "older",
      draft: "",
      caretAtStart: true,
    });
    expect(first).toMatchObject({ handled: true, text: "newer", cursor: 0 });
    const second = historyNavigate({
      history,
      cursor: first.cursor,
      direction: "older",
      draft: first.text,
      caretAtStart: true,
    });
    expect(second.text).toBe("older");
  });

  it("leaves ArrowUp alone when the caret is not at the start", () => {
    const result = historyNavigate({
      history: ["older"],
      cursor: -1,
      direction: "older",
      draft: "line",
      caretAtStart: false,
    });
    expect(result.handled).toBe(false);
  });

  it("accepts a very large pad up to the limit and truncates past it", () => {
    const big = "a".repeat(MAX_PAD_CHARS);
    expect(clampPad(big).truncated).toBe(false);
    const over = clampPad(`${big}b`);
    expect(over.truncated).toBe(true);
    expect(over.text).toHaveLength(MAX_PAD_CHARS);
  });
});

describe("scratch pad persistence", () => {
  it("debounces drafts and keeps the newer copy after a crash", () => {
    expect(SCRATCH_DEBOUNCE_MS).toBe(500);
    const disk = { content: "saved", updatedAt: 1_000, history: ["a"] };
    const crashed = { content: "typed after last flush", updatedAt: 1_500, history: ["a"] };
    expect(mergePads(crashed, disk)?.content).toBe("typed after last flush");
    expect(mergePads(disk, crashed)?.content).toBe("typed after last flush");
  });

  it("merges per-tab drafts from local and disk copies", () => {
    const merged = mergeDraftFiles(
      { pads: { tab_a: { content: "local", updatedAt: 5, history: [] } } },
      { pads: { tab_a: { content: "disk", updatedAt: 2, history: ["old"] }, tab_b: { content: "b", updatedAt: 3, history: [] } } },
    );
    expect(merged.pads.tab_a.content).toBe("local");
    expect(merged.pads.tab_b.content).toBe("b");
  });

  it("drops mirrored pads of deleted tabs before merging with disk", () => {
    const local = {
      pads: {
        open: { content: "o", updatedAt: 1, history: [] },
        closed: { content: "c", updatedAt: 1, history: [] },
        deleted: { content: "d", updatedAt: 9, history: [] },
      },
    };
    const kept = dropUnknownLocalPads(local, ["open", "closed"]);
    expect(Object.keys(kept?.pads ?? {}).sort()).toEqual(["closed", "open"]);
    expect(mergeDraftFiles(kept, { pads: {} }).pads.deleted).toBeUndefined();
    expect(dropUnknownLocalPads(local, undefined)).toBe(local);
    expect(dropUnknownLocalPads(null, ["open"])).toBeNull();
    expect(dropUnknownLocalPads(local, [])?.pads).toEqual({});
  });

  it("ignores a corrupted local draft instead of throwing", () => {
    expect(readDraftBlob("{not json")).toBeNull();
    expect(readDraftBlob(null)).toBeNull();
  });

  it("reports a storage write failure", () => {
    const storage: DraftStorage = {
      read: () => null,
      write: () => {
        throw new Error("disk full");
      },
    };
    const result = saveLocalDrafts(storage, { pads: {} });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("disk full");
    expect(loadLocalDrafts({ read: () => "{", write: () => {} })).toBeNull();
  });

  it("stores a prompt on the tab that sent it", () => {
    const next = rememberPrompt(
      upsertPad({ pads: {} }, "tab_1", "draft", 10).file,
      "tab_1",
      "hello",
      11,
    );
    expect(next.pads.tab_1.history).toEqual(["hello"]);
    expect(next.pads.tab_1.content).toBe("draft");
  });
});

describe("pad after a send", () => {
  const range = (pad: string, part: string) => {
    const start = pad.indexOf(part);
    return { start, end: start + part.length };
  };

  it("empties the pad when the whole pad was sent", () => {
    expect(padAfterSend("Fix the login bug\nthen add tests", null)).toBe("");
  });

  it("cuts out only the sent selection", () => {
    const pad = "first\nsecond\nthird";
    expect(padAfterSend(pad, range(pad, "second"))).toBe("first\nthird");
    const spaced = "first\n\nsecond\n\nthird";
    expect(padAfterSend(spaced, range(spaced, "second"))).toBe("first\n\nthird");
    expect(padAfterSend(spaced, range(spaced, "first"))).toBe("second\n\nthird");
    expect(padAfterSend(spaced, range(spaced, "third"))).toBe("first\n\nsecond");
  });

  it("keeps the rest of a line when part of it was sent", () => {
    const pad = "run the tests now";
    expect(padAfterSend(pad, range(pad, "the tests "))).toBe("run now");
  });
});
