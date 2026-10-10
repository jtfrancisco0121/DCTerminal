import { useEffect, useState } from "react";
import { activityList } from "../bridge";

/** Slower than the open panel: the button only shows a count. */
export const ACTIVITY_BUTTON_POLL_MS = 5000;

type Props = {
  tabId: string;
  busy: boolean;
  /** Changes when the panel closes, so the count catches up. */
  refreshKey?: unknown;
  onOpen: () => void;
};

/** "Activity (n)" next to "Changes (n)" in chat headers and terminal toolbars. */
export function ActivityButton({ tabId, busy, refreshKey, onOpen }: Props) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      activityList(tabId)
        .then((entries) => {
          if (!cancelled) setCount(entries.length);
        })
        .catch(() => {});
    };
    refresh();
    // Once more after the turn ends (busy flips false) via the dependency.
    const timer = busy ? window.setInterval(refresh, ACTIVITY_BUTTON_POLL_MS) : undefined;
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [busy, refreshKey, tabId]);

  return (
    <button
      type="button"
      className="secondary-button activity-button"
      onClick={onOpen}
      title="Every command, file write, fetch, and MCP call the agent made in this tab"
    >
      {count > 0 ? `Activity (${count})` : "Activity"}
    </button>
  );
}
