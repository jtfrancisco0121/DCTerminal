// @vitest-environment jsdom
import { fireEvent, render, renderHook, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useAppShortcuts } from "../useAppShortcuts";
import { ChatFindBar } from "./ChatFindBar";

describe("ChatFindBar", () => {
  it("closes on Escape without cancelling the running turn", () => {
    const onCancelTurn = vi.fn();
    const onClose = vi.fn();
    renderHook(() =>
      useAppShortcuts({
        platform: "mac",
        dialogOpen: false,
        promptInFlight: true,
        onAction: () => {},
        onCancelTurn,
      }),
    );
    render(
      <ChatFindBar
        query="x"
        index={0}
        count={1}
        focusKey={0}
        onQuery={() => {}}
        onStep={() => {}}
        onClose={onClose}
      />,
    );
    fireEvent.keyDown(screen.getByLabelText("Find in chat"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    expect(onCancelTurn).not.toHaveBeenCalled();
  });
});
