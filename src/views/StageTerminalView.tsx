/**
 * A terminal view that follows a bridged pipeline stage's typing rules
 * (V5, D27): read-only while autopilot drives the stage, open while it
 * needs you or you took it over, with Take over and Hand back on its bar.
 * Any other terminal renders exactly as `TerminalView`.
 */
import type { BridgeTag } from "../bridge";
import { TerminalView, type TerminalViewProps } from "../components/TerminalView";
import { useStageWatch } from "../terminal/useStageWatch";

type Props = Omit<TerminalViewProps, "watch"> & {
  tab: { id: string; bridge?: BridgeTag | null };
  /** The stage needs you now (a permission dialog, a question, a plan). */
  needsYou: boolean;
  onNotice: (title: string, body: string) => void;
};

export function StageTerminalView({ tab, needsYou, onNotice, ...props }: Props) {
  const watch = useStageWatch(tab, needsYou, onNotice);
  return <TerminalView {...props} watch={watch} />;
}
