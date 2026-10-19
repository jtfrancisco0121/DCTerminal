// The Claude Code version that Needs-you detection (permissionDialog.ts) was
// written and tested against. The detector matches that version's screen
// bytes, so a newer or older Claude may draw its permission dialog in a way
// the detector misses. The fixtures in fixtures/ are named
// `claude-<TESTED_CLAUDE_VERSION>-*.bin`, and a test keeps the two in step:
// re-capture the fixtures and bump this together.

import { useEffect } from "react";

export const TESTED_CLAUDE_VERSION = "2.1.287";

/** How the detected version compares with the tested one. */
export type ClaudeVersionCheck = "match" | "newer" | "older" | "unknown";

/** major.minor.patch from text such as `2.1.287 (Claude Code)`; null when absent. */
function versionParts(text: string | null | undefined): [number, number, number] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text ?? "");
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Missing or unreadable is "unknown", never a mismatch. */
export function compareClaudeVersion(
  detected: string | null | undefined,
  tested: string = TESTED_CLAUDE_VERSION,
): ClaudeVersionCheck {
  const have = versionParts(detected);
  const want = versionParts(tested);
  if (!have || !want) return "unknown";
  for (let i = 0; i < 3; i++) {
    if (have[i] !== want[i]) return have[i] > want[i] ? "newer" : "older";
  }
  return "match";
}

/** Plain words for a mismatch; null for the tested version or an unknown one. */
export function claudeVersionWarning(detected: string | null | undefined): string | null {
  const check = compareClaudeVersion(detected);
  if (check === "match" || check === "unknown") return null;
  const have = versionParts(detected)!.join(".");
  return (
    `Needs-you detection was written for Claude Code ${TESTED_CLAUDE_VERSION}; you have ${have}. ` +
    "If a tab asks for permission and does not show Needs you, answer in the terminal and tell JT."
  );
}

/** Versions already announced in this window (each window is its own page). */
const announced = new Set<string>();

/**
 * One notice per mismatched version per window. `detected` comes from the
 * provider check Settings > Providers already runs (useProviders), so this
 * adds no CLI call. Never blocks anything.
 */
export function useClaudeVersionNotice(
  detected: string | null | undefined,
  notice: (title: string, body: string) => void,
): void {
  useEffect(() => {
    const warning = claudeVersionWarning(detected);
    if (!warning) return;
    const key = versionParts(detected)!.join(".");
    if (announced.has(key)) return;
    announced.add(key);
    notice("Claude Code version not tested", warning);
  }, [detected, notice]);
}

/** For tests. */
export function resetClaudeVersionNotices(): void {
  announced.clear();
}
