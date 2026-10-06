// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentToasts } from "./AgentToasts";
import type { AgentToast } from "../notify/agentNotify";

const toasts: AgentToast[] = [
  { id: "1", tabId: "a", kind: "permission", title: "Reviewer needs permission", body: "Run npm test" },
  { id: "2", tabId: "b", kind: "finished", title: "Implementer finished", body: "Done." },
];

afterEach(() => {
  vi.useRealTimers();
});

describe("AgentToasts", () => {
  it("renders nothing with no toasts", () => {
    const { container } = render(
      <AgentToasts toasts={[]} onOpen={() => {}} onDismiss={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("opens the tab when a toast is clicked", () => {
    const onOpen = vi.fn();
    render(<AgentToasts toasts={toasts} onOpen={onOpen} onDismiss={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Reviewer needs permission/ }));
    expect(onOpen).toHaveBeenCalledWith(toasts[0]);
  });

  it("dismisses with the close button", () => {
    const onDismiss = vi.fn();
    const onOpen = vi.fn();
    render(<AgentToasts toasts={toasts} onOpen={onOpen} onDismiss={onDismiss} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Dismiss notification" })[1]);
    expect(onDismiss).toHaveBeenCalledWith("2");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("auto-dismisses after the toast's lifetime", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<AgentToasts toasts={[toasts[1]]} onOpen={() => {}} onDismiss={onDismiss} />);
    act(() => {
      vi.advanceTimersByTime(5900);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(onDismiss).toHaveBeenCalledWith("2");
  });

  it("holds the timer while the window is unfocused so toasts wait for the user", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const { rerender } = render(
      <AgentToasts toasts={[toasts[1]]} paused onOpen={() => {}} onDismiss={onDismiss} />,
    );
    act(() => {
      vi.advanceTimersByTime(60000);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    rerender(<AgentToasts toasts={[toasts[1]]} onOpen={() => {}} onDismiss={onDismiss} />);
    act(() => {
      vi.advanceTimersByTime(6100);
    });
    expect(onDismiss).toHaveBeenCalledWith("2");
  });

  it("marks needs-you toasts as urgent for screen readers", () => {
    render(<AgentToasts toasts={toasts} onOpen={() => {}} onDismiss={() => {}} />);
    expect(screen.getByRole("alert").textContent).toContain("Reviewer needs permission");
  });
});
