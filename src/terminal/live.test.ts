import { afterEach, describe, expect, it, vi } from "vitest";
import type { PtyPacket } from "../bridge";

const handlers: ((packet: PtyPacket) => void)[] = [];
vi.mock("../bridge", () => ({
  createPtyChannel: (onPacket: (packet: PtyPacket) => void) => {
    handlers.push(onPacket);
    return { onmessage: onPacket };
  },
}));

const {
  beginLivePty,
  dropLivePty,
  livePty,
  notePtyInput,
  ptyExitCode,
  restartLivePty,
  subscribePtyAnswer,
  subscribePtyExit,
} = await import("./live");
const { dialogDetector } = await import("./permissionDialog");

const last = () => handlers[handlers.length - 1];
const exit = (code: number | null) => last()({ kind: "exit", data: "", code });

afterEach(() => {
  dropLivePty("t1");
  handlers.length = 0;
  vi.restoreAllMocks();
});

describe("live PTY exit", () => {
  it("tells exit listeners once, with -1 for a signal", () => {
    const seen: [string, number][] = [];
    const off = subscribePtyExit((id, code) => seen.push([id, code]));
    beginLivePty("t1");
    expect(ptyExitCode("t1")).toBeNull();
    exit(3);
    expect(seen).toEqual([["t1", 3]]);
    expect(ptyExitCode("t1")).toBe(3);
    beginLivePty("t1");
    exit(null);
    expect(seen).toEqual([["t1", 3], ["t1", -1]]);
    expect(ptyExitCode("t1")).toBe(-1);
    off();
  });

  it("is silent for a closed tab or a replaced process", () => {
    const seen: string[] = [];
    const off = subscribePtyExit((id) => seen.push(id));
    beginLivePty("t1");
    const first = last();
    beginLivePty("t1");
    first({ kind: "exit", data: "", code: 1 });
    dropLivePty("t1");
    exit(1);
    expect(seen).toEqual([]);
    off();
  });

  it("forgets the dialog on exit and on restart", () => {
    beginLivePty("t1");
    const dialog = "Do you want to proceed?\r\n❯ 1. Yes\r\n  2. No\r\n";
    last()({ kind: "data", data: btoa(unescape(encodeURIComponent(dialog))), code: null });
    expect(dialogDetector.isVisible("t1")).toBe(true);
    exit(0);
    expect(dialogDetector.isVisible("t1")).toBe(false);
  });
});

describe("restart", () => {
  it("replaces startedAt with the new process's start but keeps planSince", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const first = beginLivePty("t1");
    exit(1);
    now.mockReturnValue(5_000);
    const live = restartLivePty("t1");
    expect(livePty("t1")).toBe(live);
    // The dead process's start is not the new one's.
    expect(live.startedAt).toBe(5_000);
    expect(live.exited).toBe(false);
    // Plan files written since the tab's first start still count.
    expect(first.planSince).toBe(1_000);
    expect(live.planSince).toBe(1_000);
    // A second restart still keeps the tab's first start.
    now.mockReturnValue(9_000);
    expect(restartLivePty("t1")).toMatchObject({ startedAt: 9_000, planSince: 1_000 });
  });

  it("starts both at now when nothing ran before", () => {
    vi.spyOn(Date, "now").mockReturnValue(2_000);
    const live = restartLivePty("t1");
    expect(live.startedAt).toBe(2_000);
    expect(live.planSince).toBe(2_000);
  });
});

describe("notePtyInput and the permission dialog", () => {
  it("mouse moves over a dialog never answer it; Enter may", async () => {
    // @ts-expect-error type error without @types/node package
    const { readFileSync } = await import("node:fs");
    const capture = new Uint8Array(readFileSync(new URL("./fixtures/claude-2.1.287-proceed.bin", import.meta.url)));
    dialogDetector.feed("mouse", capture);
    expect(dialogDetector.isVisible("mouse")).toBe(true);
    notePtyInput("mouse", "\x1b[<35;40;12M");
    notePtyInput("mouse", "\x1b[<64;40;12M");
    expect(dialogDetector.answering("mouse")).toBe(false);
    expect(dialogDetector.isVisible("mouse", Date.now() + 60_000)).toBe(true);
    notePtyInput("mouse", "\r");
    expect(dialogDetector.answering("mouse")).toBe(true);
    dialogDetector.forget("mouse");
  });

  it("tells answer listeners about keys that may answer a dialog, not typing or mouse moves", () => {
    const seen: string[] = [];
    const off = subscribePtyAnswer((id) => seen.push(id));
    notePtyInput("t1", "a");
    notePtyInput("t1", "\x1b[<35;40;12M");
    expect(seen).toEqual([]);
    notePtyInput("t1", "\r");
    notePtyInput("t2", "2");
    notePtyInput("t3");
    expect(seen).toEqual(["t1", "t2", "t3"]);
    off();
    notePtyInput("t1", "\r");
    expect(seen).toHaveLength(3);
  });
});
