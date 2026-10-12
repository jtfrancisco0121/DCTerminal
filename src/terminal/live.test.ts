import { afterEach, describe, expect, it, vi } from "vitest";
import type { PtyPacket } from "../bridge";

const handlers: ((packet: PtyPacket) => void)[] = [];
vi.mock("../bridge", () => ({
  createPtyChannel: (onPacket: (packet: PtyPacket) => void) => {
    handlers.push(onPacket);
    return { onmessage: onPacket };
  },
}));

const { beginLivePty, dropLivePty, notePtyInput, ptyExitCode, subscribePtyExit } = await import("./live");
const { dialogDetector } = await import("./permissionDialog");

const last = () => handlers[handlers.length - 1];
const exit = (code: number | null) => last()({ kind: "exit", data: "", code });

afterEach(() => {
  dropLivePty("t1");
  handlers.length = 0;
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
});
