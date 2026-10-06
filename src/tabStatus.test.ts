import { describe, expect, it } from "vitest";
import { emptyRuntime } from "./liveTabs";
import type { PermissionRequestEvent } from "./bridge";
import {
  clearMarks,
  computeTabStatus,
  markAfterTurn,
  tabStatusLabel,
  type TabMark,
} from "./tabStatus";

const permission = { tabId: "a", sessionId: "s", jsonRpcId: 1 } as PermissionRequestEvent;

describe("markAfterTurn", () => {
  it("marks a finished turn on a tab the user is not watching", () => {
    expect(markAfterTurn({}, "a", "finished", false)).toEqual({ a: "finished" });
    expect(markAfterTurn({}, "a", "question", false)).toEqual({ a: "question" });
    expect(markAfterTurn({}, "a", "failed", false)).toEqual({ a: "error" });
  });

  it("leaves no mark when the user is watching", () => {
    const marks: Record<string, TabMark> = { a: "question" };
    expect(markAfterTurn(marks, "a", "finished", true)).toEqual({});
  });

  it("ignores a cancelled turn", () => {
    const marks: Record<string, TabMark> = { a: "finished" };
    expect(markAfterTurn(marks, "a", null, false)).toBe(marks);
  });
});

describe("clearMarks", () => {
  it("clears visible tabs and keeps the same object when nothing changes", () => {
    const marks: Record<string, TabMark> = { a: "finished", b: "error" };
    expect(clearMarks(marks, ["a", null])).toEqual({ b: "error" });
    expect(clearMarks(marks, ["zzz"])).toBe(marks);
  });
});

describe("computeTabStatus", () => {
  it("is idle with nothing going on", () => {
    expect(computeTabStatus({ planPending: false })).toEqual({
      busy: false,
      unseen: false,
      needsYou: null,
    });
  });

  it("is busy while a prompt is in flight or a terminal is streaming", () => {
    expect(
      computeTabStatus({ runtime: { ...emptyRuntime(), promptInFlight: true }, planPending: false })
        .busy,
    ).toBe(true);
    expect(computeTabStatus({ planPending: false, terminalBusy: true }).busy).toBe(true);
  });

  it("flags needs-you in priority order", () => {
    const rt = { ...emptyRuntime(), promptInFlight: true, permission };
    expect(computeTabStatus({ runtime: rt, planPending: true }).needsYou).toBe("permission");
    expect(computeTabStatus({ planPending: true, mark: "question" }).needsYou).toBe("plan");
    expect(computeTabStatus({ planPending: false, mark: "question" }).needsYou).toBe("question");
    expect(computeTabStatus({ planPending: false, mark: "error" }).needsYou).toBe("error");
    expect(
      computeTabStatus({ runtime: { ...emptyRuntime(), agentExited: true }, planPending: false })
        .needsYou,
    ).toBe("error");
  });

  it("shows the unseen dot only for a plain finished turn", () => {
    expect(computeTabStatus({ planPending: false, mark: "finished" }).unseen).toBe(true);
    expect(computeTabStatus({ planPending: false, mark: "question" }).unseen).toBe(false);
  });
});

describe("tabStatusLabel", () => {
  it("describes the most important state", () => {
    expect(tabStatusLabel({ busy: true, unseen: false, needsYou: "permission" })).toBe(
      "Needs you: permission request",
    );
    expect(tabStatusLabel({ busy: false, unseen: false, needsYou: "plan" })).toBe(
      "Needs you: plan to review",
    );
    expect(tabStatusLabel({ busy: false, unseen: false, needsYou: "question" })).toBe(
      "Needs you: agent asked a question",
    );
    expect(tabStatusLabel({ busy: false, unseen: false, needsYou: "error" })).toBe(
      "Needs you: stopped with an error",
    );
    expect(tabStatusLabel({ busy: true, unseen: true, needsYou: null })).toBe("Working");
    expect(tabStatusLabel({ busy: false, unseen: true, needsYou: null })).toBe(
      "Finished, not viewed yet",
    );
    expect(tabStatusLabel({ busy: false, unseen: false, needsYou: null })).toBe("");
  });
});
