// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./bridge", () => ({
  DEFAULT_UI_SETTINGS: { theme: "github-dark", shortcutBar: false, tipsSeen: [], padHeight: 0, padHidden: false },
  getUiSettings: vi.fn(async () => ({ theme: "github-light", shortcutBar: false, tipsSeen: [], padHeight: 0, padHidden: false })),
  setUiSettings: vi.fn(async (ui: unknown) => ui),
}));
vi.mock("./terminal/park", () => ({ setTerminalTheme: vi.fn() }));

import { getUiSettings, setUiSettings, type UiSettings } from "./bridge";
import { setTerminalTheme } from "./terminal/park";
import { useUiSettings } from "./useUiSettings";

describe("useUiSettings (U7/U8)", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("data-theme");
    vi.mocked(setUiSettings).mockClear();
  });

  it("applies the saved theme to the app and terminals, then saves changes", async () => {
    const { result } = renderHook(() => useUiSettings());
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("github-light"));
    expect(setTerminalTheme).toHaveBeenCalledWith("github-light", {});
    act(() => result.current.update({ theme: "github-dark", shortcutBar: true }));
    expect(document.documentElement.dataset.theme).toBe("github-dark");
    expect(result.current.ui.shortcutBar).toBe(true);
    expect(setUiSettings).toHaveBeenCalledWith({
      theme: "github-dark",
      shortcutBar: true,
      tipsSeen: [],
      padHeight: 0,
      padHidden: false,
    });
  });

  it("marks a tip seen once", async () => {
    const { result } = renderHook(() => useUiSettings());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    act(() => result.current.markTipSeen("palette"));
    act(() => result.current.markTipSeen("palette"));
    expect(result.current.ui.tipsSeen).toEqual(["palette"]);
    expect(setUiSettings).toHaveBeenCalledTimes(1);
  });

  it("follows the OS light/dark setting live while the theme is Match system", async () => {
    let dark = false;
    const listeners = new Set<() => void>();
    vi.stubGlobal("matchMedia", () => ({
      get matches() {
        return dark;
      },
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    }));
    try {
      const { result, unmount } = renderHook(() => useUiSettings());
      await waitFor(() => expect(result.current.loaded).toBe(true));
      act(() => result.current.update({ theme: "system" }));
      expect(document.documentElement.dataset.theme).toBe("github-light");
      expect(setUiSettings).toHaveBeenLastCalledWith(expect.objectContaining({ theme: "system" }));
      dark = true;
      act(() => listeners.forEach((fn) => fn()));
      expect(document.documentElement.dataset.theme).toBe("github-dark");
      expect(setTerminalTheme).toHaveBeenLastCalledWith("github-dark", {});
      // An old saved theme stops following the OS.
      act(() => result.current.update({ theme: "github-light" }));
      expect(listeners.size).toBe(0);
      unmount();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("waits for the first load before saving, so a change does not save defaults over stored settings", async () => {
    let finishLoad: (value: UiSettings) => void = () => {};
    vi.mocked(getUiSettings).mockImplementationOnce(() => new Promise((resolve) => (finishLoad = resolve)));
    const { result } = renderHook(() => useUiSettings());
    act(() => result.current.markTipSeen("palette"));
    // Applied at once, but nothing is saved before the stored settings arrive.
    expect(result.current.ui.tipsSeen).toEqual(["palette"]);
    expect(setUiSettings).not.toHaveBeenCalled();
    await act(async () =>
      finishLoad({ theme: "github-light", shortcutBar: true, tipsSeen: ["welcome"], padHeight: 120, padHidden: false }),
    );
    await waitFor(() => expect(result.current.loaded).toBe(true));
    // One save: the stored settings with the change on top.
    expect(setUiSettings).toHaveBeenCalledTimes(1);
    expect(setUiSettings).toHaveBeenCalledWith({
      theme: "github-light",
      shortcutBar: true,
      tipsSeen: ["welcome", "palette"],
      padHeight: 120,
      padHidden: false,
    });
    expect(result.current.ui.tipsSeen).toEqual(["welcome", "palette"]);
  });

  it("updateChecked made before the first load resolves once the merged settings are saved", async () => {
    let finishLoad: (value: UiSettings) => void = () => {};
    vi.mocked(getUiSettings).mockImplementationOnce(() => new Promise((resolve) => (finishLoad = resolve)));
    const { result } = renderHook(() => useUiSettings());
    let saved: Promise<void> = Promise.resolve();
    act(() => {
      saved = result.current.updateChecked({ shortcutBar: true });
    });
    expect(setUiSettings).not.toHaveBeenCalled();
    await act(async () =>
      finishLoad({ theme: "github-light", shortcutBar: false, tipsSeen: ["welcome"], padHeight: 0, padHidden: false }),
    );
    await act(async () => saved);
    expect(setUiSettings).toHaveBeenCalledWith(
      expect.objectContaining({ shortcutBar: true, tipsSeen: ["welcome"], theme: "github-light" }),
    );
  });

  it("updateChecked made before the first load rejects, not hangs, when the hook unmounts first", async () => {
    vi.mocked(getUiSettings).mockImplementationOnce(() => new Promise(() => {}));
    const { result, unmount } = renderHook(() => useUiSettings());
    let saved: Promise<void> = Promise.resolve();
    act(() => {
      saved = result.current.updateChecked({ shortcutBar: true });
    });
    unmount();
    const outcome = await Promise.race([
      saved.then(
        () => "resolved",
        (err: unknown) => `rejected: ${err instanceof Error ? err.message : String(err)}`,
      ),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 20)),
    ]);
    expect(outcome).toMatch(/^rejected: /);
    expect(setUiSettings).not.toHaveBeenCalled();
  });

  it("updateChecked rejects when the save fails", async () => {
    const { result } = renderHook(() => useUiSettings());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    vi.mocked(setUiSettings).mockRejectedValueOnce(new Error("disk full"));
    await expect(result.current.updateChecked({ shortcutBar: true })).rejects.toThrow("disk full");
  });
});
