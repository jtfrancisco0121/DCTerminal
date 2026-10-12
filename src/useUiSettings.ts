import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_UI_SETTINGS, getUiSettings, setUiSettings, type UiSettings } from "./bridge";
import { setTerminalTheme } from "./terminal/park";
import { errorText } from "./components/InlineNotice";
import { applyTheme, cachedTheme, SYSTEM_THEME, watchSystemTheme } from "./theme";

/**
 * U7/U8: theme, shortcut bar, and one-time tips, stored in settings.json in
 * DCTerminal's app data dir. Changes apply at once and are saved behind.
 */
export function useUiSettings(onError?: (title: string, message: string) => void) {
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
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
      .catch((err: unknown) =>
        onErrorRef.current?.("Display settings did not load", errorText(err)),
      )
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
    // "Match system" follows the OS setting live.
    if (ui.theme === SYSTEM_THEME) {
      return watchSystemTheme(() => setTerminalTheme(applyTheme(SYSTEM_THEME)));
    }
  }, [ui.theme]);

  /** Applies and saves. Rejects when the save fails, so a caller can show it. */
  const persist = useCallback((next: UiSettings): Promise<void> => {
    uiRef.current = next;
    setUi(next);
    // Apply now so the switch is instant, not one render later.
    setTerminalTheme(applyTheme(next.theme));
    return Promise.resolve(setUiSettings(next)).then((saved) => {
      if (saved) setUi(saved);
    });
  }, []);

  /** Fire and forget: a failed save is shown as a toast. */
  const save = useCallback((next: UiSettings) => {
    void persist(next).catch((err: unknown) =>
      onErrorRef.current?.("Display settings not saved", errorText(err)),
    );
  }, [persist]);

  const update = useCallback(
    (patch: Partial<UiSettings>) => save({ ...uiRef.current, ...patch }),
    [save],
  );

  /** Like update, but the returned promise rejects when the save fails. */
  const updateChecked = useCallback(
    (patch: Partial<UiSettings>) => persist({ ...uiRef.current, ...patch }),
    [persist],
  );

  const markTipSeen = useCallback(
    (id: string) => {
      const current = uiRef.current;
      if (current.tipsSeen.includes(id)) return;
      save({ ...current, tipsSeen: [...current.tipsSeen, id] });
    },
    [save],
  );

  return { ui, loaded, update, updateChecked, markTipSeen };
}
