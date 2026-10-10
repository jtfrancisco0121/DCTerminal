import { useCallback, useEffect, useMemo, useState } from "react";
import { activityClear, activityList, type ActivityEntry } from "../bridge";
import {
  ACTIVITY_KINDS,
  countActivity,
  decisionLabel,
  decisionTitle,
  isRejected,
  kindOf,
  matchesFilter,
  statusLabel,
  summaryLine,
  timeOfDay,
  type ActivityFilter,
} from "../activity/activityModel";

type Props = {
  tabId: string;
  tabLabel: string;
  /** The tab's agent is working: refresh every POLL_MS while open. */
  busy: boolean;
  /** Terminal tabs run the CLI directly, so nothing is recorded for them. */
  terminal?: boolean;
  /** Latest row count, for the "Activity (n)" button. */
  onCount?: (count: number) => void;
  onClose: () => void;
};

export const ACTIVITY_POLL_MS = 2000;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Every tool call the tab's agent made: what ran, what was written, what hit the network. */
export function ActivityPanel({ tabId, tabLabel, busy, terminal, onCount, onClose }: Props) {
  const [entries, setEntries] = useState<ActivityEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ActivityFilter | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await activityList(tabId);
      setEntries(next);
      setError(null);
      onCount?.(next.length);
    } catch (err: unknown) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, [onCount, tabId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => void load(), ACTIVITY_POLL_MS);
    return () => window.clearInterval(timer);
  }, [busy, load]);

  const counts = useMemo(() => countActivity(entries ?? []), [entries]);
  // Newest first: the question is usually "what did it just do?".
  const rows = useMemo(
    () => (entries ?? []).filter((entry) => matchesFilter(entry, filter)).reverse(),
    [entries, filter],
  );

  const clear = async () => {
    if (!window.confirm(`Clear the activity log for ${tabLabel}? This cannot be undone.`)) return;
    try {
      await activityClear(tabId);
      await load();
    } catch (err: unknown) {
      setError(errorText(err));
    }
  };

  const chips: ActivityFilter[] = [...ACTIVITY_KINDS, "network", "rejected"];

  let body;
  if (error) {
    body = <p className="error">{error}</p>;
  } else if (!entries) {
    body = <p className="hint">Loading…</p>;
  } else if (entries.length === 0) {
    body = (
      <p className="hint">
        {terminal
          ? "Terminal tabs run the CLI directly, so DCTerminal cannot see their tool calls. Chat tabs record every command, file write, and fetch here."
          : "No tool calls yet. Commands, file writes, fetches, and MCP calls show up here as the agent runs them."}
      </p>
    );
  } else if (rows.length === 0) {
    body = <p className="hint">Nothing matches this filter.</p>;
  } else {
    body = (
      <div className="activity-scroll">
        <table className="activity-table" aria-label="Agent activity">
          <thead>
            <tr>
              <th>Time</th>
              <th>Kind</th>
              <th>Decision</th>
              <th>What</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((entry) => (
              <tr
                key={entry.id}
                className={isRejected(entry) ? "activity-row activity-row-rejected" : "activity-row"}
              >
                <td className="activity-time" title={entry.time}>
                  {timeOfDay(entry.time)}
                </td>
                <td>
                  <span className={`activity-kind activity-kind-${kindOf(entry)}`}>
                    {kindOf(entry)}
                  </span>
                </td>
                <td
                  className={`activity-decision activity-decision-${entry.decision}`}
                  title={decisionTitle(entry.decision)}
                >
                  {decisionLabel(entry.decision)}
                </td>
                <td className="activity-summary" title={entry.title || entry.summary}>
                  {entry.network && (
                    <span className="activity-network" title="Network access" aria-label="network">
                      ⚠
                    </span>
                  )}
                  <code>{entry.summary || entry.title}</code>
                </td>
                <td className={`activity-status activity-status-${entry.status ?? "unknown"}`}>
                  {statusLabel(entry.status)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="overlay-backdrop" role="presentation" onClick={onClose}>
      <div
        className="overlay-panel activity-panel"
        role="dialog"
        aria-label={`Activity in ${tabLabel}`}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="changes-bar">
          <h3>Activity</h3>
          <span className="hint">{tabLabel}</span>
          <span className="activity-counts" data-testid="activity-counts">
            {summaryLine(counts)}
          </span>
          <span className="changes-bar-spacer" />
          <button
            type="button"
            className="secondary-button"
            disabled={loading}
            onClick={() => void load()}
          >
            {loading ? "Loading…" : "Refresh"}
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={!entries || entries.length === 0}
            onClick={() => void clear()}
          >
            Clear…
          </button>
          <button
            type="button"
            className="secondary-button"
            aria-label="Close activity"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div className="activity-chips" role="group" aria-label="Filter by kind">
          <button
            type="button"
            className="activity-chip"
            aria-pressed={filter === null}
            onClick={() => setFilter(null)}
          >
            all {entries?.length ?? 0}
          </button>
          {chips.map((chip) => (
            <button
              key={chip}
              type="button"
              className={`activity-chip activity-chip-${chip}`}
              aria-pressed={filter === chip}
              disabled={counts[chip] === 0 && filter !== chip}
              onClick={() => setFilter(filter === chip ? null : chip)}
            >
              {chip} {counts[chip]}
            </button>
          ))}
        </div>
        {busy && (
          <p className="hint changes-busy" role="status">
            The agent is working. This list refreshes every few seconds.
          </p>
        )}
        {body}
      </div>
    </div>
  );
}
