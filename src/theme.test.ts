// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyTheme,
  cachedTheme,
  DEFAULT_THEME,
  normalizeTheme,
  terminalTheme,
  THEME_CHOICES,
  THEMES,
  watchSystemTheme,
} from "./theme";

describe("themes (U8)", () => {
  afterEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  it("defaults to GitHub Dark and offers one alternative", () => {
    expect(DEFAULT_THEME).toBe("github-dark");
    expect(THEMES.map((t) => t.id)).toEqual(["github-dark", "github-light"]);
    expect(THEMES[0].label).toBe("GitHub Dark");
    expect(normalizeTheme("github-light")).toBe("github-light");
    expect(normalizeTheme("solarized")).toBe("github-dark");
    expect(normalizeTheme(undefined)).toBe("github-dark");
  });

  it("switches the root data-theme and remembers it for the next start", () => {
    applyTheme("github-light");
    expect(document.documentElement.dataset.theme).toBe("github-light");
    expect(document.documentElement.style.colorScheme).toBe("light");
    expect(cachedTheme()).toBe("github-light");
    applyTheme("github-dark");
    expect(document.documentElement.dataset.theme).toBe("github-dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(cachedTheme()).toBe("github-dark");
  });

  it("Match system follows the OS setting and keeps the choice cached", () => {
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
      expect(normalizeTheme("system")).toBe("system");
      expect(THEME_CHOICES[0]).toEqual({ id: "system", label: "Match system" });
      expect(applyTheme("system")).toBe("github-light");
      expect(document.documentElement.dataset.theme).toBe("github-light");
      expect(cachedTheme()).toBe("system");
      const stop = watchSystemTheme(() => applyTheme("system"));
      dark = true;
      listeners.forEach((fn) => fn());
      expect(document.documentElement.dataset.theme).toBe("github-dark");
      expect(terminalTheme("system").background).toBe("#0d1117");
      stop();
      expect(listeners.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("gives the terminal a matching palette", () => {
    expect(terminalTheme("github-dark").background).toBe("#0d1117");
    expect(terminalTheme("github-light").background).toBe("#ffffff");
    expect(terminalTheme("github-light").foreground).toBe("#1f2328");
  });
});
