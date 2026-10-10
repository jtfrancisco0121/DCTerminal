/**
 * Review verdicts from a Plan Reviewer or PR Reviewer reply. The overview
 * shows them and routing.ts picks the primary hand-off button from them;
 * nothing sends on a verdict by itself.
 */

import { contractVerdictText } from "./contract";

export type ReviewVerdict =
  | "APPROVED"
  | "APPROVED WITH CHANGES"
  | "REQUIRES REVISION"
  | "REQUEST CHANGES"
  | "REJECTED";

export type VerdictTone = "ok" | "warn" | "bad";

// Longest first so "approved with changes" never reads as "approved".
// "I approve this plan with changes" and "needs revision" are prose forms.
const VERDICT_RE =
  /\b((?:I\s+)?approved?(?:\s+(?:this|the)\s+(?:plan|pr|pull\s+request|implementation|changes?))?(?:\s*,)?\s+with\s+(?:(?:some|minor|small|a\s+few)\s+)?(?:changes|modifications|edits|revisions)|(?:requires?|needs?)\s+revisions?|revisions?\s+required|request(?:ed|ing|s)?\s+changes|changes\s+requested|rejected|approved|I\s+approve)\b/gi;

// "Approved plan" names a plan; "not approved" is not a verdict.
const NOUN_AFTER = /^[ \t]+(?:implementation[ \t]+)?(?:plan|approach|design|spec|scope|changes?)\b/i;
const NEGATED_BEFORE = /\b(?:not|never|cannot|can't|won't|isn't|wasn't|n't)[ \t]+(?:(?:yet|be|been|been[ \t]+yet)[ \t]+)?$/i;

// Plan Reviewer "Final Recommendation" options, used when no verdict is written.
const RECOMMENDATION_RE =
  /\b(proceed\s+as[\s-]is|update\s+the\s+plan,?\s+then\s+proceed|return\s+to\s+planning)\b/gi;

// A "Verdict" heading or label line: "## Verdict", "**Verdict:** …", "3. Final verdict".
const VERDICT_LABEL =
  /^[ \t>]*(?:#{1,6}[ \t]*)?(?:\*\*|__)?[ \t]*(?:\d+[.)][ \t]*)?(?:final[ \t]+|overall[ \t]+|review[ \t]+)?verdict\b/i;
const RECOMMENDATION_LABEL =
  /^[ \t>]*(?:#{1,6}[ \t]*)?(?:\*\*|__)?[ \t]*(?:\d+[.)][ \t]*)?final[ \t]+recommendation\b/i;
const HEADING = /^[ \t]*#{1,6}[ \t]+\S/;

function normalize(match: string): ReviewVerdict {
  const words = match.toLowerCase().replace(/\s+/g, " ");
  if (/\bwith\b/.test(words)) return "APPROVED WITH CHANGES";
  if (/revision/.test(words)) return "REQUIRES REVISION";
  if (/request|changes requested/.test(words)) return "REQUEST CHANGES";
  if (words === "rejected") return "REJECTED";
  return "APPROVED";
}

function lastMatch(text: string): ReviewVerdict | null {
  let found: string | null = null;
  for (const match of text.matchAll(VERDICT_RE)) {
    const index = match.index ?? 0;
    const after = text.slice(index + match[0].length);
    const before = text.slice(Math.max(0, index - 24), index);
    if (/^approved$/i.test(match[1]) && NOUN_AFTER.test(after)) continue;
    if (NEGATED_BEFORE.test(before)) continue;
    found = match[1];
  }
  return found ? normalize(found) : null;
}

function lastRecommendation(text: string): ReviewVerdict | null {
  let found: string | null = null;
  for (const match of text.matchAll(RECOMMENDATION_RE)) found = match[1].toLowerCase();
  if (!found) return null;
  if (found.startsWith("proceed")) return "APPROVED";
  if (found.startsWith("update")) return "APPROVED WITH CHANGES";
  return "REQUIRES REVISION";
}

/** The verdict on a label line or in the next few lines under it (before the next heading). */
function underLabel(
  lines: string[],
  label: RegExp,
  read: (text: string) => ReviewVerdict | null,
): ReviewVerdict | null {
  let found: ReviewVerdict | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const hit = label.exec(lines[i]);
    if (!hit) continue;
    const sameLine = read(lines[i].slice(hit[0].length));
    if (sameLine) {
      found = sameLine;
      continue;
    }
    let seen = 0;
    for (let j = i + 1; j < lines.length && seen < 3; j += 1) {
      if (!lines[j].trim()) continue;
      if (HEADING.test(lines[j])) break;
      seen += 1;
      const below = read(lines[j]);
      if (below) {
        found = below;
        break;
      }
    }
  }
  return found;
}

/**
 * The verdict in a reviewer's reply. Text under a "Verdict" heading or label
 * wins (the last one, so a quoted template earlier does not count); then a
 * "Final Recommendation" option; otherwise the last verdict phrase in the
 * reply. Null when the reply has none.
 */
export function parseReviewVerdict(text: string): ReviewVerdict | null {
  if (!text.trim()) return null;
  // The hand-off contract's `HANDOFF: Verdict` line is exact; use it first.
  const declared = contractVerdictText(text);
  const fromContract = declared ? lastMatch(declared) : null;
  if (fromContract) return fromContract;
  const lines = text.split(/\r?\n/);
  return (
    underLabel(lines, VERDICT_LABEL, lastMatch) ??
    underLabel(lines, RECOMMENDATION_LABEL, (line) => lastMatch(line) ?? lastRecommendation(line)) ??
    lastMatch(text)
  );
}

/**
 * A terminal's scrollback holds every round, so its newest "Verdict" label
 * wins. Falls back to the last verdict phrase.
 */
export function parseTerminalVerdict(text: string): ReviewVerdict | null {
  // The newest `HANDOFF: Verdict` wins (handoffSections keeps the last one).
  const declared = contractVerdictText(text);
  const fromContract = declared ? lastMatch(declared) : null;
  if (fromContract) return fromContract;
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!/\bverdict\b/i.test(lines[i])) continue;
    const found = parseReviewVerdict(lines.slice(i).join("\n"));
    if (found) return found;
  }
  return parseReviewVerdict(text);
}

export function verdictTone(verdict: ReviewVerdict): VerdictTone {
  if (verdict === "APPROVED") return "ok";
  if (verdict === "APPROVED WITH CHANGES") return "warn";
  return "bad";
}

/** The reviewer wants another round. */
export function needsRevision(verdict: ReviewVerdict | null): boolean {
  return verdict === "REQUIRES REVISION" || verdict === "REQUEST CHANGES" || verdict === "REJECTED";
}

/** Roles whose replies carry a verdict. */
export function isReviewerRole(roleId: string): boolean {
  return roleId === "role_plan_reviewer" || roleId === "role_pr_reviewer";
}
