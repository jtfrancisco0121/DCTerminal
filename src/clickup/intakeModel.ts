/**
 * The start screen's "Tickets from ClickUp" box as data (C2): what you
 * pasted, the priority, status and tag filters, the last Fetch and the tickets you unticked,
 * and what Start does with them. Pure, so the rules are tested without the
 * UI: Start only uses a Fetch whose links and filters still match the box,
 * and never starts with no ticket ticked.
 */
import type {
  ClickUpIntakeFilters,
  ClickUpIntakePreview,
  ClickUpPriority,
  ClickUpTicketRow,
} from "../bridge";
import { parseIntakeRefs, type IntakeRef, type RefProblem } from "./intakeRefs";

export const PRIORITY_OPTIONS: readonly { id: ClickUpPriority; label: string }[] = [
  { id: "urgent", label: "Urgent" },
  { id: "high", label: "High" },
  { id: "normal", label: "Normal" },
  { id: "low", label: "Low" },
  { id: "none", label: "No priority" },
];

export type IntakeDraft = {
  text: string;
  /** Empty keeps every priority. */
  priorities: ClickUpPriority[];
  /** Status names to keep; empty keeps every open status. */
  statuses: string[];
  /** Tags to keep (any one of them); empty keeps every ticket. */
  tags: string[];
  /** The last Fetch and the links and filters it was for. */
  fetched: { key: string; preview: ClickUpIntakePreview } | null;
  /** Ticket ids you unticked in the preview. */
  dropped: string[];
};

export const EMPTY_INTAKE: IntakeDraft = {
  text: "",
  priorities: [],
  statuses: [],
  tags: [],
  fetched: null,
  dropped: [],
};

/** What Start does with the box. */
export type IntakeStart =
  | { kind: "none" }
  | { kind: "blocked"; message: string }
  | { kind: "ready"; refs: IntakeRef[]; filters: ClickUpIntakeFilters; ticketIds: string[] };

export function filtersOf(draft: IntakeDraft): ClickUpIntakeFilters {
  return {
    priorities: PRIORITY_OPTIONS.map((p) => p.id).filter((id) => draft.priorities.includes(id)),
    statuses: [...draft.statuses].sort(),
    tags: [...draft.tags].sort(),
  };
}

/** Same links and filters, same key: a Fetch for another box state is stale. */
export function fetchKey(refs: IntakeRef[], filters: ClickUpIntakeFilters): string {
  return JSON.stringify([
    refs.map((r) => [r.kind, r.id, r.teamId ?? "", !!r.custom]),
    filters.priorities,
    filters.statuses,
    filters.tags,
  ]);
}

export function parsedDraft(draft: IntakeDraft): { refs: IntakeRef[]; problems: RefProblem[]; key: string } {
  const { refs, problems } = parseIntakeRefs(draft.text);
  return { refs, problems, key: fetchKey(refs, filtersOf(draft)) };
}

/** The Fetch still matches what is in the box. */
export function isCurrent(draft: IntakeDraft): boolean {
  return !!draft.fetched && draft.fetched.key === parsedDraft(draft).key;
}

export function tickedTickets(draft: IntakeDraft): ClickUpTicketRow[] {
  return (draft.fetched?.preview.tickets ?? []).filter((t) => !draft.dropped.includes(t.id));
}

export function toggleTicket(draft: IntakeDraft, id: string, ticked: boolean): IntakeDraft {
  const dropped = draft.dropped.filter((d) => d !== id);
  return { ...draft, dropped: ticked ? dropped : [...dropped, id] };
}

export function togglePriority(draft: IntakeDraft, id: ClickUpPriority, on: boolean): IntakeDraft {
  const rest = draft.priorities.filter((p) => p !== id);
  return { ...draft, priorities: on ? [...rest, id] : rest };
}

function toggleName(names: string[], name: string, on: boolean): string[] {
  const rest = names.filter((n) => n !== name);
  return on ? [...rest, name] : rest;
}

export function toggleStatus(draft: IntakeDraft, name: string, on: boolean): IntakeDraft {
  return { ...draft, statuses: toggleName(draft.statuses, name, on) };
}

export function toggleTag(draft: IntakeDraft, name: string, on: boolean): IntakeDraft {
  return { ...draft, tags: toggleName(draft.tags, name, on) };
}

/**
 * The status and tag names to offer: what the last Fetch saw, plus any you
 * ticked that it no longer saw, so a ticked filter can always be unticked.
 */
export function filterChoices(draft: IntakeDraft): { statuses: string[]; tags: string[] } {
  const merge = (seen: string[], ticked: string[]) => [...seen, ...ticked.filter((t) => !seen.includes(t))];
  const preview = draft.fetched?.preview;
  return {
    statuses: merge(preview?.seenStatuses ?? [], draft.statuses),
    tags: merge(preview?.seenTags ?? [], draft.tags),
  };
}

/** The most tickets one intake takes (the core's `MAX_TICKETS`). */
export const MAX_INTAKE_TICKETS = 100;

/** Why a Fetch over the cap cannot start, or null when it is under it. */
export function overCapMessage(draft: IntakeDraft): string | null {
  const count = draft.fetched?.preview.overCap;
  if (!count) return null;
  return `${count} tickets match, more than the ${MAX_INTAKE_TICKETS} one intake takes. Narrow the filters (priority, status or tags) and Fetch again, or paste a smaller parent.`;
}

/** "2 of 3 tickets ticked · 1 excluded". */
export function previewSummary(draft: IntakeDraft): string {
  const preview = draft.fetched?.preview;
  if (!preview) return "";
  const all = preview.tickets.length;
  const ticked = tickedTickets(draft).length;
  const tickets = `${ticked} of ${all} ticket${all === 1 ? "" : "s"} ticked`;
  return preview.excluded.length > 0 ? `${tickets} · ${preview.excluded.length} excluded` : tickets;
}

/**
 * What Start does: nothing (an empty box), refuse with why, or use the
 * ticked tickets. Lines Fetch could not read were shown with it, so they do
 * not stop a Start that has tickets from the rest.
 */
export function intakeStart(draft: IntakeDraft): IntakeStart {
  const { refs, problems } = parsedDraft(draft);
  if (refs.length === 0 && problems.length === 0) return { kind: "none" };
  if (refs.length === 0) return { kind: "blocked", message: problems[0].message };
  if (!isCurrent(draft)) {
    return {
      kind: "blocked",
      message: draft.fetched
        ? "The ClickUp links or filters changed since Fetch. Press Fetch again, then Start."
        : "Press Fetch to read the ClickUp tickets, then Start.",
    };
  }
  const overCap = overCapMessage(draft);
  if (overCap) return { kind: "blocked", message: overCap };
  const ticketIds = tickedTickets(draft).map((t) => t.id);
  if (ticketIds.length === 0) {
    return { kind: "blocked", message: "Tick at least one ticket, or clear the ClickUp box." };
  }
  return { kind: "ready", refs, filters: filtersOf(draft), ticketIds };
}
