// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PipelineRun } from "../bridge";

vi.mock("../bridge", () => ({
  pipelineActorMessage: vi.fn(async () => ({ tabId: "tab_impl" })),
}));

import { pipelineActorMessage } from "../bridge";
import { StoryCheckpointPanel } from "./StoryCheckpointPanel";
import { StoryList } from "./StoryList";

const CHECKPOINT = "Rerun the 7,839-file case on Windows and read the log";

function waitingRun(lane: string | null = "pr1"): PipelineRun {
  return {
    id: "ee_s",
    kind: "full",
    cwd: "/repo",
    stage: "implementer",
    overviewTabId: "",
    tabIds: {},
    createdAt: "2026-10-22T00:00:00Z",
    engine: 2,
    status: "waiting",
    stopReason: "checkpoint",
    lanes: lane
      ? [{ id: lane, title: "PR1 — Engine fixes", status: "active", stage: "implementer", round: 1, tabIds: {}, repo: "engine" }]
      : [],
    stories: [
      { lane, id: "s1", title: "R5 instrumentation", tickets: ["86c0r5"], checkpoint: CHECKPOINT, status: "waiting" },
      { lane, id: "s2", title: "T14-4 log dedupe", status: "pending" },
      { lane, id: "s3", title: "T14-2 lock-file filter", status: "pending" },
      { lane, id: "s4", title: "T14-1 folder name", status: "pending", added: true },
    ],
    autopilot: {
      enabled: true,
      waiting: "PR1 — Engine fixes: story s1 (1 of 4) passed its checks, and its checkpoint waits for you.",
      storyWait: { stageId: "implementer", lane, story: "s1", checkpoint: CHECKPOINT, turn: "tab_impl|bridge|t1", at: "2026-10-22T10:00:00Z" },
    },
  };
}

describe("StoryCheckpointPanel (L3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the story's checkpoint and Continue sends your note and added stories to the run actor", async () => {
    const onDone = vi.fn();
    const onNotice = vi.fn();
    render(<StoryCheckpointPanel run={waitingRun()} onDone={onDone} onNotice={onNotice} />);
    const panel = screen.getByRole("region", { name: "Story checkpoint" });
    expect(panel.textContent).toContain("Checkpoint after story s1 (1 of 4): R5 instrumentation");
    expect(panel.textContent).toContain("PR1 — Engine fixes · engine");
    expect(panel.textContent).toContain(CHECKPOINT);
    const button = within(panel).getByRole("button", { name: "Continue" });
    expect(button.getAttribute("title")).toBe('Send "T14-4 log dedupe" to the Implementer, with your note.');

    fireEvent.change(screen.getByLabelText("Your note for the next story"), {
      target: { value: "JT's finding from the Windows rerun: the walk stalls 40 s." },
    });
    fireEvent.change(screen.getByLabelText("Add stories after this one (optional, one per line)"), {
      target: { value: "Skip the lock file before the walk\n" },
    });
    expect(button.getAttribute("title")).toBe('Send "Skip the lock file before the walk" to the Implementer, with your note.');
    fireEvent.click(button);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(pipelineActorMessage).toHaveBeenCalledWith("ee_s", {
      kind: "storyContinue",
      lane: "pr1",
      story: "s1",
      note: "JT's finding from the Windows rerun: the walk stalls 40 s.",
      add: "Skip the lock file before the walk",
    });
    expect(onNotice).not.toHaveBeenCalled();
  });

  it("names a refused Continue and renders nothing when the run waits on no checkpoint story", async () => {
    vi.mocked(pipelineActorMessage).mockRejectedValueOnce(new Error("The run is not waiting on that story's checkpoint any more."));
    const onNotice = vi.fn();
    const { unmount } = render(<StoryCheckpointPanel run={waitingRun(null)} onDone={vi.fn()} onNotice={onNotice} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Next story not sent", expect.stringContaining("not waiting")));
    expect(pipelineActorMessage).toHaveBeenCalledWith("ee_s", { kind: "storyContinue", lane: null, story: "s1", note: null, add: null });
    unmount();
    const running = { ...waitingRun(), status: "running" as const, stopReason: null };
    const { container } = render(<StoryCheckpointPanel run={running} onDone={vi.fn()} onNotice={vi.fn()} />);
    expect(container.innerHTML).toBe("");
  });

  it("a note too long keeps Continue off", () => {
    render(<StoryCheckpointPanel run={waitingRun()} onDone={vi.fn()} onNotice={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Your note for the next story"), { target: { value: "x".repeat(4001) } });
    expect(screen.getByText("The note is longer than 4000 characters.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("StoryList (L3)", () => {
  it("lists each story compactly with its tickets and where it stands", () => {
    render(<StoryList run={waitingRun()} lane="pr1" label="Stories of PR1 — Engine fixes" />);
    const items = within(screen.getByRole("list", { name: "Stories of PR1 — Engine fixes" })).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "s1 R5 instrumentation · 86c0r5 · waiting on you",
      "s2 T14-4 log dedupe · pending",
      "s3 T14-2 lock-file filter · pending",
      "s4 T14-1 folder name · pending · added by you",
    ]);
  });

  it("renders nothing for a pull request not built in stories", () => {
    const { container } = render(<StoryList run={waitingRun()} lane="pr2" label="Stories of PR2" />);
    expect(container.innerHTML).toBe("");
  });
});
