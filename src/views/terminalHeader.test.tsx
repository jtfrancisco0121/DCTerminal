// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TabSummary } from "../bridge";
import { folderName, terminalHeaderFor, type TerminalHeaderDeps } from "./terminalHeader";

const tab = (partial: Partial<TabSummary> = {}): TabSummary => ({
  id: "t1",
  label: "Plan Reviewer · Effort picker",
  roleId: "role_plan_reviewer",
  cwd: "/Users/jt/app",
  phase: "running",
  mergedPromptChars: 0,
  startupPromptSent: true,
  hasTranscript: false,
  folderStatus: "ok",
  color: "#58a6ff",
  kind: "terminal",
  terminalLaunch: "role",
  acpSessionId: null,
  ...partial,
});

const deps = (partial: Partial<TerminalHeaderDeps> = {}): TerminalHeaderDeps => ({
  roles: [],
  roleColors: {},
  controls: {
    modelPickerFor: () => null,
    changesButton: () => <button type="button">Changes</button>,
    activityButton: () => <button type="button">Activity</button>,
  } as unknown as TerminalHeaderDeps["controls"],
  terminalStates: { t1: { kind: "idle" } },
  tabStatuses: {},
  workingSince: {},
  sessionLogs: { t1: { turnDone: true } as never },
  terminalVerdict: { tabId: "t1", verdict: "APPROVED" },
  isTerminalSource: () => true,
  busy: false,
  openTerminalHandoff: vi.fn(async () => {}),
  openChainOverviewTab: vi.fn(async () => {}),
  readTerminalVerdict: vi.fn(),
  stopTerminalTurn: vi.fn(),
  ...partial,
});

describe("terminalHeaderFor (grid cells and second pane)", () => {
  it("shows the cell's state and next-step action, scoped to its own tab", () => {
    const d = deps();
    render(<>{terminalHeaderFor(d, tab(), { compact: true, controls: false })}</>);
    expect(screen.getByRole("status").textContent).toBe("Done · APPROVED");
    expect(screen.queryByRole("button", { name: "Changes" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Send to/ }));
    expect(d.openTerminalHandoff).toHaveBeenCalledWith(expect.any(String), "t1");
  });

  it("shows a working cell with Stop, and an exited cell with its code", () => {
    const d = deps({ terminalStates: { t1: { kind: "working" } } });
    const { unmount } = render(<>{terminalHeaderFor(d, tab(), { compact: true })}</>);
    expect(screen.getByRole("status").textContent).toMatch(/^Working/);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(d.stopTerminalTurn).toHaveBeenCalledWith("t1");
    expect(screen.getByRole("button", { name: "Changes" })).toBeTruthy();
    unmount();
    render(
      <>
        {terminalHeaderFor(deps({ terminalStates: { t1: { kind: "exited", code: 1 } } }), tab(), {
          compact: true,
        })}
      </>,
    );
    expect(screen.getByRole("status").textContent).toBe("Exited · code 1");
  });

  it("counts each tab's working time from its own start, across a tab switch", () => {
    const now = Date.now();
    const d = deps({
      terminalStates: { t1: { kind: "working" }, t2: { kind: "working" } },
      workingSince: { t1: now - 185_000, t2: now - 5_000 },
    });
    // One header element re-rendered for another tab, as the active tab's header is.
    const { container, rerender } = render(<>{terminalHeaderFor(d, tab())}</>);
    const pill = () => container.querySelector(".terminal-header-pill")!.textContent;
    expect(pill()).toBe("Working · 3m 05s");
    rerender(<>{terminalHeaderFor(d, tab({ id: "t2" }))}</>);
    expect(pill()).toMatch(/^Working · [5-6]s$/);
    rerender(<>{terminalHeaderFor(d, tab())}</>);
    expect(pill()).toMatch(/^Working · 3m 0[5-6]s$/);
  });

  it("says which kind of prompt needs the user", () => {
    render(
      <>
        {terminalHeaderFor(
          deps({
            terminalStates: {
              t1: { kind: "needs", needs: "permission", toolId: "x", toolTitle: "Bash" },
            },
          }),
          tab(),
          { compact: true },
        )}
      </>,
    );
    expect(screen.getByRole("status").textContent).toBe("Needs you: permission request");
  });

  it("names a plain shell Terminal and has no hand-off", () => {
    render(
      <>
        {terminalHeaderFor(
          deps({ isTerminalSource: () => false, terminalStates: {} }),
          tab({ terminalLaunch: "", label: "zsh" }),
          { compact: true },
        )}
      </>,
    );
    expect(screen.getByText("Terminal")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Send to/ })).toBeNull();
    expect(folderName("C:\\Projects\\app\\")).toBe("app");
  });

  it("offers the Plan pane toggle in a pipeline tab's own header only", () => {
    const chain = { chainId: "ee_1", kind: "eagle1", step: 2, total: 4 } as TabSummary["chain"];
    const { unmount } = render(<>{terminalHeaderFor(deps(), tab({ chain }), { viewSwitch: true })}</>);
    expect(screen.getByRole("button", { name: "Plan" }).getAttribute("aria-pressed")).toBe("false");
    unmount();
    render(<>{terminalHeaderFor(deps(), tab({ chain }), { compact: true })}</>);
    expect(screen.queryByRole("button", { name: "Plan" })).toBeNull();
  });

  it("has no Plan pane toggle off a pipeline", () => {
    render(<>{terminalHeaderFor(deps(), tab(), { viewSwitch: true })}</>);
    expect(screen.queryByRole("button", { name: "Plan" })).toBeNull();
  });
});
