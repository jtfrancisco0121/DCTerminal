// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TabSwitcher } from "./TabSwitcher";

const tabs = [
  { id: "1", label: "Planner · UI Overhaul", cwd: "/Users/jt/Projects/Koneksi", phase: "running" },
  { id: "2", label: "Developer · Encryptor", cwd: "/Users/jt/Projects/Encryptor", phase: "draft" },
  { id: "3", label: "Shell", cwd: "/Users/jt/Projects/koneksi-api", phase: "terminal" },
];

describe("TabSwitcher", () => {
  it("filters by folder and opens the first match on Enter", () => {
    const onSelect = vi.fn();
    render(<TabSwitcher tabs={tabs} onSelect={onSelect} onClose={() => {}} />);
    const input = screen.getByPlaceholderText("Go to tab by name or folder");
    fireEvent.change(input, { target: { value: "encryptor" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("2");
  });

  it("moves the selection with the arrow keys", () => {
    const onSelect = vi.fn();
    render(<TabSwitcher tabs={tabs} onSelect={onSelect} onClose={() => {}} />);
    const input = screen.getByPlaceholderText("Go to tab by name or folder");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[2].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("2");
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(<TabSwitcher tabs={tabs} onSelect={() => {}} onClose={onClose} />);
    fireEvent.keyDown(screen.getByPlaceholderText("Go to tab by name or folder"), {
      key: "Escape",
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows the folder name, the status, and which tab is current", () => {
    render(
      <TabSwitcher
        tabs={tabs}
        activeTabId="3"
        statuses={{ "1": { busy: false, unseen: false, needsYou: "permission" } }}
        onSelect={() => {}}
        onClose={() => {}}
      />,
    );
    const rows = screen.getAllByRole("option");
    expect(rows[0].textContent).toContain("Koneksi");
    expect(rows[0].textContent).toContain("Needs you: permission request");
    expect(rows[2].textContent).toContain("current");
    fireEvent.change(screen.getByPlaceholderText("Go to tab by name or folder"), {
      target: { value: "needs" },
    });
    expect(screen.getAllByRole("option")).toHaveLength(1);
  });

  it("says when nothing matches", () => {
    render(<TabSwitcher tabs={tabs} onSelect={() => {}} onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText("Go to tab by name or folder"), {
      target: { value: "zzz" },
    });
    expect(screen.getByText("No tabs match")).toBeTruthy();
  });
});
