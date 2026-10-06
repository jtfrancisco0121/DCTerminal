// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SHORTCUT_BAR_ACTIONS, ShortcutBar, shortcutBarItems } from "./ShortcutBar";

describe("ShortcutBar (U7)", () => {
  it("lists the everyday shortcuts once each with platform keys", () => {
    const items = shortcutBarItems("mac");
    expect(items.map((item) => item.action)).toEqual([...SHORTCUT_BAR_ACTIONS]);
    expect(items.find((item) => item.action === "commandPalette")?.keys).toContain("⌘");
    const win = shortcutBarItems("windows");
    expect(win.find((item) => item.action === "commandPalette")?.keys).toContain("Ctrl");
  });

  it("runs the action when a hint is clicked and can hide itself", () => {
    const onRun = vi.fn();
    const onHide = vi.fn();
    render(<ShortcutBar platform="windows" onRun={onRun} onHide={onHide} />);
    const bar = screen.getByRole("group", { name: "Shortcut bar" });
    fireEvent.click(within(bar).getByRole("button", { name: /Commands/ }));
    expect(onRun).toHaveBeenCalledWith("commandPalette");
    fireEvent.click(within(bar).getByRole("button", { name: "Hide shortcut bar" }));
    expect(onHide).toHaveBeenCalledOnce();
  });
});
