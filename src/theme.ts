/**
 * U8: colour themes. The palette lives in App.css as CSS variables on
 * :root (GitHub Dark) and one [data-theme="…"] block per other preset; this
 * module only flips the attribute, keeps the terminal palette in step, and
 * caches the choice so the next start paints the right colours before
 * settings load. Custom colour overrides sit on top as inline variables.
 */
import type { ITheme } from "@xterm/xterm";

export type ThemeId =
  | "github-dark"
  | "github-light"
  | "dracula"
  | "nord"
  | "tokyo-night"
  | "catppuccin-mocha";
/** What is saved: a concrete theme, or "system" to follow the OS. */
export type ThemeChoice = ThemeId | "system";

export const DEFAULT_THEME: ThemeId = "github-dark";
export const SYSTEM_THEME = "system";

/** Swatch dots for the Settings picker: background, accent, success, attention, done. */
export type ThemeSwatch = [string, string, string, string, string];

export const THEMES: {
  id: ThemeId;
  label: string;
  scheme: "dark" | "light";
  swatch: ThemeSwatch;
}[] = [
  {
    id: "github-dark",
    label: "GitHub Dark",
    scheme: "dark",
    swatch: ["#0d1117", "#388bfd", "#3fb950", "#f0c14b", "#a371f7"],
  },
  {
    id: "github-light",
    label: "GitHub Light",
    scheme: "light",
    swatch: ["#ffffff", "#0969da", "#1a7f37", "#9a6700", "#8250df"],
  },
  {
    id: "dracula",
    label: "Dracula",
    scheme: "dark",
    swatch: ["#282a36", "#bd93f9", "#50fa7b", "#f1fa8c", "#8be9fd"],
  },
  {
    id: "nord",
    label: "Nord",
    scheme: "dark",
    swatch: ["#2e3440", "#88c0d0", "#a3be8c", "#ebcb8b", "#b48ead"],
  },
  {
    id: "tokyo-night",
    label: "Tokyo Night",
    scheme: "dark",
    swatch: ["#1a1b26", "#7aa2f7", "#9ece6a", "#e0af68", "#bb9af7"],
  },
  {
    id: "catppuccin-mocha",
    label: "Catppuccin Mocha",
    scheme: "dark",
    swatch: ["#1e1e2e", "#89b4fa", "#a6e3a1", "#f9e2af", "#cba6f7"],
  },
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

export const TERMINAL_THEMES: Record<ThemeId, ITheme> = {
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
    yellow: "#9a6700",
    blue: "#0969da",
    magenta: "#8250df",
    cyan: "#1b7c83",
    white: "#57606a",
    brightBlack: "#57606a",
    brightRed: "#a40e26",
    brightGreen: "#1a7f37",
    brightYellow: "#7d4e00",
    brightBlue: "#0969da",
    brightMagenta: "#8250df",
    brightCyan: "#1b7c83",
    brightWhite: "#6e7781",
  },
  // Dracula spec palette: https://draculatheme.com/contribute
  dracula: {
    background: "#282a36",
    foreground: "#f8f8f2",
    cursor: "#f8f8f2",
    cursorAccent: "#282a36",
    selectionBackground: "#44475a",
    black: "#21222c",
    red: "#ff5555",
    green: "#50fa7b",
    yellow: "#f1fa8c",
    blue: "#bd93f9",
    magenta: "#ff79c6",
    cyan: "#8be9fd",
    white: "#f8f8f2",
    brightBlack: "#6272a4",
    brightRed: "#ff6e6e",
    brightGreen: "#69ff94",
    brightYellow: "#ffffa5",
    brightBlue: "#d6acff",
    brightMagenta: "#ff92df",
    brightCyan: "#a4ffff",
    brightWhite: "#ffffff",
  },
  // Nord: https://www.nordtheme.com/docs/colors-and-palettes
  nord: {
    background: "#2e3440",
    foreground: "#d8dee9",
    cursor: "#d8dee9",
    cursorAccent: "#2e3440",
    selectionBackground: "#434c5e",
    black: "#3b4252",
    red: "#bf616a",
    green: "#a3be8c",
    yellow: "#ebcb8b",
    blue: "#81a1c1",
    magenta: "#b48ead",
    cyan: "#88c0d0",
    white: "#e5e9f0",
    brightBlack: "#616e88",
    brightRed: "#bf616a",
    brightGreen: "#a3be8c",
    brightYellow: "#ebcb8b",
    brightBlue: "#81a1c1",
    brightMagenta: "#b48ead",
    brightCyan: "#8fbcbb",
    brightWhite: "#eceff4",
  },
  // Tokyo Night ("night" style): https://github.com/folke/tokyonight.nvim
  "tokyo-night": {
    background: "#1a1b26",
    foreground: "#c0caf5",
    cursor: "#c0caf5",
    cursorAccent: "#1a1b26",
    selectionBackground: "#283457",
    black: "#15161e",
    red: "#f7768e",
    green: "#9ece6a",
    yellow: "#e0af68",
    blue: "#7aa2f7",
    magenta: "#bb9af7",
    cyan: "#7dcfff",
    white: "#a9b1d6",
    brightBlack: "#414868",
    brightRed: "#f7768e",
    brightGreen: "#9ece6a",
    brightYellow: "#e0af68",
    brightBlue: "#7aa2f7",
    brightMagenta: "#bb9af7",
    brightCyan: "#7dcfff",
    brightWhite: "#c0caf5",
  },
  // Catppuccin Mocha: https://catppuccin.com/palette
  "catppuccin-mocha": {
    background: "#1e1e2e",
    foreground: "#cdd6f4",
    cursor: "#f5e0dc",
    cursorAccent: "#1e1e2e",
    selectionBackground: "#585b70",
    black: "#45475a",
    red: "#f38ba8",
    green: "#a6e3a1",
    yellow: "#f9e2af",
    blue: "#89b4fa",
    magenta: "#f5c2e7",
    cyan: "#94e2d5",
    white: "#bac2de",
    brightBlack: "#585b70",
    brightRed: "#f38ba8",
    brightGreen: "#a6e3a1",
    brightYellow: "#f9e2af",
    brightBlue: "#89b4fa",
    brightMagenta: "#f5c2e7",
    brightCyan: "#94e2d5",
    brightWhite: "#a6adc8",
  },
};

/** The terminal palette for a theme, with any custom background and text colour on top. */
export function terminalTheme(
  id: string | null | undefined,
  custom?: CustomColors | null,
): ITheme {
  const base = TERMINAL_THEMES[resolveTheme(id)];
  const colors = normalizeCustomColors(custom);
  if (!colors.background && !colors.text) return base;
  return {
    ...base,
    ...(colors.background
      ? { background: colors.background, cursorAccent: colors.background }
      : {}),
    ...(colors.text ? { foreground: colors.text } : {}),
  };
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

/**
 * Custom colours: a few #rrggbb values that override the chosen preset's CSS
 * variables. "Accent" is links and buttons; "Working" is the busy status
 * colour (the --accent dots, pills, and focus ring).
 */
export type CustomColors = {
  background?: string;
  text?: string;
  accent?: string;
  working?: string;
  needsYou?: string;
  done?: string;
};

export type CustomColorKey = keyof CustomColors;

export const CUSTOM_COLOR_FIELDS: { key: CustomColorKey; label: string; vars: string[] }[] = [
  { key: "background", label: "Background", vars: ["--bg"] },
  { key: "text", label: "Text", vars: ["--fg"] },
  { key: "accent", label: "Accent", vars: ["--accent-fg", "--accent-emphasis"] },
  { key: "working", label: "Working", vars: ["--accent", "--accent-bright"] },
  { key: "needsYou", label: "Needs you", vars: ["--attention", "--attention-emphasis"] },
  { key: "done", label: "Done", vars: ["--done", "--done-bright"] },
];

const CUSTOM_CACHE_KEY = "dcterminal.customColors";
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** Only #rrggbb values for known keys survive; anything else is dropped. */
export function normalizeCustomColors(value: unknown): CustomColors {
  if (!value || typeof value !== "object") return {};
  const out: CustomColors = {};
  for (const { key } of CUSTOM_COLOR_FIELDS) {
    const raw = (value as Record<string, unknown>)[key];
    if (typeof raw === "string" && HEX_COLOR.test(raw)) out[key] = raw.toLowerCase();
  }
  return out;
}

export function cachedCustomColors(): CustomColors {
  try {
    const raw = window.localStorage.getItem(CUSTOM_CACHE_KEY);
    return raw ? normalizeCustomColors(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

/**
 * Put the custom colours on the root element as inline variables (they win
 * over every [data-theme] block) and cache them for the next start. Colours
 * that are not set are removed, so the preset shows through again.
 */
export function applyCustomColors(value: unknown): CustomColors {
  const colors = normalizeCustomColors(value);
  const style = document.documentElement.style;
  for (const { key, vars } of CUSTOM_COLOR_FIELDS) {
    const color = colors[key];
    for (const name of vars) {
      if (color) style.setProperty(name, color);
      else style.removeProperty(name);
    }
  }
  try {
    if (Object.keys(colors).length === 0) window.localStorage.removeItem(CUSTOM_CACHE_KEY);
    else window.localStorage.setItem(CUSTOM_CACHE_KEY, JSON.stringify(colors));
  } catch {
    // Private mode or storage disabled: the colours still live in settings.json.
  }
  return colors;
}
