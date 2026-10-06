// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TabBar } from "./TabBar";
import type { TabSummary } from "./bridge";

const tab = (partial: Partial<TabSummary>): TabSummary => ({
  id: "tab_1",
  label: "Developer · Encryptor",
  roleId: "role_developer",
  cwd: "C:\\Projects\\Encryptor",
  phase: "draft",
  mergedPromptChars: 0,
  startupPromptSent: false,
  hasTranscript: false,
  folderStatus: "ok",
  color: "#3fb950",
  kind: "role",
  terminalLaunch: "",
  acpSessionId: null,
  ...partial,
});

describe("TabBar", () => {
  it("shows each tab's own label and closes only the clicked tab", () => {
    const onClose = vi.fn();
    const onSelect = vi.fn();
    const onNew = vi.fn();
    render(
      <TabBar
        tabs={[
          tab({ id: "tab_1", label: "Planner · UI Overhaul" }),
          tab({ id: "tab_2", label: "Developer · Encryptor" }),
        ]}
        activeTabId="tab_2"
        onSelect={onSelect}
        onClose={onClose}
        onNew={onNew}
      />,
    );
    expect(screen.getByRole("tab", { name: /Planner · UI Overhaul/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Developer · Encryptor/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close Developer · Encryptor" }));
    expect(onClose).toHaveBeenCalledWith("tab_2");
    fireEvent.click(screen.getByRole("button", { name: "+ New tab" }));
    expect(onNew).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("tab", { name: /Planner · UI Overhaul/ }));
    expect(onSelect).toHaveBeenCalledWith("tab_1");
  });

  it("marks a terminal role tab", () => {
    render(
      <TabBar
        tabs={[tab({ terminalLaunch: "role", label: "Developer · Encryptor" })]}
        activeTabId="tab_1"
        onSelect={() => {}}
        onClose={() => {}}
        onNew={() => {}}
      />,
    );
    expect(screen.getByText("Terminal")).toBeTruthy();
  });
});
