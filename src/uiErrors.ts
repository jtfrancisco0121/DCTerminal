/**
 * Render errors caught by a pane or view boundary (PaneBoundary), newest
 * last, for the log drawer. Kept in memory for this window only.
 */

export type UiError = { at: number; source: string; message: string };

const MAX_ERRORS = 50;

let errors: readonly UiError[] = [];
const listeners = new Set<() => void>();

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

export function recordUiError(source: string, error: unknown): void {
  errors = [...errors, { at: Date.now(), source, message: messageOf(error) }].slice(-MAX_ERRORS);
  for (const listener of listeners) listener();
}

/** A stable array until the next error (fit for useSyncExternalStore). */
export function uiErrors(): readonly UiError[] {
  return errors;
}

export function subscribeUiErrors(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** For tests. */
export function clearUiErrors(): void {
  errors = [];
  for (const listener of listeners) listener();
}
