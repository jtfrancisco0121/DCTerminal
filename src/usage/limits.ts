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

/** Status-bar line. Prefers the 5-hour window. Empty until the first update. */
export function statusLimit(windows: RateWindow[]): LimitLine {
  if (windows.length === 0) {
    return {
      text: "Claude usage not reported yet",
      tone: "muted",
      title: USAGE_NOTE,
    };
  }
  const primary = windows.find((window) => window.rateLimitType === "five_hour") ?? windows[0];
  return {
    text: formatWindowLine(primary),
    tone: limitTone(primary),
    title: [USAGE_NOTE, ...windows.map((window) => formatWindowLine(window))].join("\n"),
  };
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
