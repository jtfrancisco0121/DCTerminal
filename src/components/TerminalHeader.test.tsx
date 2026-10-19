// @vitest-environment jsdom
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useAppShortcuts } from "../useAppShortcuts";
import { TerminalHeader, type NextStep } from "./TerminalHeader";

const working = { tone: "working", text: "Working", timed: true } as const;
const done = { tone: "done", text: "Done · APPROVED", timed: false } as const;

const next = (partial: Partial<NextStep> = {}): NextStep => ({
  targets: [
    { id: "role_implementer", name: "Implementer" },
    { id: "role_planner", name: "Planner" },
  ],
  primaryTarget: "role_implementer",
  primaryLabel: "Next: Send to Implementer",
  completeNote: null,
  busy: false,
  onSend: () => {},
  ...partial,
});

const base = {
  roleName: "Plan Reviewer",
  roleColor: "#58a6ff",
  title: "Effort picker",
  turnEnded: false,
};

describe("TerminalHeader", () => {
  it("shows role, task, state, folder and branch on the left", () => {
    render(
      <TerminalHeader {...base} state={working} folder="app" branch="feat/x" turnEnded={false} />,
    );
    expect(screen.getByText("Plan Reviewer")).toBeTruthy();
    expect(screen.getByText("Effort picker")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Working");
    expect(screen.getByText("app")).toBeTruthy();
    expect(screen.getByLabelText("Git branch").textContent).toContain("feat/x");
  });

  it("keeps the ticking seconds out of the live region", () => {
    vi.useFakeTimers();
    try {
      const start = Date.now();
      const { container } = render(
        <TerminalHeader {...base} state={working} workingSince={start - 12_000} />,
      );
      const status = screen.getByRole("status");
      const pill = container.querySelector(".terminal-header-pill")!;
      expect(status.textContent).toBe("Working");
      expect(pill.textContent).toBe("Working · 12s");
      const seconds = pill.querySelector("[aria-hidden]")!;
      expect(seconds.textContent).toBe(" · 12s");
      expect(status.contains(seconds)).toBe(false);
      act(() => {
        vi.advanceTimersByTime(3000);
      });
      expect(pill.textContent).toBe("Working · 15s");
      expect(status.textContent).toBe("Working");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows no seconds without a start time or when not working", () => {
    const { container, rerender } = render(<TerminalHeader {...base} state={working} />);
    const pill = () => container.querySelector(".terminal-header-pill")!.textContent;
    expect(pill()).toBe("Working");
    rerender(<TerminalHeader {...base} state={done} workingSince={Date.now() - 5000} turnEnded />);
    expect(pill()).toBe("Done · APPROVED");
  });

  it("has a primary split button only when the turn ended, with the others in its menu", () => {
    const onSend = vi.fn();
    const { rerender } = render(
      <TerminalHeader {...base} state={working} next={next({ onSend })} turnEnded={false} />,
    );
    expect(screen.getByRole("button", { name: "Next: Send to Implementer" }).className).toContain(
      "secondary-button",
    );
    rerender(<TerminalHeader {...base} state={done} next={next({ onSend })} turnEnded />);
    const main = screen.getByRole("button", { name: "Next: Send to Implementer" });
    expect(main.className).toContain("primary-button");
    fireEvent.click(main);
    expect(onSend).toHaveBeenCalledWith("role_implementer");
    fireEvent.click(screen.getByRole("button", { name: "More hand-off targets" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Send to Planner" }));
    expect(onSend).toHaveBeenCalledWith("role_planner");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes the hand-off menu on Escape without cancelling another tab's running turn", () => {
    // Grid view: the active chat tab has a turn in flight; this header is another cell's.
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
    render(<TerminalHeader {...base} compact state={done} next={next()} turnEnded />);
    const caret = screen.getByRole("button", { name: "More hand-off targets" });
    fireEvent.click(caret);
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.keyDown(caret, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(onCancelTurn).not.toHaveBeenCalled();
  });

  it("claims Escape for an open hand-off menu even when the click left focus on the body", () => {
    // WebKit does not focus a clicked button (nor does jsdom's click), so
    // Escape goes to whatever holds focus after the menu opens.
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
    render(<TerminalHeader {...base} compact state={done} next={next()} turnEnded />);
    const caret = screen.getByRole("button", { name: "More hand-off targets" });
    fireEvent.click(caret);
    expect(document.activeElement).toBe(screen.getAllByRole("menuitem")[0]);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(onCancelTurn).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(caret);
  });

  it("shows Stop only while working", () => {
    const onStop = vi.fn();
    const { rerender } = render(<TerminalHeader {...base} state={working} onStop={onStop} />);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onStop).toHaveBeenCalledOnce();
    rerender(<TerminalHeader {...base} state={done} onStop={onStop} turnEnded />);
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("renders the compact variant with its actions", () => {
    const { container } = render(
      <TerminalHeader
        {...base}
        compact
        state={done}
        turnEnded
        next={next()}
        actions={<button type="button">Remove</button>}
      />,
    );
    expect(container.querySelector(".terminal-header-compact")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Done · APPROVED");
  });

  it("shows the complete note when nothing is left to hand on", () => {
    render(
      <TerminalHeader
        {...base}
        state={done}
        next={next({ targets: [], primaryTarget: null, completeNote: "Chain complete" })}
      />,
    );
    expect(screen.getByText("Chain complete")).toBeTruthy();
  });
});
