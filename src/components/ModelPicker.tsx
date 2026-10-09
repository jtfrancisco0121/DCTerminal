import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
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

type PopoverPos = {
  top?: number;
  bottom?: number;
  left: number;
  width: number;
  maxHeight: number;
};

const POPOVER_WIDTH = 320;
const VIEW_PAD = 8;
const GAP = 4;
const PREFERRED_MAX_H = 280;

function placePopover(anchor: DOMRect): PopoverPos {
  const width = Math.min(POPOVER_WIDTH, window.innerWidth - VIEW_PAD * 2);
  const spaceBelow = window.innerHeight - anchor.bottom - GAP - VIEW_PAD;
  const spaceAbove = anchor.top - GAP - VIEW_PAD;
  // Prefer below when there is room; flip up near the bottom of the window
  // (startup form actions) or when above clearly has more space.
  const openUp = spaceBelow < 180 && spaceAbove > spaceBelow;
  const maxHeight = Math.max(120, Math.min(PREFERRED_MAX_H, openUp ? spaceAbove : spaceBelow));

  // Align to the trigger's right edge (matches the old CSS), then clamp.
  let left = anchor.right - width;
  if (left < VIEW_PAD) left = VIEW_PAD;
  if (left + width > window.innerWidth - VIEW_PAD) {
    left = Math.max(VIEW_PAD, window.innerWidth - VIEW_PAD - width);
  }

  if (openUp) {
    return {
      bottom: window.innerHeight - anchor.top + GAP,
      left,
      width,
      maxHeight,
    };
  }
  return {
    top: anchor.bottom + GAP,
    left,
    width,
    maxHeight,
  };
}

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
  const [pos, setPos] = useState<PopoverPos | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const shown = value ?? inherited?.model ?? "";
  const shownEntry = models.find((model) => model.id === shown);

  const options = useMemo(() => {
    const list: {
      id: string | null;
      label: string;
      fast: boolean;
      badge?: string | null;
      idHint?: string;
      isDefault?: boolean;
    }[] = [];
    if (inherited && !query.trim()) {
      list.push({
        id: null,
        label: `${inherited.label}: ${modelLabel(models, inherited.model)}`,
        fast: false,
        isDefault: true,
      });
    }
    for (const model of filterModels(models, query)) {
      list.push({
        id: model.id,
        label: model.label,
        fast: model.fast,
        badge: model.badge,
        idHint: model.id,
      });
    }
    // A saved id the list no longer has must stay selectable.
    if (value && !models.some((model) => model.id === value) && !query.trim()) {
      list.push({ id: value, label: value, fast: false, idHint: "not in the list" });
    }
    return list;
  }, [inherited, models, query, value]);

  const updatePosition = () => {
    const anchor = buttonRef.current?.getBoundingClientRect();
    if (!anchor) return;
    setPos(placePopover(anchor));
  };

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    updatePosition();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onReposition = () => updatePosition();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("resize", onReposition);
    window.addEventListener("scroll", onReposition, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", onReposition);
      window.removeEventListener("scroll", onReposition, true);
    };
  }, [open]);

  useEffect(() => setCursor(0), [query, open]);

  useEffect(() => {
    if (!open) return;
    const item = listRef.current?.querySelector<HTMLElement>(`[data-cursor="${cursor}"]`);
    item?.scrollIntoView?.({ block: "nearest" });
  }, [cursor, open, options.length]);

  const choose = (id: string | null) => {
    setOpen(false);
    setQuery("");
    onChange(id);
  };

  const popover =
    open &&
    pos &&
    createPortal(
      <div
        ref={popoverRef}
        className="model-picker-popover"
        data-own-escape=""
        role="dialog"
        aria-label={`${ariaLabel} list`}
        style={{
          position: "fixed",
          top: pos.top,
          bottom: pos.bottom,
          left: pos.left,
          width: pos.width,
          maxHeight: pos.maxHeight,
          zIndex: 40,
        }}
      >
        <input
          className="text-input model-picker-search"
          autoFocus
          placeholder={`Search ${models.length} models`}
          aria-label="Search models"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setCursor((n) => Math.min(n + 1, Math.max(options.length - 1, 0)));
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
        <ul className="model-picker-list" role="listbox" aria-label={ariaLabel} ref={listRef}>
          {options.map((option, index) => (
            <li key={option.id ?? "__inherit__"}>
              <button
                type="button"
                role="option"
                data-cursor={index}
                aria-selected={option.id === value}
                className={
                  index === cursor ? "model-option model-option-active" : "model-option"
                }
                onMouseEnter={() => setCursor(index)}
                onClick={() => choose(option.id)}
              >
                <span className="model-option-main">
                  <span className="model-option-label">{option.label}</span>
                  {option.idHint && option.idHint !== option.label && (
                    <span className="model-option-id">{option.idHint}</span>
                  )}
                </span>
                <span className="model-option-meta">
                  {option.fast && <span className="model-badge">Fast</span>}
                  {option.badge && <span className="model-badge">{option.badge}</span>}
                  {option.isDefault && <span className="model-default-badge">default</span>}
                </span>
              </button>
            </li>
          ))}
          {options.length === 0 && (
            <li className="model-picker-empty">No models match</li>
          )}
        </ul>
      </div>,
      document.body,
    );

  return (
    <div
      className={compact ? "model-picker model-picker-compact" : "model-picker"}
      ref={rootRef}
    >
      <button
        type="button"
        ref={buttonRef}
        className="model-picker-button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        title={shown ? `Model: ${shown}` : ariaLabel}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="model-picker-value">
          {shownEntry?.label ?? (shown || "Choose a model")}
        </span>
        {shownEntry?.fast && <span className="model-badge">Fast</span>}
        {shownEntry?.badge && <span className="model-badge">{shownEntry.badge}</span>}
        {value === null && inherited && <span className="model-default-badge">default</span>}
      </button>
      {popover}
    </div>
  );
}
