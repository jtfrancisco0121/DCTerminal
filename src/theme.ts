/**
 * U8: colour themes. The palette lives in App.css as CSS variables on
 * :root (GitHub Dark) and [data-theme="github-light"]; this module only
 * flips the attribute, keeps the terminal palette in step, and caches the
 * choice so the next start paints the right colours before settings load.
 */
import type { ITheme } from "@xterm/xterm";

export type ThemeId = "github-dark" | "github-light";
/** What is saved: a concrete theme, or "system" to follow the OS. */
export type ThemeChoice = ThemeId | "system";

export const DEFAULT_THEME: ThemeId = "github-dark";
export const SYSTEM_THEME = "system";

export const THEMES: { id: ThemeId; label: string; scheme: "dark" | "light" }[] = [
  { id: "github-dark", label: "GitHub Dark", scheme: "dark" },
  { id: "github-light", label: "GitHub Light", scheme: "light" },
];

/** The Settings list: "Match system" first, then the concrete themes. */
export const THEME_CHOICES: { id: ThemeChoice; label: string }[] = [
  { id: SYSTEM_THEME, label: "Match system" },
  ...THEMES.map(({ id, label }) => ({ id, label })),
];

const CACHE_KEY = "dcterminal.theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

/** A saved value as a choice. Unknown or missing values fall back to GitHub Dark. */
export function normalizeTheme(id: string | null | undefined): ThemeChoice {
  if (id === SYSTEM_THEME) return SYSTEM_THEME;
  return THEMES.some((theme) => theme.id === id) ? (id as ThemeId) : DEFAULT_THEME;
}

export function systemPrefersDark(): boolean {
  try {
    return window.matchMedia?.(DARK_QUERY).matches ?? true;
  } catch {
    return true;
  }
}

/** The concrete theme for a saved choice. */
export function resolveTheme(id: string | null | undefined): ThemeId {
  const choice = normalizeTheme(id);
  if (choice !== SYSTEM_THEME) return choice;
  return systemPrefersDark() ? "github-dark" : "github-light";
}

/** Calls back when the OS light/dark setting changes. Returns the unsubscribe. */
export function watchSystemTheme(onChange: () => void): () => void {
  let query: MediaQueryList | undefined;
  try {
    query = window.matchMedia?.(DARK_QUERY);
  } catch {
    query = undefined;
  }
  if (!query) return () => {};
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

const TERMINAL_THEMES: Record<ThemeId, ITheme> = {
  "github-dark": {
    background: "#0d1117",
    foreground: "#e6edf3",
    cursor: "#58a6ff",
    cursorAccent: "#0d1117",
    selectionBackground: "#264f78",
    black: "#484f58",
    red: "#ff7b72",
    green: "#3fb950",
    yellow: "#d29922",
    blue: "#58a6ff",
    magenta: "#bc8cff",
    cyan: "#39c5cf",
    white: "#b1bac4",
    brightBlack: "#6e7681",
    brightRed: "#ffa198",
    brightGreen: "#56d364",
    brightYellow: "#e3b341",
    brightBlue: "#79c0ff",
    brightMagenta: "#d2a8ff",
    brightCyan: "#56d4dd",
    brightWhite: "#f0f6fc",
  },
  "github-light": {
    background: "#ffffff",
    foreground: "#1f2328",
    cursor: "#0969da",
    cursorAccent: "#ffffff",
    selectionBackground: "#b6e3ff",
    black: "#24292f",
    red: "#cf222e",
    green: "#116329",
    yellow: "#4d2d00",
    blue: "#0969da",
    magenta: "#8250df",
    cyan: "#1b7c83",
    white: "#6e7781",
    brightBlack: "#57606a",
    brightRed: "#a40e26",
    brightGreen: "#1a7f37",
    brightYellow: "#633c01",
    brightBlue: "#218bff",
    brightMagenta: "#a475f9",
    brightCyan: "#3192aa",
    brightWhite: "#8c959f",
  },
};

export function terminalTheme(id: string | null | undefined): ITheme {
  return TERMINAL_THEMES[resolveTheme(id)];
}

export function cachedTheme(): ThemeChoice {
  try {
    return normalizeTheme(window.localStorage.getItem(CACHE_KEY));
  } catch {
    return DEFAULT_THEME;
  }
}

/**
 * Switch the app's CSS variables to a theme and remember the choice. For
 * "system" the OS setting picks the palette; the choice, not the palette, is
 * cached. Returns the concrete theme applied.
 */
export function applyTheme(id: string | null | undefined): ThemeId {
  const choice = normalizeTheme(id);
  const theme = resolveTheme(choice);
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = THEMES.find((item) => item.id === theme)?.scheme ?? "dark";
  try {
    window.localStorage.setItem(CACHE_KEY, choice);
  } catch {
    // Private mode or storage disabled: the setting still lives in settings.json.
  }
  return theme;
}
