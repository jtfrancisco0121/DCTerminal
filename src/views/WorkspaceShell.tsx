import type { Dispatch, ReactNode, SetStateAction } from "react";
import type { TabSummary } from "../bridge";
import { GridSplit } from "../components/GridSplit";
import { WorkspaceSplit } from "../components/WorkspaceSplit";
import { clampSplitSize, type SplitState } from "../tabChrome";
import type { PaneRenderers } from "./workspacePanes";

export type WorkspaceShellProps = {
  /** The tab strip. */
  tabBar: ReactNode;
  /** Dialogs, toasts and panels drawn over the workspace. */
  overlays: ReactNode;
  /** When set, the Settings page replaces the workspace body. */
  settings?: ReactNode;
  filePanel: ReactNode;
  firstUseTip: ReactNode;
  statusBar: ReactNode;
  showGrid: boolean;
  split: SplitState;
  setSplit: Dispatch<SetStateAction<SplitState>>;
  activeTabId: string | null;
  activeTabSummary: TabSummary | null | undefined;
  savedTabs: TabSummary[];
  /** The tab in the second pane of a split. */
  secondaryTab: TabSummary | undefined;
  focusedPane: "primary" | "secondary";
  setFocusedPane: (pane: "primary" | "secondary") => void;
  panes: Pick<PaneRenderers, "gridTone" | "gridCellBar" | "renderGridCell" | "renderSecondary">;
  /** The active tab's view. */
  children?: ReactNode;
};

/**
 * The workspace frame: tab strip, file panel, the active tab's view (alone,
 * split with a second tab, or in the grid), first-use tip, status bar and
 * overlays. With `settings`, the Settings page takes the body.
 */
export function WorkspaceShell({
  tabBar,
  overlays,
  settings,
  filePanel,
  firstUseTip,
  statusBar,
  showGrid,
  split,
  setSplit,
  activeTabId,
  activeTabSummary,
  savedTabs,
  secondaryTab,
  focusedPane,
  setFocusedPane,
  panes,
  children,
}: WorkspaceShellProps) {
  const { gridTone, gridCellBar, renderGridCell, renderSecondary } = panes;
  if (settings !== undefined) {
    return (
      <section className="workspace-shell">
        {tabBar}
        {settings}
        {overlays}
      </section>
    );
  }
  return (
    <section className="workspace-shell">
      {tabBar}
      <div className="workspace-body">
        {filePanel}
        <div className="workspace-main">
          {showGrid ? (
            <GridSplit
              ids={split.gridTabIds ?? []}
              renderCell={(tabId) => {
                if (tabId === activeTabId && activeTabSummary) {
                  return (
                    <div
                      className={`split-pane split-pane-primary split-pane-focused grid-cell grid-cell-active grid-cell-${gridTone(activeTabSummary)}`}
                      data-pane="primary"
                    >
                      {gridCellBar(activeTabSummary)}
                      <div className="grid-cell-main">{children}</div>
                    </div>
                  );
                }
                const tab = savedTabs.find((item) => item.id === tabId);
                return tab ? renderGridCell(tab) : null;
              }}
            />
          ) : (
            <WorkspaceSplit
              mode={secondaryTab ? split.mode : "single"}
              primarySize={clampSplitSize(split.primarySize)}
              onResize={(size) => {
                const next = clampSplitSize(size);
                setSplit((current) =>
                  Math.abs(clampSplitSize(current.primarySize) - next) < 0.5
                    ? current
                    : { ...current, primarySize: next },
                );
              }}
              primary={
                <div
                  className={
                    secondaryTab && focusedPane === "primary"
                      ? "split-pane split-pane-primary split-pane-focused"
                      : "split-pane split-pane-primary"
                  }
                  data-pane="primary"
                  onFocusCapture={() => setFocusedPane("primary")}
                  onMouseDown={() => setFocusedPane("primary")}
                >
                  {children}
                </div>
              }
              secondary={secondaryTab ? renderSecondary(secondaryTab) : null}
            />
          )}
        </div>
      </div>
      {firstUseTip}
      {statusBar}
      {overlays}
    </section>
  );
}
