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
    expect(setTerminalTheme).toHaveBeenCalledWith("github-light");
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
});
