import type { ProviderId } from "../provider/types";
import type { PreparedHandoff } from "./executor";
import { terminalHandoffInput } from "./map";

/**
 * What a manual terminal hand-off starts: the target role in a new tab, as
 * the source's provider, with the chain tag the tab is about to join. The
 * tab is tagged after it starts, so the start carries the chain: its stage
 * kind sets the permission mode (a copied Planner launches in plan mode).
 */
export function handoffTerminalStart(
  prepared: PreparedHandoff,
  targetRoleId: string,
  cwd: string,
  provider: ProviderId,
) {
  const terminal = terminalHandoffInput(prepared.mapped);
  const values: Record<string, string> = { ...terminal.values, cwd };
  return {
    roleId: targetRoleId,
    values,
    tabId: null,
    handoffPlan: terminal.handoffPlan,
    provider,
    chain: prepared.nextChain,
  };
}
