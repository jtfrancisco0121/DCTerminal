/**
 * The GitHub monitor: activity in the watched koneksi-tech repos and the
 * user's own repos, plus what needs the user. Read-only. The data comes from
 * the window's poller (see useGithubPoller) through the feed cache, so the
 * tab shows its last feed right after a tab switch.
 */
import { useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { githubPushCommits, githubSaveFilters, githubStatus } from "../bridge";
import {
  requestGithubRefresh,
  setGithubFilters,
  setGithubStatus,
  setPushCommits,
  useGithubState,
} from "../github/feedCache";
import {
  applyFilters,
  chipCounts,
  groupByDay,
  isGithubUrl,
  kindLabel,
  kindTone,
  reachNote,
  refLabel,
  relativeTime,
  reposForChip,
  shortRepo,
  TYPE_GROUPS,
  unreachable,
} from "../github/githubModel";
import type { FeedItem, GithubFilters } from "../github/githubTypes";
import { needsYouItems, needsYouLabel, needsYouMeta, needsYouRef } from "../github/needsYou";
import { errorText } from "./InlineNotice";

type Props = {
  onNotice: (title: string, body: string) => void;
};

const CHIPS: { id: GithubFilters["chip"]; label: string }[] = [
  { id: "all", label: "All" },
  { id: "koneksi-tech", label: "koneksi-tech" },
  { id: "mine", label: "Mine" },
];

function ago(seconds: number | undefined, now: number): string {
  if (!seconds) return "";
  const s = Math.max(0, Math.round(now / 1000 - seconds));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  return `${Math.round(s / 60)}m ago`;
}

export function GitHubTab({ onNotice }: Props) {
  const { feed, status, filters, error, loading, commits } = useGithubState();
  const [now, setNow] = useState(() => Date.now());
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);

  // The saved filters and gh's state load once per run.
  useEffect(() => {
    if (status) return;
    void githubStatus()
      .then(setGithubStatus)
      .catch((err: unknown) => onNotice("GitHub status not read", errorText(err)));
  }, [status, onNotice]);

  const open = (url: string) => {
    if (!isGithubUrl(url)) return;
    void openUrl(url).catch((err: unknown) =>
      onNotice("Could not open the browser", errorText(err)),
    );
  };

  const change = (patch: Partial<GithubFilters>) => {
    const next = { ...filters, ...patch };
    setGithubFilters(next);
    void githubSaveFilters(next).catch((err: unknown) =>
      onNotice("GitHub filters not saved", errorText(err)),
    );
  };

  const checkAgain = () => {
    void githubStatus()
      .then(setGithubStatus)
      .catch((err: unknown) => onNotice("GitHub status not read", errorText(err)));
    requestGithubRefresh();
  };

  const repos = feed?.repos ?? status?.repos ?? [];
  const counts = chipCounts(repos);
  const n = (chip: string) => (chip === "all" ? counts.all : chip === "mine" ? counts.mine : counts.org);
  const filtered = useMemo(() => applyFilters(feed?.items ?? [], filters), [feed, filters]);
  const days = useMemo(() => groupByDay(filtered.shown, now), [filtered, now]);
  const needs = needsYouItems(feed);
  const gone = unreachable(repos);
  const setup = feed?.setup ?? (status && status.state !== "ready" && !feed ? { state: status.state, fix: status.fix ?? "" } : null);
  const note = reachNote(repos, filters);
  const pushKey = (item: FeedItem) => `${item.repo}@${item.push?.head ?? ""}`;

  const togglePush = (item: FeedItem) => {
    const key = pushKey(item);
    const wasOpen = !!expanded[key];
    setExpanded((prev) => ({ ...prev, [key]: !wasOpen }));
    if (wasOpen || !item.push || commits[key]) return;
    void githubPushCommits(item.repo, item.push.before, item.push.head)
      .then((loaded) => setPushCommits(key, loaded))
      .catch((err: unknown) => setPushCommits(key, { error: errorText(err) }));
  };

  if (setup) {
    return (
      <section className="gh-tab" aria-label="GitHub">
        <div className="gh-setup" role="status">
          <h2 className="gh-setup-title">
            {setup.state === "missing"
              ? "GitHub CLI not found"
              : setup.state === "signed_out"
                ? "Signed out of GitHub"
                : setup.state === "scope"
                  ? "gh needs another permission"
                  : "GitHub cannot be reached"}
          </h2>
          <p>{setup.fix}</p>
          <p className="gh-muted">DCTerminal reads GitHub through gh, so it never sees your token.</p>
          <div>
            <button type="button" className="primary-button" onClick={checkAgain}>
              Check again
            </button>
          </div>
        </div>
      </section>
    );
  }

  const visibleRepos = reposForChip(repos, filters.chip);
  return (
    <section className="gh-tab" aria-label="GitHub">
      <header className="gh-head">
        <h2 className="gh-title">GitHub</h2>
        <span className="gh-muted">
          {status?.login ? `${status.login} · ` : ""}read through your gh login
        </span>
        <span className="gh-spacer" />
        <span className="gh-muted" aria-live="polite">
          {loading && !feed
            ? "Loading…"
            : feed
              ? `Updated ${ago(feed.fetchedAt, now)} · every ${feed.pollInterval}s`
              : ""}
        </span>
      </header>

      <div className="gh-filters">
        <div className="gh-row-filters" role="group" aria-label="Source">
          {CHIPS.map((chip) => (
            <button
              key={chip.id}
              type="button"
              className="gh-chip"
              aria-pressed={filters.chip === chip.id}
              onClick={() => change({ chip: chip.id, repo: "" })}
            >
              {chip.label}
              <span className="gh-chip-count">
                {` · ${n(chip.id)} repo${n(chip.id) === 1 ? "" : "s"}`}
              </span>
            </button>
          ))}
          <label className="gh-field">
            <span className="gh-muted">Repo</span>
            <select
              value={filters.repo}
              onChange={(event) => change({ repo: event.target.value })}
              aria-label="Repo"
            >
              <option value="">All repos</option>
              {visibleRepos.map((repo) => (
                <option key={repo.repo} value={repo.repo}>
                  {shortRepo(repo.repo)}
                  {repo.source === "personal" ? " (personal)" : ""}
                  {repo.reachable === false ? " — can’t be reached" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="gh-check">
            <input
              type="checkbox"
              checked={filters.involvesMe}
              onChange={(event) => change({ involvesMe: event.target.checked })}
            />
            Involves me
          </label>
          <label className="gh-check">
            <input
              type="checkbox"
              checked={filters.showBots}
              onChange={(event) => change({ showBots: event.target.checked })}
            />
            Show bots
          </label>
        </div>
        <div className="gh-row-filters" role="group" aria-label="Event types">
          <span className="gh-muted">Show</span>
          {TYPE_GROUPS.map((group) => {
            const on = !filters.hiddenTypes.includes(group.id);
            return (
              <button
                key={group.id}
                type="button"
                className="gh-chip gh-chip-small"
                aria-pressed={on}
                onClick={() =>
                  change({
                    hiddenTypes: on
                      ? [...filters.hiddenTypes, group.id]
                      : filters.hiddenTypes.filter((t) => t !== group.id),
                  })
                }
              >
                {group.label}
              </button>
            );
          })}
        </div>
      </div>

      {error && (
        <div className="gh-banner gh-banner-warn" role="alert">
          <strong>The last update failed.</strong> {error}
        </div>
      )}
      {gone.length > 0 && (
        <div className="gh-banner gh-banner-warn" role="status">
          <strong>
            {gone.map((r) => shortRepo(r.repo)).join(", ")} can’t be reached
          </strong>
          <span>
            {" "}
            It may have been renamed, or your access changed. The other {repos.length - gone.length}{" "}
            repos still update.
          </span>
        </div>
      )}
      {feed?.rateLimited && (
        <div className="gh-banner" role="status">
          GitHub’s rate limit is nearly used up, so updates are paused until it resets.
        </div>
      )}

      <div className="gh-body">
        <section className="gh-needs" aria-label="Needs you">
          <div className="gh-needs-head">
            <strong>Needs you</strong>
            <span className="gh-needs-count">{needs.length}</span>
            <span className="gh-muted">From your notifications and PR search</span>
          </div>
          {needs.length === 0 ? (
            <p className="gh-empty">Nothing needs you in these repos.</p>
          ) : (
            <ul className="gh-needs-list">
              {needs.map((item) => (
                <li key={item.id} className="gh-needs-item">
                  <span className="gh-needs-text">
                    <span className="gh-needs-label">{needsYouLabel(item)}</span>
                    <span>
                      <span className="gh-ref">{needsYouRef(item)}</span> {item.title}
                    </span>
                    <span className="gh-muted">
                      {[needsYouMeta(item), relativeTime(item.at, now)].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={!isGithubUrl(item.url)}
                    onClick={() => open(item.url)}
                  >
                    Open
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="gh-feed" aria-label="Activity">
          <div className="gh-feed-head">
            <strong>Activity</strong>
            <span className="gh-muted">newest first</span>
          </div>
          {days.length === 0 ? (
            <p className="gh-empty">
              {feed ? "No activity matches these filters." : "Loading activity…"}
            </p>
          ) : (
            days.map((day) => (
              <div key={day.label} className="gh-day">
                <h3 className="gh-day-label">{day.label}</h3>
                <ul className="gh-items">
                  {day.items.map((item) => {
                    const key = pushKey(item);
                    const loaded = commits[key];
                    return (
                      <li key={`${item.repo}:${item.id}`} className="gh-item">
                        <div className="gh-item-line">
                          <button
                            type="button"
                            className="gh-item-main"
                            disabled={!isGithubUrl(item.url)}
                            onClick={() => open(item.url)}
                            title={isGithubUrl(item.url) ? "Open on GitHub" : undefined}
                          >
                            <span className="gh-time">{relativeTime(item.at, now)}</span>
                            <span className={`gh-kind gh-kind-${kindTone(item)}`}>{kindLabel(item)}</span>
                            <span className="gh-ref">{refLabel(item)}</span>
                            <span className="gh-item-title">{item.title}</span>
                            <span className="gh-muted gh-item-detail">{item.detail}</span>
                            <span className={`gh-source gh-source-${item.source === "personal" ? "mine" : "org"}`}>
                              {item.source === "personal" ? "mine" : "koneksi"}
                            </span>
                            <span className="gh-actor">
                              {item.actor}
                              {item.actorIsBot ? <span className="gh-bot"> bot</span> : null}
                            </span>
                          </button>
                          {item.push && (
                            <button
                              type="button"
                              className="gh-expand"
                              aria-expanded={!!expanded[key]}
                              onClick={() => togglePush(item)}
                            >
                              {expanded[key] ? "Hide commits" : "Show commits"}
                            </button>
                          )}
                        </div>
                        {item.push && expanded[key] && (
                          <ul className="gh-commits">
                            {!loaded && <li className="gh-muted">Loading commits…</li>}
                            {loaded && "error" in loaded && (
                              <li className="gh-muted">{loaded.error}</li>
                            )}
                            {loaded &&
                              "commits" in loaded &&
                              loaded.commits.map((commit) => (
                                <li key={commit.sha}>
                                  <button
                                    type="button"
                                    className="gh-commit"
                                    disabled={!isGithubUrl(commit.url)}
                                    onClick={() => open(commit.url)}
                                  >
                                    <code>{commit.sha.slice(0, 7)}</code>
                                    <span>{commit.message}</span>
                                    <span className="gh-muted">{commit.author}</span>
                                  </button>
                                </li>
                              ))}
                            {loaded && "commits" in loaded && loaded.total > loaded.commits.length && (
                              <li className="gh-muted">
                                {loaded.total - loaded.commits.length} more on GitHub
                              </li>
                            )}
                          </ul>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))
          )}
          <footer className="gh-foot">
            {note && <span>{note}</span>}
            {filtered.hiddenBots > 0 && (
              <span>
                {filtered.hiddenBots} bot event{filtered.hiddenBots === 1 ? "" : "s"} hidden
              </span>
            )}
            <span>Read-only. DCTerminal never sees your GitHub token.</span>
          </footer>
        </section>
      </div>
    </section>
  );
}
