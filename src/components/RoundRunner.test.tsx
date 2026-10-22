// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RoundView } from "../bridge";

vi.mock("../bridge", () => ({
  roundGet: vi.fn(async () => null),
  roundAction: vi.fn(),
  pipelineActorMessage: vi.fn(async () => ({ tabId: "tab_impl" })),
  listenChainRunUpdated: vi.fn(async () => () => {}),
}));

import { pipelineActorMessage, roundAction, roundGet } from "../bridge";
import { RoundRunner } from "./RoundRunner";

function running(): RoundView {
  return {
    round: {
      id: "round_1",
      triageRunId: "ee_triage",
      title: "QA 9.9",
      cwd: "/repo",
      pipeline: "eagle1",
      runsAtOnce: 2,
      commitUpToWave: 1,
      waves: 2,
      createdAt: "2026-10-22T10:00:00Z",
      plans: [],
    },
    plans: [
      { planId: "plan1", title: "Session expiry", wave: 1, state: "running", runId: "ee_p1", tickets: ["QA-1"], repos: ["backend"] },
      { planId: "plan2", title: "Banner", wave: 1, state: "stopped", runId: "ee_p2", note: "The check failed 3 times.", tickets: ["QA-2"], repos: ["web"] },
      {
        planId: "plan3",
        title: "Both",
        wave: 2,
        state: "ready",
        waiting: "Held: the round is committed up to wave 1.",
        tickets: ["QA-3"],
        repos: ["backend", "web"],
      },
      { planId: "plan4", title: "Parked one", wave: null, state: "parked", note: "Waits on a decision.", tickets: ["QA-4"], repos: ["web"] },
      { planId: "plan5", title: "Start failed", wave: 1, state: "stopped", note: "Could not start: the form is incomplete", tickets: ["QA-5"], repos: [] },
      { planId: "plan6", title: "Elsewhere", wave: null, state: "deferred", tickets: ["QA-6"], repos: ["cdn"] },
    ],
    checkpoints: [
      {
        planId: "plan1",
        runId: "ee_p1",
        stageTitle: "Implementer",
        sourceTabId: "tab_review",
        targetRoleId: "role_implementer",
        waiting: "Checkpoint before Implementer.",
      },
    ],
  };
}

describe("RoundRunner (R2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts an approved round with the pipeline, the cap and Commit up to wave you pick", async () => {
    vi.mocked(roundAction).mockResolvedValue(running());
    render(<RoundRunner triageRunId="ee_triage" runComplete waves={2} />);
    const start = await screen.findByRole("button", { name: "Start round" });
    expect((screen.getByLabelText("Pipeline for each plan") as HTMLSelectElement).value).toBe("eagle1");
    // The round's own pipeline is not offered for its plans.
    expect(within(screen.getByLabelText("Pipeline for each plan")).queryByText("QA round")).toBeNull();
    fireEvent.change(screen.getByLabelText("Runs at once"), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText("Commit up to wave"), { target: { value: "2" } });
    fireEvent.click(start);
    await waitFor(() =>
      expect(roundAction).toHaveBeenCalledWith({ kind: "start", triageRunId: "ee_triage", pipeline: "eagle1", runsAtOnce: 3, commitUpToWave: 2 }),
    );
    expect(await screen.findByRole("table", { name: "Plan runs" })).toBeTruthy();
  });

  it("asks you to approve the round before it can start", async () => {
    render(<RoundRunner triageRunId="ee_triage" runComplete={false} waves={2} />);
    expect(await screen.findByText(/Approve the round \(scope and wave order\) to start it/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start round" })).toBeNull();
  });

  it("shows each plan's state and why it waits, and raises Commit up to wave", async () => {
    vi.mocked(roundGet).mockResolvedValue(running());
    vi.mocked(roundAction).mockResolvedValue(running());
    const onOpenRun = vi.fn();
    render(<RoundRunner triageRunId="ee_triage" runComplete waves={2} onOpenRun={onOpenRun} />);
    const table = await screen.findByRole("table", { name: "Plan runs" });
    expect(screen.getByText("0 of 5 plans done · 1 running · 2 stopped · 1 ready · 1 parked · 1 deferred")).toBeTruthy();
    const row = (id: string) => within(table).getAllByRole("row").find((r) => r.textContent?.includes(id))!;
    expect(row("plan3").textContent).toContain("Held: the round is committed up to wave 1.");
    expect(row("plan2").textContent).toContain("The check failed 3 times.");
    // A stopped run is carried on in its own overview; only a start that failed is retried here.
    expect(within(row("plan2")).queryByRole("button", { name: "Retry" })).toBeNull();
    fireEvent.click(within(row("plan2")).getByRole("button", { name: "Open run" }));
    expect(onOpenRun).toHaveBeenCalledWith("ee_p2");
    fireEvent.click(within(row("plan5")).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(roundAction).toHaveBeenCalledWith({ kind: "retry", roundId: "round_1", planId: "plan5" }));
    expect(within(row("plan6")).queryAllByRole("button")).toHaveLength(0);
    fireEvent.change(screen.getAllByLabelText("Commit up to wave")[0], { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(roundAction).toHaveBeenCalledWith({ kind: "settings", roundId: "round_1", runsAtOnce: 2, commitUpToWave: 2 }),
    );
  });

  it("unparks a plan into the wave you pick", async () => {
    vi.mocked(roundGet).mockResolvedValue(running());
    vi.mocked(roundAction).mockResolvedValue(running());
    render(<RoundRunner triageRunId="ee_triage" runComplete waves={2} />);
    fireEvent.change(await screen.findByLabelText("Wave for plan4"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Unpark" }));
    await waitFor(() => expect(roundAction).toHaveBeenCalledWith({ kind: "unpark", roundId: "round_1", planId: "plan4", wave: 1 }));
  });

  it("approves a plan checkpoint with your Send to that run's actor", async () => {
    vi.mocked(roundGet).mockResolvedValue(running());
    render(<RoundRunner triageRunId="ee_triage" runComplete waves={2} />);
    const list = await screen.findByRole("region", { name: "Approve all checkpoints" });
    expect(list.textContent).toContain("plan1 waits before Implementer.");
    fireEvent.click(within(list).getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(pipelineActorMessage).toHaveBeenCalledWith("ee_p1", {
        kind: "send",
        sourceTabId: "tab_review",
        targetRoleId: "role_implementer",
      }),
    );
  });

  it("says why a button did nothing", async () => {
    vi.mocked(roundGet).mockResolvedValue(running());
    vi.mocked(roundAction).mockRejectedValue(new Error("Commit up to wave is 1 to 2."));
    render(<RoundRunner triageRunId="ee_triage" runComplete waves={2} />);
    await screen.findByRole("table", { name: "Plan runs" });
    fireEvent.change(screen.getByLabelText("Runs at once"), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(roundAction).toHaveBeenCalled());
    expect(await screen.findByText(/Commit up to wave is 1 to 2/)).toBeTruthy();
  });
});
