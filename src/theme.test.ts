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
