import { classifyTurn, type TurnOutcome } from "./pad";

export type TurnNotice = {
  tabId: string;
  success: boolean;
  stopReason?: string | null;
  error?: string | null;
};

type Pending = {
  resolve: (outcome: TurnOutcome) => void;
};

/**
 * One in-flight ACP turn per tab. `expect` may run before the send returns;
 * `notify` resolves it from the real `prompt-finished` event, even if that
 * event arrives first.
 */
export function createTurnWaiter() {
  const pending = new Map<string, Pending>();
  const early = new Map<string, TurnOutcome>();

  return {
    expect(tabId: string): Promise<TurnOutcome> {
      const already = early.get(tabId);
      if (already) {
        early.delete(tabId);
        return Promise.resolve(already);
      }
      return new Promise((resolve) => {
        pending.set(tabId, { resolve });
      });
    },
    notify(evt: TurnNotice): void {
      const outcome = classifyTurn(evt);
      const waiter = pending.get(evt.tabId);
      if (waiter) {
        pending.delete(evt.tabId);
        waiter.resolve(outcome);
        return;
      }
      early.set(evt.tabId, outcome);
    },
    /** A new turn starts: a result left over from an earlier, unwatched turn is stale. */
    forget(tabId: string): void {
      early.delete(tabId);
    },
    cancel(tabId: string): void {
      const waiter = pending.get(tabId);
      if (!waiter) return;
      pending.delete(tabId);
      waiter.resolve("cancelled");
    },
  };
}
