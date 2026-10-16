import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_THEME, TERMINAL_THEMES, THEMES, type ThemeId } from "./theme";

let css = "";
beforeAll(async () => {
  // @ts-expect-error type error without @types/node package
  const { readFileSync } = await import("node:fs");
  css = readFileSync(new URL("./App.css", import.meta.url), "utf8") as string;
});

/** Selectors of top-level rules (depth 0), comments removed. */
function topLevelSelectors(source: string): string[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") {
      if (depth === 0) out.push(text.slice(start, i).trim());
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) start = i + 1;
    }
  }
  return out;
}

describe("design tokens (R1)", () => {
  it("defines the scale tokens on :root", () => {
    for (const token of [
      "--text-2xs", "--text-xs", "--text-sm", "--text-md", "--text-lg", "--text-xl",
      "--space-1", "--space-6", "--radius-sm", "--radius-md", "--radius-lg", "--radius-pill",
      "--elev-1", "--elev-2", "--elev-3",
      "--z-sticky", "--z-dropdown", "--z-overlay", "--z-drawer", "--z-toast", "--z-tip", "--z-menu",
      "--focus-ring", "--term-pad",
    ]) {
      expect(css).toMatch(new RegExp(`${token}:\\s*[^;]+;`));
    }
  });

  it("never uses the --shadow colour as a whole box-shadow", () => {
    expect(css).not.toMatch(/box-shadow:\s*var\(--shadow\)/);
  });

  it("keeps z-indexes on the layer tokens", () => {
    const raw = css.match(/z-index:\s*\d+/g) ?? [];
    expect(raw).toEqual([]);
  });

  it("has no duplicate top-level selector blocks", () => {
    const seen = new Map<string, number>();
    for (const sel of topLevelSelectors(css)) {
      if (sel.startsWith("@keyframes")) continue;
      seen.set(sel, (seen.get(sel) ?? 0) + 1);
    }
    const dupes = [...seen].filter(([, n]) => n > 1).map(([s]) => s);
    expect(dupes).toEqual([]);
  });
});

describe("buttons and focus ring (R2)", () => {
  it("has one rule for the global focus ring", () => {
    expect(css).toMatch(
      /:where\(button, a, input, select, textarea, \[tabindex\]\):focus-visible\s*\{\s*outline: none;\s*box-shadow: var\(--focus-ring\);/,
    );
  });

  it("defines every button variant", () => {
    for (const cls of [".primary-button", ".secondary-button", ".danger-button", ".ghost-button", ".icon-button", ".link-button"]) {
      expect(css).toContain(`\n${cls} {`);
    }
  });

  it("primary buttons have no accent (blue) border", () => {
    const block = css.match(/\n\.primary-button \{[^}]*\}/)?.[0] ?? "";
    expect(block).not.toContain("var(--accent)");
  });
});

describe("chain tab strip (R19)", () => {
  const rule = (selector: string) =>
    new RegExp(`(?:^|\\n)${selector.replace(/\./g, "\\.")}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";

  it("stays on one row at 820px: no wrapping, and the label and chips may shrink", () => {
    expect(rule(".tab-bar")).toContain("flex-wrap: nowrap");
    expect(rule(".tab-list")).toContain("flex-wrap: nowrap");
    // Four chips and a label share about 600px (820px less the icon buttons):
    // their minimum widths (60px chips, 0 label) fit, longer text is cut with an ellipsis.
    expect(rule(".tab-chain-label")).toMatch(/min-width: 0/);
    expect(rule(".tab-chain-label")).toMatch(/max-width: 8rem/);
    expect(rule(".tab-chip-chain")).toMatch(/min-width: 3\.75rem/);
    // R14: plain chips keep their width and the strip scrolls instead.
    expect(rule(".tab-chip")).toMatch(/flex: 0 0 auto/);
    expect(rule(".tab-list")).toMatch(/overflow-x: auto/);
    expect(rule(".tab-chip-chain")).toMatch(/flex: 0 1 auto/);
  });
});

describe("theme presets", () => {
  /** `--name: value` pairs of the top-level rule with exactly this selector. */
  const tokens = (selector: string): Map<string, string> => {
    const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const at = text.search(new RegExp(`(?:^|\\n)${selector.replace(/[[\]().:"]/g, "\\$&")}\\s*\\{`));
    const body = at < 0 ? "" : text.slice(text.indexOf("{", at) + 1, text.indexOf("}", at));
    return new Map([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  };
  const blockFor = (id: ThemeId) =>
    id === DEFAULT_THEME ? tokens(":root") : tokens(`:root[data-theme="${id}"]`);
  /** Colour tokens on :root: the ones each theme must set (the scale tokens are shared). */
  const colourTokens = () =>
    [...tokens(":root")].filter(([, value]) => /^(#|rgba?\()/.test(value)).map(([name]) => name);

  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (hex: string) => {
    const n = parseInt(hex.slice(1, 7), 16);
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

  it("every preset sets every colour token :root sets", () => {
    const required = colourTokens();
    expect(required.length).toBeGreaterThan(40);
    for (const theme of THEMES) {
      const block = blockFor(theme.id);
      const missing = required.filter((name) => !block.has(name));
      expect(missing, theme.id).toEqual([]);
    }
  });

  it("every theme has a terminal palette, and its swatch matches the CSS", () => {
    for (const theme of THEMES) {
      expect(TERMINAL_THEMES[theme.id], theme.id).toBeDefined();
      const block = blockFor(theme.id);
      expect(
        ["--bg", "--accent", "--success", "--attention", "--done"].map((name) => block.get(name)),
        theme.id,
      ).toEqual(theme.swatch);
      expect(TERMINAL_THEMES[theme.id].background, theme.id).toBe(theme.swatch[0]);
    }
  });

  it("keeps the status colours distinct and readable as small text on every preset", () => {
    for (const theme of THEMES) {
      const block = blockFor(theme.id);
      const bg = block.get("--bg") as string;
      // Working, Needs you, Done, Exited.
      const status = ["--accent", "--attention", "--done", "--danger"].map(
        (name) => block.get(name) as string,
      );
      expect(new Set(status).size, theme.id).toBe(4);
      for (const color of status) {
        // WCAG AA for normal text: the pills and labels are small.
        expect(contrast(color, bg), `${theme.id} ${color}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

describe("needs-you surfaces", () => {
  /** Declarations of every top-level rule whose selector matches. */
  const rulesFor = (pattern: RegExp): string[] => {
    const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
    return [...text.matchAll(/(^|\n)([^{}\n][^{}]*)\{([^{}]*)\}/g)]
      .filter((m) => pattern.test(m[2].trim()))
      .map((m) => `${m[2].trim()} { ${m[3].trim()} }`);
  };

  it("use the Needs you colour (--attention), so a custom one reaches them", () => {
    const rules = rulesFor(/-needs\b|^\.permission-card$|^\.terminal-chat-permission$/);
    expect(rules.length).toBeGreaterThan(8);
    for (const rule of rules) expect(rule).not.toMatch(/var\(--warning/);
    expect(rules.filter((rule) => rule.includes("var(--attention")).length).toBeGreaterThan(8);
  });
});
