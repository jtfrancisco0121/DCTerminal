/** What a run actor answered a hand-off with (`pipelineActorMessage`). */
export interface ActorSendOutcome {
  tabId?: string | null;
}

/**
 * After your Send or Send back on an engine-2 run went to its run actor:
 * list the tabs again, then show the terminal it opened or sent into, as a
 * manual hand-off always switched to its tab. `fallbackTabId` is shown when
 * the actor names none. Autopilot's own opens stay in the background; this
 * is only for your button.
 */
export async function showActorOutcome(
  outcome: ActorSendOutcome,
  deps: { refreshTabs: () => Promise<unknown>; selectTab: (tabId: string) => Promise<unknown> },
  fallbackTabId: string | null = null,
): Promise<void> {
  await deps.refreshTabs();
  const tabId = outcome.tabId ?? fallbackTabId;
  if (tabId) await deps.selectTab(tabId);
}
