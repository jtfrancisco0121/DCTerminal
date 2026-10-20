import { describe, expect, it } from "vitest";
import {
  autopilotUsageLine,
  contextPercent,
  isStale,
  knownUsagePercent,
  limitAlerts,
  limitTone,
  statusLimit,
  type RateWindow,
} from "./limits";

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
  it("says unknown before the first update, never 0%", () => {
    const line = statusLimit([]);
    expect(line.text).toBe("Claude usage unknown");
    expect(line.text).not.toMatch(/0%/);
    expect(line.tone).toBe("muted");
    expect(line.title).toMatch(/terminal tabs report it through the status line/i);
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
    expect(line.text).toBe("Claude usage unknown · 5h reset since the last reading");
    expect(line.tone).toBe("muted");
    expect(line.title).toContain("Last reported");
    expect(isStale(window({ resetsAt: null, seenAtMs: now - 60_000 }), now)).toBe(false);
  });

  it("shows the current 7d window when only the 5h reading is stale, matching the usage percent", () => {
    const now = Date.UTC(2026, 9, 10, 12, 0);
    const windows = [
      window({ resetsAt: Date.UTC(2026, 9, 10, 9, 0) / 1000, utilization: 91 }),
      window({ rateLimitType: "seven_day", label: "7d", utilization: 40, resetsAt: Date.UTC(2026, 9, 14) / 1000 }),
    ];
    const line = statusLimit(windows, now);
    expect(line.text).not.toMatch(/unknown/);
    expect(line.text.startsWith("Claude 7d 40%")).toBe(true);
    expect(knownUsagePercent(windows, now)).toBe(40);
    expect(line.title).toContain("Claude 5h has reset since the last reading");
  });

  it("a reading with no reset time is stale once its window's length has passed", () => {
    const now = Date.UTC(2026, 9, 10, 12, 0);
    const hour = 3_600_000;
    expect(isStale(window({ resetsAt: null, seenAtMs: now - 6 * hour }), now)).toBe(true);
    expect(isStale(window({ resetsAt: null, seenAtMs: now - 4 * hour }), now)).toBe(false);
    const week = window({ rateLimitType: "seven_day", label: "7d", resetsAt: null });
    expect(isStale({ ...week, seenAtMs: now - 6 * hour }, now)).toBe(false);
    expect(isStale({ ...week, seenAtMs: now - 8 * 24 * hour }, now)).toBe(true);
  });

  it("usage is the highest window still current; stale or missing is unknown, not 0", () => {
    const now = Date.UTC(2026, 9, 10, 12, 0);
    const later = Date.UTC(2026, 9, 10, 15, 0) / 1000;
    const earlier = Date.UTC(2026, 9, 10, 9, 0) / 1000;
    expect(knownUsagePercent([], now)).toBeNull();
    expect(knownUsagePercent([window({ utilization: null, resetsAt: later })], now)).toBeNull();
    // Reset since the reading: its 95% no longer applies.
    expect(knownUsagePercent([window({ utilization: 95, resetsAt: earlier })], now)).toBeNull();
    expect(
      knownUsagePercent(
        [
          window({ utilization: 95, resetsAt: earlier }),
          window({ rateLimitType: "seven_day", label: "7d", utilization: 40.4, resetsAt: later }),
        ],
        now,
      ),
    ).toBe(40);
    expect(knownUsagePercent([window({ utilization: 0, resetsAt: later })], now)).toBe(0);
  });

  it("the overview says what autopilot does with usage, known or not", () => {
    const now = Date.UTC(2026, 9, 10, 12, 0);
    const later = Date.UTC(2026, 9, 10, 15, 0) / 1000;
    const unknown = autopilotUsageLine([], 90, now);
    expect(unknown.known).toBe(false);
    expect(unknown.text).toBe(
      "Claude usage: unknown. Autopilot keeps going, and stops if Claude reports a usage limit.",
    );
    const known = autopilotUsageLine([window({ utilization: 42, resetsAt: later })], 90, now);
    expect(known).toEqual({ known: true, text: "Claude usage: 42% (autopilot pauses at 90%)." });
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
