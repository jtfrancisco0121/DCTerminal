// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QuestionCard } from "./QuestionCard";

const request = {
  tabId: "t1",
  sessionId: "s1",
  jsonRpcId: 3,
  title: "Pick one",
  prompt: "Which approach?",
  choices: [
    { id: "a", label: "Option A" },
    { id: "b", label: "Option B" },
  ],
};

describe("QuestionCard", () => {
  it("answers, skips, or cancels", () => {
    const onAnswer = vi.fn();
    const onSkip = vi.fn();
    const onCancel = vi.fn();
    render(
      <QuestionCard
        request={request}
        busy={false}
        onAnswer={onAnswer}
        onSkip={onSkip}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Option A" }));
    expect(onAnswer).toHaveBeenCalledWith("a");
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(onSkip).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalled();
  });
});
