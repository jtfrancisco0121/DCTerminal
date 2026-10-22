import { describe, expect, it } from "vitest";
import type { ClickUpIntakePreview } from "../bridge";
import {
  EMPTY_INTAKE,
  fetchKey,
  filtersOf,
  intakeStart,
  isCurrent,
  parsedDraft,
  previewSummary,
  tickedTickets,
  togglePriority,
  toggleTicket,
  type IntakeDraft,
} from "./intakeModel";

const preview: ClickUpIntakePreview = {
  parents: [{ kind: "task", id: "7xk2epic01", title: "QA 1.2.8", url: "https://app.clickup.com/t/7xk2epic01", tickets: 3 }],
  tickets: [
    { id: "86b1aa001", customId: "QA-129", title: "Sync stalls", priority: "high", status: "to do", statusType: "open", url: "u1" },
    { id: "86b1aa002", title: "Duplicate log lines", priority: "normal", status: "qa failed", statusType: "custom", url: "u2" },
  ],
  excluded: [
    { id: "86b1aa003", title: "Lock files", priority: "none", status: "closed", statusType: "closed", url: "u3", reason: "Status is \"closed\" (closed)" },
  ],
  problems: [],
};

function fetched(text: string, extra: Partial<IntakeDraft> = {}): IntakeDraft {
  const draft = { ...EMPTY_INTAKE, text, ...extra };
  return { ...draft, fetched: { key: parsedDraft(draft).key, preview } };
}

describe("intake model (C2)", () => {
  it("does nothing on Start with an empty box", () => {
    expect(intakeStart(EMPTY_INTAKE)).toEqual({ kind: "none" });
    expect(intakeStart({ ...EMPTY_INTAKE, text: "\n  \n" })).toEqual({ kind: "none" });
  });

  it("asks for a Fetch first, and again when the links or filters changed", () => {
    expect(intakeStart({ ...EMPTY_INTAKE, text: "86b1aa001" })).toEqual({
      kind: "blocked",
      message: "Press Fetch to read the ClickUp tickets, then Start.",
    });
    const draft = fetched("https://app.clickup.com/t/7xk2epic01");
    expect(isCurrent(draft)).toBe(true);
    expect(isCurrent({ ...draft, text: `${draft.text}\n86b1aa009` })).toBe(false);
    const filtered = togglePriority(draft, "high", true);
    expect(intakeStart(filtered)).toEqual({
      kind: "blocked",
      message: "The ClickUp links or filters changed since Fetch. Press Fetch again, then Start.",
    });
    expect(intakeStart({ ...EMPTY_INTAKE, text: "not a link" })).toEqual({
      kind: "blocked",
      message: "Line 1 is not a ClickUp task or list link.",
    });
  });

  it("starts with the ticked tickets only, and never with none", () => {
    const draft = toggleTicket(fetched("https://app.clickup.com/t/7xk2epic01"), "86b1aa002", false);
    expect(tickedTickets(draft).map((t) => t.id)).toEqual(["86b1aa001"]);
    expect(previewSummary(draft)).toBe("1 of 2 tickets ticked · 1 excluded");
    expect(intakeStart(draft)).toEqual({
      kind: "ready",
      refs: [{ kind: "task", id: "7xk2epic01", line: 1 }],
      filters: { priorities: [] },
      ticketIds: ["86b1aa001"],
    });
    const none = toggleTicket(draft, "86b1aa001", false);
    expect(intakeStart(none)).toEqual({ kind: "blocked", message: "Tick at least one ticket, or clear the ClickUp box." });
    expect(tickedTickets(toggleTicket(none, "86b1aa002", true)).map((t) => t.id)).toEqual(["86b1aa002"]);
  });

  it("keeps the priority filter in ClickUp's order whatever order you ticked it in", () => {
    const draft = togglePriority(togglePriority(EMPTY_INTAKE, "low", true), "urgent", true);
    expect(filtersOf(draft)).toEqual({ priorities: ["urgent", "low"] });
    expect(filtersOf(togglePriority(draft, "low", false))).toEqual({ priorities: ["urgent"] });
    expect(fetchKey([], { priorities: ["urgent"] })).not.toBe(fetchKey([], { priorities: [] }));
  });
});
