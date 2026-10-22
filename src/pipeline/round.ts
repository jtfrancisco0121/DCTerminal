/**
 * A QA round's summary (R1), pure: the plans of a Triage run's
 * `round.json` as table rows, in wave order, and a one-line count.
 */
import type { RoundPlan, RoundPlanStatus, RunRound } from "../bridge";

export type RoundRow = {
  id: string;
  title: string;
  tickets: string[];
  repos: string[];
  status: RoundPlanStatus;
  /** "Wave 2", or "—" for a plan with none. */
  wave: string;
  /** Why a deferred or parked plan waits; empty for an active plan. */
  reason: string;
  summary: string;
};

const STATUS_ORDER: Readonly<Record<RoundPlanStatus, number>> = { active: 0, parked: 1, deferred: 2 };

/** "plan10" after "plan9". */
function planNumber(id: string): number {
  const n = Number.parseInt(id.replace(/^plan/i, ""), 10);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

function sortKey(plan: RoundPlan): [number, number, number] {
  return [plan.wave ?? Number.MAX_SAFE_INTEGER, STATUS_ORDER[plan.status] ?? 3, planNumber(plan.id)];
}

/** The plans as rows: by wave, then active before parked before deferred, then by number. */
export function roundRows(round: RunRound): RoundRow[] {
  return [...round.plans]
    .sort((a, b) => {
      const [x, y] = [sortKey(a), sortKey(b)];
      return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
    })
    .map((plan) => ({
      id: plan.id,
      title: plan.title,
      tickets: plan.tickets,
      repos: plan.repos,
      status: plan.status,
      wave: plan.wave ? `Wave ${plan.wave}` : "—",
      reason: plan.status === "active" ? "" : (plan.reason ?? "").trim(),
      summary: plan.summary,
    }));
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** "8 plans (6 active, 1 parked, 1 deferred) · 4 waves · 22 tickets · 1 excluded". */
export function roundCountText(round: RunRound): string {
  const count = (status: RoundPlanStatus) => round.plans.filter((p) => p.status === status).length;
  const parts = [`${count("active")} active`];
  if (count("parked")) parts.push(`${count("parked")} parked`);
  if (count("deferred")) parts.push(`${count("deferred")} deferred`);
  const tickets = round.plans.reduce((sum, p) => sum + p.tickets.length, 0);
  const line = [
    `${plural(round.plans.length, "plan")} (${parts.join(", ")})`,
    plural(round.waves.length, "wave"),
    plural(tickets, "ticket"),
  ];
  if (round.excluded.length) line.push(`${round.excluded.length} excluded`);
  return line.join(" · ");
}

/** Each repo's merge order as "plan1 → plan2 → plan4", repos by name. */
export function mergeOrderLines(round: RunRound): { repo: string; order: string }[] {
  return Object.keys(round.mergeOrder)
    .sort()
    .map((repo) => ({ repo, order: (round.mergeOrder[repo] ?? []).join(" → ") }));
}
