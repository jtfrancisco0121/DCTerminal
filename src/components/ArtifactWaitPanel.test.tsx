// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactWait, PipelineRun } from "../bridge";

vi.mock("../bridge", () => ({
  pipelineActorMessage: vi.fn(async () => ({ tabId: "tab_analyst" })),
}));

import { pipelineActorMessage } from "../bridge";
import { ArtifactWaitPanel } from "./ArtifactWaitPanel";
import {
  MAX_ARTIFACT_ANSWER_CHARS,
  artifactAnswerAction,
  artifactAnswerProblem,
  artifactWaitKey,
  pendingArtifactWait,
} from "../pipeline/artifacts";
import { resendableStory } from "../pipeline/stories";

const PARTIAL: ArtifactWait = {
  stageId: "analyst",
  stageTitle: "Analyst",
  status: "partial",
  questions: ["Is offline use in scope?", "Who signs off?"],
  artifacts: ["brief.md"],
  turn: "tab_analyst|bridge|t1",
  at: "2026-10-22T10:00:00Z",
};

function waitingRun(wait: ArtifactWait | null = PARTIAL): PipelineRun {
  return {
    id: "ee_f",
    kind: "eagle-eye-l",
    cwd: "/repo",
    stage: "analyst",
    overviewTabId: "",
    tabIds: {},
    createdAt: "2026-10-22T00:00:00Z",
    engine: 2,
    status: "waiting",
    stopReason: "checkpoint",
    autopilot: { enabled: true, waiting: "Analyst has open questions.", artifactWait: wait },
  };
}

describe("artifact waits (F1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is pending only while the run waits with checkpoint", () => {
    expect(pendingArtifactWait(waitingRun())).toEqual(PARTIAL);
    expect(artifactWaitKey(waitingRun())).toBe("analyst@2026-10-22T10:00:00Z");
    expect(pendingArtifactWait({ ...waitingRun(), status: "stopped", stopReason: "paused_by_you" })).toBeNull();
    expect(pendingArtifactWait(waitingRun(null))).toBeNull();
    expect(artifactWaitKey(waitingRun(null))).toBe("");
  });

  it("needs answers to open questions but lets a blocked stage go on with no note", () => {
    expect(artifactAnswerProblem(PARTIAL, "  ")).toContain("Write your answers to Analyst's questions");
    expect(artifactAnswerProblem(PARTIAL, "x".repeat(MAX_ARTIFACT_ANSWER_CHARS + 1))).toContain("longer than");
    expect(artifactAnswerProblem(PARTIAL, "Out of scope.")).toBeNull();
    const blocked: ArtifactWait = { ...PARTIAL, status: "blocked", questions: [], reason: "The wiki is down." };
    expect(artifactAnswerProblem(blocked, "")).toBeNull();
    expect(artifactAnswerAction(blocked, "  ")).toEqual({ kind: "artifactAnswer", stageId: "analyst", answer: null });
    expect(artifactAnswerAction(PARTIAL, " Out. ")).toEqual({ kind: "artifactAnswer", stageId: "analyst", answer: "Out." });
  });

  it("offers no Resend story while the run waits on a document", () => {
    const run = waitingRun();
    run.stories = [{ lane: null, id: "s1", title: "One", status: "failed" }];
    expect(resendableStory(run, null)).toBeNull();
  });

  it("shows the questions and Answer sends your answers to the run actor", async () => {
    const onDone = vi.fn();
    render(<ArtifactWaitPanel run={waitingRun()} onDone={onDone} onNotice={vi.fn()} />);
    const panel = screen.getByRole("region", { name: "Document questions" });
    expect(panel.textContent).toContain("Analyst has questions");
    expect(panel.textContent).toContain("brief.md");
    expect(within(panel).getAllByRole("listitem").map((item) => item.textContent)).toEqual(PARTIAL.questions);
    const button = within(panel).getByRole("button", { name: "Answer" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(panel).getByRole("textbox"), { target: { value: "1. No. 2. JT." } });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(pipelineActorMessage).toHaveBeenCalledWith("ee_f", { kind: "artifactAnswer", stageId: "analyst", answer: "1. No. 2. JT." });
  });

  it("shows a blocked stage's reason with Continue", async () => {
    const blocked: ArtifactWait = { ...PARTIAL, status: "blocked", questions: [], reason: "The wiki is down." };
    const onNotice = vi.fn();
    vi.mocked(pipelineActorMessage).mockRejectedValueOnce(new Error("Autopilot is off for this run."));
    render(<ArtifactWaitPanel run={waitingRun(blocked)} onDone={vi.fn()} onNotice={onNotice} />);
    const panel = screen.getByRole("region", { name: "Document questions" });
    expect(panel.textContent).toContain("Analyst is blocked");
    expect(panel.textContent).toContain("The wiki is down.");
    fireEvent.click(within(panel).getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Not continued", expect.stringContaining("Autopilot is off")));
  });

  it("renders nothing when the run waits on no document", () => {
    const { container } = render(<ArtifactWaitPanel run={waitingRun(null)} onDone={vi.fn()} onNotice={vi.fn()} />);
    expect(container.textContent).toBe("");
  });
});
