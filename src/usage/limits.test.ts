import { describe, expect, it } from "vitest";
import { contextPercent, limitTone, statusLimit, type RateWindow } from "./limits";

function window(overrides: Partial<RateWindow> = {}): RateWindow {
  return {
    rateLimitType: "five_hour",
    label: "5h",
    utilization: 42,
    resetsAt: Date.UTC(2026, 9, 9, 15, 10) / 1000,
    status: "allowed",
    seenAtMs: 1,
    ...overrides,
  };
}

describe("Claude limit display", () => {
  it("says not reported yet before the first update", () => {
    const line = statusLimit([]);
    expect(line.text).toBe("Claude usage not reported yet");
    expect(line.tone).toBe("muted");
    expect(line.title).toMatch(/terminal tabs don't report usage/);
  });

  it("formats the 5-hour window and does not invent a percent", () => {
    const dated = statusLimit([window({ utilization: null })]);
    expect(dated.text.startsWith("Claude 5h")).toBe(true);
    expect(dated.text).not.toMatch(/%/);
    expect(dated.text).toContain("resets");
    const filled = statusLimit([
      window({ utilization: 42.4 }),
      window({ rateLimitType: "seven_day", label: "7d", utilization: 10 }),
    ]);
    expect(filled.text.startsWith("Claude 5h 42%")).toBe(true);
    expect(filled.title).toContain("Claude 7d 10%");
  });

  it("turns yellow at 80% or allowed_warning and red when rejected", () => {
    expect(limitTone(window({ utilization: 80 }))).toBe("warn");
    expect(limitTone(window({ utilization: 10, status: "allowed_warning" }))).toBe("warn");
    expect(limitTone(window({ status: "rejected", utilization: 10 }))).toBe("hot");
    expect(limitTone(window({ utilization: 42 }))).toBe("ok");
  });

  it("shows context fill as a percent", () => {
    expect(contextPercent({ used: 26504, size: 1_000_000 })).toBe("Context 3%");
    expect(contextPercent(null)).toBeNull();
    expect(contextPercent({ used: 1, size: 0 })).toBeNull();
  });
});
