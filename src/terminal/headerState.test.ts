import { describe, expect, it } from "vitest";
import { formatElapsed, headerPillText, headerStateOf, headerWorking, trackWorkingSince } from "./headerState";

describe("headerStateOf", () => {
  it("reads exited, needs you, working, done and idle from the terminal state", () => {
    const base = { turnEnded: false };
    expect(headerStateOf({ ...base, state: { kind: "exited", code: 2 } })).toMatchObject({
      tone: "exited",
      text: "Exited · code 2",
    });
    expect(
      headerStateOf({
        ...base,
        state: { kind: "needs", needs: "plan", toolId: "t", toolTitle: "Plan" },
      }).text,
    ).toBe("Needs you: plan to review");
    expect(headerStateOf({ ...base, state: { kind: "working" } })).toMatchObject({
      tone: "working",
      timed: true,
    });
    expect(headerStateOf({ turnEnded: true, state: { kind: "idle" }, verdict: "APPROVED" }).text).toBe(
      "Done · APPROVED",
    );
    expect(headerStateOf({ turnEnded: true, state: { kind: "idle" } }).text).toBe("Done");
    expect(headerStateOf({ ...base, state: { kind: "idle" } }).tone).toBe("idle");
  });

  it("falls back to the chip status for terminals without a derived state", () => {
    const status = { busy: true, unseen: false, needsYou: null };
    expect(headerStateOf({ turnEnded: false, status }).tone).toBe("working");
    expect(headerStateOf({ turnEnded: false, status: { ...status, busy: false, needsYou: "permission" } }).tone).toBe(
      "needs",
    );
    expect(headerStateOf({ turnEnded: false, status: { ...status, busy: false, exitCode: 0 } }).text).toBe(
      "Exited · code 0",
    );
  });

  it("says to check the terminal when a working turn's state is unknown", () => {
    const state = headerStateOf({ turnEnded: false, state: { kind: "working", unknown: true } });
    expect(state).toEqual({ tone: "unknown", text: "State unknown · check the terminal", timed: false });
  });

  it("counts an unknown turn as working for Stop and the composer's Queue", () => {
    const unknown = headerStateOf({ turnEnded: false, state: { kind: "working", unknown: true } });
    expect(headerWorking(unknown)).toBe(true);
    expect(headerWorking(headerStateOf({ turnEnded: false, state: { kind: "working" } }))).toBe(true);
    expect(headerWorking(headerStateOf({ turnEnded: true, state: { kind: "idle" } }))).toBe(false);
  });

  it("counts up while working", () => {
    expect(formatElapsed(12)).toBe("12s");
    expect(formatElapsed(65)).toBe("1m 05s");
    expect(formatElapsed(3720)).toBe("1h 02m");
    expect(headerPillText({ tone: "working", text: "Working", timed: true }, 12)).toBe("Working · 12s");
    expect(headerPillText({ tone: "done", text: "Done", timed: false }, 12)).toBe("Done");
  });
});

describe("trackWorkingSince", () => {
  it("keeps each tab's start, prefers the log's prompt time, and drops tabs that stopped", () => {
    let map = trackWorkingSince({}, [{ tabId: "a", working: true }], 1000);
    expect(map).toEqual({ a: 1000 });
    const same = trackWorkingSince(map, [{ tabId: "a", working: true }], 5000);
    expect(same).toBe(map);
    map = trackWorkingSince(
      map,
      [
        { tabId: "a", working: true },
        { tabId: "b", working: true, turnStartedAt: 400 },
        { tabId: "c", working: false },
      ],
      6000,
    );
    expect(map).toEqual({ a: 1000, b: 400 });
    // A prompt time from the future (clock skew) is capped at now.
    expect(trackWorkingSince({}, [{ tabId: "d", working: true, turnStartedAt: 9000 }], 7000)).toEqual({
      d: 7000,
    });
    // NaN from an unparsable time falls back to the first time seen.
    expect(trackWorkingSince({}, [{ tabId: "e", working: true, turnStartedAt: NaN }], 7000)).toEqual({
      e: 7000,
    });
    // Stopping and starting again restarts the count.
    map = trackWorkingSince(map, [{ tabId: "a", working: false }], 8000);
    expect(map).toEqual({});
    expect(trackWorkingSince(map, [{ tabId: "a", working: true }], 9000)).toEqual({ a: 9000 });
  });
});
