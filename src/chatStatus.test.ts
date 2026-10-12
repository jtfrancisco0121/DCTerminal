import { describe, expect, it } from "vitest";
import { chatSessionStatus, humanizeStatus, stopReasonText } from "./chatStatus";

const base = {
  activity: null,
  waitingPermission: false,
  promptError: null,
  agentExited: false,
  accepting: false,
  hasSession: true,
};

describe("chatSessionStatus", () => {
  it("is Ready when idle", () => {
    expect(chatSessionStatus(base)).toEqual({ tone: "ok", text: "Ready" });
  });
  it("shows a failed turn as an error, not Ready", () => {
    expect(chatSessionStatus({ ...base, promptError: "boom" })).toEqual({
      tone: "error",
      text: "Last turn failed",
    });
  });
  it("shows an exited agent as an error", () => {
    expect(chatSessionStatus({ ...base, agentExited: true, promptError: "x" }).text).toBe("Agent exited");
  });
  it("shows Starting while the session is coming up", () => {
    expect(chatSessionStatus({ ...base, hasSession: false, accepting: true })).toEqual({
      tone: "busy",
      text: "Starting…",
    });
  });
  it("activity wins, and a permission wait needs the user", () => {
    expect(chatSessionStatus({ ...base, activity: "Waiting", waitingPermission: true }).tone).toBe("needs");
    expect(chatSessionStatus({ ...base, activity: "Working" }).tone).toBe("busy");
  });
});

describe("stopReasonText", () => {
  it("never shows the raw value", () => {
    expect(stopReasonText("end_turn")).toBe("Last turn finished");
    expect(stopReasonText("max_tokens")).toContain("length limit");
    expect(stopReasonText(null)).toBe("Last turn finished");
    expect(stopReasonText("odd_reason")).toBe("Last turn ended (odd reason)");
  });
});

describe("humanizeStatus", () => {
  it("reads naturally", () => {
    expect(humanizeStatus("in_progress")).toBe("In progress");
    expect(humanizeStatus("completed")).toBe("Completed");
  });
});
