/**
 * Settings > Appearance: theme swatch cards, a status-pill preview, and
 * custom colour overrides.
 *
 * The swatch-card grid follows the Themes tab of Agentic IDE's
 * SettingsPanel (better-agentic-ide, MIT License, © Alvin Reyes).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { UiSettings } from "../bridge";
import { setTerminalTheme } from "../terminal/park";
import {
  applyCustomColors,
  CUSTOM_COLOR_FIELDS,
  normalizeCustomColors,
  normalizeTheme,
  resolveTheme,
  TERMINAL_THEMES,
  THEME_CHOICES,
  THEMES,
  type CustomColorKey,
  type CustomColors,
  type ThemeId,
} from "../theme";
import { isTabStop, radioProps, RadioGroup } from "./RadioGroup";

type Props = {
  uiSettings?: UiSettings | null;
  onUiSettings?: (patch: Partial<UiSettings>) => void | Promise<unknown>;
};

const SWATCH_NAMES = ["Background", "Accent", "Success", "Attention", "Done"];

/** A dragged colour input fires on every move; it is saved once it settles. */
export const CUSTOM_COLOR_SAVE_DELAY_MS = 300;

/** The preset's own colour for a custom-colour field (what the input shows when unset). */
function presetColor(theme: ThemeId, key: CustomColorKey): string {
  const [background, accent, , attention, done] =
    THEMES.find((item) => item.id === theme)?.swatch ?? THEMES[0].swatch;
  switch (key) {
    case "background":
      return background;
    case "text":
      return (TERMINAL_THEMES[theme].foreground as string) ?? "#ffffff";
    case "accent":
    case "working":
      return accent;
    case "needsYou":
      return attention;
    case "done":
      return done;
  }
}

export function ThemePicker({ uiSettings, onUiSettings }: Props) {
  const current = normalizeTheme(uiSettings?.theme);
  const shown = resolveTheme(current);
  const saved = normalizeCustomColors(uiSettings?.customColors);
  // Colours picked but not saved yet: shown and applied live, saved after a pause.
  const [draft, setDraft] = useState<CustomColors | null>(null);
  const custom = draft ?? saved;
  const hasCustom = Object.keys(custom).length > 0;
  const disabled = !onUiSettings;

  const onUiSettingsRef = useRef(onUiSettings);
  onUiSettingsRef.current = onUiSettings;
  const pendingRef = useRef<CustomColors | null>(null);
  const timerRef = useRef<number | null>(null);
  const cancelSave = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    pendingRef.current = null;
  };
  const flush = useCallback(() => {
    const next = pendingRef.current;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    pendingRef.current = null;
    if (!next) return;
    void onUiSettingsRef.current?.({ customColors: next });
    setDraft(null);
  }, []);
  // Closing Settings mid-drag still saves the last colour.
  useEffect(() => flush, [flush]);

  const setCustom = (key: CustomColorKey, value: string) => {
    const next: CustomColors = { ...custom, [key]: value };
    pendingRef.current = next;
    setDraft(next);
    applyCustomColors(next);
    // Only the background and text colours reach the terminal palette.
    if (key === "background" || key === "text") setTerminalTheme(shown, next);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(flush, CUSTOM_COLOR_SAVE_DELAY_MS);
  };

  return (
    <>
      <span className="field-label" aria-hidden="true">
        Theme
      </span>
      <RadioGroup label="Theme" className="theme-picker">
        {THEME_CHOICES.map((choice, index) => {
          const checked = choice.id === current;
          const swatch =
            THEMES.find((item) => item.id === resolveTheme(choice.id))?.swatch ?? THEMES[0].swatch;
          return (
            <button
              key={choice.id}
              type="button"
              className={`theme-card${checked ? " theme-card-current" : ""}`}
              disabled={disabled}
              onClick={() => {
                if (checked) return;
                flush();
                void onUiSettings?.({ theme: choice.id });
              }}
              {...radioProps(checked, isTabStop(checked, true, index))}
            >
              <span className="theme-card-dots" aria-hidden="true">
                {swatch.map((color, at) => (
                  <span
                    key={SWATCH_NAMES[at]}
                    className="theme-card-dot"
                    style={{ background: color }}
                  />
                ))}
              </span>
              <span className="theme-card-label">{choice.label}</span>
            </button>
          );
        })}
      </RadioGroup>
      <p className="hint">
        Match system follows your operating system&apos;s light or dark setting and changes
        with it.
      </p>
      <div className="theme-status-preview" aria-label="Status colours" role="group">
        <span className="theme-pill theme-pill-working">Working</span>
        <span className="theme-pill theme-pill-needs">Needs you</span>
        <span className="theme-pill theme-pill-done">Done</span>
        <span className="theme-pill theme-pill-exited">Exited</span>
      </div>

      <div className="theme-custom-head">
        <h4>Custom colours</h4>
        <button
          type="button"
          className="secondary-button"
          disabled={disabled || !hasCustom}
          onClick={() => {
            cancelSave();
            setDraft(null);
            void onUiSettings?.({ customColors: {} });
          }}
        >
          Reset
        </button>
      </div>
      <p className="hint">These replace the theme&apos;s colours until you reset them.</p>
      <div className="theme-custom-grid">
        {CUSTOM_COLOR_FIELDS.map((field) => (
          <label key={field.key} className="theme-custom-field">
            <input
              type="color"
              value={custom[field.key] ?? presetColor(shown, field.key)}
              disabled={disabled}
              onChange={(event) => setCustom(field.key, event.target.value)}
              onBlur={flush}
            />
            {field.label}
          </label>
        ))}
      </div>
    </>
  );
}
