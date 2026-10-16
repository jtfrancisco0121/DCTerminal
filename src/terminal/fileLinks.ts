/**
 * Which bare paths in terminal output name real files in the tab's folder.
 * One batched backend call per line, with a short cache so hovering the same
 * output does not ask again. Design after ADE (better-agentic-ide)
 * src/lib/terminalFileLinks.ts, MIT License, (c) 2025-2026 Alvin Reyes.
 */
import { filesResolve } from "../bridge";

export const RESOLVE_CACHE_MS = 4000;
const MAX_CACHE = 2000;

type Resolver = (tabId: string, paths: string[]) => Promise<string[]>;

const cache = new Map<string, { at: number; exists: boolean }>();
// Read at call time, not import time: test files that mock the bridge
// without filesResolve still load the terminal modules.
let resolver: Resolver | null = null;

/** Tests swap the backend call. */
export function setFileResolver(next: Resolver | null): void {
  resolver = next;
  cache.clear();
}

/** The subset of `paths` that exist inside the tab's folder. Never rejects. */
export async function existingPaths(
  tabId: string,
  paths: string[],
  now: number = Date.now(),
): Promise<Set<string>> {
  const key = (path: string) => `${tabId}\0${path}`;
  const unique = [...new Set(paths)];
  const missing = unique.filter((path) => {
    const hit = cache.get(key(path));
    return !hit || now - hit.at > RESOLVE_CACHE_MS;
  });
  if (missing.length > 0) {
    let found: string[];
    try {
      found = await (resolver ?? filesResolve)(tabId, missing);
    } catch {
      // intentionally silent: a failed check only means no link this time.
      return new Set();
    }
    if (cache.size > MAX_CACHE) cache.clear();
    const hits = new Set(found);
    for (const path of missing) cache.set(key(path), { at: now, exists: hits.has(path) });
  }
  return new Set(unique.filter((path) => cache.get(key(path))?.exists));
}
