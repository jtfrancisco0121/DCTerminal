import { describe, expect, it, vi } from "vitest";

vi.mock("./terminal/live", () => ({
  livePty: (id: string) => (id === "term-live" ? { id } : undefined),
}));

import { liveTabs, liveTabsNow } from "./liveWork";
import startupFormSource from "./StartupForm.tsx?raw";

const tab = (id: string, phase: string, kind?: string) => ({ id, phase, kind });

describe("liveTabs", () => {
  it("counts running agents and terminals with a live shell, nothing else", () => {
    const tabs = [
      tab("chat-running", "running"),
      tab("chat-idle", "awaitingInput", "role"),
      tab("chat-draft", "draft"),
      tab("term-live", "terminal", "terminal"),
      tab("term-gone", "terminal", "terminal"),
    ];
    expect(liveTabs(tabs).map((t) => t.id)).toEqual(["chat-running", "term-live"]);
  });

  it("is empty when nothing runs", () => {
    expect(liveTabs([tab("chat-idle", "awaitingInput")])).toEqual([]);
  });
});

describe("liveTabsNow", () => {
  it("also counts a hidden pipeline stage whose terminal runs in the backend (no view, V5)", async () => {
    const tabs = [
      tab("chat-running", "running"),
      tab("term-live", "terminal", "terminal"),
      tab("stage-hidden", "terminal", "terminal"),
      tab("stage-ended", "terminal", "terminal"),
      tab("chat-idle", "awaitingInput", "role"),
    ];
    const running = vi.fn(async (ids: string[]) => ids.filter((id) => id === "stage-hidden"));
    const live = await liveTabsNow(tabs, running);
    expect(live.map((t) => t.id)).toEqual(["chat-running", "term-live", "stage-hidden"]);
    // Only terminals with no live view are asked about.
    expect(running).toHaveBeenCalledWith(["stage-hidden", "stage-ended"]);
  });

  it("falls back to the views it knows when the backend cannot answer", async () => {
    const tabs = [tab("term-live", "terminal", "terminal"), tab("stage-hidden", "terminal", "terminal")];
    const live = await liveTabsNow(tabs, async () => {
      throw new Error("no backend");
    });
    expect(live.map((t) => t.id)).toEqual(["term-live"]);
  });

  it("asks nothing when every terminal has a view", async () => {
    const running = vi.fn(async () => []);
    expect((await liveTabsNow([tab("term-live", "terminal", "terminal")], running)).length).toBe(1);
    expect(running).not.toHaveBeenCalled();
  });

  it("is what the Close window? and Replace the open tabs questions count", () => {
    const code = startupFormSource.replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/\bliveTabs\(/);
    expect(code.match(/await liveTabsNow\(/g)?.length).toBe(2);
  });
});
