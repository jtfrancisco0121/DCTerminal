// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PipelineRun } from "../bridge";

vi.mock("../bridge", () => ({
  pipelineActorMessage: vi.fn(async () => ({ tabId: "tab_impl" })),
}));

import { pipelineActorMessage } from "../bridge";
import { VerifyWaitPanel } from "./VerifyWaitPanel";

const STEPS = "Run the qa128-ml Playwright project on the Windows staging build.";

function waitingRun(extra: Partial<PipelineRun> = {}): PipelineRun {
  return {
    id: "ee_v",
    kind: "full",
    cwd: "/repo",
    stage: "implementer",
    overviewTabId: "",
    tabIds: {},
    createdAt: "2026-10-22T00:00:00Z",
    engine: 2,
    status: "waiting",
    stopReason: "checkpoint",
    lanes: [{ id: "pr1", title: "PR1 — API", status: "active", stage: "implementer", round: 1, tabIds: {}, repo: "backend" }],
    autopilot: {
      enabled: true,
      waiting: "PR1 — API: Implementer passed its checks, and backend verify waits for you.",
      verify: {
        stageId: "implementer",
        lane: "pr1",
        label: "backend verify",
        steps: STEPS,
        turn: "tab_impl|bridge|t1",
        prs: ["https://github.com/acme/backend/pull/1"],
        at: "2026-10-22T10:00:00Z",
      },
    },
    ...extra,
  };
}

describe("VerifyWaitPanel (L2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the steps, the lane and its pull request, and Mark verified answers the run actor", async () => {
    const onDone = vi.fn();
    const onNotice = vi.fn();
    render(<VerifyWaitPanel run={waitingRun()} onDone={onDone} onNotice={onNotice} />);
    const panel = screen.getByRole("region", { name: "Verification" });
    expect(panel.textContent).toContain("backend verify");
    expect(panel.textContent).toContain("PR1 — API · backend");
    expect(panel.textContent).toContain(STEPS);
    expect(within(screen.getByRole("list", { name: "Pull requests to verify" })).getByText("https://github.com/acme/backend/pull/1")).toBeTruthy();

    fireEvent.click(within(panel).getByRole("button", { name: "Mark verified" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(pipelineActorMessage).toHaveBeenCalledWith("ee_v", {
      kind: "verify",
      stageId: "implementer",
      lane: "pr1",
      verified: true,
      note: null,
    });
    expect(onNotice).not.toHaveBeenCalled();
  });

  it("Failed asks what failed and sends the note back", async () => {
    const onDone = vi.fn();
    render(<VerifyWaitPanel run={waitingRun()} onDone={onDone} onNotice={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Failed" }));
    fireEvent.click(screen.getByRole("button", { name: "Send back" }));
    expect(screen.getByText("Say what failed: the note goes back to the stage.")).toBeTruthy();
    expect(pipelineActorMessage).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("What failed"), {
      target: { value: "  The session list stays empty after sign-in.  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send back" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(pipelineActorMessage).toHaveBeenCalledWith("ee_v", {
      kind: "verify",
      stageId: "implementer",
      lane: "pr1",
      verified: false,
      note: "The session list stays empty after sign-in.",
    });
  });

  it("Cancel closes the note box without sending, and a refused answer says why", async () => {
    vi.mocked(pipelineActorMessage).mockRejectedValueOnce(new Error("The run is not waiting on that verification any more."));
    const onDone = vi.fn();
    const onNotice = vi.fn();
    render(<VerifyWaitPanel run={waitingRun()} onDone={onDone} onNotice={onNotice} />);
    fireEvent.click(screen.getByRole("button", { name: "Failed" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("What failed")).toBeNull();
    expect(pipelineActorMessage).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Mark verified" }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Not marked verified", "The run is not waiting on that verification any more."));
    expect(onDone).toHaveBeenCalled();
  });

  it("renders nothing unless the run waits on a verify gate", () => {
    const { container, rerender } = render(
      <VerifyWaitPanel run={waitingRun({ stopReason: "stalled" })} onDone={vi.fn()} onNotice={vi.fn()} />,
    );
    expect(container.textContent).toBe("");
    rerender(<VerifyWaitPanel run={waitingRun({ autopilot: { enabled: true } })} onDone={vi.fn()} onNotice={vi.fn()} />);
    expect(container.textContent).toBe("");
  });
});
