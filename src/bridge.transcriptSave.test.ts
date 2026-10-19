import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  Channel: class Channel {},
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));

import { devSessionStop, transcriptSave } from "./bridge";

type Held = { resolve: () => void; reject: (err: Error) => void };

/** Each invoke waits until the test settles it. */
function holdInvokes(): Held[] {
  const held: Held[] = [];
  invoke.mockImplementation(
    () =>
      new Promise<void>((resolve, reject) => {
        held.push({ resolve: () => resolve(), reject });
      }),
  );
  return held;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("transcript saves for one tab run in order", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("sends a tab's second save only after its first one finishes", async () => {
    const held = holdInvokes();
    const first = transcriptSave("tab_a", "older", "/w");
    const second = transcriptSave("tab_a", "newer", "/w");
    await flush();
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenLastCalledWith("transcript_save", {
      tabId: "tab_a",
      text: "older",
      cwd: "/w",
    });

    held[0].resolve();
    await first;
    await flush();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenLastCalledWith("transcript_save", {
      tabId: "tab_a",
      text: "newer",
      cwd: "/w",
    });
    held[1].resolve();
    await second;
  });

  it("does not hold another tab's save", async () => {
    const held = holdInvokes();
    const a = transcriptSave("tab_a", "a", "/w");
    const b = transcriptSave("tab_b", "b", "/w");
    await flush();
    expect(invoke).toHaveBeenCalledTimes(2);
    held.forEach((h) => h.resolve());
    await Promise.all([a, b]);
  });

  it("a failed save rejects its caller and the next save still runs", async () => {
    const held = holdInvokes();
    const first = transcriptSave("tab_a", "older", "/w");
    const stop = devSessionStop("newer", "tab_a");
    await flush();
    expect(invoke).toHaveBeenCalledTimes(1);

    held[0].reject(new Error("disk full"));
    await expect(first).rejects.toThrow("disk full");
    await flush();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenLastCalledWith("dev_session_stop", {
      transcript: "newer",
      tabId: "tab_a",
    });
    held[1].resolve();
    await stop;
  });
});
