// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FIRST_USE_TIP_ID, FirstUseTip, shouldShowTip } from "./FirstUseTip";

describe("FirstUseTip (U7)", () => {
  it("shows once: only after settings load and until the tip is marked seen", () => {
    expect(shouldShowTip({ loaded: false, tipsSeen: [], blocked: false })).toBe(false);
    expect(shouldShowTip({ loaded: true, tipsSeen: [], blocked: false })).toBe(true);
    expect(shouldShowTip({ loaded: true, tipsSeen: [FIRST_USE_TIP_ID], blocked: false })).toBe(
      false,
    );
    expect(shouldShowTip({ loaded: true, tipsSeen: [], blocked: true })).toBe(false);
  });

  it("names the palette and help keys and offers the shortcut bar", () => {
    const onDismiss = vi.fn();
    const onShowBar = vi.fn();
    render(
      <FirstUseTip platform="mac" barOn={false} onDismiss={onDismiss} onShowBar={onShowBar} />,
    );
    const tip = screen.getByRole("status", { name: "Tip" });
    expect(tip.textContent).toContain("⌘+K");
    fireEvent.click(screen.getByRole("button", { name: "Show shortcut bar" }));
    expect(onShowBar).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("Got it dismisses without turning the bar on", () => {
    const onDismiss = vi.fn();
    const onShowBar = vi.fn();
    render(
      <FirstUseTip platform="windows" barOn={false} onDismiss={onDismiss} onShowBar={onShowBar} />,
    );
    expect(screen.getByRole("status", { name: "Tip" }).textContent).toContain("Ctrl+K");
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(onShowBar).not.toHaveBeenCalled();
  });

  it("hides the bar button when the bar is already on", () => {
    render(<FirstUseTip platform="windows" barOn onDismiss={() => {}} onShowBar={() => {}} />);
    expect(screen.queryByRole("button", { name: "Show shortcut bar" })).toBeNull();
  });
});
