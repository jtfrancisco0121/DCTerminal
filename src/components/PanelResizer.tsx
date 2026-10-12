import type { KeyboardEvent } from "react";

type Props = {
  label: string;
  value: number;
  min: number;
  max: number;
  /** Pixels moved by one arrow key press. */
  step?: number;
  onChange: (next: number) => void;
};

export function clampWidth(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** The next width for a key press, or null when the key does not resize. */
export function resizeKey(
  key: string,
  value: number,
  min: number,
  max: number,
  step: number,
  shift = false,
): number | null {
  const amount = shift ? step * 4 : step;
  switch (key) {
    case "ArrowLeft":
      return clampWidth(value - amount, min, max);
    case "ArrowRight":
      return clampWidth(value + amount, min, max);
    case "Home":
      return min;
    case "End":
      return max;
    default:
      return null;
  }
}

/** A vertical drag handle on a panel's right edge, also operable with the arrow keys. */
export function PanelResizer({ label, value, min, max, step = 16, onChange }: Props) {
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = resizeKey(event.key, value, min, max, step, event.shiftKey);
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    onChange(next);
  };
  return (
    <div
      className="file-panel-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onMouseDown={(event) => {
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = value;
        const onMove = (move: MouseEvent) =>
          onChange(clampWidth(startWidth + move.clientX - startX, min, max));
        const onUp = () => {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
      }}
    />
  );
}
