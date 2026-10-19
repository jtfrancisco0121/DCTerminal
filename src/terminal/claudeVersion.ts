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

/** Toast slot of the version notice, so a later app notice does not replace it. */
export const CLAUDE_VERSION_NOTICE_SLOT = "__claude-version__";

type Version = { core: [number, number, number]; pre: string[] };

/**
 * The first `major.minor.patch[-pre-release]` in text such as
 * `2.1.287 (Claude Code)` or `2.1.287-beta.1`; build metadata (`+build5`) is
 * ignored. Null when there is none.
 */
function parseVersion(text: string | null | undefined): Version | null {
  const match = /(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?/.exec(text ?? "");
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split(".") : [],
  };
}

function versionText(version: Version): string {
  const core = version.core.join(".");
  return version.pre.length ? `${core}-${version.pre.join(".")}` : core;
}

/** Semver pre-release order: a release is above any of its pre-releases. */
function comparePre(a: string[], b: string[]): number {
  if (!a.length || !b.length) return b.length - a.length;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const [x, y] = [a[i], b[i]];
    if (x === y) continue;
    const [xNum, yNum] = [/^\d+$/.test(x), /^\d+$/.test(y)];
    if (xNum && yNum) return Number(x) - Number(y);
    if (xNum !== yNum) return xNum ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return a.length - b.length;
}

/** Missing or unreadable is "unknown", never a mismatch. A pre-release is not its release. */
export function compareClaudeVersion(
  detected: string | null | undefined,
  tested: string = TESTED_CLAUDE_VERSION,
): ClaudeVersionCheck {
  const have = parseVersion(detected);
  const want = parseVersion(tested);
  if (!have || !want) return "unknown";
  for (let i = 0; i < 3; i++) {
    if (have.core[i] !== want.core[i]) return have.core[i] > want.core[i] ? "newer" : "older";
  }
  const pre = comparePre(have.pre, want.pre);
  return pre === 0 ? "match" : pre > 0 ? "newer" : "older";
}

/** Plain words for a mismatch; null for the tested version or an unknown one. */
export function claudeVersionWarning(detected: string | null | undefined): string | null {
  const check = compareClaudeVersion(detected);
  if (check === "match" || check === "unknown") return null;
  const have = versionText(parseVersion(detected)!);
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
  notice: (title: string, body: string, slot: string) => void,
): void {
  useEffect(() => {
    const warning = claudeVersionWarning(detected);
    if (!warning) return;
    const key = versionText(parseVersion(detected)!);
    if (announced.has(key)) return;
    announced.add(key);
    notice("Claude Code version not tested", warning, CLAUDE_VERSION_NOTICE_SLOT);
  }, [detected, notice]);
}

/** For tests. */
export function resetClaudeVersionNotices(): void {
  announced.clear();
}
