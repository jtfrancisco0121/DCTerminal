import { useEffect } from "react";
import type { PermissionRequestEvent } from "./bridge";
import { openDialogCount } from "./components/Dialog";

type Props = {
  request: PermissionRequestEvent;
  busy: boolean;
  onSelect: (optionId: string) => void;
  onCancel: () => void;
  /** False when another pane has focus: only the focused pane's card answers keys. */
  keysActive?: boolean;
};

const EDITABLE = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";

function firstAllowOption(request: PermissionRequestEvent): string | null {
  const allow = request.options.find(
    (opt) =>
      opt.id.includes("allow") ||
      (!opt.id.includes("reject") && !opt.label.toLowerCase().includes("reject")),
  );
  return allow?.id ?? request.options[0]?.id ?? null;
}

function firstRejectOption(request: PermissionRequestEvent): string | null {
  const reject = request.options.find(
    (opt) => opt.id.includes("reject") || opt.label.toLowerCase().includes("reject"),
  );
  return reject?.id ?? null;
}

export function PermissionCard({ request, busy, onSelect, onCancel, keysActive = true }: Props) {
  useEffect(() => {
    if (!keysActive) return;
    const onKey = (event: KeyboardEvent) => {
      if (busy || event.defaultPrevented || event.isComposing || event.repeat) return;
      // Cmd+A selects text; only bare keys (Shift allowed) answer the card.
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      // An open Dialog owns the keyboard. The card is itself role="dialog", so count, don't query.
      if (openDialogCount() > 0) return;
      const target = event.target;
      if (
        target instanceof Element &&
        ((target instanceof HTMLElement && target.isContentEditable) || target.closest(EDITABLE))
      ) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "a") {
        const id = firstAllowOption(request);
        if (!id) return;
        event.preventDefault();
        event.stopPropagation();
        onSelect(id);
        return;
      }
      if (key === "r") {
        const id = firstRejectOption(request);
        if (!id) return;
        event.preventDefault();
        event.stopPropagation();
        onSelect(id);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [busy, keysActive, onCancel, onSelect, request]);

  return (
    <div className="permission-card" role="dialog" aria-labelledby="perm-title">
      <p id="perm-title" className="permission-card-title">
        {request.title}
      </p>
      <p className="permission-card-meta">
        {request.displayKind || request.toolClass}
        {request.network ? " · network" : ""}
        {request.toolClass ? ` · ${request.toolClass}` : ""}
      </p>
      <p className="permission-card-hint">
        The agent is paused until you choose an action below.
      </p>
      {request.message && (
        <p className="permission-card-message">{request.message}</p>
      )}
      <div className="permission-card-actions">
        {request.options.map((opt) => (
          <button
            key={opt.id}
            type="button"
            className={
              opt.id.includes("reject")
                ? "secondary-button"
                : "primary-button"
            }
            disabled={busy}
            onClick={() => onSelect(opt.id)}
          >
            {opt.label}
          </button>
        ))}
        <button
          type="button"
          className="secondary-button"
          disabled={busy}
          onClick={onCancel}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
