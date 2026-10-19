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

  it("a file panel crash clears when another tab becomes active", () => {
    const panelFor = (id: string) => (id === "a" ? <Boom /> : <p>beta files</p>);
    const base = { secondaryTab: undefined, split: { mode: "single" as const, secondaryTabId: null, primarySize: 50 } };
    const { rerender } = render(<WorkspaceShell {...props({ ...base, filePanel: panelFor("a") })} />);
    expect(screen.getByRole("alert").textContent).toContain("File panel");
    rerender(
      <WorkspaceShell
        {...props({
          ...base,
          activeTabId: "b",
          activeTabSummary: tab("b", "Beta"),
          filePanel: panelFor("b"),
          children: <p>beta view</p>,
        })}
      />,
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("beta files")).toBeTruthy();
  });

  it("a crash in pane 1's strip keeps the active view and the second pane", () => {
    render(
      <WorkspaceShell
        {...props({
          panes: {
            ...props({}).panes,
            renderSecondary: () => <p>beta view</p>,
            paneStrip: (_tab, number) => (number === 1 ? <Boom /> : null),
          },
        })}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("Pane 1 strip");
    expect(screen.getByText("alpha view")).toBeTruthy();
    expect(screen.getByText("beta view")).toBeTruthy();
    expect(screen.getByRole("tablist", { name: "Tabs" })).toBeTruthy();
  });

  it("a second pane whose render helper throws keeps the main pane and tab bar", () => {
    const panes = {
      ...props({}).panes,
      renderSecondary: () => {
        throw new Error("second pane broke");
      },
    };
    render(<WorkspaceShell {...props({ panes })} />);
    expect(screen.getByRole("alert").textContent).toContain("Second pane");
    expect(screen.getByText("alpha view")).toBeTruthy();
    expect(screen.getByRole("tablist", { name: "Tabs" })).toBeTruthy();
  });

  it("a pane 1 strip whose helper throws keeps the active view and the second pane", () => {
    const panes = {
      ...props({}).panes,
      renderSecondary: () => <p>beta view</p>,
      paneStrip: (_tab: TabSummary, number: number) => {
        if (number === 1) throw new Error("strip broke");
        return null;
      },
    };
    render(<WorkspaceShell {...props({ panes })} />);
    expect(screen.getByRole("alert").textContent).toContain("Pane 1 strip");
    expect(screen.getByText("alpha view")).toBeTruthy();
    expect(screen.getByText("beta view")).toBeTruthy();
    expect(screen.getByRole("tablist", { name: "Tabs" })).toBeTruthy();
  });

  it("a grid cell whose render helper throws keeps the other cells", () => {
    render(
      <WorkspaceShell
        {...props({
          showGrid: true,
          split: { mode: "grid", secondaryTabId: null, gridTabIds: ["a", "b"] },
          secondaryTab: undefined,
          panes: {
            ...props({}).panes,
            renderGridCell: () => {
              throw new Error("grid cell broke");
            },
          },
        })}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("Grid cell");
    expect(screen.getByText("alpha view")).toBeTruthy();
    expect(screen.getByRole("tablist", { name: "Tabs" })).toBeTruthy();
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
