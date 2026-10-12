// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CommandPalette } from "./CommandPalette";

const base = { tabs: [], canReopen: false, splitOpen: false, onRun: () => {}, onClose: () => {} };

describe("CommandPalette", () => {
  it("shows each command's shortcut from the keymap", () => {
    render(<CommandPalette {...base} platform="mac" initialQuery="close tab" />);
    const option = screen.getByRole("button", { name: /Close tab/ });
    expect(within(option).getByText("⌘+W").tagName).toBe("KBD");
  });

  it("uses Ctrl off macOS", () => {
    render(<CommandPalette {...base} platform="windows" initialQuery="settings" />);
    expect(screen.getAllByText("Ctrl+,").length).toBe(1);
  });

  it("lists the group once as a header, not on every row", () => {
    render(<CommandPalette {...base} platform="windows" />);
    const tabsHeaders = screen.getAllByText("Tabs").filter((el) => el.className === "palette-group");
    expect(tabsHeaders.length).toBe(1);
    const row = screen.getByRole("button", { name: /^New tab Ctrl/ });
    expect(row.textContent).not.toContain("Tabs");
  });

  it("runs the chosen command", () => {
    const onRun = vi.fn();
    render(<CommandPalette {...base} onRun={onRun} platform="windows" initialQuery="rename" />);
    fireEvent.click(screen.getByRole("button", { name: /Rename tab/ }));
    expect(onRun).toHaveBeenCalledWith("renameTab");
  });
});
