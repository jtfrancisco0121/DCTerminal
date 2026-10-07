/** Per-tab ring buffer of sent follow-up messages (arrow keys in the composer). */

export const COMPOSER_HISTORY_LIMIT = 50;

export function pushComposerHistory(
  history: string[],
  message: string,
  limit = COMPOSER_HISTORY_LIMIT,
): string[] {
  const trimmed = message.trim();
  if (!trimmed) return history;
  const withoutDup = history.filter((line) => line !== trimmed);
  const next = [...withoutDup, trimmed];
  if (next.length <= limit) return next;
  return next.slice(next.length - limit);
}
