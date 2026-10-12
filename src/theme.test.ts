// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  applyTheme,
  cachedTheme,
  DEFAULT_THEME,
  normalizeTheme,
  terminalTheme,
  THEMES,
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

  it("gives the terminal a matching palette", () => {
    expect(terminalTheme("github-dark").background).toBe("#0d1117");
    expect(terminalTheme("github-light").background).toBe("#ffffff");
    expect(terminalTheme("github-light").foreground).toBe("#1f2328");
  });
});

describe("light terminal palette (R22)", () => {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (hex: string) => {
    const n = parseInt(hex.slice(1), 16);
    return (
      0.2126 * channel((n >> 16) & 255) +
      0.7152 * channel((n >> 8) & 255) +
      0.0722 * channel(n & 255)
    );
  };
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  it("keeps the dim and bright colors readable (>= 4.5:1) on the light background", () => {
    const light = terminalTheme("github-light");
    for (const key of [
      "yellow",
      "white",
      "brightWhite",
      "brightMagenta",
      "brightBlue",
      "brightCyan",
      "brightYellow",
    ] as const) {
      expect(
        contrast(light[key] as string, light.background as string),
        key,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});
