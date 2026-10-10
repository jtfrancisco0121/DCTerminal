// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const events = vi.hoisted(() => ({
  handler: null as ((event: { chainId: string }) => void) | null,
  unlisten: vi.fn(),
}));

vi.mock("../bridge", () => ({
  getPipelineRun: vi.fn(),
  listenChainRunUpdated: vi.fn(async (handler: (event: { chainId: string }) => void) => {
    events.handler = handler;
    return events.unlisten;
  }),
  pipelinePromotePlan: vi.fn(async () => {}),
  pipelineSetCandidatePlan: vi.fn(async () => {}),
}));
vi.mock("../pipeline/terminalText", () => ({ liveTerminalReader: null }));

import type { PipelineRun } from "../bridge";
import { getPipelineRun } from "../bridge";
import { OVERVIEW_FALLBACK_POLL_MS } from "../pipeline/overviewRefresh";
import { PipelineOverview } from "./PipelineOverview";

const run = (handoffs: PipelineRun["handoffs"] = {}): PipelineRun => ({
  id: "ee_1",
  kind: "full",
  cwd: "/p",
  stage: "planner",
  overviewTabId: "ov",
  tabIds: {},
  createdAt: "2026-10-10T00:00:00Z",
  chainId: "ee_1",
  handoffs,
});

const reader = { selection: () => "", tail: () => "", planFile: async () => "" };

function renderOverview() {
  return render(
    <PipelineOverview
      runId="ee_1"
      cwd="/p"
      tabs={[]}
      runtimes={{}}
      onJump={() => {}}
      onWatch={() => {}}
      onRefreshTabs={async () => {}}
      onNotice={() => {}}
      terminalReader={reader}
    />,
  );
}

describe("PipelineOverview refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    events.handler = null;
  });

  it("refetches on chain-run-updated for its own run only", async () => {
    vi.mocked(getPipelineRun).mockResolvedValue({ run: run() });
    renderOverview();
    expect(await screen.findByText("Eagle-Eye 1 overview")).toBeTruthy();
    expect(getPipelineRun).toHaveBeenCalledTimes(1);

    vi.mocked(getPipelineRun).mockResolvedValue({
      run: run({ role_plan_reviewer: { text: "Fresh plan", at: "now" } }),
    });
    await act(async () => events.handler?.({ chainId: "ee_other" }));
    expect(getPipelineRun).toHaveBeenCalledTimes(1);
    await act(async () => events.handler?.({ chainId: "ee_1" }));
    expect(await screen.findByText("Fresh plan")).toBeTruthy();
    expect(getPipelineRun).toHaveBeenCalledTimes(2);
  });

  it("polls only as a slow fallback and stops listening on unmount", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(getPipelineRun).mockResolvedValue({ run: run() });
      const view = renderOverview();
      await act(async () => {});
      expect(getPipelineRun).toHaveBeenCalledTimes(1);
      await act(async () => vi.advanceTimersByTime(4000));
      expect(getPipelineRun).toHaveBeenCalledTimes(1);
      await act(async () => vi.advanceTimersByTime(OVERVIEW_FALLBACK_POLL_MS));
      expect(getPipelineRun).toHaveBeenCalledTimes(2);
      view.unmount();
      expect(events.unlisten).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
