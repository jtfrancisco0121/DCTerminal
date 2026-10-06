import { useCallback, useRef, useState } from "react";
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  decideNotification,
  dismissToast,
  dismissToastsForTab,
  notificationMessage,
  pushToast,
  type AgentEvent,
  type AgentToast,
  type NotificationSettings,
} from "./agentNotify";
import { showSystemNotification } from "./systemNotify";
import { isWindowFocused } from "./windowFocus";

type Options = {
  /** Null until Settings load; the defaults apply meanwhile. */
  settings: NotificationSettings | null;
  /** Tabs on screen right now: the active tab and the second split pane. */
  visibleTabIds: () => (string | null | undefined)[];
  tabLabel: (tabId: string) => string;
  isWindowFocused?: () => boolean;
  showSystem?: (title: string, body: string, options?: { askAgain?: boolean }) => Promise<boolean>;
};

let toastSeq = 0;
function nextToastId(): string {
  toastSeq += 1;
  return `toast-${Date.now()}-${toastSeq}`;
}

/**
 * F1: turn agent events into toasts and OS notifications. `notify` is
 * stable, so ACP listeners can call it without re-subscribing.
 */
export function useAgentNotifications(options: Options) {
  const [toasts, setToasts] = useState<AgentToast[]>([]);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const notify = useCallback((tabId: string, event: AgentEvent) => {
    const opts = optionsRef.current;
    const decision = decideNotification({
      tabId,
      visibleTabIds: opts.visibleTabIds(),
      windowFocused: (opts.isWindowFocused ?? isWindowFocused)(),
      settings: opts.settings ?? DEFAULT_NOTIFICATION_SETTINGS,
    });
    if (!decision.toast && !decision.system) return;
    const message = notificationMessage(event, opts.tabLabel(tabId));
    if (decision.toast) {
      setToasts((prev) =>
        pushToast(prev, { id: nextToastId(), tabId, kind: event.kind, ...message }),
      );
    }
    if (decision.system) {
      void (opts.showSystem ?? showSystemNotification)(message.title, message.body);
    }
  }, []);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => dismissToast(prev, id));
  }, []);

  const dismissTab = useCallback((tabId: string) => {
    setToasts((prev) => dismissToastsForTab(prev, tabId));
  }, []);

  /** Settings button: always shows both, and may re-ask for OS permission. */
  const sendTest = useCallback(() => {
    const opts = optionsRef.current;
    const title = "DCTerminal notifications are on";
    const body = "You will see this when a background tab finishes or needs you.";
    setToasts((prev) =>
      pushToast(prev, { id: nextToastId(), tabId: "__test__", kind: "finished", title, body }),
    );
    void (opts.showSystem ?? showSystemNotification)(title, body, { askAgain: true });
  }, []);

  return { toasts, notify, dismiss, dismissTab, sendTest };
}
