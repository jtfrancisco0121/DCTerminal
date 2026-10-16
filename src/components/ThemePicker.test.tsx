// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const setTerminalTheme = vi.fn();
vi.mock("../terminal/park", () => ({
  setTerminalTheme: (...args: unknown[]) => setTerminalTheme(...args),
}));

import { CUSTOM_COLOR_SAVE_DELAY_MS, ThemePicker } from "./ThemePicker";

const ui = { theme: "nord", shortcutBar: false, tipsSeen: [], padHeight: 0, padHidden: false };

beforeEach(() => {
  vi.useFakeTimers();
  setTerminalTheme.mockClear();
  document.documentElement.removeAttribute("style");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ThemePicker custom colours", () => {
  it("applies a dragged colour live and saves it once it settles", () => {
    const onUiSettings = vi.fn();
    render(<ThemePicker uiSettings={ui} onUiSettings={onUiSettings} />);
    const input = screen.getByLabelText("Background") as HTMLInputElement;
    for (const value of ["#101010", "#202020", "#303030"]) {
      fireEvent.change(input, { target: { value } });
      act(() => vi.advanceTimersByTime(100));
    }
    const root = document.documentElement.style;
    expect(root.getPropertyValue("--bg")).toBe("#303030");
    expect(setTerminalTheme).toHaveBeenLastCalledWith("nord", { background: "#303030" });
    expect(input.value).toBe("#303030");
    expect(onUiSettings).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(CUSTOM_COLOR_SAVE_DELAY_MS));
    expect(onUiSettings).toHaveBeenCalledTimes(1);
    expect(onUiSettings).toHaveBeenCalledWith({ customColors: { background: "#303030" } });
  });

  it("does not repaint terminals for a status colour", () => {
    render(<ThemePicker uiSettings={ui} onUiSettings={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Needs you"), { target: { value: "#ff00ff" } });
    expect(document.documentElement.style.getPropertyValue("--attention")).toBe("#ff00ff");
    expect(setTerminalTheme).not.toHaveBeenCalled();
  });

  it("saves at once on blur and on unmount", () => {
    const onUiSettings = vi.fn();
    const view = render(<ThemePicker uiSettings={ui} onUiSettings={onUiSettings} />);
    const done = screen.getByLabelText("Done");
    fireEvent.change(done, { target: { value: "#00ff00" } });
    fireEvent.blur(done);
    expect(onUiSettings).toHaveBeenCalledWith({ customColors: { done: "#00ff00" } });
    view.rerender(
      <ThemePicker uiSettings={{ ...ui, customColors: { done: "#00ff00" } }} onUiSettings={onUiSettings} />,
    );
    fireEvent.change(screen.getByLabelText("Accent"), { target: { value: "#0000ff" } });
    view.unmount();
    expect(onUiSettings).toHaveBeenCalledTimes(2);
    expect(onUiSettings).toHaveBeenLastCalledWith({
      customColors: { done: "#00ff00", accent: "#0000ff" },
    });
    act(() => vi.advanceTimersByTime(CUSTOM_COLOR_SAVE_DELAY_MS));
    expect(onUiSettings).toHaveBeenCalledTimes(2);
  });

  it("drops a pending colour on Reset", () => {
    const onUiSettings = vi.fn();
    render(
      <ThemePicker uiSettings={{ ...ui, customColors: { done: "#00ff00" } }} onUiSettings={onUiSettings} />,
    );
    fireEvent.change(screen.getByLabelText("Accent"), { target: { value: "#0000ff" } });
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    act(() => vi.advanceTimersByTime(CUSTOM_COLOR_SAVE_DELAY_MS));
    expect(onUiSettings).toHaveBeenCalledTimes(1);
    expect(onUiSettings).toHaveBeenCalledWith({ customColors: {} });
  });
});
