/**
 * The merge queue's words (R3), pure: what each place in a repo's queue
 * says, and the line under each repo.
 */
import type { QueueEntry, QueueState, RepoQueue } from "../bridge";

const LABELS: Readonly<Record<QueueState, string>> = {
  open: "open",
  draft: "draft",
  merged: "merged",
  closed: "closed (not merged)",
  missing: "no pull request yet",
  parked: "parked",
  unknown: "state unknown",
};

export function stateLabel(state: QueueState): string {
  return LABELS[state] ?? state;
}

/** "plan2 #12", or "plan3" before it has a pull request. */
export function entryName(entry: QueueEntry): string {
  return entry.number ? `${entry.planId} #${entry.number}` : entry.planId;
}

/** "Next to merge: plan2 #12", "Waiting: …", or "Everything merged". */
export function repoLine(queue: RepoQueue): string {
  const next = queue.entries.find((e) => e.next);
  if (next) return `Next to merge: ${entryName(next)}`;
  const left = queue.entries.filter((e) => e.state !== "merged" && e.state !== "closed" && e.state !== "parked");
  if (left.length === 0) return "Everything merged";
  const first = left[0];
  if (first.state === "missing") return `Nothing to merge yet: ${first.planId} has no pull request here.`;
  if (first.state === "unknown") return `Nothing suggested: ${entryName(first)}'s state could not be read.`;
  return "Nothing to merge now.";
}
