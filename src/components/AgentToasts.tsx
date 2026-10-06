import { useEffect, useRef } from "react";
import { toastLifetimeMs, type AgentToast } from "../notify/agentNotify";

type Props = {
  toasts: AgentToast[];
  /** True while the window is unfocused: toasts wait instead of fading. */
  paused?: boolean;
  /** Jump to the toast's tab. The caller also dismisses it. */
  onOpen: (toast: AgentToast) => void;
  onDismiss: (id: string) => void;
};

function ToastItem({
  toast,
  paused,
  onOpen,
  onDismiss,
}: {
  toast: AgentToast;
  paused: boolean;
  onOpen: (toast: AgentToast) => void;
  onDismiss: (id: string) => void;
}) {
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useEffect(() => {
    if (paused) return;
    const timer = window.setTimeout(() => dismissRef.current(toast.id), toastLifetimeMs(toast.kind));
    return () => window.clearTimeout(timer);
  }, [paused, toast.id, toast.kind]);

  const urgent = toast.kind !== "finished";
  return (
    <div
      className={`agent-toast agent-toast-${toast.kind}`}
      role={urgent ? "alert" : "status"}
    >
      <button
        type="button"
        className="agent-toast-body"
        onClick={() => onOpen(toast)}
        title="Open this tab"
      >
        <strong className="agent-toast-title">{toast.title}</strong>
        <span className="agent-toast-text">{toast.body}</span>
      </button>
      <button
        type="button"
        className="agent-toast-close"
        aria-label="Dismiss notification"
        onClick={() => onDismiss(toast.id)}
      >
        ×
      </button>
    </div>
  );
}

/** In-app notifications for agent events on background tabs (F1). */
export function AgentToasts({ toasts, paused = false, onOpen, onDismiss }: Props) {
  if (toasts.length === 0) return null;
  return (
    <div className="agent-toasts">
      {toasts.map((toast) => (
        <ToastItem
          key={toast.id}
          toast={toast}
          paused={paused}
          onOpen={onOpen} onDismiss={onDismiss} />
      ))}
    </div>
  );
}
