// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const openUrl = vi.fn();
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: (url: string) => openUrl(url) }));
vi.mock("../bridge", () => ({
  githubStatus: vi.fn(),
  githubSaveFilters: vi.fn(),
  githubPushCommits: vi.fn(),
}));

import { githubPushCommits, githubSaveFilters, githubStatus } from "../bridge";
import { resetGithubStateForTests, setGithubFeed, setGithubStatus } from "../github/feedCache";
import { DEFAULT_FILTERS } from "../github/githubModel";
import { feed, item } from "../github/testFeed";
import { GitHubTab } from "./GitHubTab";

const repos = [
  { repo: "koneksi-tech/koneksi-web", source: "koneksi-tech", reachable: true, oldest: "2026-10-13T00:00:00Z" },
  { repo: "koneksi-tech/koneksi-s3-gateway", source: "koneksi-tech", reachable: false, error: "Not found" },
  { repo: "jtfrancisco0121/notes", source: "personal", reachable: true },
];
const ready = { state: "ready", login: "jtfrancisco0121", repos: [], filters: DEFAULT_FILTERS };

const human = item({ id: "h", title: "Add upload retry" });
const bot = item({ id: "b", title: "Bump vite", actor: "dependabot[bot]", actorIsBot: true });
const push = item({
  id: "p",
  kind: "push",
  title: "Pushed to staging",
  number: undefined,
  ref: "staging",
  url: "https://github.com/koneksi-tech/koneksi-web/compare/aaa...bbb",
  push: { before: "a".repeat(40), head: "b".repeat(40) },
});

function show(over = {}, notice = vi.fn()) {
  act(() => {
    setGithubStatus(ready);
    setGithubFeed(feed({ items: [human, bot, push], repos, ...over }));
  });
  render(<GitHubTab onNotice={notice} />);
  return notice;
}

beforeEach(() => {
  resetGithubStateForTests();
  openUrl.mockReset().mockResolvedValue(undefined);
  vi.mocked(githubStatus).mockReset().mockResolvedValue(ready as never);
  vi.mocked(githubSaveFilters).mockReset().mockImplementation(async (f) => f);
  vi.mocked(githubPushCommits).mockReset();
});

describe("GitHubTab", () => {
  it("shows the feed with bots hidden by default and says how many", () => {
    show();
    expect(screen.getByText("Add upload retry")).toBeTruthy();
    expect(screen.queryByText("Bump vite")).toBeNull();
    expect(screen.getByText("1 bot event hidden")).toBeTruthy();
    expect(screen.getByText(/Read-only/)).toBeTruthy();
  });

  it("Show bots reveals them and saves the choice", async () => {
    show();
    fireEvent.click(screen.getByLabelText("Show bots"));
    expect(screen.getByText("Bump vite")).toBeTruthy();
    await waitFor(() =>
      expect(githubSaveFilters).toHaveBeenCalledWith(expect.objectContaining({ showBots: true })),
    );
  });

  it("the chips show repo counts and filter the feed", () => {
    show({ items: [human, item({ id: "m", source: "personal", repo: "jtfrancisco0121/notes", title: "My note" })] });
    expect(screen.getByRole("button", { name: /koneksi-tech\s*· 2 repos/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Mine/ }));
    expect(screen.getByText("My note")).toBeTruthy();
    expect(screen.queryByText("Add upload retry")).toBeNull();
  });

  it("an event type toggle hides that group", () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Pushes" }));
    expect(screen.queryByText("Pushed to staging")).toBeNull();
    expect(screen.getByText("Add upload retry")).toBeTruthy();
  });

  it("clicking a row opens github.com in the system browser", () => {
    show();
    fireEvent.click(screen.getByText("Add upload retry"));
    expect(openUrl).toHaveBeenCalledWith("https://github.com/koneksi-tech/koneksi-web/pull/41");
  });

  it("never opens an address that is not on github.com", () => {
    show({ items: [item({ id: "x", title: "Odd", url: "https://evil.example/x" })] });
    fireEvent.click(screen.getByText("Odd"));
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("tells the user when the browser would not open", async () => {
    openUrl.mockRejectedValue(new Error("no browser"));
    const notice = show();
    fireEvent.click(screen.getByText("Add upload retry"));
    await waitFor(() => expect(notice).toHaveBeenCalledWith("Could not open the browser", expect.stringContaining("no browser")));
  });

  it("a push row loads its commits only when expanded", async () => {
    vi.mocked(githubPushCommits).mockResolvedValue({
      total: 1,
      commits: [{ sha: "1234567890", message: "Retry on 503", author: "alice", url: "https://github.com/o/r/commit/1234567", at: "" }],
    });
    show();
    expect(githubPushCommits).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Show commits" }));
    expect(await screen.findByText("Retry on 503")).toBeTruthy();
    expect(githubPushCommits).toHaveBeenCalledWith("koneksi-tech/koneksi-web", "a".repeat(40), "b".repeat(40));
    fireEvent.click(screen.getByRole("button", { name: "Hide commits" }));
    fireEvent.click(screen.getByRole("button", { name: "Show commits" }));
    expect(githubPushCommits).toHaveBeenCalledTimes(1);
  });

  it("shows a push error in place of the commits", async () => {
    vi.mocked(githubPushCommits).mockRejectedValue(new Error("Those commits are no longer available"));
    show();
    fireEvent.click(screen.getByRole("button", { name: "Show commits" }));
    expect(await screen.findByText(/no longer available/)).toBeTruthy();
  });

  it("lists what needs the user, without bots, and opens the item", () => {
    const needs = [
      item({ id: "review_requested:1", kind: "review_requested", title: "Presign", number: 412, repo: "koneksi-tech/koneksi-backend" }),
      item({ id: "review_requested:2", kind: "review_requested", title: "Dependabot PR", actor: "dependabot[bot]", actorIsBot: true }),
    ];
    show({ needsYou: needs });
    const panel = screen.getByRole("region", { name: "Needs you" });
    expect(within(panel).getByText("Review requested from you")).toBeTruthy();
    expect(within(panel).queryByText(/Dependabot PR/)).toBeNull();
    fireEvent.click(within(panel).getByRole("button", { name: "Open" }));
    expect(openUrl).toHaveBeenCalled();
  });

  it("says so when nothing needs the user", () => {
    show();
    expect(screen.getByText("Nothing needs you in these repos.")).toBeTruthy();
  });

  it("an unreachable repo gets a notice and a mark in the repo filter, and the feed still shows", () => {
    show();
    expect(screen.getByText(/koneksi-s3-gateway can’t be reached/)).toBeTruthy();
    expect(screen.getByRole("option", { name: /koneksi-s3-gateway — can’t be reached/ })).toBeTruthy();
    expect(screen.getByText("Add upload retry")).toBeTruthy();
  });

  it("shows the fix instead of the feed when gh is signed out", async () => {
    const setup = { state: "signed_out", fix: "Run `gh auth login` in a terminal, then check again." };
    show({ setup, items: [] });
    expect(screen.getByText("Signed out of GitHub")).toBeTruthy();
    expect(screen.getByText(/gh auth login/)).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Needs you" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(githubStatus).toHaveBeenCalled());
  });

  it("shows the fix from the status before the first feed arrives", () => {
    act(() => {
      setGithubStatus({ ...ready, state: "missing", fix: "Install the GitHub CLI" } as never);
    });
    render(<GitHubTab onNotice={vi.fn()} />);
    expect(screen.getByText("GitHub CLI not found")).toBeTruthy();
  });

  it("keeps its last feed when remounted", () => {
    show();
    const first = render(<GitHubTab onNotice={vi.fn()} />);
    first.unmount();
    render(<GitHubTab onNotice={vi.fn()} />);
    expect(screen.getAllByText("Add upload retry").length).toBeGreaterThan(0);
  });
});
