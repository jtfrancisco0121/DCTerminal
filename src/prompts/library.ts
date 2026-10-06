/** F6 prompt library helpers (pure; the data lives in app data via bridge). */

export type PadSelection = { start: number; end: number };

/**
 * Put `text` into the pad: replace the selection / insert at the cursor when
 * one is known, else append after a blank line. Returns the caret after it.
 */
export function insertIntoPad(
  content: string,
  text: string,
  selection?: PadSelection | null,
): { content: string; caret: number } {
  if (selection) {
    const start = Math.min(Math.max(0, selection.start), content.length);
    const end = Math.min(Math.max(start, selection.end), content.length);
    return {
      content: content.slice(0, start) + text + content.slice(end),
      caret: start + text.length,
    };
  }
  if (!content) return { content: text, caret: text.length };
  const sep = content.endsWith("\n\n") ? "" : content.endsWith("\n") ? "\n" : "\n\n";
  const next = content + sep + text;
  return { content: next, caret: next.length };
}

const NAME_MAX = 60;

/** A starting name for "Save as prompt": the first non-blank line. */
export function defaultPromptName(body: string): string {
  const line = body.split(/\r?\n/).find((l) => l.trim())?.trim() ?? "";
  return line.length > NAME_MAX ? `${line.slice(0, NAME_MAX - 1)}…` : line;
}

/** Keep items whose name or body contains every word of `query`. */
export function filterPrompts<T extends { name?: string; body?: string; text?: string }>(
  items: T[],
  query: string,
): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return items;
  return items.filter((item) => {
    const hay = `${item.name ?? ""}\n${item.body ?? ""}\n${item.text ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
