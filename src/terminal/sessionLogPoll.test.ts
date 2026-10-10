import { describe, expect, it } from "vitest";
import {
  SESSION_LOG_POLL_MS,
  SESSION_LOG_QUIET_READS,
  afterSessionLogRead,
  sameSessionLog,
  sessionLogDue,
  sessionLogTick,
  type SessionLogPollState,
} from "./sessionLogPoll";

const read = (
  state: SessionLogPollState | undefined,
  busy: boolean,
  turnDone: boolean | null,
  now: number,
) => afterSessionLogRead(state, busy, turnDone === null ? null : { turnDone }, now);

describe("session log polling", () => {
  it("reads once when first watched, then not while idle and done", () => {
    expect(sessionLogDue(undefined, false, 0)).toBe(true);
    const state = read(undefined, false, true, 0);
    expect(sessionLogDue(state, false, 60_000)).toBe(false);
  });

  it("reads every few seconds while output streams, then once after it stops", () => {
    let state = read(undefined, false, true, 0);
    state = sessionLogTick(state, true)!;
    expect(sessionLogDue(state, true, 1_000)).toBe(false);
    expect(sessionLogDue(state, true, SESSION_LOG_POLL_MS)).toBe(true);
    state = read(state, true, false, 1_000);
    expect(sessionLogDue(state, true, 1_000 + SESSION_LOG_POLL_MS - 1)).toBe(false);
    expect(sessionLogDue(state, true, 1_000 + SESSION_LOG_POLL_MS)).toBe(true);
    expect(sessionLogDue(state, false, 1_500)).toBe(true);
    state = read(state, false, true, 1_500);
    expect(sessionLogDue(state, false, 100_000)).toBe(false);
  });

  it("re-arms the quiet read after a burst shorter than a poll", () => {
    let state = read(undefined, false, true, 0);
    state = read(state, false, true, 10_000);
    state = sessionLogTick(state, true)!;
    expect(sessionLogDue(state, false, 10_500)).toBe(true);
  });

  it("keeps reading a quiet tab whose turn is open, a few times", () => {
    let state = read(undefined, true, false, 0);
    let now = 0;
    let reads = 0;
    while (sessionLogDue(state, false, (now += SESSION_LOG_POLL_MS))) {
      state = read(state, false, false, now);
      reads += 1;
    }
    expect(reads).toBe(SESSION_LOG_QUIET_READS);
  });

  it("does not re-read a quiet tab without a log", () => {
    const state = read(read(undefined, true, null, 0), false, null, 1_000);
    expect(sessionLogDue(state, false, 60_000)).toBe(false);
    expect(sessionLogDue(state, true, 60_000)).toBe(true);
  });

  it("compares only the fields the app reacts to", () => {
    const log = { turnDone: true, lastReply: "a", plan: null, planAt: null, lastPromptAt: "t" };
    expect(sameSessionLog(log, { ...log })).toBe(true);
    expect(sameSessionLog(log, { ...log, turnDone: false })).toBe(false);
    expect(sameSessionLog(log, { ...log, lastReply: "b" })).toBe(false);
    expect(sameSessionLog(null, null)).toBe(true);
    expect(sameSessionLog(log, null)).toBe(false);
  });
});
