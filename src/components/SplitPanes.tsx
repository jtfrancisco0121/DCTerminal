import type { ReactNode } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import type { SplitMode } from "../tabChrome";

type Props = {
  mode: SplitMode;
  primary: ReactNode;
  secondary: ReactNode | null;
};

export function SplitPanes({ mode, primary, secondary }: Props) {
  if (mode === "single" || !secondary) return <>{primary}</>;
  return (
    <PanelGroup
      direction={mode === "horizontal" ? "horizontal" : "vertical"}
      className="split-group"
    >
      <Panel minSize={20} defaultSize={50}>
        {primary}
      </Panel>
      <PanelResizeHandle className="split-handle" />
      <Panel minSize={20} defaultSize={50}>
        {secondary}
      </Panel>
    </PanelGroup>
  );
}
