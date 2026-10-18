// @vitest-environment jsdom
import { fireEvent, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAppShortcuts } from "./useAppShortcuts";

describe("useAppShortcuts", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()?.();
  });

  it("Escape cancels the turn in flight", () => {
    const onCancelTurn = vi.fn();
    renderHook(() =>
      useAppShortcuts({
        platform: "mac",
        dialogOpen: false,
        promptInFlight: true,
        onAction: () => {},
        onCancelTurn,
      }),
    );
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onCancelTurn).toHaveBeenCalledTimes(1);
  });

  it("Escape with a pending permission cancels the permission, not the turn", () => {
    const onCancelTurn = vi.fn();
    const onPermissionEscape = vi.fn(() => true);
    // The app registers this hook before any permission card mounts, so it sees keys first.
    renderHook(() =>
      useAppShortcuts({
        platform: "mac",
        dialogOpen: false,
        promptInFlight: true,
        onAction: () => {},
        onCancelTurn,
        onPermissionEscape,
      }),
    );
    // A permission card's own window listener runs afterwards and skips handled keys.
    const cardCancel = vi.fn();
    const card = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) cardCancel();
    };
    window.addEventListener("keydown", card, true);
    cleanups.push(() => window.removeEventListener("keydown", card, true));
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onPermissionEscape).toHaveBeenCalledTimes(1);
    expect(onPermissionEscape).toHaveBeenCalledWith(document.body);
    expect(cardCancel).not.toHaveBeenCalled();
    expect(onCancelTurn).not.toHaveBeenCalled();
  });

  it("Escape cancels the turn when no permission takes it", () => {
    const onCancelTurn = vi.fn();
    const onPermissionEscape = vi.fn(() => false);
    renderHook(() =>
      useAppShortcuts({
        platform: "mac",
        dialogOpen: false,
        promptInFlight: true,
        onAction: () => {},
        onCancelTurn,
        onPermissionEscape,
      }),
    );
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onPermissionEscape).toHaveBeenCalledTimes(1);
    expect(onCancelTurn).toHaveBeenCalledTimes(1);
  });
});
