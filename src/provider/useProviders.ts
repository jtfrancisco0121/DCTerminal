import { useCallback, useEffect, useState } from "react";
import {
  getProviderSettings,
  providerStatus,
  setProviderSettings,
  type ProviderReport,
  type ProviderSettingsView,
  type ProvidersSettings,
} from "../bridge";

export type ProvidersState = {
  view: ProviderSettingsView | null;
  claude: ProviderReport | null;
  cursor: ProviderReport | null;
  checking: boolean;
  error: string | null;
  /** Re-run detection and sign-in checks. */
  refresh: () => Promise<void>;
  /** Reload saved settings only (no CLI calls), e.g. after the Start card chip. */
  refreshSettings: () => Promise<void>;
  save: (next: ProvidersSettings) => Promise<void>;
};

/**
 * Provider settings plus detection for both providers. Detection runs the
 * CLIs (read-only), so it is loaded once and refreshed on demand.
 */
export function useProviders(enabled = true): ProvidersState {
  const [view, setView] = useState<ProviderSettingsView | null>(null);
  const [claude, setClaude] = useState<ProviderReport | null>(null);
  const [cursor, setCursor] = useState<ProviderReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      const [nextView, nextClaude, nextCursor] = await Promise.all([
        getProviderSettings(),
        providerStatus("claude"),
        providerStatus("cursor"),
      ]);
      setView(nextView);
      setClaude(nextClaude);
      setCursor(nextCursor);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setChecking(false);
    }
  }, []);

  const refreshSettings = useCallback(async () => {
    try {
      setView(await getProviderSettings());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const save = useCallback(
    async (next: ProvidersSettings) => {
      setError(null);
      try {
        const saved = await setProviderSettings(next);
        setView(saved);
        // The folder decides which account `claude auth status` reports.
        setClaude(await providerStatus("claude"));
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [],
  );

  useEffect(() => {
    if (!enabled) return;
    void refresh();
  }, [enabled, refresh]);

  return { view, claude, cursor, checking, error, refresh, refreshSettings, save };
}
