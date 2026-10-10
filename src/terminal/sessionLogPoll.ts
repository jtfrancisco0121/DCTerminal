/**
 * When to re-read a terminal tab's Claude session log. Reads happen every
 * SESSION_LOG_POLL_MS while the PTY is producing output, once more after it
 * goes quiet, and a few more times while that read says the turn is still
 * open (a permission prompt keeps the screen still). A finished turn on a
 * quiet tab is never re-read.
 */

export const SESSION_LOG_POLL_MS = 3000;
/** Quiet reads allowed while the log says the turn has not ended. */
export const SESSION_LOG_QUIET_READS = 10;

export type SessionLogPollState = {
  lastReadAt: number;
  /** Reads since the PTY went quiet. */
  quietReads: number;
  /** null: the tab has no session log (Cursor, an older tab). */
  turnDone: boolean | null;
};

/**
 * Called on every tick. Output since the last read re-arms the quiet read,
 * even when the burst ended before the next poll.
 */
export function sessionLogTick(
  state: SessionLogPollState | undefined,
  busy: boolean,
): SessionLogPollState | undefined {
  return busy && state && state.quietReads > 0 ? { ...state, quietReads: 0 } : state;
}

export function sessionLogDue(
  state: SessionLogPollState | undefined,
  busy: boolean,
  now: number,
): boolean {
  if (!state) return true;
  const waited = now - state.lastReadAt >= SESSION_LOG_POLL_MS;
  if (busy) return waited;
  if (state.quietReads === 0) return true;
  return state.turnDone === false && state.quietReads < SESSION_LOG_QUIET_READS && waited;
}

export function afterSessionLogRead(
  state: SessionLogPollState | undefined,
  busy: boolean,
  log: { turnDone: boolean } | null,
  now: number,
): SessionLogPollState {
  return {
    lastReadAt: now,
    quietReads: busy ? 0 : (state?.quietReads ?? 0) + 1,
    turnDone: log ? log.turnDone : null,
  };
}

/** The fields the app reacts to; tool calls are read by the activity panel itself. */
export function sameSessionLog(
  a: {
    turnDone: boolean;
    lastReply: string;
    plan: string | null;
    planAt: string | null;
    lastPromptAt: string | null;
  } | null | undefined,
  b: typeof a,
): boolean {
  if (!a || !b) return a === b;
  return (
    a.turnDone === b.turnDone &&
    a.lastReply === b.lastReply &&
    a.plan === b.plan &&
    a.planAt === b.planAt &&
    a.lastPromptAt === b.lastPromptAt
  );
}
