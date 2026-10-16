// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listeners: ((event: { chainId: string }) => void)[] = [];
vi.mock("../bridge", () => ({
  getPipelineRun: vi.fn(),
  listenChainRunUpdated: vi.fn(async (handler: (event: { chainId: string }) => void) => {
    listeners.push(handler);
    return () => {
      listeners.splice(listeners.indexOf(handler), 1);
    };
  }),
}));

import { getPipelineRun, type PipelineRun } from "../bridge";
import { PlanPane, PlanPaneToggle } from "./PlanPane";
import { planPaneOpen, resetPlanPaneState } from "./planPaneState";

function view(patch: Partial<PipelineRun>) {
  return {
    run: {
      id: "ee_1",
      kind: "eagle1",
      cwd: "/repo",
      stage: "implementer",
      overviewTabId: "",
      tabIds: {},
      createdAt: "2026-10-16T09:00:00Z",
      ...patch,
    },
  };
}

describe("PlanPane", () => {
  beforeEach(() => {
    listeners.length = 0;
    vi.mocked(getPipelineRun).mockReset();
    resetPlanPaneState();
  });

  it("shows the candidate, then the approved plan once the run changes, with a live badge", async () => {
    vi.mocked(getPipelineRun).mockResolvedValueOnce(view({ candidatePlan: "# Draft plan" }));
    render(<PlanPane tabId="t1" runId="ee_1" />);
    expect(await screen.findByRole("heading", { name: "Draft plan" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Plan · candidate" })).toBeTruthy();
    await waitFor(() => expect(screen.getByText("LIVE")).toBeTruthy());

    vi.mocked(getPipelineRun).mockResolvedValueOnce(
      view({
        approvedPlan: "# Final plan",
        updatedAt: "2026-10-16T10:00:00Z",
        events: [{ at: "2026-10-16T10:00:00Z", kind: "note", round: 2, summary: "", outcome: "planApproved" }],
      }),
    );
    // Another run's change is ignored; this run's refetches.
    act(() => listeners.forEach((listener) => listener({ chainId: "other" })));
    act(() => listeners.forEach((listener) => listener({ chainId: "ee_1" })));
    expect(await screen.findByRole("heading", { name: "Final plan" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Plan · approved in round 2" })).toBeTruthy();
    expect(screen.getByText(/^Updated /)).toBeTruthy();
    expect(getPipelineRun).toHaveBeenCalledTimes(2);
  });

  it("switches between rendered and source", async () => {
    vi.mocked(getPipelineRun).mockResolvedValue(view({ approvedPlan: "# Steps\n\n- one" }));
    render(<PlanPane tabId="t1" runId="ee_1" />);
    await screen.findByRole("heading", { name: "Steps" });
    fireEvent.click(screen.getByRole("radio", { name: "Source" }));
    expect(screen.queryByRole("heading", { name: "Steps" })).toBeNull();
    expect(document.querySelector(".plan-pane-source")!.textContent).toContain("# Steps");
  });

  it("says when the run has no plan yet, and closes from its header", async () => {
    vi.mocked(getPipelineRun).mockResolvedValue(view({}));
    render(
      <>
        <PlanPaneToggle tabId="t1" />
        <PlanPane tabId="t1" runId="ee_1" />
      </>,
    );
    expect(await screen.findByText(/No plan yet/)).toBeTruthy();
    const toggle = screen.getByRole("button", { name: "Plan" });
    fireEvent.click(toggle);
    expect(planPaneOpen("t1")).toBe(true);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Close plan pane" }));
    expect(planPaneOpen("t1")).toBe(false);
  });

  it("shows a load error", async () => {
    vi.mocked(getPipelineRun).mockRejectedValue(new Error("unknown pipeline run: ee_1"));
    render(<PlanPane tabId="t1" runId="ee_1" />);
    expect(await screen.findByText("unknown pipeline run: ee_1")).toBeTruthy();
  });
});
