import { describe, expect, it, vi } from "vitest";
import { createDialogDetector } from "./permissionDialog";
import {
  answerPermission,
  composerPayload,
  permissionKey,
  sendComposerText,
  stopTurn,
  STOP_KEY,
  type PtyAnswerDeps,
} from "./ptyAnswers";

const PROCEED =
  "Bash command\r\n  touch x\r\nDo you want to proceed?\r\n❯ 1. Yes\r\n  2. Yes, and don't ask again\r\n  3. No\r\n";
const enc = new TextEncoder();

function harness() {
  let next = 1;
  const timers = new Map<number, () => void>();
  const setTimer = (fn: () => void) => {
    const handle = next++;
    timers.set(handle, fn);
    return handle;
  };
  const clearTimer = (handle: unknown) => timers.delete(handle as number);
  const detector = createDialogDetector({ setTimer, clearTimer });
  const writes: [string, string][] = [];
  const notes: [string, string | undefined][] = [];
  const deps: PtyAnswerDeps = {
    write: async (tabId, data) => {
      writes.push([tabId, data]);
    },
    note: (tabId, data) => {
      notes.push([tabId, data]);
      // The real note feeds the detector; an answer key starts its hide timer.
      detector.input(tabId, undefined, "answer");
    },
    detector,
    setTimer,
    clearTimer,
  };
  const runTimers = () => {
    const fns = [...timers.values()];
    timers.clear();
    fns.forEach((fn) => fn());
  };
  return { detector, deps, writes, notes, runTimers, timers };
}

describe("composer", () => {
  it("pastes the text bracketed, keeps its newlines, and presses Enter once", () => {
    expect(composerPayload("one\r\ntwo")).toBe("\x1b[200~one\ntwo\x1b[201~\r");
    expect(composerPayload("  \n ")).toBeNull();
  });

  it("notes the send as input before writing it", async () => {
    const write = vi.fn(async () => {});
    const note = vi.fn();
    expect(await sendComposerText("t1", "fix it", { write, note })).toBe(true);
    expect(note).toHaveBeenCalledWith("t1");
    expect(write).toHaveBeenCalledWith("t1", "\x1b[200~fix it\x1b[201~\r");
    expect(await sendComposerText("t1", " ", { write, note })).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("stops the turn with Esc", async () => {
    const write = vi.fn(async () => {});
    const note = vi.fn();
    await stopTurn("t1", { write, note });
    expect(note).toHaveBeenCalledWith("t1", STOP_KEY);
    expect(write).toHaveBeenCalledWith("t1", "\x1b");
  });
});

describe("permission answers", () => {
  it("only single digits are keys", () => {
    expect(permissionKey({ key: "2", label: "Yes" })).toBe("2");
    expect(permissionKey({ key: "0", label: "x" })).toBeNull();
    expect(permissionKey({ key: "12", label: "x" })).toBeNull();
  });

  it("writes the option's digit and reports closed when the dialog goes", async () => {
    const h = harness();
    h.detector.feed("t1", enc.encode(PROCEED));
    const result = answerPermission("t1", { key: "2", label: "Yes, and don't ask again" }, h.deps);
    await Promise.resolve();
    expect(h.writes).toEqual([["t1", "2"]]);
    expect(h.notes).toEqual([["t1", "2"]]);
    // The detector's hide timer fires: no redraw came after the answer.
    h.runTimers();
    await expect(result).resolves.toBe("closed");
  });

  it("reports closed at once when another dialog replaced it", async () => {
    const h = harness();
    h.detector.feed("t1", enc.encode(PROCEED));
    const result = answerPermission("t1", { key: "1", label: "Yes" }, h.deps);
    await Promise.resolve();
    h.detector.feed("t1", enc.encode(PROCEED.replace("touch x", "rm y")));
    await expect(result).resolves.toBe("closed");
  });

  it("reports stuck when the same dialog is drawn again and stays", async () => {
    const h = harness();
    h.detector.feed("t1", enc.encode(PROCEED));
    const result = answerPermission("t1", { key: "1", label: "Yes" }, h.deps, 3500);
    await Promise.resolve();
    // The same dialog drawn again cancels the detector's hide.
    h.detector.feed("t1", enc.encode(PROCEED));
    expect(h.detector.isVisible("t1")).toBe(true);
    h.runTimers();
    await expect(result).resolves.toBe("stuck");
  });

  it("rejects an option without a number key and a failed write", async () => {
    const h = harness();
    await expect(answerPermission("t1", { key: "x", label: "?" }, h.deps)).rejects.toThrow(/no number key/);
    const failing = { ...h.deps, write: async () => Promise.reject(new Error("no pty t1")) };
    await expect(answerPermission("t1", { key: "1", label: "Yes" }, failing)).rejects.toThrow("no pty t1");
  });
});
