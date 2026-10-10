/**
 * Review verdicts from a Plan Reviewer or PR Reviewer reply. The overview
 * shows them and routing.ts picks the primary hand-off button from them;
 * nothing sends on a verdict by itself.
 */

export type ReviewVerdict =
  | "APPROVED"
  | "APPROVED WITH CHANGES"
  | "REQUIRES REVISION"
  | "REQUEST CHANGES"
  | "REJECTED";

export type VerdictTone = "ok" | "warn" | "bad";

// Longest first so "approved with changes" never reads as "approved".
const VERDICT_RE =
  /\b(approved\s+with\s+changes|requires\s+revision|request(?:ed)?\s+changes|changes\s+requested|rejected|approved)\b/gi;

function normalize(match: string): ReviewVerdict {
  const words = match.toLowerCase().replace(/\s+/g, " ");
  if (words === "approved with changes") return "APPROVED WITH CHANGES";
  if (words === "requires revision") return "REQUIRES REVISION";
  if (words.startsWith("request") || words === "changes requested") return "REQUEST CHANGES";
  if (words === "rejected") return "REJECTED";
  return "APPROVED";
}

function lastMatch(text: string): ReviewVerdict | null {
  let found: string | null = null;
  for (const match of text.matchAll(VERDICT_RE)) found = match[1];
  return found ? normalize(found) : null;
}

/**
 * The verdict in a reviewer's reply. Text under a "Verdict" heading or
 * label wins; otherwise the last verdict phrase in the reply. Null when
 * the reply has none.
 */
export function parseReviewVerdict(text: string): ReviewVerdict | null {
  if (!text.trim()) return null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (!/\bverdict\b/i.test(lines[i])) continue;
    const sameLine = lastMatch(lines[i].replace(/^.*?\bverdict\b/i, ""));
    if (sameLine) return sameLine;
    // The first non-empty line after the label.
    for (let j = i + 1; j < lines.length; j += 1) {
      if (!lines[j].trim()) continue;
      const below = lastMatch(lines[j]);
      if (below) return below;
      break;
    }
  }
  return lastMatch(text);
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
