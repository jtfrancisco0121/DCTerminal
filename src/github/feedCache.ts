/**
 * The GitHub tab's data, kept at module level so it survives tab switches
 * and remounts: the tab shows its last feed at once while the poller (which
 * runs at window level) fetches the next.
 */
import { useSyncExternalStore } from "react";
import type { GithubFeed, GithubFilters, GithubStatus, PushCommits } from "./githubTypes";
import { DEFAULT_FILTERS } from "./githubModel";

export type GithubState = {
  feed: GithubFeed | null;
  status: GithubStatus | null;
  filters: GithubFilters;
  /** Last failure to run a cycle at all (not a per-repo problem). */
  error: string | null;
  /** A cycle is running. */
  loading: boolean;
  /** Bumped by "Check again" to make the poller run now. */
  refreshNonce: number;
  /** Loaded push commits, by `repo@head`. */
  commits: Record<string, PushCommits | { error: string }>;
};

const initial = (): GithubState => ({
  feed: null,
  status: null,
  filters: DEFAULT_FILTERS,
  error: null,
  loading: false,
  refreshNonce: 0,
  commits: {},
});

let state: GithubState = initial();
const listeners = new Set<() => void>();

function set(patch: Partial<GithubState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function getGithubState(): GithubState {
  return state;
}

export function subscribeGithub(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useGithubState(): GithubState {
  return useSyncExternalStore(subscribeGithub, getGithubState, getGithubState);
}

export function setGithubFeed(feed: GithubFeed): void {
  set({ feed, error: null, loading: false });
}

export function setGithubStatus(status: GithubStatus): void {
  set({ status, filters: state.status ? state.filters : status.filters });
}

export function setGithubFilters(filters: GithubFilters): void {
  set({ filters });
}

export function setGithubError(error: string | null): void {
  set({ error, loading: false });
}

export function setGithubLoading(loading: boolean): void {
  set({ loading });
}

export function requestGithubRefresh(): void {
  set({ refreshNonce: state.refreshNonce + 1 });
}

export function setPushCommits(key: string, value: PushCommits | { error: string }): void {
  set({ commits: { ...state.commits, [key]: value } });
}

export function resetGithubStateForTests(): void {
  state = initial();
  for (const listener of listeners) listener();
}
