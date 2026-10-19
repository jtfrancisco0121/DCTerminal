// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TabSummary } from "../bridge";
import { WorkspaceShell, type WorkspaceShellProps } from "./WorkspaceShell";

function Boom(): never {
  throw new Error("second pane broke");
}

const tab = (id: string, label: string) => ({ id, label, cwd: "/tmp", kind: "role" }) as unknown as TabSummary;

function props(overrides: Partial<WorkspaceShellProps>): WorkspaceShellProps {
  return {
    tabBar: <div role="tablist" aria-label="Tabs" />,
    overlays: null,
    filePanel: null,
    firstUseTip: null,
    statusBar: <footer>status</footer>,
    showGrid: false,
    split: { mode: "horizontal", secondaryTabId: "b", primarySize: 50 },
    setSplit: () => {},
    activeTabId: "a",
    activeTabSummary: tab("a", "Alpha"),
    savedTabs: [tab("a", "Alpha"), tab("b", "Beta")],
    secondaryTab: tab("b", "Beta"),
    focusedPane: "primary",
    setFocusedPane: () => {},
    panes: {
      gridTone: () => "idle",
      gridCellBar: () => <></>,
      renderGridCell: () => <></>,
      renderSecondary: () => <Boom />,
      paneStrip: () => null,
    },
    renderPreview: () => null,
    children: <p>alpha view</p>,
    ...overrides,
  };
}

describe("WorkspaceShell boundaries", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("a crash in the second pane keeps the main pane, tab bar and status bar", () => {
    render(<WorkspaceShell {...props({})} />);
    expect(screen.getByRole("alert").textContent).toContain("second pane broke");
    expect(screen.getByText("alpha view")).toBeTruthy();
    expect(screen.getByRole("tablist", { name: "Tabs" })).toBeTruthy();
    expect(screen.getByText("status")).toBeTruthy();
  });

  it("a crash in the main view keeps the second pane", () => {
    render(
      <WorkspaceShell
        {...props({
          panes: { ...props({}).panes, renderSecondary: () => <p>beta view</p> },
          children: <Boom />,
        })}
      />,
    );
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("beta view")).toBeTruthy();
  });

  it("a crash in Settings keeps the tab bar", () => {
    render(<WorkspaceShell {...props({ settings: <Boom /> })} />);
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByRole("tablist", { name: "Tabs" })).toBeTruthy();
  });

  it("a crash in the file panel keeps the main view", () => {
    render(<WorkspaceShell {...props({ filePanel: <Boom />, secondaryTab: undefined })} />);
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("alpha view")).toBeTruthy();
  });

  it("a crash in a grid cell keeps the other cells", () => {
    render(
      <WorkspaceShell
        {...props({
          showGrid: true,
          split: { mode: "grid", secondaryTabId: null, gridTabIds: ["a", "b"] },
          secondaryTab: undefined,
          panes: { ...props({}).panes, renderGridCell: () => <Boom /> },
        })}
      />,
    );
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("alpha view")).toBeTruthy();
  });
});
