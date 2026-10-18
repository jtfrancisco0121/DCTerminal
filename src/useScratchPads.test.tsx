// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./bridge", () => ({
  scratchLoad: vi.fn(async () => ({ pads: [] })),
  scratchSave: vi.fn(async () => null),
}));

import { scratchLoad, scratchSave, type ScratchPadEntry } from "./bridge";
import { useScratchPads } from "./useScratchPads";

const DISK_TIME = "2026-10-06T00:00:00.000Z";

function diskPad(tabId: string, content: string, updatedAt = DISK_TIME): ScratchPadEntry {
  return { tabId, content, updatedAt, history: [] };
}

async function loaded(pads: ScratchPadEntry[], tabId = "tab-a") {
  vi.mocked(scratchLoad).mockResolvedValueOnce({ pads, knownTabIds: pads.map((p) => p.tabId) });
  const hook = renderHook(() => useScratchPads(tabId));
  await waitFor(() => expect(hook.result.current.content).toBe(pads.find((p) => p.tabId === tabId)?.content ?? ""));
  return hook;
}

describe("useScratchPads across windows (S1 PR2)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.mocked(scratchLoad).mockReset();
    vi.mocked(scratchLoad).mockResolvedValue({ pads: [] });
    vi.mocked(scratchSave).mockReset();
    vi.mocked(scratchSave).mockResolvedValue(null);
  });

  it("flush saves only pads this window changed", async () => {
    const { result } = await loaded([diskPad("tab-a", "saved a"), diskPad("tab-b", "saved b")]);
    act(() => result.current.setContent("tab-a", "edited a"));
    act(() => result.current.flush());
    await waitFor(() => expect(scratchSave).toHaveBeenCalled());
    expect(scratchSave).toHaveBeenCalledTimes(1);
    const [tabId, content, history, updatedAt] = vi.mocked(scratchSave).mock.calls[0];
    expect([tabId, content, history]).toEqual(["tab-a", "edited a", []]);
    expect(Date.parse(updatedAt ?? "")).toBeGreaterThan(Date.parse(DISK_TIME));

    // Saved once: a second flush has nothing new to write.
    vi.mocked(scratchSave).mockClear();
    act(() => result.current.flush());
    await Promise.resolve();
    expect(scratchSave).not.toHaveBeenCalled();
  });

  it("pagehide with no edits saves nothing", async () => {
    await loaded([diskPad("tab-a", "saved a"), diskPad("tab-b", "saved b")]);
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    await Promise.resolve();
    expect(scratchSave).not.toHaveBeenCalled();
  });

  it("a rejected save adopts the stored pad", async () => {
    const { result } = await loaded([diskPad("tab-a", "saved a")]);
    act(() => result.current.setContent("tab-a", "stale edit"));
    const newer = new Date(Date.now() + 60_000).toISOString();
    vi.mocked(scratchSave).mockResolvedValueOnce({
      applied: false,
      pad: { tabId: "tab-a", content: "typed in the other window", updatedAt: newer, history: ["kept"] },
    });
    act(() => result.current.flush());
    await waitFor(() => expect(result.current.content).toBe("typed in the other window"));
    expect(result.current.history).toEqual(["kept"]);
    expect(result.current.persistError).toBeNull();

    vi.mocked(scratchSave).mockClear();
    act(() => result.current.flush());
    await Promise.resolve();
    expect(scratchSave).not.toHaveBeenCalled();
  });

  it("an edit typed before the load resolves is kept", async () => {
    let resolveLoad: (snap: { pads: ScratchPadEntry[]; knownTabIds: string[] }) => void = () => {};
    vi.mocked(scratchLoad).mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveLoad = resolve;
      }),
    );
    const { result } = renderHook(() => useScratchPads("tab-a"));
    act(() => result.current.setContent("tab-a", "typed early"));
    await act(async () => {
      resolveLoad({
        pads: [diskPad("tab-a", "older disk copy"), diskPad("tab-b", "saved b")],
        knownTabIds: ["tab-a", "tab-b"],
      });
    });
    expect(result.current.content).toBe("typed early");
    act(() => result.current.flush());
    await waitFor(() => expect(scratchSave).toHaveBeenCalled());
    expect(vi.mocked(scratchSave).mock.calls.map((c) => [c[0], c[1]])).toEqual([["tab-a", "typed early"]]);
  });
});
