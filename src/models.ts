import type { ModelEntry, ModelSettings, ModelVia } from "./bridge";

/** The app default. Not `composer-2.5-fast`. */
export const DEFAULT_MODEL_ID = "composer-2.5";

export function defaultModelSettings(): ModelSettings {
  return { defaultModel: DEFAULT_MODEL_ID, roleModels: {} };
}

/** Same rule as Rust `valid_model_id`: never a flag, no spaces. */
export function validModelId(id: string): boolean {
  return (
    id.length > 0 &&
    id.length <= 100 &&
    !id.startsWith("-") &&
    /^[A-Za-z0-9._:/-]+$/.test(id)
  );
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
