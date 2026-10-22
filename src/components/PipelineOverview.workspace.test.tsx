// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../bridge", () => ({
  getPipelineRun: vi.fn(),
  clickupIntakeCheck: vi.fn(async () => null),
  pipelineRunRound: vi.fn(async () => null),
  clickupWritebackLoad: vi.fn(async () => null),
  listenChainRunUpdated: vi.fn(async () => () => {}),
  pipelinePromotePlan: vi.fn(async () => {}),
  pipelineSetCandidatePlan: vi.fn(async () => {}),
  pipelineSetAutopilot: vi.fn(async () => {}),
  pipelineRunGates: vi.fn(async () => []),
  pipelineRunTasks: vi.fn(async () => null),
  exportTextFile: vi.fn(async () => {}),
  workspaceReposFor: vi.fn(async (folder: string) => ({
    workspace: folder === "/ws",
    repos: folder === "/ws" ? [{ name: "koneksi-engine", folder: "/ws/koneksi-engine" }] : [],
  })),
}));
vi.mock("../pipeline/terminalText", () => ({ liveTerminalReader: null }));

import type { PipelineRun, TabSummary } from "../bridge";
import { getPipelineRun, workspaceReposFor } from "../bridge";
import type { TabRuntime } from "../liveTabs";
import type { TerminalReader } from "../pipeline/terminalText";
import { PipelineOverview } from "./PipelineOverview";

const reviewer: TabSummary = {
  id: "rev",
  label: "Plan Reviewer",
  roleId: "role_plan_reviewer",
  cwd: "/ws",
  phase: "running",
  mergedPromptChars: 0,
  startupPromptSent: true,
  hasTranscript: false,
  folderStatus: "ok",
  color: "#fff",
  acpSessionId: null,
};

const noTerminal: TerminalReader = { selection: () => "", tail: () => "", planFile: async () => "" };

const onePr: TabRuntime = {
  segments: [
    {
      id: "s1",
      kind: "agent",
      text: "## HANDOFF: Verdict\nAPPROVED\n\n## HANDOFF: Pull requests\n* `PR1 — Heartbeat`: repo `koneksi-engine`, Depends on: none",
    } as TabRuntime["segments"][number],
  ],
} as TabRuntime;

function show(cwd: string, onFanOut: (runId: string) => Promise<void>) {
  const view: PipelineRun = {
    id: "ee_1",
    kind: "full",
    cwd,
    stage: "plan_reviewer",
    overviewTabId: "ov",
    tabIds: { role_plan_reviewer: "rev" },
    createdAt: "2026-10-22T00:00:00Z",
    chainId: "ee_1",
    engine: 1,
  };
  vi.mocked(getPipelineRun).mockResolvedValue({ run: view });
  render(
    <PipelineOverview
      runId="ee_1"
      cwd={cwd}
      tabs={[{ ...reviewer, cwd }]}
      runtimes={{ rev: onePr }}
      onJump={() => {}}
      onWatch={() => {}}
      onRefreshTabs={async () => {}}
      onNotice={() => {}}
      terminalReader={noTerminal}
      onFanOut={onFanOut}
      onStartLane={async () => {}}
    />,
  );
}

describe("PipelineOverview in a workspace folder (W1)", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it("offers a one-pull-request plan a fan-out into its repo's worktree", async () => {
    const onFanOut = vi.fn(async () => {});
    show("/ws", onFanOut);
    const panel = await screen.findByRole("region", { name: "Fan out" });
    expect(panel.textContent).toContain("workspace of repos, not a git repo");
    expect(panel.textContent).toContain("PR1 — Heartbeat");
    fireEvent.click(within(panel).getByRole("button", { name: "Fan out into 1 Implementer" }));
    await waitFor(() => expect(onFanOut).toHaveBeenCalledWith("ee_1"));
  });

  it("offers nothing for one pull request in a repo folder, as before", async () => {
    show("/src/app", vi.fn(async () => {}));
    await waitFor(() => expect(workspaceReposFor).toHaveBeenCalledWith("/src/app"));
    await screen.findAllByText(/Plan Reviewer/);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("region", { name: "Fan out" })).toBeNull();
  });
});
