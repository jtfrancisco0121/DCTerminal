/**
 * Display helpers for Claude 5-hour and 7-day limits. The adapter sends
 * utilization and a reset time. Token totals and dollar amounts are not shown.
 */

export type RateWindow = {
  rateLimitType: string;
  label: string;
  utilization: number | null;
  resetsAt: number | null;
  status: string;
  seenAtMs: number;
};

export type UsageTone = "ok" | "warn" | "hot" | "muted";

export type LimitLine = {
  text: string;
  tone: UsageTone;
  title: string;
};

const USAGE_NOTE = "Updated by Claude chat tabs; terminal tabs don't report usage.";

export function limitTone(window: RateWindow): UsageTone {
  if (window.status === "rejected") return "hot";
  if (window.status === "allowed_warning") return "warn";
  if (window.utilization != null && window.utilization >= 80) return "warn";
  return "ok";
}

export function formatReset(resetsAt: number | null): string | null {
  if (resetsAt == null) return null;
  const date = new Date(resetsAt * 1000);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function formatWindowLine(window: RateWindow): string {
  const head =
    window.utilization == null
      ? `Claude ${window.label}`
      : `Claude ${window.label} ${Math.round(window.utilization)}%`;
  const reset = formatReset(window.resetsAt);
  return reset ? `${head} · resets ${reset}` : head;
}

/**
 * The window has reset since this reading (for example a reading saved before
 * a restart), so its percent no longer applies.
 */
export function isStale(window: RateWindow, now = Date.now()): boolean {
  return window.resetsAt != null && window.resetsAt * 1000 <= now;
}

/** Status-bar line. Prefers the 5-hour window. Empty until the first update. */
export function statusLimit(windows: RateWindow[], now = Date.now()): LimitLine {
  if (windows.length === 0) {
    return {
      text: "Claude usage not reported yet",
      tone: "muted",
      title: USAGE_NOTE,
    };
  }
  const primary = windows.find((window) => window.rateLimitType === "five_hour") ?? windows[0];
  const lines = windows.map((window) =>
    isStale(window, now) ? `Claude ${window.label} has reset since the last reading` : formatWindowLine(window),
  );
  const title = [USAGE_NOTE, ...lines, `Last reported ${formatSeen(primary.seenAtMs)}`].join("\n");
  if (isStale(primary, now)) {
    return { text: `Claude ${primary.label} reset · no new reading`, tone: "muted", title };
  }
  return { text: formatWindowLine(primary), tone: limitTone(primary), title };
}

/** A one-time heads-up about a limit window. `key` changes when the window resets. */
export type LimitAlert = {
  key: string;
  title: string;
  body: string;
  /** The limit is reached, not just close. */
  reached: boolean;
};

export const LIMIT_ALERT_PERCENT = 80;

/** Windows that are near or at their limit and have not reset since the reading. */
export function limitAlerts(windows: RateWindow[], now = Date.now()): LimitAlert[] {
  const alerts: LimitAlert[] = [];
  for (const window of windows) {
    if (isStale(window, now)) continue;
    const reset = formatReset(window.resetsAt);
    const key = `${window.rateLimitType}:${window.resetsAt ?? "?"}`;
    if (window.status === "rejected") {
      alerts.push({
        key: `${key}:reached`,
        title: `Claude ${window.label} limit reached`,
        body: reset ? `New requests wait until it resets at ${reset}.` : "New requests wait until it resets.",
        reached: true,
      });
      continue;
    }
    const near =
      window.status === "allowed_warning" ||
      (window.utilization != null && window.utilization >= LIMIT_ALERT_PERCENT);
    if (!near) continue;
    const pct = window.utilization == null ? "nearly used" : `at ${Math.round(window.utilization)}%`;
    alerts.push({
      key: `${key}:near`,
      title: `Claude ${window.label} limit ${pct}`,
      body: `${reset ? `Resets at ${reset}. ` : ""}A long run may stop when the limit is reached.`,
      reached: false,
    });
  }
  return alerts;
}

/** Context fill for a Claude chat tab. Percent only — no token counts. */
export function contextPercent(fill: { used: number; size: number } | null | undefined): string | null {
  if (!fill || fill.size <= 0) return null;
  const pct = Math.min(100, Math.round((fill.used / fill.size) * 100));
  return `Context ${pct}%`;
}

export function formatSeen(seenAtMs: number): string {
  const date = new Date(seenAtMs);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    day: "numeric",
  });
}
