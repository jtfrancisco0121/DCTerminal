// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SessionCards } from "./SessionCards";
import { emptySessionCards, lastAgentSegmentId } from "../sessionCards";
import type { HandoffTargetId } from "../handoff/map";

describe("Claude plan card", () => {
  it("offers hand-off and Keep planning, never Accept", () => {
    const onReject = vi.fn();
    const onSend = vi.fn();
    render(
      <SessionCards
        cards={emptySessionCards()}
        segments={[]}
        planRequest={{
          jsonRpcId: 3,
          title: "Ready to code?",
          entries: [],
          markdown: "1. Add the picker",
          keepOptionId: "reject",
        }}
        busy={false}
        onAcceptPlan={() => {}}
        onRejectPlan={onReject}
        handoff={{
          enabled: true,
          reason: null,
          targets: ["role_plan_reviewer", "role_implementer"],
          primaryTarget: "role_plan_reviewer",
          onSend,
        }}
      />,
    );
    expect(screen.getByText("Add the picker")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accept plan" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next: Send to Plan Reviewer" }));
    expect(onSend).toHaveBeenCalledWith("role_plan_reviewer");
    fireEvent.click(screen.getByRole("button", { name: "Keep planning" }));
    expect(onReject).toHaveBeenCalledOnce();
  });
});

describe("Hand-off card", () => {
  const handoff = () => ({
    enabled: true,
    reason: null,
    targets: ["role_implementer", "role_developer"] as HandoffTargetId[],
    primaryTarget: null,
    onSend: () => {},
  });

  it("shows the hand-off buttons before the chat has an agent message", () => {
    render(
      <SessionCards
        cards={emptySessionCards()}
        segments={[{ id: "u1", kind: "user", text: "plan it" }]}
        planRequest={null}
        busy={false}
        handoff={handoff()}
      />,
    );
    expect(screen.getByRole("heading", { name: "Hand-off" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send to Implementer" })).toBeTruthy();
  });

  it("drops the duplicate buttons once chat shows them under the last agent message", () => {
    const cards = emptySessionCards();
    cards.todos = [{ id: "t1", content: "Write the plan", status: "completed" }];
    const { container } = render(
      <SessionCards
        cards={cards}
        segments={[
          { id: "u1", kind: "user", text: "plan it" },
          { id: "a1", kind: "agent", text: "Here is the plan." },
        ]}
        planRequest={null}
        busy={false}
        handoff={handoff()}
      />,
    );
    expect(screen.queryByRole("heading", { name: "Hand-off" })).toBeNull();
    expect(screen.getByText("Write the plan")).toBeTruthy();
    expect(container.querySelector(".handoff-actions")).toBeNull();
  });

  it("renders nothing when the hand-off would be its only card", () => {
    const { container } = render(
      <SessionCards
        cards={emptySessionCards()}
        segments={[{ id: "a1", kind: "agent", text: "Done." }]}
        planRequest={null}
        busy={false}
        handoff={handoff()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});

describe("lastAgentSegmentId", () => {
  it("skips empty agent segments and later non-agent ones", () => {
    expect(
      lastAgentSegmentId([
        { id: "a1", kind: "agent", text: "hi" },
        { id: "a2", kind: "agent", text: "  " },
        { id: "t1", kind: "tool", text: "Read file" },
      ]),
    ).toBe("a1");
    expect(lastAgentSegmentId([{ id: "u1", kind: "user", text: "x" }])).toBeNull();
  });
});

describe("Session cards de-duplication and wording", () => {
  it("does not repeat running tools that the transcript already lists", () => {
    const { container } = render(
      <SessionCards
        cards={emptySessionCards()}
        segments={[{ id: "t1", kind: "tool", text: "Edit file", toolStatus: "in_progress" }]}
        planRequest={null}
        busy={false}
      />,
    );
    expect(container.textContent).not.toContain("Tool progress");
    expect(container.textContent).not.toContain("Edit file");
  });

  it("renders the plan as markdown and words statuses plainly", () => {
    render(
      <SessionCards
        cards={{ plan: [{ content: "Step", status: "in_progress" }], todos: [], tasks: [] }}
        segments={[]}
        planRequest={{ jsonRpcId: 1, title: "Plan", entries: [], markdown: "## Heading\n\n- one", keepOptionId: "k" }}
        busy={false}
      />,
    );
    expect(screen.getByRole("heading", { name: "Heading" })).toBeTruthy();
    expect(screen.getByText("In progress")).toBeTruthy();
    expect(screen.queryByText("in_progress")).toBeNull();
  });
});
