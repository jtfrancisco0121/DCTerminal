import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_UI_SETTINGS, getUiSettings, setUiSettings, type UiSettings } from "./bridge";
import { setTerminalTheme } from "./terminal/park";
import { applyTheme, cachedTheme } from "./theme";

/**
 * U7/U8: theme, shortcut bar, and one-time tips, stored in settings.json in
 * DCTerminal's app data dir. Changes apply at once and are saved behind.
 */
export function useUiSettings() {
  const [ui, setUi] = useState<UiSettings>(() => ({
    ...DEFAULT_UI_SETTINGS,
    theme: cachedTheme(),
  }));
  const [loaded, setLoaded] = useState(false);
  const uiRef = useRef(ui);
  uiRef.current = ui;

  useEffect(() => {
    let cancelled = false;
    getUiSettings()
      .then((value) => {
        if (cancelled) return;
        setUi(value);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const theme = applyTheme(ui.theme);
    setTerminalTheme(theme);
  }, [ui.theme]);

  const save = useCallback((next: UiSettings) => {
    uiRef.current = next;
    setUi(next);
    // Apply now so the switch is instant, not one render later.
    setTerminalTheme(applyTheme(next.theme));
    void setUiSettings(next)
      .then((saved) => {
        if (saved) setUi(saved);
      })
      .catch(() => {});
  }, []);

  const update = useCallback(
    (patch: Partial<UiSettings>) => save({ ...uiRef.current, ...patch }),
    [save],
  );

  const markTipSeen = useCallback(
    (id: string) => {
      const current = uiRef.current;
      if (current.tipsSeen.includes(id)) return;
      save({ ...current, tipsSeen: [...current.tipsSeen, id] });
    },
    [save],
  );

  return { ui, loaded, update, markTipSeen };
}
