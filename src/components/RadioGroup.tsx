import type { HTMLAttributes, KeyboardEvent, ReactNode } from "react";

/**
 * Radio semantics for a row of buttons: the group is one tab stop (the
 * checked radio, or the first when none is checked), and the arrow keys,
 * Home and End move the choice. Mark each button with radioProps().
 */

type Props = {
  /** Accessible name of the group. */
  label: string;
  children: ReactNode;
} & Omit<HTMLAttributes<HTMLDivElement>, "role" | "aria-label" | "onKeyDown" | "children">;

const MOVES: Record<string, number> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
};

/** Props for one radio button of a group. `tabbable` is true for exactly one. */
export function radioProps(checked: boolean, tabbable: boolean = checked) {
  return {
    role: "radio" as const,
    "aria-checked": checked,
    tabIndex: tabbable ? 0 : -1,
  };
}

/** True for the radio that holds the tab stop: the checked one, else the first. */
export function isTabStop(checked: boolean, anyChecked: boolean, index: number): boolean {
  return anyChecked ? checked : index === 0;
}

export function onRadioKeyDown(event: KeyboardEvent<HTMLElement>): void {
  const key = event.key;
  if (!(key in MOVES) && key !== "Home" && key !== "End") return;
  const radios = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]'),
  ).filter((el) => !(el as HTMLButtonElement).disabled);
  if (radios.length === 0) return;
  const at = radios.indexOf(document.activeElement as HTMLElement);
  if (at < 0) return;
  event.preventDefault();
  const next =
    key === "Home"
      ? 0
      : key === "End"
        ? radios.length - 1
        : (at + MOVES[key] + radios.length) % radios.length;
  radios[next].focus();
  // Selection follows focus.
  radios[next].click();
}

export function RadioGroup({ label, children, ...rest }: Props) {
  return (
    <div {...rest} role="radiogroup" aria-label={label} onKeyDown={onRadioKeyDown}>
      {children}
    </div>
  );
}
