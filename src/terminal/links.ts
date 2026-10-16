/**
 * `path:line` links in terminal output (compiler errors, stack traces, test
 * failures). Pure helpers: park.ts registers the xterm link provider.
 */

export type PathLink = {
  /** The matched text, for example `src/app.ts:12:3`. */
  text: string;
  /** The path part, as printed. */
  path: string;
  line: number;
  column: number | null;
  /** Zero-based start offset in the line, and exclusive end offset. */
  start: number;
  end: number;
};

// No lookbehind: older WebKit builds reject it at parse time. The first group
// is the character before the path, so a URL host such as `example.com:8080`
// (preceded by `/`) is not taken for a file.
const PATH_LINE =
  /(^|[^\w/\\.:@~-])((?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|~\/|\/)?(?:[\w.@~+-]+[\\/])*[\w@~+-][\w.@~+-]*\.[A-Za-z][A-Za-z0-9]{0,7}):(\d+)(?::(\d+))?(?!\w)/g;

/** Every `path:line[:col]` in one line of terminal text. */
export function findPathLinks(text: string): PathLink[] {
  const links: PathLink[] = [];
  PATH_LINE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PATH_LINE.exec(text)) !== null) {
    const prefix = match[1] ?? "";
    const path = match[2];
    const start = match.index + prefix.length;
    const line = Number(match[3]);
    if (!Number.isSafeInteger(line) || line < 1) continue;
    links.push({
      text: match[0].slice(prefix.length),
      path,
      line,
      column: match[4] ? Number(match[4]) : null,
      start,
      end: match.index + match[0].length,
    });
  }
  return links;
}

/** A bare path in terminal output (no `:line`), before the existence check. */
export type BarePath = {
  path: string;
  /** Zero-based start offset in the line, and exclusive end offset. */
  start: number;
  end: number;
};

// Tokenising after ADE (better-agentic-ide) src/lib/terminalFileLinks.ts,
// MIT License, (c) 2025-2026 Alvin Reyes. Brackets, quotes and commas end a
// path, so "Write(docs/plan.md)" and "`a.md`," yield just the path.
const BARE_TOKEN = /[^\s`'"()<>[\]{}|,;]+/g;
const TRAILING = /[.:!?]+$/;
const LINE_COL = /(:\d+){1,2}$/;
const HAS_EXT = /\.[A-Za-z0-9]{1,10}$/;
/** At most this many candidates per line go to the existence check. */
export const MAX_BARE_PER_LINE = 20;

/**
 * Path-like tokens that `findPathLinks` does not already cover: anything with
 * a folder separator or a file extension. Most are not files ("e.g", "3.14"
 * is skipped here); the caller keeps only the ones that exist.
 */
export function findBarePaths(text: string): BarePath[] {
  const taken = findPathLinks(text);
  const out: BarePath[] = [];
  BARE_TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = BARE_TOKEN.exec(text)) !== null && out.length < MAX_BARE_PER_LINE) {
    const start = match.index;
    const raw = match[0];
    if (raw.includes("://") || raw.startsWith("-") || raw.startsWith("@")) continue;
    const token = raw.replace(TRAILING, "").replace(LINE_COL, "").replace(TRAILING, "");
    if (token.length < 3 || token.startsWith("~")) continue;
    if (!token.includes("/") && !token.includes("\\") && !HAS_EXT.test(token)) continue;
    if (/^v?[\d.]+$/.test(token) || /^\.+[\\/]*$/.test(token)) continue;
    const end = start + token.length;
    if (taken.some((link) => start < link.end && end > link.start)) continue;
    out.push({ path: token, start, end });
  }
  return out;
}

function segments(value: string): string[] {
  return value.split("/").filter((part) => part && part !== ".");
}

/**
 * The path relative to the tab's folder, which is what the Files panel opens,
 * or null when the file lies outside it (or the path is `~`-based).
 */
export function relativeToCwd(path: string, cwd: string): string | null {
  const file = path.replace(/\\/g, "/");
  const root = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  if (file.startsWith("~/")) return null;
  let rest: string[];
  const absolute = file.startsWith("/") || /^[A-Za-z]:\//.test(file);
  if (absolute) {
    const lowerFile = file.toLowerCase();
    const lowerRoot = root.toLowerCase();
    const caseless = /^[A-Za-z]:/.test(root);
    const a = caseless ? lowerFile : file;
    const b = caseless ? lowerRoot : root;
    if (!root || !a.startsWith(`${b}/`)) return null;
    rest = segments(file.slice(root.length + 1));
  } else {
    rest = segments(file);
  }
  const out: string[] = [];
  for (const part of rest) {
    if (part === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else {
      out.push(part);
    }
  }
  return out.length > 0 ? out.join("/") : null;
}

/** Cmd-click on macOS, Ctrl-click elsewhere. A plain click only selects. */
export function isLinkModifier(
  event: { metaKey: boolean; ctrlKey: boolean },
  platform: "mac" | "windows" | "linux",
): boolean {
  return platform === "mac" ? event.metaKey : event.ctrlKey;
}
