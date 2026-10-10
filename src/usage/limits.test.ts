import { describe, expect, it } from "vitest";
import { contextPercent, isStale, limitAlerts, limitTone, statusLimit, type RateWindow } from "./limits";

function window(overrides: Partial<RateWindow> = {}): RateWindow {
  return {
    rateLimitType: "five_hour",
    label: "5h",
    utilization: 42,
    resetsAt: Date.UTC(2099, 9, 9, 15, 10) / 1000,
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

  it("marks a reading from before the window reset as old", () => {
    const now = Date.UTC(2026, 9, 10, 12, 0);
    const old = window({ resetsAt: Date.UTC(2026, 9, 10, 9, 0) / 1000, utilization: 91 });
    expect(isStale(old, now)).toBe(true);
    const line = statusLimit([old], now);
    expect(line.text).toBe("Claude 5h reset · no new reading");
    expect(line.tone).toBe("muted");
    expect(line.title).toContain("Last reported");
    expect(isStale(window({ resetsAt: null }), now)).toBe(false);
  });

  it("raises one alert near the limit and another when it is reached", () => {
    expect(limitAlerts([window({ utilization: 42 })])).toEqual([]);
    const [near] = limitAlerts([window({ utilization: 84.6 })]);
    expect(near.title).toBe("Claude 5h limit at 85%");
    expect(near.reached).toBe(false);
    const [warned] = limitAlerts([window({ utilization: null, status: "allowed_warning" })]);
    expect(warned.title).toBe("Claude 5h limit nearly used");
    const [hit] = limitAlerts([window({ status: "rejected", utilization: 100 })]);
    expect(hit.reached).toBe(true);
    expect(hit.key).not.toBe(near.key);
    // A new window (new reset time) is a new alert.
    const [next] = limitAlerts([window({ utilization: 90, resetsAt: Date.UTC(2099, 9, 9, 20, 10) / 1000 })]);
    expect(next.key).not.toBe(near.key);
    // A reading from before the reset never alerts.
    const now = Date.UTC(2026, 9, 10, 12, 0);
    expect(limitAlerts([window({ utilization: 99, resetsAt: Date.UTC(2026, 9, 10, 9, 0) / 1000 })], now)).toEqual([]);
  });
});
