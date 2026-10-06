// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("./systemNotify", () => ({ showSystemNotification: vi.fn(async () => true) }));

import { DEFAULT_NOTIFICATION_SETTINGS, type NotificationSettings } from "./agentNotify";
import { useAgentNotifications } from "./useAgentNotifications";

function setup(opts: {
  focused: boolean;
  visible?: string[];
  settings?: NotificationSettings | null;
}) {
  const showSystem = vi.fn(async () => true);
  const hook = renderHook(() =>
    useAgentNotifications({
      settings: opts.settings === undefined ? DEFAULT_NOTIFICATION_SETTINGS : opts.settings,
      visibleTabIds: () => opts.visible ?? ["a"],
      tabLabel: (id) => (id === "b" ? "Reviewer" : "Implementer"),
      isWindowFocused: () => opts.focused,
      showSystem,
    }),
  );
  return { ...hook, showSystem };
}

describe("useAgentNotifications", () => {
  it("toasts a background tab's permission request while focused, no system", () => {
    const { result, showSystem } = setup({ focused: true });
    act(() => result.current.notify("b", { kind: "permission", detail: "Run npm test" }));
    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0]).toMatchObject({
      tabId: "b",
      kind: "permission",
      title: "Reviewer needs permission",
      body: "Run npm test",
    });
    expect(showSystem).not.toHaveBeenCalled();
  });

  it("stays quiet for the visible tab in a focused window", () => {
    const { result, showSystem } = setup({ focused: true });
    act(() => result.current.notify("a", { kind: "finished", detail: "Done" }));
    expect(result.current.toasts).toHaveLength(0);
    expect(showSystem).not.toHaveBeenCalled();
  });

  it("sends a system notification when the window is not focused", () => {
    const { result, showSystem } = setup({ focused: false });
    act(() => result.current.notify("a", { kind: "question", detail: "Which one?" }));
    expect(showSystem).toHaveBeenCalledWith("Implementer has a question", "Which one?");
    expect(result.current.toasts).toHaveLength(1);
  });

  it("does nothing when disabled in Settings", () => {
    const { result, showSystem } = setup({
      focused: false,
      settings: { ...DEFAULT_NOTIFICATION_SETTINGS, enabled: false },
    });
    act(() => result.current.notify("b", { kind: "finished", detail: "Done" }));
    expect(result.current.toasts).toHaveLength(0);
    expect(showSystem).not.toHaveBeenCalled();
  });

  it("uses the defaults until settings load", () => {
    const { result } = setup({ focused: true, settings: null });
    act(() => result.current.notify("b", { kind: "finished", detail: "Done" }));
    expect(result.current.toasts).toHaveLength(1);
  });

  it("dismisses one toast or all of a tab's toasts", () => {
    const { result } = setup({ focused: true, visible: ["z"] });
    act(() => {
      result.current.notify("a", { kind: "finished", detail: "1" });
      result.current.notify("b", { kind: "finished", detail: "2" });
    });
    expect(result.current.toasts).toHaveLength(2);
    act(() => result.current.dismissTab("a"));
    expect(result.current.toasts.map((t) => t.tabId)).toEqual(["b"]);
    act(() => result.current.dismiss(result.current.toasts[0].id));
    expect(result.current.toasts).toHaveLength(0);
  });

  it("shows an app notice as a toast without a system notification", () => {
    const { result, showSystem } = setup({ focused: true });
    act(() => result.current.notice("Worktree removed", "feat/x", "finished"));
    expect(result.current.toasts[0]).toMatchObject({
      tabId: "__notice__",
      title: "Worktree removed",
      body: "feat/x",
    });
    expect(showSystem).not.toHaveBeenCalled();
  });

  it("sends a test notification regardless of focus", () => {
    const { result, showSystem } = setup({ focused: true });
    act(() => result.current.sendTest());
    expect(result.current.toasts).toHaveLength(1);
    expect(showSystem).toHaveBeenCalledWith(
      "DCTerminal notifications are on",
      expect.any(String),
      { askAgain: true },
    );
  });
});
