import { describe, expect, it } from "vitest";
import { formatElapsed, headerPillText, headerStateOf } from "./headerState";

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
    ).toBe("Needs you");
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

  it("counts up while working", () => {
    expect(formatElapsed(12)).toBe("12s");
    expect(formatElapsed(65)).toBe("1m 05s");
    expect(formatElapsed(3720)).toBe("1h 02m");
    expect(headerPillText({ tone: "working", text: "Working", timed: true }, 12)).toBe("Working · 12s");
    expect(headerPillText({ tone: "done", text: "Done", timed: false }, 12)).toBe("Done");
  });
});
