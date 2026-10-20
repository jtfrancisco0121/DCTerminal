import { describe, expect, it } from "vitest";

// @ts-expect-error type error without @types/node package
const { readFileSync } = await import("node:fs");

/** StartupForm's code with its comments removed, so a comment never satisfies a check. */
const source: string = (readFileSync(new URL("../StartupForm.tsx", import.meta.url), "utf8") as string)
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

/** The code from `start` up to the first `end` after it. */
function section(start: string, end: string): string {
  const at = source.indexOf(start);
  expect(at, start).toBeGreaterThanOrEqual(0);
  const stop = source.indexOf(end, at + start.length);
  expect(stop, `${start} … ${end}`).toBeGreaterThan(at);
  return source.slice(at, stop + end.length);
}

describe("StartupForm uses useBridgeNeeds at every point", () => {
  it("binds the hook's clears from useBridgeNeeds", () => {
    expect(source).toMatch(/const bridgeNeeds = useBridgeNeeds\(/);
    expect(source).toMatch(/\bafterRead: bridgeNeedsAfterLogRead\b[^}]*\} = bridgeNeeds;/);
    expect(source).toMatch(/\bafterDialog: bridgeNeedsAfterScreen\b[^}]*\} = bridgeNeeds;/);
  });

  it("clears after each session-log read", () => {
    const handler = section("const storeSessionLog = useCallback(", "\n  );\n");
    expect(handler).toContain("bridgeNeedsAfterLogRead(tabId, log, readAt)");
    // Its dependency list, so the callback sees the hook's current clear.
    expect(handler.slice(handler.lastIndexOf("["))).toMatch(/\bbridgeNeedsAfterLogRead\b/);
  });

  it("clears when the screen's dialog changes", () => {
    const handler = section("dialogDetector.subscribe((id) => {", "\n    });");
    expect(handler).toContain("bridgeNeedsAfterScreen(id, visible)");
  });

  it("reads the marks into the terminal states and recomputes them when a mark changes", () => {
    const memo = section("const terminalStates = useMemo(", "]);");
    expect(memo).toContain("bridgeNeeds: bridgeNeeds.markOf(tab.id)");
    const deps = memo.slice(memo.lastIndexOf("}, ["));
    expect(deps).toMatch(/\bbridgeNeeds\.version\b/);
  });
});
