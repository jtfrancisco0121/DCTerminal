import { useCallback, useEffect, useState } from "react";
import { Dialog } from "./Dialog";

export type ConfirmOptions = {
  title: string;
  /** The question. Newlines are kept. */
  message: string;
  /** Label of the button that goes ahead. Default "Confirm". */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the confirm button as destructive. */
  danger?: boolean;
};

type Pending = ConfirmOptions & { resolve: (ok: boolean) => void };

let host: ((pending: Pending) => void) | null = null;

/**
 * Ask the user to confirm. Resolves true on confirm, false on Cancel, Escape
 * or a click outside. Without a mounted ConfirmHost (unit tests of a single
 * component) it falls back to the browser prompt so the answer is never lost.
 */
export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  if (!host) {
    return Promise.resolve(window.confirm(`${options.title}\n\n${options.message}`));
  }
  const show = host;
  return new Promise<boolean>((resolve) => show({ ...options, resolve }));
}

/** The one confirm style. Returns `confirm(options) => Promise<boolean>`. */
export function useConfirm(): (options: ConfirmOptions) => Promise<boolean> {
  return useCallback((options: ConfirmOptions) => confirmAction(options), []);
}

/** Mount once near the app root. Shows the queued confirmations one at a time. */
export function ConfirmHost() {
  const [queue, setQueue] = useState<Pending[]>([]);
  useEffect(() => {
    host = (pending) => setQueue((prev) => [...prev, pending]);
    return () => {
      host = null;
    };
  }, []);
  const current = queue[0];
  if (!current) return null;
  const answer = (ok: boolean) => {
    current.resolve(ok);
    setQueue((prev) => prev.slice(1));
  };
  return (
    <Dialog
      key={queue.length + current.title}
      role="alertdialog"
      title={current.title}
      className="confirm-dialog"
      hideClose
      onClose={() => answer(false)}
      describedBy="confirm-message"
      footer={
        <>
          <button type="button" className="secondary-button" onClick={() => answer(false)}>
            {current.cancelLabel ?? "Cancel"}
          </button>
          <button
            type="button"
            data-autofocus
            className={current.danger ? "danger-button" : "primary-button"}
            onClick={() => answer(true)}
          >
            {current.confirmLabel ?? "Confirm"}
          </button>
        </>
      }
    >
      <p id="confirm-message" className="confirm-text">
        {current.message}
      </p>
    </Dialog>
  );
}
