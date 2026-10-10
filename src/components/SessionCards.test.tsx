// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SessionCards } from "./SessionCards";
import { emptySessionCards } from "../sessionCards";

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
    expect(screen.getByText("1. Add the picker")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accept plan" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next: Send to Plan Reviewer" }));
    expect(onSend).toHaveBeenCalledWith("role_plan_reviewer");
    fireEvent.click(screen.getByRole("button", { name: "Keep planning" }));
    expect(onReject).toHaveBeenCalledOnce();
  });
});
