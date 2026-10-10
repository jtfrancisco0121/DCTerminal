import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../bridge", () => ({ changesSnapshot: vi.fn(async () => ({})) }));

import { createTurnSnapshotter } from "./turnSnapshot";

afterEach(() => {
  vi.useRealTimers();
});

describe("terminal turn snapshots", () => {
  it("snapshots once per tab per 2 seconds", async () => {
    let clock = 10_000;
    const snapshot = vi.fn(async () => {});
    const before = createTurnSnapshotter({ snapshot, now: () => clock });
    await before("tab_a");
    await before("tab_a");
    await before("tab_b");
    expect(snapshot.mock.calls.map((call) => call[0])).toEqual(["tab_a", "tab_b"]);
    clock += 2_000;
    await before("tab_a");
    expect(snapshot).toHaveBeenCalledTimes(3);
  });

  it("swallows failures such as a folder outside git", async () => {
    const before = createTurnSnapshotter({
      snapshot: async () => {
        throw new Error("not a git repository");
      },
    });
    await expect(before("tab_a")).resolves.toBeUndefined();
    const throwsSync = createTurnSnapshotter({
      snapshot: () => {
        throw new Error("bridge missing");
      },
    });
    await expect(throwsSync("tab_a")).resolves.toBeUndefined();
  });

  it("stops waiting for a slow snapshot so the send is never blocked", async () => {
    vi.useFakeTimers();
    const snapshot = vi.fn(() => new Promise<void>(() => {}));
    const before = createTurnSnapshotter({ snapshot, waitMs: 400 });
    let released = false;
    void before("tab_a").then(() => {
      released = true;
    });
    await vi.advanceTimersByTimeAsync(399);
    expect(released).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(released).toBe(true);
  });
});
