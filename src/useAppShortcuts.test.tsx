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

  it("Escape answered by a permission card does not cancel the turn", () => {
    // A permission card's window listener answers Escape first and marks it handled.
    const card = (event: KeyboardEvent) => {
      if (event.key === "Escape") event.preventDefault();
    };
    window.addEventListener("keydown", card, true);
    cleanups.push(() => window.removeEventListener("keydown", card, true));
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
    expect(onCancelTurn).not.toHaveBeenCalled();
  });
});
