// @vitest-environment jsdom
import { cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAppShortcuts } from "../useAppShortcuts";
import { TerminalContextMenu } from "./TerminalContextMenu";

afterEach(cleanup);

describe("TerminalContextMenu", () => {
  const items = (copyDisabled: boolean) => [
    { id: "copy", label: "Copy", shortcut: "Ctrl+Shift+C", disabled: copyDisabled, onSelect: vi.fn() },
    { id: "paste", label: "Paste", onSelect: vi.fn() },
    { id: "clear", label: "Clear scrollback", divider: true, onSelect: vi.fn() },
  ];

  it("focuses the first enabled item and moves with the arrow keys", () => {
    render(<TerminalContextMenu x={10} y={10} items={items(true)} />);
    const [copy, paste, clear] = screen.getAllByRole("menuitem") as HTMLButtonElement[];
    expect(copy.disabled).toBe(true);
    expect(document.activeElement).toBe(paste);
    fireEvent.keyDown(paste, { key: "ArrowDown" });
    expect(document.activeElement).toBe(clear);
    fireEvent.keyDown(clear, { key: "ArrowDown" });
    expect(document.activeElement).toBe(paste);
    fireEvent.keyDown(paste, { key: "End" });
    expect(document.activeElement).toBe(clear);
  });

  it("shows shortcuts and enables Copy with a selection", () => {
    render(<TerminalContextMenu x={10} y={10} items={items(false)} />);
    expect(screen.getByText("Ctrl+Shift+C")).toBeTruthy();
    const copy = screen.getByRole("menuitem", { name: /Copy/ }) as HTMLButtonElement;
    expect(copy.disabled).toBe(false);
    expect(document.activeElement).toBe(copy);
  });

  // The owner closes the menu from its own window capture listener, which runs
  // after the global one. Focus moves into the menu, so Escape must not cancel a
  // running chat turn (this menu also opens in a chat tab's ::pane terminal).
  it("leaves a running chat turn alone on Escape", () => {
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
    render(<TerminalContextMenu x={10} y={10} items={items(false)} />);
    const focused = document.activeElement as HTMLElement;
    expect(focused.getAttribute("role")).toBe("menuitem");
    fireEvent.keyDown(focused, { key: "Escape" });
    expect(onCancelTurn).not.toHaveBeenCalled();
  });
});
