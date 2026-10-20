import type { ProviderModelSettings, TabSummary } from "../bridge";
import { effectiveModelFor } from "../models";

/** D12a: what the overview says about a stage that asked for auto mode on Haiku. */
export const HAIKU_DEFAULT_MODE_NOTE =
  "Runs on Haiku, where auto mode is unavailable: Claude silently uses default mode instead, so it asks before risky actions more often.";

/** `haiku`, `claude-haiku-…`, with or without `[1m]`. */
export function isHaikuModel(id: string): boolean {
  const trimmed = id.trim();
  const base = trimmed.endsWith("[1m]") ? trimmed.slice(0, -4) : trimmed;
  return base === "haiku" || base.startsWith("claude-haiku-");
}

/**
 * The D12a note for a Claude stage launched in `auto` whose model (the
 * tab's own, then the role's, then the Claude default) is Haiku; else null.
 */
export function haikuDefaultModeNote(
  tab: TabSummary | undefined,
  settings: ProviderModelSettings | null | undefined,
): string | null {
  if (!tab || tab.provider !== "claude" || tab.permissionMode !== "auto") return null;
  const model = effectiveModelFor("claude", settings ?? null, tab.roleId || null, tab.model);
  return isHaikuModel(model) ? HAIKU_DEFAULT_MODE_NOTE : null;
}
