// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const events: { runUpdated: (() => void) | null } = { runUpdated: null };

vi.mock("../bridge", () => ({
  ptyInputState: vi.fn(),
  ptyStageNeeds: vi.fn(),
  pipelineActorMessage: vi.fn(async () => ({})),
  listenChainRunUpdated: vi.fn(async (handler: () => void) => {
    events.runUpdated = handler;
    return () => {};
  }),
}));

import { listenChainRunUpdated, pipelineActorMessage, ptyInputState, ptyStageNeeds, type StageInput } from "../bridge";
import { useStageWatch } from "./useStageWatch";

const watchOnly: StageInput = { open: false, stage: true, takenOver: false, needs: false };
const stage = { id: "tab_rev", bridge: { runId: "ee_1", stage: "pr_reviewer" } };
const flush = () => act(async () => {});

describe("useStageWatch (V5, D27)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    events.runUpdated = null;
    vi.mocked(ptyStageNeeds).mockResolvedValue(watchOnly);
    vi.mocked(ptyInputState).mockResolvedValue(watchOnly);
  });

  it("is nothing for a tab that is not a bridged stage", async () => {
    const { result } = renderHook(() => useStageWatch({ id: "tab_shell", bridge: null }, false, vi.fn()));
    await flush();
    expect(result.current).toBeNull();
    expect(ptyStageNeeds).not.toHaveBeenCalled();
    expect(listenChainRunUpdated).not.toHaveBeenCalled();
  });

  it("is read-only on autopilot and opens while the stage needs you", async () => {
    const { result, rerender } = renderHook(({ needs }) => useStageWatch(stage, needs, vi.fn()), {
      initialProps: { needs: false },
    });
    await flush();
    expect(ptyStageNeeds).toHaveBeenLastCalledWith("tab_rev", false);
    expect(result.current).toMatchObject({ canType: false, takenOver: false });
    vi.mocked(ptyStageNeeds).mockResolvedValue({ ...watchOnly, open: true, needs: true });
    rerender({ needs: true });
    await flush();
    expect(ptyStageNeeds).toHaveBeenLastCalledWith("tab_rev", true);
    expect(result.current?.canType).toBe(true);
  });

  it("takes over and hands back through the run actor, then reads the new state", async () => {
    const onError = vi.fn();
    const { result } = renderHook(() => useStageWatch(stage, false, onError));
    await flush();
    vi.mocked(ptyInputState).mockResolvedValue({ ...watchOnly, open: true, takenOver: true });
    await act(async () => result.current!.onTakeOver!());
    expect(pipelineActorMessage).toHaveBeenCalledWith("ee_1", { kind: "takeOver", tabId: "tab_rev" });
    expect(result.current).toMatchObject({ canType: true, takenOver: true });
    vi.mocked(ptyInputState).mockResolvedValue(watchOnly);
    await act(async () => result.current!.onHandBack!());
    expect(pipelineActorMessage).toHaveBeenLastCalledWith("ee_1", { kind: "handBack", tabId: "tab_rev" });
    expect(result.current).toMatchObject({ canType: false, takenOver: false });
    // A run change made elsewhere (the overview's button) is read again.
    vi.mocked(ptyInputState).mockResolvedValue({ ...watchOnly, open: true, takenOver: true });
    await act(async () => events.runUpdated!());
    expect(result.current?.takenOver).toBe(true);
    vi.mocked(pipelineActorMessage).mockRejectedValueOnce(new Error("That tab is not on this run."));
    await act(async () => result.current!.onHandBack!());
    expect(onError).toHaveBeenCalledWith("Not handed back", "That tab is not on this run.");
  });

  it("reads its rules again once its terminal is open (the first read after a restart can come too early)", async () => {
    // Before the relaunch records the stage folder, the backend does not know the stage yet.
    vi.mocked(ptyStageNeeds).mockResolvedValue({ open: true, stage: false, takenOver: false, needs: false });
    const { result, rerender } = renderHook(({ opened }) => useStageWatch(stage, false, vi.fn(), opened), {
      initialProps: { opened: 0 },
    });
    await flush();
    expect(result.current).toBeNull();
    rerender({ opened: 1 });
    await flush();
    expect(ptyInputState).toHaveBeenCalledWith("tab_rev");
    expect(result.current).toMatchObject({ canType: false, takenOver: false });
  });
});
