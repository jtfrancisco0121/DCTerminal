import { useEffect, useRef, useState, type ReactNode } from "react";
import { headerPillText, type HeaderState } from "../terminal/headerState";

export type NextStep = {
  /** Hand-off targets with their display names. */
  targets: { id: string; name: string }[];
  /** The chain's next role or where the verdict points; the split button's main action. */
  primaryTarget: string | null;
  /** Main button text when `primaryTarget` is set ("Next: Send to Implementer"). */
  primaryLabel: string | null;
  /** Nothing left to hand on. */
  completeNote: string | null;
  busy: boolean;
  onSend: (target: string) => void;
};

export type TerminalHeaderProps = {
  roleName: string;
  roleColor: string;
  /** Task title; left out when it only repeats the role. */
  title: string;
  state: HeaderState;
  /** Folder name and branch, shown beside the title. */
  folder?: string | null;
  folderTitle?: string;
  branch?: string | null;
  branchTitle?: string;
  /** The chain label button. */
  chain?: ReactNode;
  /** Right side: model, Changes, Activity. */
  right?: ReactNode;
  next?: NextStep | null;
  /** The turn ended: the split button is primary. */
  turnEnded: boolean;
  /** Stops the running turn; shown while working. */
  onStop?: (() => void) | null;
  /** Compact: grid cells and the second pane. */
  compact?: boolean;
  /** Buttons at the far right (Swap, Close, remove from grid). */
  actions?: ReactNode;
  /** Called when the pointer or focus reaches the hand-off button (reads the verdict). */
  onPrepare?: () => void;
};

/** Seconds since `active` last turned on; 0 while it is off. */
function useElapsed(active: boolean): number {
  const startedAt = useRef<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  if (active && startedAt.current === null) startedAt.current = Date.now();
  if (!active) startedAt.current = null;
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return startedAt.current === null ? 0 : Math.max(0, (now - startedAt.current) / 1000);
}

/** "Send to <next role> ▾": the main target on the button, the others in its menu. */
export function SendToSplitButton({
  next,
  primary,
  compact,
  onPrepare,
}: {
  next: NextStep;
  primary: boolean;
  compact?: boolean;
  onPrepare?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const main = next.targets.find((item) => item.id === next.primaryTarget) ?? next.targets[0];
  if (!main) {
    return next.completeNote ? <span className="handoff-complete">{next.completeNote}</span> : null;
  }
  const others = next.targets.filter((item) => item.id !== main.id);
  const label =
    main.id === next.primaryTarget && next.primaryLabel
      ? next.primaryLabel
      : `Send to ${main.name}`;
  const className = primary ? "primary-button" : "secondary-button";
  return (
    <span
      ref={rootRef}
      className={`split-button${compact ? " split-button-compact" : ""}`}
      onPointerOver={onPrepare}
      onFocus={onPrepare}
    >
      {next.completeNote && <span className="handoff-complete">{next.completeNote}</span>}
      <button
        type="button"
        className={`${className} split-button-main`}
        disabled={next.busy}
        title={`Open a ${main.name} tab with this hand-off`}
        onClick={() => next.onSend(main.id)}
      >
        {label}
      </button>
      {others.length > 0 && (
        <button
          type="button"
          className={`${className} split-button-caret`}
          disabled={next.busy}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="More hand-off targets"
          title="Other hand-off targets"
          onClick={() => setOpen((value) => !value)}
        >
          ▾
        </button>
      )}
      {open && (
        <div className="split-button-menu" role="menu">
          {others.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className="split-button-item"
              onClick={() => {
                setOpen(false);
                next.onSend(item.id);
              }}
            >
              Send to {item.name}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

/**
 * One header for a terminal tab (R16): role dot, role, task, state pill,
 * folder and branch on the left; model, Changes, Activity and the hand-off
 * split button on the right. The compact variant fits grid cells and the
 * second pane.
 */
export function TerminalHeader({
  roleName,
  roleColor,
  title,
  state,
  folder,
  folderTitle,
  branch,
  branchTitle,
  chain,
  right,
  next,
  turnEnded,
  onStop,
  compact = false,
  actions,
  onPrepare,
}: TerminalHeaderProps) {
  const elapsed = useElapsed(state.timed);
  const showTitle = title && title !== roleName;
  return (
    <div
      className={`terminal-header terminal-header-${state.tone}${compact ? " terminal-header-compact" : ""}`}
      role="group"
      aria-label={`${roleName} terminal`}
    >
      <div className="terminal-header-left">
        <span className="terminal-header-dot" aria-hidden style={{ background: roleColor }} />
        <span className="terminal-header-role">{roleName}</span>
        {showTitle && (
          <span className="terminal-header-title" title={title}>
            {title}
          </span>
        )}
        <span
          className={`terminal-header-pill terminal-header-pill-${state.tone}`}
          role="status"
          aria-label={`State: ${state.text}`}
        >
          {headerPillText(state, elapsed)}
        </span>
        {chain}
        {folder && (
          <span className="terminal-header-meta" title={folderTitle}>
            {folder}
          </span>
        )}
        {branch && (
          <span className="session-branch" aria-label="Git branch" title={branchTitle}>
            ⎇ {branch}
          </span>
        )}
      </div>
      <div className="terminal-header-right">
        {right}
        {onStop && state.tone === "working" && (
          <button
            type="button"
            className="secondary-button"
            onClick={onStop}
            title="Interrupt the current turn (sends Esc to the terminal)"
          >
            Stop
          </button>
        )}
        {next && (
          <SendToSplitButton
            next={next}
            primary={turnEnded && state.tone === "done"}
            compact={compact}
            onPrepare={onPrepare}
          />
        )}
        {actions}
      </div>
    </div>
  );
}
