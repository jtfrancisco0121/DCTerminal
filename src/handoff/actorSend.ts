import type { ActorAction, ActorOutcome } from "../bridge";

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

/**
 * The run whose actor takes your terminal hand-off from `tab`: its chain's
 * run when that run is on engine 2, else null (the hand-off works the
 * engine-1 way). `engine` is the run's, as `getPipelineRun` reads it.
 */
export function actorRunFor(
  surface: string,
  tab: { chain?: { chainId: string } | null; bridge?: { runId: string } | null } | null | undefined,
  engine: number | null | undefined,
): string | null {
  if (surface !== "terminal" || !tab?.chain) return null;
  return (engine ?? 1) >= 2 ? tab.chain.chainId : null;
}

/**
 * The engine-2 run a hand-off you make yourself, not through the actor (to
 * a Chat tab, or into a live chat tab), is recorded on, so autopilot and you
 * never both make it; null on an engine-1 run, which has no autopilot.
 */
export function recordRunFor(
  tab: { chain?: { chainId: string } | null } | null | undefined,
  engine: number | null | undefined,
): string | null {
  if (!tab?.chain) return null;
  return (engine ?? 1) >= 2 ? tab.chain.chainId : null;
}

/** The hand-off on (or, `back`, send-back) from `sourceTabId` you make yourself. */
export interface YourHandoff {
  sourceTabId: string;
  back: boolean;
  force?: boolean;
}

type ActorMessage = (runId: string, action: ActorAction) => Promise<ActorOutcome>;

/**
 * Records your hand-off with `runId`'s actor before you make it, as your
 * terminal Send does: autopilot's warning when it made it already (nothing
 * recorded; `force` records it anyway), else null. No run, or the actor
 * could not record it: null, and the hand-off goes ahead.
 */
export async function recordYourHandoff(
  runId: string | null,
  handoff: YourHandoff,
  message: ActorMessage,
): Promise<string | null> {
  if (!runId) return null;
  const outcome = await message(runId, {
    kind: "recordHandoff",
    sourceTabId: handoff.sourceTabId,
    back: handoff.back,
    force: !!handoff.force,
    // intentionally silent: unrecorded (say a tab the actor does not place), the hand-off goes ahead as before.
  }).catch(() => null);
  return outcome?.warning ?? null;
}

/** Drops the record when the hand-off then failed, so autopilot may make it. */
export async function releaseYourHandoff(
  runId: string | null,
  handoff: YourHandoff,
  message: ActorMessage,
): Promise<void> {
  if (!runId) return;
  // intentionally silent: a record left behind only adds a warning to a later hand-off.
  await message(runId, { kind: "releaseHandoff", sourceTabId: handoff.sourceTabId, back: handoff.back }).catch(
    () => {},
  );
}
