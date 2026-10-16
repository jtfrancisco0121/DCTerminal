// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./bridge", () => ({
  DEFAULT_UI_SETTINGS: { theme: "github-dark", shortcutBar: false, tipsSeen: [], padHeight: 0, padHidden: false },
  getUiSettings: vi.fn(async () => ({ theme: "github-light", shortcutBar: false, tipsSeen: [], padHeight: 0, padHidden: false })),
  setUiSettings: vi.fn(async (ui: unknown) => ui),
}));
vi.mock("./terminal/park", () => ({ setTerminalTheme: vi.fn() }));

import { setUiSettings } from "./bridge";
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

  it("updateChecked rejects when the save fails", async () => {
    const { result } = renderHook(() => useUiSettings());
    await waitFor(() => expect(result.current.loaded).toBe(true));
    vi.mocked(setUiSettings).mockRejectedValueOnce(new Error("disk full"));
    await expect(result.current.updateChecked({ shortcutBar: true })).rejects.toThrow("disk full");
  });
});
