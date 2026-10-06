import type { ReactNode } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import type { SplitMode } from "../tabChrome";

type Props = {
  mode: SplitMode;
  primarySize: number;
  primary: ReactNode;
  secondary: ReactNode | null;
  onResize: (primarySize: number) => void;
};

/**
 * The main pane and the optional second pane. The group stays mounted when
 * the second pane opens or closes, so the main pane's content (a running
 * chat or terminal) is not remounted.
 */
export function WorkspaceSplit({ mode, primarySize, primary, secondary, onResize }: Props) {
  const open = mode !== "single" && secondary !== null;
  return (
    <PanelGroup
      direction={mode === "vertical" ? "vertical" : "horizontal"}
      className="workspace-split"
      onLayout={(sizes) => {
        if (open && sizes.length === 2 && Number.isFinite(sizes[0])) onResize(sizes[0]);
      }}
    >
      <Panel id="pane-primary" order={1} minSize={15} defaultSize={open ? primarySize : 100}>
        {primary}
      </Panel>
      {open && (
        <>
          <PanelResizeHandle
            className={mode === "vertical" ? "split-handle split-handle-row" : "split-handle"}
          />
          <Panel id="pane-secondary" order={2} minSize={15} defaultSize={100 - primarySize}>
            {secondary}
          </Panel>
        </>
      )}
    </PanelGroup>
  );
}
