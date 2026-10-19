import {
  useEffect,
  useId,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

/** Open dialogs, oldest first. Escape and the Tab trap act on the last one. */
const stack: string[] = [];
let nextId = 0;

/** How many Dialogs are open. The app-wide Escape handler stands down while any is. */
export function openDialogCount(): number {
  return stack.length;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute("hidden") && el.getAttribute("aria-hidden") !== "true",
  );
}

type Props = {
  /** The dialog's name: shown in the header and used as its accessible name. */
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Fixed below the scrolling body. Order: Cancel first, the main action last. */
  footer?: ReactNode;
  /** Extra class on the panel (existing per-dialog styling hooks). */
  className?: string;
  /** "alertdialog" for confirmations. */
  role?: "dialog" | "alertdialog";
  /** Keep the title for screen readers only (palette-style dialogs with their own input). */
  hideTitle?: boolean;
  /** False while the dialog must not be dismissed (a send in flight). */
  dismissible?: boolean;
  /** Runs before Escape, the backdrop or Close dismiss it. Return false to keep it open. */
  onRequestClose?: () => boolean;
  /** Anchor the panel at the top (palettes) instead of the centre. */
  placement?: "top" | "center";
  /** Hide the Close button (the footer already has Cancel). */
  hideClose?: boolean;
  /** Extra header content, right of the title. */
  headerExtra?: ReactNode;
  /** Optional description id for alertdialog text. */
  describedBy?: string;
};

/**
 * The one dialog shell (R3): a header with title and Close, a scrolling body
 * and a footer that stays in view. Escape closes only the top dialog, Tab stays
 * inside it, and focus returns to what opened it.
 */
export function Dialog({
  title,
  onClose,
  children,
  footer,
  className = "",
  role = "dialog",
  hideTitle = false,
  dismissible = true,
  onRequestClose,
  placement = "center",
  hideClose = false,
  headerExtra,
  describedBy,
}: Props) {
  const reactId = useId();
  const titleId = `dialog-title-${reactId}`;
  const panelRef = useRef<HTMLDivElement>(null);
  const idRef = useRef(`d${nextId++}`);
  const latest = useRef({ onClose, dismissible, onRequestClose });
  latest.current = { onClose, dismissible, onRequestClose };

  const requestClose = () => {
    const { onClose: close, dismissible: ok, onRequestClose: guard } = latest.current;
    if (!ok) return;
    if (guard && !guard()) return;
    close();
  };

  useEffect(() => {
    const id = idRef.current;
    stack.push(id);
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    if (panel && !panel.contains(document.activeElement)) {
      const first = panel.querySelector<HTMLElement>("[data-autofocus]") ?? focusables(panel)[0];
      (first ?? panel).focus();
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (stack[stack.length - 1] !== id) return;
      const target = event.target instanceof Element ? event.target : null;
      // Popovers and menus inside a dialog close themselves first.
      if (target?.closest("[data-own-escape]")) return;
      event.preventDefault();
      requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      const at = stack.lastIndexOf(id);
      if (at >= 0) stack.splice(at, 1);
      // A hidden tab's terminal stays connected in the aria-hidden park; typing
      // there would reach a PTY the user cannot see.
      if (previous && previous.isConnected && !previous.closest("[aria-hidden='true']")) {
        previous.focus();
      }
    };
    // requestClose reads the latest props from a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab" || !panelRef.current) return;
    // A portaled popover (model picker) manages its own Tab.
    if (event.target instanceof Node && !panelRef.current.contains(event.target)) return;
    const items = focusables(panelRef.current);
    if (items.length === 0) {
      event.preventDefault();
      panelRef.current.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panelRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    } else if (!panelRef.current.contains(active)) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className={`overlay-backdrop${placement === "center" ? " overlay-backdrop-center" : ""}`}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <div
        ref={panelRef}
        className={`overlay-panel ${className}`.trim()}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header className={`dialog-header${hideTitle ? " dialog-header-hidden" : ""}`}>
          <h2 id={titleId} className={hideTitle ? "sr-only" : "dialog-title"}>
            {title}
          </h2>
          {!hideTitle && headerExtra}
          {!hideTitle && !hideClose && (
            <button
              type="button"
              className="icon-button dialog-close"
              aria-label="Close"
              title="Close (Esc)"
              disabled={!dismissible}
              onClick={requestClose}
            >
              ×
            </button>
          )}
        </header>
        <div className="dialog-body">{children}</div>
        {footer && <footer className="dialog-footer">{footer}</footer>}
      </div>
    </div>
  );
}
