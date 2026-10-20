import { beforeAll, describe, expect, it } from "vitest";
import type { StopReason } from "../bridge";
import { STOP_REASONS, isStopReason, stopNotice, stopReasonText } from "./stopReasons";

type Fs = { readFileSync(path: URL, encoding: "utf8"): string };
let fs: Fs;

beforeAll(async () => {
  // @ts-expect-error type error without @types/node package
  fs = (await import("node:fs")) as Fs;
});

/** The codes the Rust core sends (`StopReason::as_str`). */
function rustCodes(): string[] {
  const source = fs.readFileSync(new URL("../../src-tauri/src/store/state_types.rs", import.meta.url), "utf8");
  return [...source.matchAll(/StopReason::\w+ => "([a-z_]+)"/g)].map((m) => m[1]);
}

describe("stop reasons", () => {
  it("has a plain-English line for every code the core sends, and no other", () => {
    const codes = rustCodes();
    expect(codes).toHaveLength(13);
    expect([...STOP_REASONS].sort()).toEqual([...codes].sort());
  });

  // One test per code: each reads as a sentence of its own.
  const expected: Record<StopReason, RegExp> = {
    checkpoint: /checkpoint/i,
    gate_failed: /check kept failing/i,
    no_check_found: /nothing to run/i,
    no_result: /no result/i,
    no_verdict: /no verdict/i,
    blocking_findings: /review found problems/i,
    round_cap: /round cap/i,
    usage_limit: /usage limit/i,
    stalled: /stopped making progress/i,
    app_restarted: /closed/i,
    carry_out_failed: /could not carry out/i,
    taken_over: /took over/i,
    paused_by_you: /turned autopilot off/i,
  };
  for (const code of STOP_REASONS) {
    it(`${code} reads in plain English`, () => {
      const line = stopReasonText(code);
      expect(line).toMatch(expected[code]);
      expect(line).toMatch(/^[A-Z].*\.$/);
      expect(line).not.toContain("_");
    });
  }

  it("lines are all different", () => {
    const lines = STOP_REASONS.map((code) => stopReasonText(code));
    expect(new Set(lines).size).toBe(lines.length);
  });

  it("an unknown or missing code has no line", () => {
    expect(stopReasonText("cosmic_rays")).toBeNull();
    expect(stopReasonText(null)).toBeNull();
    expect(stopReasonText(undefined)).toBeNull();
    expect(isStopReason("usage_limit")).toBe(true);
    expect(isStopReason("advance")).toBe(false);
  });

  it("the notification leads with the code's line, then the reason", () => {
    expect(stopNotice("usage_limit", "Plan Reviewer hit a Claude usage limit: resets 3pm.")).toBe(
      "Claude's usage limit was reached. Plan Reviewer hit a Claude usage limit: resets 3pm.",
    );
    // Older backends send no code: the reason alone.
    expect(stopNotice(null, "Tab 2 is still working.")).toBe("Tab 2 is still working.");
  });
});
