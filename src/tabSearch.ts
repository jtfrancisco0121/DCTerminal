/** F2 jump-to-tab: rank open tabs by name, folder name, then full path. */

export type SearchableTab = { id: string; label: string; cwd: string };

export function folderName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

function tokenScore(token: string, label: string, folder: string, cwd: string, extra: string) {
  if (label.startsWith(token)) return 0;
  if (label.split(/[\s·\-_/]+/).some((word) => word.startsWith(token))) return 1;
  if (label.includes(token)) return 2;
  if (folder.includes(token)) return 3;
  if (cwd.includes(token)) return 4;
  if (extra.includes(token)) return 5;
  return null;
}

/**
 * Every word in the query must match the name, folder, path, or `extra`
 * (status text). Better matches first; ties keep tab order.
 */
export function searchTabs<T extends SearchableTab>(
  tabs: T[],
  query: string,
  extra: (tab: T) => string = () => "",
): T[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return tabs;
  const scored: { tab: T; score: number; index: number }[] = [];
  tabs.forEach((tab, index) => {
    const label = tab.label.toLowerCase();
    const cwd = tab.cwd.toLowerCase();
    const folder = folderName(cwd);
    const more = extra(tab).toLowerCase();
    let score = 0;
    for (const token of tokens) {
      const s = tokenScore(token, label, folder, cwd, more);
      if (s === null) return;
      score += s;
    }
    scored.push({ tab, score, index });
  });
  return scored.sort((a, b) => a.score - b.score || a.index - b.index).map((item) => item.tab);
}
