import { describe, expect, it, vi } from "vitest";

vi.mock("./terminal/live", () => ({
  livePty: (id: string) => (id === "term-live" ? { id } : undefined),
}));

import { liveTabs } from "./liveWork";

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
