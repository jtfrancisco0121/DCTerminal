import { beforeAll, describe, expect, it } from "vitest";

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
    expect(rule(".tab-chip")).toMatch(/flex: 0 1 auto/);
  });
});
