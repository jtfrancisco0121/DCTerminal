import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_UI_SETTINGS, getUiSettings, setUiSettings, type UiSettings } from "./bridge";
import { setTerminalTheme } from "./terminal/park";
import { errorText } from "./components/InlineNotice";
import {
  applyCustomColors,
  applyTheme,
  cachedCustomColors,
  cachedTheme,
  normalizeCustomColors,
  SYSTEM_THEME,
  watchSystemTheme,
} from "./theme";

/**
 * U7/U8: theme, custom colours, shortcut bar, and one-time tips, stored in settings.json in
 * DCTerminal's app data dir. Changes apply at once and are saved behind.
 */
export function useUiSettings(onError?: (title: string, message: string) => void) {
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const [ui, setUi] = useState<UiSettings>(() => ({
    ...DEFAULT_UI_SETTINGS,
    theme: cachedTheme(),
    customColors: cachedCustomColors(),
  }));
  const [loaded, setLoaded] = useState(false);
  const uiRef = useRef(ui);
  uiRef.current = ui;

  // Changes made before the first load resolves: kept on screen, then
  // replayed over the stored settings and saved, so defaults never overwrite them.
  const settledRef = useRef(false);
  const pendingRef = useRef<Array<(current: UiSettings) => UiSettings>>([]);
  const [firstLoad] = useState(() => {
    let settle: () => void = () => {};
    let fail: (err: Error) => void = () => {};
    const done = new Promise<void>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    // Only queued changes wait on it; nobody waiting is not an error.
    done.catch(() => {});
    return { done, settle, fail, saved: Promise.resolve() };
  });

  const write = useCallback(
    (value: UiSettings): Promise<void> =>
      Promise.resolve(setUiSettings(value)).then((saved) => {
        if (saved) setUi(saved);
      }),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    getUiSettings()
      .then((value) => {
        if (cancelled) return;
        const merged = pendingRef.current.reduce((current, edit) => edit(current), value);
        uiRef.current = merged;
        setUi(merged);
      })
      .catch((err: unknown) =>
        onErrorRef.current?.("Display settings did not load", errorText(err)),
      )
      .finally(() => {
        if (cancelled) return;
        settledRef.current = true;
        setLoaded(true);
        if (pendingRef.current.length > 0) {
          pendingRef.current = [];
          firstLoad.saved = write(uiRef.current);
        }
        firstLoad.settle();
      });
    return () => {
      cancelled = true;
      // Unmounted before the load: queued changes are not saved, so their
      // callers hear it instead of waiting forever. (StrictMode's extra
      // cleanup runs before anything can be queued.)
      if (!settledRef.current && pendingRef.current.length > 0) {
        pendingRef.current = [];
        firstLoad.fail(new Error("Display settings closed before they loaded"));
      }
    };
  }, [firstLoad, write]);

  // A stable key, so a reload with the same colours does not repaint.
  const customKey = JSON.stringify(normalizeCustomColors(ui.customColors));
  useEffect(() => {
    const custom = applyCustomColors(JSON.parse(customKey));
    const theme = applyTheme(ui.theme);
    setTerminalTheme(theme, custom);
    // "Match system" follows the OS setting live.
    if (ui.theme === SYSTEM_THEME) {
      return watchSystemTheme(() => setTerminalTheme(applyTheme(SYSTEM_THEME), custom));
    }
  }, [ui.theme, customKey]);

  /** Applies and saves. Rejects when the save fails, so a caller can show it. */
  const persist = useCallback(
    (edit: (current: UiSettings) => UiSettings): Promise<void> => {
      const next = edit(uiRef.current);
      uiRef.current = next;
      setUi(next);
      // Apply now so the switch is instant, not one render later.
      setTerminalTheme(applyTheme(next.theme), applyCustomColors(next.customColors));
      if (settledRef.current) return write(next);
      // Saved once the stored settings are in, with this change on top.
      pendingRef.current.push(edit);
      return firstLoad.done.then(() => firstLoad.saved);
    },
    [firstLoad, write],
  );

  /** Fire and forget: a failed save is shown as a toast. */
  const save = useCallback(
    (edit: (current: UiSettings) => UiSettings) => {
      void persist(edit).catch((err: unknown) =>
        onErrorRef.current?.("Display settings not saved", errorText(err)),
      );
    },
    [persist],
  );

  const update = useCallback(
    (patch: Partial<UiSettings>) => save((current) => ({ ...current, ...patch })),
    [save],
  );

  /** Like update, but the returned promise rejects when the save fails. */
  const updateChecked = useCallback(
    (patch: Partial<UiSettings>) => persist((current) => ({ ...current, ...patch })),
    [persist],
  );

  const markTipSeen = useCallback(
    (id: string) => {
      if (uiRef.current.tipsSeen.includes(id)) return;
      save((current) =>
        current.tipsSeen.includes(id) ? current : { ...current, tipsSeen: [...current.tipsSeen, id] },
      );
    },
    [save],
  );

  return { ui, loaded, update, updateChecked, markTipSeen };
}
