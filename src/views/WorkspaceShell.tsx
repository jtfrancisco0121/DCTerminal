import type { Dispatch, ReactNode, SetStateAction } from "react";
import type { TabSummary } from "../bridge";
import { GridSplit } from "../components/GridSplit";
import { PaneBoundary } from "../components/PaneBoundary";
import { WorkspaceSplit } from "../components/WorkspaceSplit";
import { PreviewLayer, PreviewSlotProvider, usePreviewSlots } from "../preview/PreviewLayer";
import { clampSplitSize, type SplitState } from "../tabChrome";
import { viewLabel } from "./paneLabel";
import type { PaneRenderers } from "./workspacePanes";

/**
 * Calls a pane helper during its own render, so an error the helper throws
 * lands in the PaneBoundary around it rather than in the shell. No DOM.
 */
function RenderInBoundary({ render }: { render: () => ReactNode }) {
  return <>{render()}</>;
}

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
  panes: Pick<
    PaneRenderers,
    "gridTone" | "gridCellBar" | "renderGridCell" | "renderSecondary" | "paneStrip"
  >;
  /** A preview tab's page; it stays mounted while the tab exists (see PreviewLayer). */
  renderPreview: (tabId: string) => ReactNode;
  /** The active tab's view. */
  children?: ReactNode;
};

/**
 * The workspace frame: tab strip, file panel, the active tab's view (alone,
 * split with a second tab, or in the grid), first-use tip, status bar and
 * overlays. With `settings`, the Settings page takes the body. Each pane and
 * view sits in its own PaneBoundary, so one crash leaves the rest working.
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
  renderPreview,
  children,
}: WorkspaceShellProps) {
  const { gridTone, gridCellBar, renderGridCell, renderSecondary, paneStrip } = panes;
  const { slots, register } = usePreviewSlots();
  // Keyed, so it is the same layer (and the same iframes) with or without Settings.
  const previews = (
    <PreviewLayer
      key="preview-layer"
      tabIds={savedTabs.filter((tab) => tab.kind === "preview").map((tab) => tab.id)}
      slots={slots}
      render={(tabId) => (
        <PaneBoundary label="Preview" paneId={`preview:${tabId}`}>
          {renderPreview(tabId)}
        </PaneBoundary>
      )}
    />
  );
  if (settings !== undefined) {
    return (
      <PreviewSlotProvider register={register}>
        <section className="workspace-shell">
          {tabBar}
          <PaneBoundary label="Settings" paneId="settings">
            {settings}
          </PaneBoundary>
          {overlays}
          {previews}
        </section>
      </PreviewSlotProvider>
    );
  }
  // The active tab's view; a crash clears when another tab takes the pane.
  const activeView = (
    <PaneBoundary label={viewLabel(activeTabSummary)} paneId={activeTabId} resetKey={activeTabId}>
      {children}
    </PaneBoundary>
  );
  return (
    <PreviewSlotProvider register={register}>
      <section className="workspace-shell">
        {tabBar}
        <div className="workspace-body">
          {filePanel && (
            // The panel follows the active tab, so a crash clears on a tab switch.
            <PaneBoundary label="File panel" paneId="files" resetKey={activeTabId}>
              {filePanel}
            </PaneBoundary>
          )}
          <div className="workspace-main">
            {showGrid ? (
              <GridSplit
                ids={split.gridTabIds ?? []}
                renderCell={(tabId) => {
                  if (tabId === activeTabId && activeTabSummary) {
                    return (
                      <PaneBoundary label="Grid cell">
                        <RenderInBoundary
                          render={() => (
                            <div
                              className={`split-pane split-pane-primary split-pane-focused grid-cell grid-cell-active grid-cell-${gridTone(activeTabSummary)}`}
                              data-pane="primary"
                            >
                              {gridCellBar(activeTabSummary)}
                              <div className="grid-cell-main">{activeView}</div>
                            </div>
                          )}
                        />
                      </PaneBoundary>
                    );
                  }
                  const tab = savedTabs.find((item) => item.id === tabId);
                  return tab ? (
                    <PaneBoundary label="Grid cell">
                      <RenderInBoundary render={() => renderGridCell(tab)} />
                    </PaneBoundary>
                  ) : null;
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
                      !secondaryTab
                        ? "split-pane split-pane-primary"
                        : focusedPane === "primary"
                          ? "split-pane split-pane-primary split-pane-focused"
                          : "split-pane split-pane-primary split-pane-dim"
                    }
                    data-pane="primary"
                    onFocusCapture={() => setFocusedPane("primary")}
                    onMouseDown={() => setFocusedPane("primary")}
                  >
                    {/* Pane 1's strip shows only while a second pane is open. */}
                    {secondaryTab && activeTabSummary && (
                      <PaneBoundary label="Pane 1 strip" resetKey={activeTabId}>
                        <RenderInBoundary render={() => paneStrip(activeTabSummary, 1, focusedPane === "primary")} />
                      </PaneBoundary>
                    )}
                    {activeView}
                  </div>
                }
                secondary={
                  secondaryTab ? (
                    <PaneBoundary label="Second pane" resetKey={secondaryTab.id}>
                      <RenderInBoundary render={() => renderSecondary(secondaryTab)} />
                    </PaneBoundary>
                  ) : null
                }
              />
            )}
          </div>
        </div>
        {firstUseTip}
        {statusBar}
        {overlays}
        {previews}
      </section>
    </PreviewSlotProvider>
  );
}
