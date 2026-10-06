/**
 * F5 text matching. Case-insensitive and non-overlapping, the same rules as
 * `src-tauri/src/history_search.rs`, so a hit's `occurrence` from the
 * backend points at the same match here.
 */

export type TextRange = { start: number; end: number };

export type Snippet = { before: string; match: string; after: string };

export type SegmentLike = { id: string; kind: string; text: string };

export type SegmentHit = Snippet & {
  segmentId: string;
  segmentIndex: number;
  /** n-th match inside this segment. */
  occurrence: number;
  range: TextRange;
};

export type HighlightPart = { text: string; hit: number | null };

/** First char of the lowercase form, so one char stays one char. */
function fold(char: string): string {
  return [...char.toLowerCase()][0] ?? char;
}

export function findAll(text: string, query: string): TextRange[] {
  const needle = [...query].map(fold);
  if (needle.length === 0 || needle.every((c) => c.trim() === "")) return [];
  const chars: { at: number; c: string }[] = [];
  let at = 0;
  for (const c of text) {
    chars.push({ at, c: fold(c) });
    at += c.length;
  }
  const out: TextRange[] = [];
  let i = 0;
  while (i + needle.length <= chars.length) {
    let ok = true;
    for (let k = 0; k < needle.length; k += 1) {
      if (chars[i + k].c !== needle[k]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      const end = i + needle.length < chars.length ? chars[i + needle.length].at : text.length;
      out.push({ start: chars[i].at, end });
      i += needle.length;
    } else {
      i += 1;
    }
  }
  return out;
}

const oneLine = (text: string) => text.split(/\s+/).filter(Boolean).join(" ");

export function snippet(text: string, range: TextRange, radius = 60): Snippet {
  const head = [...text.slice(0, range.start)];
  const tail = [...text.slice(range.end)];
  let before = oneLine(head.slice(Math.max(0, head.length - radius)).join(""));
  let after = oneLine(tail.slice(0, radius).join(""));
  if (/\s$/.test(text.slice(0, range.start)) && before) before += " ";
  if (/^\s/.test(text.slice(range.end)) && after) after = ` ${after}`;
  if (head.length > radius) before = `…${before}`;
  if (tail.length > radius) after = `${after}…`;
  return { before, match: text.slice(range.start, range.end), after };
}

export function searchSegments(segments: SegmentLike[], query: string): SegmentHit[] {
  const hits: SegmentHit[] = [];
  segments.forEach((segment, segmentIndex) => {
    if (!segment.text.trim()) return;
    findAll(segment.text, query).forEach((range, occurrence) => {
      hits.push({
        segmentId: segment.id,
        segmentIndex,
        occurrence,
        range,
        ...snippet(segment.text, range),
      });
    });
  });
  return hits;
}

export function highlightParts(text: string, query: string): HighlightPart[] {
  const ranges = findAll(text, query);
  if (ranges.length === 0) return [{ text, hit: null }];
  const parts: HighlightPart[] = [];
  let at = 0;
  ranges.forEach((range, index) => {
    if (range.start > at) parts.push({ text: text.slice(at, range.start), hit: null });
    parts.push({ text: text.slice(range.start, range.end), hit: index });
    at = range.end;
  });
  if (at < text.length) parts.push({ text: text.slice(at), hit: null });
  return parts;
}
