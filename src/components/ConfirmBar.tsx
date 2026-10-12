import { useEffect, useRef } from "react";

type Props = {
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * A small inline confirmation inside a panel. Local stand-in until the shared
 * Dialog/useConfirm (PR7) exists; callers can then swap it for that.
 */
export function ConfirmBar({ message, confirmLabel, cancelLabel, onConfirm, onCancel }: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => cancelRef.current?.focus(), []);
  return (
    <div
      className="confirm-bar"
      role="alertdialog"
      aria-label={message}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <span>{message}</span>
      <button ref={cancelRef} type="button" className="secondary-button" onClick={onCancel}>
        {cancelLabel}
      </button>
      <button type="button" className="danger-button" onClick={onConfirm}>
        {confirmLabel}
      </button>
    </div>
  );
}
