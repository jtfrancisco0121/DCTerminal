import { describe, expect, it, vi } from "vitest";
// @ts-expect-error type error without @types/node package
import { readdirSync, readFileSync } from "node:fs";
import { TESTED_CLAUDE_VERSION } from "./claudeVersion";
import {
  createDialogDetector,
  findPermissionOptions,
  matchPermissionDialog,
  normalizeTerminalText,
} from "./permissionDialog";

const enc = new TextEncoder();
const bytes = (s: string) => enc.encode(s);

/** Manually driven timers. */
function manualTimers() {
  let next = 1;
  const pending = new Map<number, () => void>();
  return {
    setTimer: (fn: () => void, _ms: number) => {
      const h = next++;
      pending.set(h, fn);
      return h;
    },
    clearTimer: (h: unknown) => {
      pending.delete(h as number);
    },
    runAll() {
      const fns = [...pending.values()];
      pending.clear();
      fns.forEach((f) => f());
    },
    get count() {
      return pending.size;
    },
  };
}

function setup() {
  const timers = manualTimers();
  const d = createDialogDetector({ setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  const calls: string[] = [];
  d.subscribe((id) => calls.push(id));
  return { d, timers, calls };
}

const options = (second: string, last = "3. No") =>
  `❯ 1. Yes\r\n  2. ${second}\r\n  ${last}\r\n`;

const PROCEED = `\x1b[1mBash command\x1b[22m\r\n  touch x\r\nDo you want to proceed?\r\n${options(
  "Yes, and don't ask again for touch commands in /tmp/x",
  "3. No, and tell Claude what to do differently (esc)",
)}`;

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
}

function feedInRandomChunks(d: ReturnType<typeof createDialogDetector>, id: string, b: Uint8Array, seed: number) {
  let x = seed;
  const rand = () => {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    return x / 0x7fffffff;
  };
  for (let i = 0; i < b.length; ) {
    const n = 1 + Math.floor(rand() * 64);
    d.feed(id, b.subarray(i, i + n));
    i += n;
  }
}

describe("normalizeTerminalText", () => {
  it("strips SGR/OSC/erase and turns cursor moves into spaces and newlines", () => {
    const raw =
      "\x1b]0;✳ Claude Code\x07\x1b[38;5;153mDo\x1b[5Gyou\x1b[2Cwant\x1b[K to\x1b[1B\r\x1b[3C1.\x1b[7GYes\x1b[10;1H│ 3. No ─╮";
    const out = normalizeTerminalText(raw);
    expect(out.replace(/ +/g, " ")).toBe("Do you want to\n\n 1. Yes\n 3. No ");
  });
});

describe("matchPermissionDialog", () => {
  it.each([
    ["Do you want to proceed?", "Yes, and don't ask again for npm commands in /p"],
    ["Do you want to make this edit to main.ts?", "Yes, allow all edits during this session"],
    ["Do you want to allow Claude to fetch this content?", "Yes, and don't ask again for example.com"],
    ["Do you want to allow this connection?", "Yes, and always allow access to /p from this project"],
  ])("matches %s with its options", (q, second) => {
    expect(matchPermissionDialog(normalizeTerminalText(`${q}\r\n${options(second)}`))).toBe(true);
  });

  it("does not match the question without numbered options", () => {
    expect(matchPermissionDialog("Do you want to proceed?\nSure, go ahead.\n")).toBe(false);
    expect(matchPermissionDialog("Do you want to proceed?\n1. Yes\n")).toBe(false);
    expect(matchPermissionDialog("1. Yes\n2. No\n")).toBe(false);
  });

  it("requires the options near the question", () => {
    const filler = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    expect(matchPermissionDialog(`Do you want to proceed?\n${filler}\n1. Yes\n2. No`)).toBe(false);
  });
});

describe("dialog detector", () => {
  it("sees each question with options", () => {
    const { d } = setup();
    d.feed("a", bytes(PROCEED));
    expect(d.isVisible("a")).toBe(true);
    d.feed("b", bytes(`Do you want to allow this connection?\r\n${options("Yes, and always allow access to /x from this project")}`));
    expect(d.isVisible("b")).toBe(true);
    d.feed("c", bytes(`Do you want to allow Claude to fetch this content?\r\n${options("Yes, and don't ask again")}`));
    expect(d.isVisible("c")).toBe(true);
  });

  it("matches an edit question with a bold file name inside the line", () => {
    const { d } = setup();
    d.feed(
      "a",
      bytes(
        "\x1b[1C\x1b[1B\x1b[39mDo you want to make this edit to \x1b[1mnote.txt\x1b[22m?\x1b[K\r\r\n" +
          "\x1b[2G\x1b[38;5;153m❯\x1b[4G\x1b[38;5;246m1.\x1b[7G\x1b[38;5;153mYes\x1b[39m\r\r\n" +
          "\x1b[4G\x1b[38;5;246m2.\x1b[7G\x1b[39mYes, allow all edits during this session\r\r\n" +
          "\x1b[4G\x1b[38;5;246m3.\x1b[7G\x1b[39mNo\r\r\n",
      ),
    );
    expect(d.isVisible("a")).toBe(true);
  });

  it("handles cursor-forward instead of spaces", () => {
    const { d } = setup();
    d.feed("a", bytes("Do\x1b[1Cyou\x1b[1Cwant\x1b[1Cto\x1b[1Cproceed?\r\x1b[1B\x1b[1C❯\x1b[1C1.\x1b[1CYes\r\x1b[1B\x1b[3C2.\x1b[1CNo"));
    expect(d.isVisible("a")).toBe(true);
  });

  it("survives chunk splits mid-escape and mid-UTF-8", () => {
    const { d } = setup();
    const b = bytes(`\x1b]0;✳ Claude Code\x07\x1b[38;5;153m${PROCEED}`);
    // Split inside "❯" (3 bytes) and inside an SGR sequence.
    const arrow = b.indexOf(0xe2, 30);
    const cuts = [3, 10, 25, arrow + 1, arrow + 2];
    let prev = 0;
    for (const c of [...cuts, b.length]) {
      d.feed("a", b.subarray(prev, c));
      prev = c;
    }
    expect(d.isVisible("a")).toBe(true);
    // Byte-at-a-time too.
    const { d: d2 } = setup();
    for (let i = 0; i < b.length; i++) d2.feed("a", b.subarray(i, i + 1));
    expect(d2.isVisible("a")).toBe(true);
  });

  it("stays visible across redraws and notifies once", () => {
    const { d, calls } = setup();
    for (let i = 0; i < 5; i++) d.feed("a", bytes(`\x1b[H\x1b[2J${PROCEED}\x1b[33B✢ Working…`));
    expect(d.isVisible("a")).toBe(true);
    expect(calls).toEqual(["a"]);
  });

  it("never becomes visible from plain text or quiet time", () => {
    const { d, timers, calls } = setup();
    d.feed("a", bytes("Do you want to proceed? I think we should.\r\n"));
    timers.runAll();
    expect(d.isVisible("a", Date.now() + 60_000)).toBe(false);
    expect(calls).toEqual([]);
  });

  it("hides after input plus the debounce with no re-match", () => {
    const { d, timers, calls } = setup();
    d.feed("a", bytes(PROCEED));
    d.input("a", 1000);
    expect(d.isVisible("a", 2000)).toBe(true);
    expect(d.isVisible("a", 4000)).toBe(false); // deadline passed even before the timer runs
    d.feed("a", bytes("⏺ Bash(touch x)\r\n"));
    timers.runAll();
    expect(d.isVisible("a")).toBe(false);
    expect(calls).toEqual(["a", "a"]);
  });

  it("uses a real timer by default", () => {
    vi.useFakeTimers();
    try {
      const d = createDialogDetector({ debounceMs: 3000 });
      const calls: string[] = [];
      d.subscribe((id) => calls.push(id));
      d.feed("a", bytes(PROCEED));
      d.input("a");
      vi.advanceTimersByTime(2999);
      expect(d.isVisible("a")).toBe(true);
      vi.advanceTimersByTime(1);
      expect(d.isVisible("a")).toBe(false);
      expect(calls).toEqual(["a", "a"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps it visible when the option list redraws after input (arrow keys)", () => {
    const { d, timers, calls } = setup();
    d.feed("a", bytes(PROCEED));
    d.input("a", 1000);
    d.feed("a", bytes("\x1b[5A\r  1. Yes\r\x1b[1B❯ 2. Yes, and don't ask again\r\x1b[1B  3. No\r\n"));
    expect(timers.count).toBe(0);
    timers.runAll();
    expect(d.isVisible("a", 99_999)).toBe(true);
    expect(calls).toEqual(["a"]);
    // Answering now (no redraw) hides it.
    d.input("a", 100_000);
    timers.runAll();
    expect(d.isVisible("a")).toBe(false);
  });

  it("notifies again when a whole dialog is drawn after an answer (the next tool's)", () => {
    const { d, timers, calls } = setup();
    d.feed("a", bytes(PROCEED));
    d.input("a", 1000);
    d.feed("a", bytes(`Do you want to make this edit to auth.ts?\r\n${options("Yes, allow all edits")}`));
    expect(calls).toEqual(["a", "a"]);
    expect(timers.count).toBe(0);
    // Later spinner output with the dialog still in the window is not a new draw.
    d.feed("a", bytes("\r\x1b[2K✻ Thinking…"));
    expect(calls).toEqual(["a", "a"]);
    expect(d.isVisible("a", 99_999)).toBe(true);
  });

  it("exposes the dialog's text and whether the user typed since it was drawn", () => {
    const { d, timers } = setup();
    expect(d.prompt("a")).toBe("");
    d.feed("a", bytes(PROCEED));
    expect(d.prompt("a")).toBe("Bash command\ntouch x\nDo you want to proceed?");
    expect(d.answering("a")).toBe(false);
    d.input("a", 1000);
    expect(d.answering("a")).toBe(true);
    d.feed("a", bytes(`\x1b[1mBash command\x1b[22m\r\n  rm y\r\nDo you want to proceed?\r\n${options("Yes")}`));
    expect(d.answering("a")).toBe(false);
    expect(d.prompt("a")).toBe("Bash command\nrm y\nDo you want to proceed?");
    d.input("a", 2000);
    timers.runAll();
    expect(d.prompt("a")).toBe("");
    expect(d.answering("a")).toBe(false);
  });

  it("clear with keepPartial still sees a next dialog half drawn at that moment", () => {
    const { d, calls } = setup();
    d.feed("a", bytes(PROCEED));
    d.input("a", 1000);
    // B's question has arrived, its options not yet, when A's answer is read.
    d.feed("a", bytes("Bash command\r\n  rm y\r\nDo you want to proceed?\r\n"));
    d.clear("a", { keepPartial: true });
    expect(d.isVisible("a")).toBe(false);
    d.feed("a", bytes(options("Yes")));
    expect(d.isVisible("a")).toBe(true);
    expect(calls).toEqual(["a", "a", "a"]);
  });

  it("clear with keepPartial keeps the lines above the question, for the hint", () => {
    const { d } = setup();
    d.feed("a", bytes(PROCEED));
    d.input("a", 1000, "answer");
    d.feed("a", bytes("⏺ Bash(touch x)\r\n  ⎿ done\r\nBash command\r\n  rm y\r\nDo you want to proceed?\r\n"));
    d.clear("a", { keepPartial: true });
    d.feed("a", bytes(options("Yes")));
    expect(d.prompt("a")).toContain("rm y\nDo you want to proceed?");
  });

  it("mouse clicks may answer without a hide timer; the next full draw follows an answer", () => {
    const { d, timers, calls } = setup();
    d.feed("a", bytes(PROCEED));
    d.input("a", 1000, "press");
    expect(timers.count).toBe(0);
    expect(d.answering("a")).toBe(true);
    expect(d.isVisible("a", 99_999)).toBe(true);
    d.feed("a", bytes(`Bash command\r\n  rm y\r\nDo you want to proceed?\r\n${options("Yes")}`));
    expect(calls).toEqual(["a", "a"]);
    expect(d.drawnAfterAnswer("a")).toBe(true);
    expect(d.answering("a")).toBe(false);
  });

  it("an arrow key then a full redraw is not after an answer", () => {
    const { d } = setup();
    d.feed("a", bytes(PROCEED));
    d.input("a", 1000, "key");
    d.feed("a", bytes(PROCEED));
    expect(d.drawnAfterAnswer("a")).toBe(false);
  });

  it("clear with keepPartial never keeps a whole (answered) dialog", () => {
    const { d } = setup();
    d.feed("a", bytes(PROCEED));
    d.clear("a", { keepPartial: true });
    d.feed("a", bytes("\r\x1b[2K✻ Thinking…"));
    expect(d.isVisible("a")).toBe(false);
  });

  it("input clears stale text so an old dialog cannot re-match", () => {
    const { d, timers } = setup();
    d.feed("a", bytes("Do you want to proceed?\r\n"));
    d.input("a");
    d.feed("a", bytes(options("Yes, and don't ask again")));
    expect(d.isVisible("a")).toBe(false);
    timers.runAll();
  });

  it("clear() hides it and drops the window", () => {
    const { d, calls } = setup();
    d.feed("a", bytes(PROCEED));
    d.clear("a");
    expect(d.isVisible("a")).toBe(false);
    d.feed("a", bytes("more output\r\n"));
    expect(d.isVisible("a")).toBe(false);
    expect(calls).toEqual(["a", "a"]);
    // A fresh dialog shows again.
    d.feed("a", bytes(PROCEED));
    expect(d.isVisible("a")).toBe(true);
  });

  it("forget() drops state and notifies if it was visible", () => {
    const { d, calls } = setup();
    d.feed("a", bytes(PROCEED));
    d.forget("a");
    expect(d.isVisible("a")).toBe(false);
    expect(calls).toEqual(["a", "a"]);
  });

  it("ignores pane mirror ids", () => {
    const { d, calls } = setup();
    d.feed("a::pane", bytes(PROCEED));
    d.input("a::pane");
    expect(d.isVisible("a::pane")).toBe(false);
    expect(calls).toEqual([]);
  });

  it("keeps only the tail of a long stream", () => {
    const timers = manualTimers();
    const d = createDialogDetector({ windowChars: 512, ...timers });
    d.feed("a", bytes(PROCEED));
    d.clear("a");
    d.feed("a", bytes("x".repeat(2000) + "\r\n" + PROCEED));
    expect(d.isVisible("a")).toBe(true);
  });

  it("unsubscribe stops notifications", () => {
    const d = createDialogDetector();
    const calls: string[] = [];
    const off = d.subscribe((id) => calls.push(id));
    off();
    d.feed("a", bytes(PROCEED));
    expect(calls).toEqual([]);
  });
});

describe("real Claude Code 2.1.287 PTY captures", () => {
  it.each(["claude-2.1.287-proceed.bin", "claude-2.1.287-create-file.bin"])(
    "%s shows the dialog when fed in random chunks",
    (name) => {
      const b = fixture(name);
      for (const seed of [1, 7, 42, 1234]) {
        const { d, calls } = setup();
        feedInRandomChunks(d, "t", b, seed);
        expect(d.isVisible("t")).toBe(true);
        expect(calls).toEqual(["t"]);
      }
    },
  );

  it("the proceed capture is not visible before the dialog is drawn", () => {
    const b = fixture("claude-2.1.287-proceed.bin");
    const cut = new TextDecoder().decode(b).indexOf("Do\x1b[5Gyou");
    expect(cut).toBeGreaterThan(0);
    const prefix = enc.encode(new TextDecoder().decode(b).slice(0, cut));
    const { d } = setup();
    d.feed("t", prefix);
    expect(d.isVisible("t")).toBe(false);
  });
});

describe("dialog options", () => {
  it("reads the numbered options of the visible dialog, in order", () => {
    const { d } = setup();
    d.feed("a", bytes(PROCEED));
    expect(d.options("a")).toEqual([
      { key: "1", label: "Yes" },
      { key: "2", label: "Yes, and don't ask again for touch commands in /tmp/x" },
      { key: "3", label: "No, and tell Claude what to do differently (esc)" },
    ]);
    expect(findPermissionOptions(normalizeTerminalText(PROCEED))).toHaveLength(3);
  });

  it("has none once the dialog is hidden, and none for a list that skips a number", () => {
    const { d } = setup();
    d.feed("a", bytes(PROCEED));
    d.clear("a");
    expect(d.options("a")).toEqual([]);
    const skipped = "Do you want to proceed?\r\n❯ 1. Yes\r\n  3. No\r\n";
    expect(findPermissionOptions(normalizeTerminalText(skipped))).toEqual([]);
  });

  it.each(["claude-2.1.287-proceed.bin", "claude-2.1.287-create-file.bin"])(
    "%s yields options from 1. Yes to N. No",
    (name) => {
      const { d } = setup();
      feedInRandomChunks(d, "t", fixture(name), 7);
      const options = d.options("t");
      expect(options.length).toBeGreaterThanOrEqual(2);
      expect(options[0]).toEqual({ key: "1", label: "Yes" });
      expect(options.map((option) => option.key)).toEqual(options.map((_, i) => String(i + 1)));
      expect(options[options.length - 1].label).toMatch(/^No\b/);
    },
  );
});

describe("permission dialog fixtures", () => {
  // The fixtures are named after the version they were captured from. A new
  // capture means a new tested version, and the other way round.
  it("are all captured from the tested Claude Code version", () => {
    const names = readdirSync(new URL("./fixtures/", import.meta.url)).filter((name: string) =>
      name.startsWith("claude-"),
    );
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(name).toMatch(new RegExp(`^claude-${TESTED_CLAUDE_VERSION.replace(/\./g, "\\.")}-`));
  });
});
