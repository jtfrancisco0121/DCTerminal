/**
 * The hand-off contract: each pipeline role ends its reply with sections
 * headed `## HANDOFF: <name>` (see docs/roles). They are read before any
 * heuristic, so the right text lands in the right field. Replies without
 * them fall back to the older parsing.
 */

/** `## HANDOFF: Plan`, `**HANDOFF: Plan**`, or a plain `HANDOFF: Plan` line (rendered copy). */
const HEADING = /^[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*)?[ \t]*HANDOFF[ \t]*:[ \t]*([^\n*]+?)[ \t]*(?:\*\*)?[ \t]*:?[ \t]*$/gim;

function normalize(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/** True for an empty answer the contract allows ("None.", "n/a"). */
export function isNoneAnswer(text: string): boolean {
  return /^(?:none|n\/a|nothing|no)\.?$/i.test(text.trim().replace(/^`|`$/g, ""));
}

/**
 * Every hand-off section by lower-case name. A name that appears more than
 * once (a revised plan, a later round in a terminal) keeps the last one.
 */
export function handoffSections(text: string): Map<string, string> {
  const hits = [...text.matchAll(HEADING)].map((m) => ({
    name: normalize(m[1]),
    start: m.index ?? 0,
    end: (m.index ?? 0) + m[0].length,
  }));
  const sections = new Map<string, string>();
  hits.forEach((hit, i) => {
    const next = hits[i + 1]?.start ?? text.length;
    // A section stops at the next hand-off heading or a horizontal rule.
    const body = text.slice(hit.end, next).split(/\n[ \t]*(?:---+|\*\*\*+)[ \t]*(?:\n|$)/)[0];
    sections.set(hit.name, body.trim());
  });
  return sections;
}

/** The first of `names` the reply has, or null. "None." counts as empty. */
export function handoffSection(text: string, ...names: string[]): string | null {
  const sections = handoffSections(text);
  for (const name of names) {
    const body = sections.get(normalize(name));
    if (body !== undefined) return isNoneAnswer(body) ? "" : body;
  }
  return null;
}

export function hasHandoffContract(text: string): boolean {
  HEADING.lastIndex = 0;
  return HEADING.test(text);
}

/**
 * The plan's pull-request list when the work ships as several pull requests,
 * or null for one pull request (or none given).
 */
export function contractPullRequestList(text: string): string | null {
  const list = handoffSection(text, "Pull requests", "Pull request plan");
  if (!list || /^one pull request\.?$/i.test(list.trim())) return null;
  return list;
}

/** `plan` followed by the pull-request list, unless the plan already carries it. */
function withPullRequestList(plan: string, list: string | null): string {
  if (!list || /^Pull requests:/im.test(plan)) return plan;
  return `${plan}\n\nPull requests:\n${list}`;
}

/** A Planner's plan, with its pull-request list and open questions when there are any. */
export function contractPlan(text: string): string | null {
  const plan = handoffSection(text, "Plan", "Implementation plan");
  if (plan === null || !plan) return null;
  const full = withPullRequestList(plan, contractPullRequestList(text));
  const questions = handoffSection(text, "Open questions", "Questions");
  return questions ? `${full}\n\nOpen questions:\n${questions}` : full;
}

/** A Plan Reviewer's reviewed plan (with its pull-request list) and notes. */
export function contractReview(text: string): { plan: string; notes: string } | null {
  const plan = handoffSection(text, "Reviewed plan", "Revised plan");
  if (plan === null || !plan) return null;
  return {
    plan: withPullRequestList(plan, contractPullRequestList(text)),
    notes: handoffSection(text, "Review notes", "Notes") ?? "",
  };
}

/** A PR Reviewer's findings for the Implementer. */
export function contractFindings(text: string): string | null {
  return handoffSection(text, "Findings for the Implementer", "Findings");
}

/** The raw text of a `HANDOFF: Verdict` section, if the reply has one. */
export function contractVerdictText(text: string): string | null {
  return handoffSection(text, "Verdict");
}

/** An Implementer's summary sections, labelled for the PR Reviewer. */
export function contractImplementation(text: string): {
  summary: string;
  files: string;
  tests: string;
  deviations: string;
  pullRequest: string;
} | null {
  const summary = handoffSection(text, "Implementation summary", "Summary");
  if (summary === null) return null;
  return {
    summary,
    files: handoffSection(text, "Files changed") ?? "",
    tests: handoffSection(text, "Tests run", "Tests") ?? "",
    deviations: handoffSection(text, "Deviations from the plan", "Deviations") ?? "",
    pullRequest: handoffSection(text, "Pull requests", "Pull request", "PR") ?? "",
  };
}
