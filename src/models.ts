import type { ModelEntry, ModelSettings, ModelVia, ProviderModelSettings } from "./bridge";
import type { ProviderId } from "./provider/types";

/** The app default. Not `composer-2.5-fast`. */
export const DEFAULT_MODEL_ID = "composer-2.5";

export const CLAUDE_DEFAULT_MODEL_ID = "default";

export function defaultModelSettings(): ModelSettings {
  return { defaultModel: DEFAULT_MODEL_ID, roleModels: {} };
}

export function defaultProviderModelSettings(): ProviderModelSettings {
  return {
    cursor: defaultModelSettings(),
    claude: { defaultModel: CLAUDE_DEFAULT_MODEL_ID, roleModels: {} },
  };
}

/** Same rule as Rust `valid_model_id`: never a flag, no spaces. `[1m]` is allowed. */
export function validModelId(id: string): boolean {
  return (
    id.length > 0 &&
    id.length <= 100 &&
    !id.startsWith("-") &&
    /^[A-Za-z0-9._:/[\]-]+$/.test(id)
  );
}

const CLAUDE_ALIASES = new Set([
  "default",
  "opus",
  "sonnet",
  "haiku",
  "fable",
  "opusplan",
  "best",
]);

/** Same rule as Rust `is_claude_model_id`. */
export function isClaudeModelId(id: string): boolean {
  const trimmed = id.trim();
  const base = trimmed.endsWith("[1m]") ? trimmed.slice(0, -4) : trimmed;
  if (!base || base.length > 100) return false;
  if (CLAUDE_ALIASES.has(base)) return true;
  const match = /^claude-(opus|sonnet|haiku|fable)-([a-z0-9.-]+)$/.exec(base);
  return !!match && /^[0-9]/.test(match[2]);
}

/** Tab override, then the role default, then the global default. */
export function effectiveModel(
  settings: ModelSettings | null,
  roleId: string | null,
  tabModel?: string | null,
): string {
  const tab = tabModel?.trim();
  if (tab && validModelId(tab)) return tab;
  const role = roleId ? settings?.roleModels[roleId]?.trim() : undefined;
  if (role && validModelId(role)) return role;
  const global = settings?.defaultModel?.trim();
  if (global && validModelId(global)) return global;
  return DEFAULT_MODEL_ID;
}

/** Model for a tab, from that provider's settings. A Cursor id never wins on Claude. */
export function effectiveModelFor(
  provider: ProviderId,
  settings: ProviderModelSettings | null,
  roleId: string | null,
  tabModel?: string | null,
): string {
  if (provider === "claude") {
    const slice = settings?.claude ?? { defaultModel: CLAUDE_DEFAULT_MODEL_ID, roleModels: {} };
    // A Cursor id stored on the tab must not replace the Claude role default.
    const tab = tabModel?.trim();
    const claudeTab = tab && isClaudeModelId(tab) ? tab : null;
    const picked = effectiveModel(slice, roleId, claudeTab);
    return isClaudeModelId(picked) ? picked : CLAUDE_DEFAULT_MODEL_ID;
  }
  return effectiveModel(settings?.cursor ?? null, roleId, tabModel);
}

/** Match id or label, every word of the query, case-insensitive. */
export function filterModels(models: ModelEntry[], query: string): ModelEntry[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return models;
  return models.filter((model) => {
    const hay = `${model.id} ${model.label} ${model.fast ? "fast" : ""}`.toLowerCase();
    return words.every((word) => hay.includes(word));
  });
}

export function modelLabel(models: ModelEntry[], id: string): string {
  return models.find((model) => model.id === id)?.label ?? id;
}

/** Short note for the transcript after a model change. */
export function modelChangeNote(model: string, via: ModelVia | null, restarted: boolean): string {
  if (via === null) return `Model set to ${model}. It applies when this session starts.`;
  if (restarted) {
    return `Model set to ${model}. The agent was restarted with --model and the session reopened.`;
  }
  if (via === "unchanged") return `Model is already ${model}.`;
  return `Model set to ${model}.`;
}

/**
 * Claude reasoning effort levels, as the adapter names them (captured from
 * `session/new`, adapter 0.88.0). A live session shows the levels it offers.
 */
export const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
