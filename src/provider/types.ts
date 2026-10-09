/** Claude-first plan, Phase 2: provider ids and the shapes the Rust side sends. */
import type { LoginStatus } from "../bridge";

export type ProviderId = "claude" | "cursor";

export const PROVIDER_IDS: ProviderId[] = ["claude", "cursor"];

/** Settings default for new and existing profiles. */
export const DEFAULT_PROVIDER: ProviderId = "claude";

export function isProviderId(value: unknown): value is ProviderId {
  return value === "claude" || value === "cursor";
}

/** `settings.json` → `providers`. */
export type ProvidersSettings = {
  default: ProviderId;
  /** Role id → provider, remembered by the Start card chip. */
  roleProvider: Record<string, string>;
  claude: { adapterPath?: string | null; claudePath?: string | null; configDir?: string | null };
  cursor: Record<string, never>;
};

/** Where the Claude config folder came from. */
export type ConfigDirSource = "env" | "setting" | "default";

export type ConfigDirInfo = {
  /** Absolute path (canonical when it exists). */
  path: string;
  /** Short form with `~`. */
  display: string;
  source: ConfigDirSource;
  exists: boolean;
};

export type ProviderSettingsView = {
  settings: ProvidersSettings;
  claudeConfigDir: ConfigDirInfo;
  /** `DCT_CLAUDE_CONFIG_DIR` when set; the setting is then ignored. */
  claudeConfigDirEnv: string | null;
};

export type ProviderStatus = {
  id: ProviderId;
  found: boolean;
  path: string | null;
  version: string | null;
  adapterFound: boolean;
  adapterPath: string | null;
  error: string | null;
};

export type ProviderReport = {
  status: ProviderStatus;
  login: LoginStatus;
  configDir: ConfigDirInfo | null;
  adapterInstall: string | null;
};

export function defaultProvidersSettings(): ProvidersSettings {
  return { default: DEFAULT_PROVIDER, roleProvider: {}, claude: {}, cursor: {} };
}

/** Start card choice for a role, else the default provider. */
export function providerForRole(settings: ProvidersSettings | null, roleId: string): ProviderId {
  const remembered = settings?.roleProvider[roleId];
  if (isProviderId(remembered)) return remembered;
  return settings?.default ?? DEFAULT_PROVIDER;
}
