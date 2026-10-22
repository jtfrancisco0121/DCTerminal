// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../bridge", () => ({
  pipelineRunRound: vi.fn(async () => null),
  // R2: the round runner under the summary.
  roundGet: vi.fn(async () => null),
  roundAction: vi.fn(),
  pipelineActorMessage: vi.fn(),
  listenChainRunUpdated: vi.fn(async () => () => {}),
}));

import { pipelineRunRound } from "../bridge";
import { exampleRound } from "../pipeline/roundFixture";
import { RoundSummary } from "./RoundSummary";

describe("RoundSummary (R1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the plans with tickets, repos, wave and status, the reasons, the merge order and round.md", async () => {
    vi.mocked(pipelineRunRound).mockResolvedValue({
      round: exampleRound(),
      markdown: "# QA round\n\n## 1. Summary\nEight plans.",
      markdownPath: "/data/runs/ee_round/round.md",
    });
    render(<RoundSummary runId="ee_round" refreshKey="a" />);
    const table = await screen.findByRole("table", { name: "Round plans" });
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(9);
    const deferred = rows.find((row) => row.textContent?.includes("plan8"))!;
    expect(deferred.textContent).toContain("deferred");
    expect(deferred.textContent).toContain("The fix is in the gateway, not our repos.");
    const four = rows.find((row) => row.textContent?.includes("plan4"))!;
    expect(four.textContent).toContain("backend, desktop, web");
    expect(four.textContent).toContain("Wave 2");
    expect(screen.getByText("8 plans (6 active, 1 parked, 1 deferred) · 4 waves · 9 tickets · 1 excluded")).toBeTruthy();
    const order = screen.getByRole("list", { name: "Merge order" });
    expect(order.textContent).toContain("backend: plan1 → plan2 → plan4 → plan3");
    expect(screen.getByRole("list", { name: "Excluded tickets" }).textContent).toContain("QA-99");
    expect(screen.getByText("Round document (round.md)")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "QA round" })).toBeTruthy();
    expect(pipelineRunRound).toHaveBeenCalledWith("ee_round");
  });

  it("renders nothing for a run with no round", async () => {
    const { container } = render(<RoundSummary runId="ee_plain" refreshKey="a" />);
    await vi.waitFor(() => expect(pipelineRunRound).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("says when the round could not be read", async () => {
    vi.mocked(pipelineRunRound).mockRejectedValue(new Error("bad json"));
    render(<RoundSummary runId="ee_round" refreshKey="a" />);
    expect(await screen.findByText(/Could not read the round: bad json/)).toBeTruthy();
  });
});
