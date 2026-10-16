import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEntriesUpdate } from "../bridge";

const watches: { tabId: string; since: number | null; send: (u: ChatEntriesUpdate) => void }[] = [];
const unwatch = vi.fn(async (_tabId: string) => {});
let liveListener: (() => void) | null = null;
const live = new Map<string, object>();

vi.mock("../bridge", () => ({
  terminalChatWatch: vi.fn(async (tabId: string, since: number | null, send: (u: ChatEntriesUpdate) => void) => {
    watches.push({ tabId, since, send });
  }),
  terminalChatUnwatch: (tabId: string) => unwatch(tabId),
}));

vi.mock("./live", () => ({
  livePty: (id: string) => live.get(id),
  subscribeLivePty: (listener: () => void) => {
    liveListener = listener;
    return () => {
      liveListener = null;
    };
  },
}));

const { chatEntriesSnapshot, subscribeChatEntries } = await import("./chatEntriesStore");

const update = (over: Partial<ChatEntriesUpdate>): ChatEntriesUpdate => ({
  sessionId: "s1",
  revision: 5,
  reset: true,
  firstSeq: 0,
  entries: [{ seq: 0, rev: 5, at: null, kind: "user", text: "hi" }],
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers();
  watches.length = 0;
  unwatch.mockClear();
  live.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("chatEntriesStore", () => {
  it("shares one watch per tab and stops it after the last subscriber leaves", () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = subscribeChatEntries("t1", a);
    const offB = subscribeChatEntries("t1", b);
    expect(watches).toHaveLength(1);
    expect(watches[0]).toMatchObject({ tabId: "t1", since: null });
    watches[0].send(update({}));
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(chatEntriesSnapshot("t1").entries).toHaveLength(1);
    offA();
    offB();
    expect(unwatch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000);
    expect(unwatch).toHaveBeenCalledWith("t1");
    expect(chatEntriesSnapshot("t1").entries).toHaveLength(0);
  });

  it("keeps the watch across a quick remount", () => {
    const off = subscribeChatEntries("t2", vi.fn());
    off();
    const offAgain = subscribeChatEntries("t2", vi.fn());
    vi.advanceTimersByTime(2000);
    expect(unwatch).not.toHaveBeenCalled();
    expect(watches).toHaveLength(1);
    offAgain();
    vi.advanceTimersByTime(2000);
    expect(unwatch).toHaveBeenCalledWith("t2");
  });

  it("watches again from the last revision when the tab's PTY is replaced", () => {
    live.set("t3", {});
    const listener = vi.fn();
    const off = subscribeChatEntries("t3", listener);
    watches[0].send(update({ revision: 7 }));
    live.set("t3", {});
    liveListener?.();
    expect(watches).toHaveLength(2);
    expect(watches[1]).toMatchObject({ tabId: "t3", since: 7 });
    // The old watch's late updates are ignored.
    watches[0].send(update({ revision: 9, entries: [] }));
    expect(chatEntriesSnapshot("t3").revision).toBe(7);
    off();
    vi.advanceTimersByTime(2000);
  });
});
