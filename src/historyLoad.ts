/**
 * Start form history in two passes. The quick pass reads only the folder's
 * own sessions and shows them first; the full pass reads every project and
 * replaces them, so the final rows are exactly what one full read returns.
 * A quick pass that fails, or ends after the full one, is ignored.
 */
export function loadHistoryInTwoPasses<T>(
  quick: (() => Promise<T[]>) | null,
  full: () => Promise<T[]>,
  onRows: (rows: T[]) => void,
  isCancelled: () => boolean,
): Promise<void> {
  let fullDone = false;
  if (quick) {
    quick()
      .then((rows) => {
        if (!fullDone && !isCancelled()) onRows(rows);
      })
      .catch(() => {});
  }
  return full().then((rows) => {
    fullDone = true;
    if (!isCancelled()) onRows(rows);
  }, (err: unknown) => {
    fullDone = true;
    throw err;
  });
}
