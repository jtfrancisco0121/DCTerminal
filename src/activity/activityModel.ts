import type { ActivityEntry, TerminalToolCall } from "../bridge";

/** Panel order. "rejected" is a decision filter, not a tool kind. */
export const ACTIVITY_KINDS = [
  "shell",
  "write",
  "edit",
  "delete",
  "fetch",
  "mcp",
  "read",
  "other",
] as const;

export type ActivityFilter = (typeof ACTIVITY_KINDS)[number] | "rejected" | "network";

/** Always listed in the header, even at zero, so "mcp 0" is an answer. */
const HEADLINE: readonly string[] = ["shell", "write", "fetch", "mcp"];

export function kindOf(entry: ActivityEntry): (typeof ACTIVITY_KINDS)[number] {
  return (ACTIVITY_KINDS as readonly string[]).includes(entry.kind)
    ? (entry.kind as (typeof ACTIVITY_KINDS)[number])
    : "other";
}

export function isRejected(entry: ActivityEntry): boolean {
  return entry.decision.endsWith("reject") || entry.decision === "cancelled";
}

export type ActivityCounts = Record<ActivityFilter, number>;

export function countActivity(entries: readonly ActivityEntry[]): ActivityCounts {
  const counts = Object.fromEntries(
    [...ACTIVITY_KINDS, "rejected", "network"].map((key) => [key, 0]),
  ) as ActivityCounts;
  for (const entry of entries) {
    counts[kindOf(entry)] += 1;
    if (isRejected(entry)) counts.rejected += 1;
    if (entry.network) counts.network += 1;
  }
  return counts;
}

/** "shell 9 · write 31 · fetch 1 · mcp 0 · rejected 0" (other kinds when > 0). */
export function summaryLine(counts: ActivityCounts): string {
  const parts = ACTIVITY_KINDS.filter((kind) => HEADLINE.includes(kind) || counts[kind] > 0).map(
    (kind) => `${kind} ${counts[kind]}`,
  );
  parts.push(`rejected ${counts.rejected}`);
  return parts.join(" · ");
}

export function matchesFilter(entry: ActivityEntry, filter: ActivityFilter | null): boolean {
  if (!filter) return true;
  if (filter === "rejected") return isRejected(entry);
  if (filter === "network") return entry.network;
  return kindOf(entry) === filter;
}

export function decisionLabel(decision: string): string {
  switch (decision) {
    case "auto_allow":
      return "auto";
    case "user_allow":
      return "you allowed";
    case "user_reject":
      return "you rejected";
    case "auto_reject":
      return "rejected";
    case "cancelled":
      return "cancelled";
    case "none":
    case "":
      return "no ask";
    default:
      return decision;
  }
}

export function decisionTitle(decision: string): string {
  if (decision === "none" || decision === "") {
    return "The agent ran this without asking (full permissions mode).";
  }
  if (decision === "auto_allow") return "Permission asked and answered allow-once automatically.";
  return `Permission: ${decisionLabel(decision)}`;
}

export function statusLabel(status: string | null): string {
  switch (status) {
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "in_progress":
      return "running";
    case "pending":
      return "pending";
    default:
      return status ?? "";
  }
}

const TERMINAL_KIND: Record<TerminalToolCall["kind"], (typeof ACTIVITY_KINDS)[number]> = {
  execute: "shell",
  read: "read",
  edit: "edit",
  fetch: "fetch",
  other: "other",
};

/** A terminal tab's session-log tool calls as read-only activity rows (no permission data). */
export function terminalActivityEntries(
  tabId: string,
  calls: readonly TerminalToolCall[],
): ActivityEntry[] {
  return calls.map((call) => ({
    id: call.id,
    tabId,
    time: call.at ?? "",
    updatedAt: call.at ?? "",
    kind:
      call.kind === "other" && call.name.startsWith("mcp__")
        ? "mcp"
        : (TERMINAL_KIND[call.kind] ?? "other"),
    title: call.title || call.name,
    summary: call.command || call.path || call.url || call.title || call.name,
    decision: "none",
    network: call.kind === "fetch",
    status: call.status,
  }));
}

export function timeOfDay(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
