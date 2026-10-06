import type { StreamSegment } from "./transcript";
import { isActiveToolStatus } from "./transcript";

export function summarizeSessionActivity(
  segments: StreamSegment[],
  opts: { promptInFlight: boolean; waitingPermission: boolean },
): string | null {
  if (opts.waitingPermission) {
    return "Waiting for permission — approve or reject above to continue";
  }
  if (!opts.promptInFlight) return null;

  const activeTools = segments.filter(
    (s) => s.kind === "tool" && isActiveToolStatus(s.toolStatus),
  ).length;
  if (activeTools > 0) {
    return `Agent working — ${activeTools} active tool${activeTools === 1 ? "" : "s"}`;
  }
  return "Agent working…";
}
