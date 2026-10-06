import { useEffect, useMemo, useRef, useState } from "react";
import type { ModelEntry } from "../bridge";
import { filterModels, modelLabel } from "../models";

type Props = {
  models: ModelEntry[];
  /** Selected id. `null` means "use the inherited model". */
  value: string | null;
  /** Shown (and used) when `value` is null. Omit to require a concrete model. */
  inherited?: { model: string; label: string } | null;
  ariaLabel: string;
  disabled?: boolean;
  compact?: boolean;
  onChange: (model: string | null) => void;
};

/** Searchable model list. Fast variants carry a badge. */
export function ModelPicker({
  models,
  value,
  inherited = null,
  ariaLabel,
  disabled = false,
  compact = false,
  onChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const shown = value ?? inherited?.model ?? "";
  const shownEntry = models.find((model) => model.id === shown);

  const options = useMemo(() => {
    const list: { id: string | null; label: string; fast: boolean; hint?: string }[] = [];
    if (inherited && !query.trim()) {
      list.push({
        id: null,
        label: `${inherited.label}: ${modelLabel(models, inherited.model)}`,
        fast: false,
        hint: "default",
      });
    }
    for (const model of filterModels(models, query)) {
      list.push({ id: model.id, label: model.label, fast: model.fast, hint: model.id });
    }
    // A saved id the list no longer has must stay selectable.
    if (value && !models.some((model) => model.id === value) && !query.trim()) {
      list.push({ id: value, label: value, fast: false, hint: "not in the list" });
    }
    return list;
  }, [inherited, models, query, value]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => setCursor(0), [query, open]);

  const choose = (id: string | null) => {
    setOpen(false);
    setQuery("");
    onChange(id);
  };

  return (
    <div className={compact ? "model-picker model-picker-compact" : "model-picker"} ref={rootRef}>
      <button
        type="button"
        className="model-picker-button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        title={shown ? `Model: ${shown}` : ariaLabel}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="model-picker-value">{shownEntry?.label ?? (shown || "Choose a model")}</span>
        {shownEntry?.fast && <span className="model-badge">Fast</span>}
        {value === null && inherited && <span className="hint">default</span>}
      </button>
      {open && (
        <div className="model-picker-popover" data-own-escape="" role="dialog" aria-label={`${ariaLabel} list`}>
          <input
            className="text-input"
            autoFocus
            placeholder={`Search ${models.length} models`}
            aria-label="Search models"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setCursor((n) => Math.min(n + 1, options.length - 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setCursor((n) => Math.max(n - 1, 0));
              } else if (event.key === "Enter") {
                event.preventDefault();
                const pick = options[cursor];
                if (pick) choose(pick.id);
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setOpen(false);
              }
            }}
          />
          <ul className="model-picker-list" role="listbox" aria-label={ariaLabel}>
            {options.map((option, index) => (
              <li key={option.id ?? "__inherit__"}>
                <button
                  type="button"
                  role="option"
                  aria-selected={option.id === value}
                  className={index === cursor ? "model-option model-option-active" : "model-option"}
                  onMouseEnter={() => setCursor(index)}
                  onClick={() => choose(option.id)}
                >
                  <span>{option.label}</span>
                  {option.fast && <span className="model-badge">Fast</span>}
                  {option.hint && <span className="hint">{option.hint}</span>}
                </button>
              </li>
            ))}
            {options.length === 0 && <li className="hint">No models match</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
