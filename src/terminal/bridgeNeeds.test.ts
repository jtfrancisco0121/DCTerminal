// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BridgeNeeds } from "../bridge";

let emit: ((event: BridgeNeeds) => void) | null = null;
vi.mock("../bridge", () => ({
  listenBridgeNeeds: vi.fn(async (handler: (event: BridgeNeeds) => void) => {
    emit = handler;
    return () => {
      emit = null;
    };
  }),
  createPtyChannel: (onPacket: (packet: { kind: string; data: string; code: number | null }) => void) => {
    channels.push(onPacket);
    return { onmessage: onPacket };
  },
}));
const channels: ((packet: { kind: string; data: string; code: number | null }) => void)[] = [];

const { useBridgeNeeds } = await import("./bridgeNeeds");
const { beginLivePty, dropLivePty, notePtyInput, restartLivePty } = await import("./live");
const { deriveTerminalState, BRIDGE_NEEDS_GRACE_MS } = await import("./claudeState");

const TAB = { id: "impl", bridge: { runId: "ee_1", stage: "implementer" } };
const bash = { id: "toolu_b1", name: "Bash", title: "Bash: npm run check" };
const running = { turnDone: false, openTool: bash, pendingTools: [bash] };

function needs(extra: Partial<BridgeNeeds> = {}): BridgeNeeds {
  return {
    schema: 1,
    runId: "ee_1",
    stageKey: "implementer",
    stageId: "implementer",
    roleId: "role_implementer",
    tabId: "impl",
    turn: "p-1",
    source: "permission_request",
    tool: "Bash",
    at: "2026-10-20T00:00:00Z",
    ...extra,
  };
}

async function mount(tabs = [TAB]) {
  const view = renderHook(() => useBridgeNeeds(() => tabs));
  await vi.waitFor(() => expect(emit).not.toBeNull());
  return view;
}

const pill = (mark: ReturnType<ReturnType<typeof useBridgeNeeds>["markOf"]>) =>
  deriveTerminalState({ log: running, bridgeNeeds: mark, dialogTool: null, ptyBusy: true, exitCode: null });

afterEach(() => {
  emit = null;
});

describe("useBridgeNeeds: the bridged Needs you lifecycle (D22)", () => {
  it("a PermissionRequest event shows Needs you at once; an answer key brings back Working while the tool still runs", async () => {
    const { result, unmount } = await mount();
    expect(pill(result.current.markOf("impl"))).toEqual({ kind: "working" });
    act(() => emit!(needs()));
    expect(pill(result.current.markOf("impl"))).toMatchObject({ kind: "needs", needs: "permission", toolId: "toolu_b1" });
    act(() => notePtyInput("impl", "\r"));
    expect(result.current.markOf("impl")).toBeNull();
    expect(pill(result.current.markOf("impl"))).toEqual({ kind: "working" });
    unmount();
  });

  it("ignores events for another stage or tab, and the late Notification backup never replaces the hook's mark", async () => {
    const { result, unmount } = await mount();
    act(() => emit!(needs({ stageKey: "pr_reviewer" })));
    act(() => emit!(needs({ tabId: "other" })));
    expect(result.current.markOf("impl")).toBeNull();
    act(() => emit!(needs()));
    const hooked = result.current.markOf("impl");
    act(() => emit!(needs({ source: "permission_prompt", tool: null, at: "2026-10-20T00:00:06Z" })));
    expect(result.current.markOf("impl")).toBe(hooked);
    unmount();
  });

  it("a screen dialog drawn after the hook and then gone clears it", async () => {
    const { result, unmount } = await mount();
    act(() => emit!(needs()));
    act(() => result.current.afterDialog("impl", true));
    expect(result.current.markOf("impl")).not.toBeNull();
    act(() => result.current.afterDialog("impl", false));
    expect(result.current.markOf("impl")).toBeNull();
    unmount();
  });

  it("a log read after the grace that shows the turn over clears it", async () => {
    const { result, unmount } = await mount();
    act(() => emit!(needs()));
    const at = result.current.markOf("impl")!.at;
    act(() => result.current.afterRead("impl", running, at + BRIDGE_NEEDS_GRACE_MS));
    expect(result.current.markOf("impl")).not.toBeNull();
    act(() => result.current.afterRead("impl", { turnDone: true, openTool: null }, at + BRIDGE_NEEDS_GRACE_MS));
    expect(result.current.markOf("impl")).toBeNull();
    unmount();
  });

  it("a permission event for a plan or a question is not a permission dialog: their own prompt shows", async () => {
    const { result, unmount } = await mount();
    act(() => emit!(needs({ tool: "ExitPlanMode" })));
    act(() => emit!(needs({ tool: "AskUserQuestion" })));
    expect(result.current.markOf("impl")).toBeNull();
    unmount();
  });

  it("a PTY that exits, or a new one on the tab (Restart, Resume), drops the mark", async () => {
    const { result, unmount } = await mount();
    beginLivePty("impl");
    act(() => emit!(needs()));
    expect(result.current.markOf("impl")).not.toBeNull();
    act(() => channels[channels.length - 1]({ kind: "exit", data: "", code: 0 }));
    expect(result.current.markOf("impl")).toBeNull();
    // Restart while the dialog was up: the new session starts with no Needs you.
    act(() => emit!(needs({ turn: "p-2" })));
    expect(result.current.markOf("impl")).not.toBeNull();
    act(() => {
      restartLivePty("impl");
    });
    expect(result.current.markOf("impl")).toBeNull();
    expect(pill(result.current.markOf("impl"))).toEqual({ kind: "working" });
    dropLivePty("impl");
    unmount();
  });

  it("bumps its version on each change so terminal states recompute", async () => {
    const { result, unmount } = await mount();
    const before = result.current.version;
    act(() => emit!(needs()));
    expect(result.current.version).toBeGreaterThan(before);
    unmount();
  });
});
