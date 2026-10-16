import { describe, expect, it } from "vitest";
import {
  applyFilters,
  chipCounts,
  dayLabel,
  DEFAULT_FILTERS,
  groupByDay,
  groupOf,
  isGithubUrl,
  kindLabel,
  reachNote,
  refLabel,
  relativeTime,
  reposForChip,
  unreachable,
} from "./githubModel";
import { item } from "./testFeed";
import type { RepoStatus } from "./githubTypes";

const mine = item({ id: "m", source: "personal", repo: "jtfrancisco0121/notes", kind: "push", involvesMe: true });
const org = item({ id: "o", kind: "pr_merged" });
const bot = item({ id: "b", actor: "dependabot[bot]", actorIsBot: true });
const review = item({ id: "r", kind: "review", detail: "approved", repo: "koneksi-tech/koneksi-desktop" });
const all = [mine, org, bot, review];

describe("filters", () => {
  it("shows everything but bots by default, and counts the hidden bots", () => {
    const out = applyFilters(all, DEFAULT_FILTERS);
    expect(out.shown.map((i) => i.id)).toEqual(["m", "o", "r"]);
    expect(out.hiddenBots).toBe(1);
  });

  it("Show bots brings bot activity back", () => {
    const out = applyFilters(all, { ...DEFAULT_FILTERS, showBots: true });
    expect(out.shown.map((i) => i.id)).toEqual(["m", "o", "b", "r"]);
    expect(out.hiddenBots).toBe(0);
  });

  it("the chips split koneksi-tech from personal repos", () => {
    expect(applyFilters(all, { ...DEFAULT_FILTERS, chip: "koneksi-tech" }).shown.map((i) => i.id)).toEqual(["o", "r"]);
    expect(applyFilters(all, { ...DEFAULT_FILTERS, chip: "mine" }).shown.map((i) => i.id)).toEqual(["m"]);
  });

  it("narrows to one repo", () => {
    const out = applyFilters(all, { ...DEFAULT_FILTERS, repo: "koneksi-tech/koneksi-desktop" });
    expect(out.shown.map((i) => i.id)).toEqual(["r"]);
  });

  it("filters over more than 600 rows across repos see every row of the repo", () => {
    const many = Array.from({ length: 700 }, (_, i) =>
      item({
        id: `r${i}`,
        repo: `koneksi-tech/repo-${i % 7}`,
        source: i % 7 === 6 ? "personal" : "koneksi-tech",
        at: new Date(Date.UTC(2026, 9, 15) - i * 60_000).toISOString(),
      }),
    );
    const one = applyFilters(many, { ...DEFAULT_FILTERS, repo: "koneksi-tech/repo-3" });
    expect(one.shown).toHaveLength(100);
    expect(applyFilters(many, { ...DEFAULT_FILTERS, chip: "mine" }).shown).toHaveLength(100);
  });

  it("event type toggles hide a group", () => {
    const out = applyFilters(all, { ...DEFAULT_FILTERS, hiddenTypes: ["push", "merge"] });
    expect(out.shown.map((i) => i.id)).toEqual(["r"]);
  });

  it("involves me keeps only items that involve the user", () => {
    expect(applyFilters(all, { ...DEFAULT_FILTERS, involvesMe: true }).shown.map((i) => i.id)).toEqual(["m"]);
  });

  it("groups kinds into the toggles", () => {
    expect(groupOf("pr_opened")).toBe("pr");
    expect(groupOf("pr_merged")).toBe("merge");
    expect(groupOf("review_requested")).toBe("review");
    expect(groupOf("tag_deleted")).toBe("branch");
    expect(groupOf("issue_opened")).toBe("other");
    expect(groupOf("something_new")).toBe("other");
  });
});

describe("labels", () => {
  it("names the kind and the reference", () => {
    expect(kindLabel(review)).toBe("Review approved");
    expect(kindLabel(item({ kind: "review", detail: "requested changes" }))).toBe("Changes requested");
    expect(refLabel(org)).toBe("koneksi-web #41");
    expect(refLabel(item({ number: undefined, ref: "staging", kind: "push" }))).toBe("koneksi-web staging");
  });

  it("writes relative times", () => {
    const now = Date.parse("2026-10-15T12:00:00Z");
    expect(relativeTime("2026-10-15T11:59:50Z", now)).toBe("now");
    expect(relativeTime("2026-10-15T11:51:00Z", now)).toBe("9m");
    expect(relativeTime("2026-10-15T07:00:00Z", now)).toBe("5h");
    expect(relativeTime("2026-10-12T12:00:00Z", now)).toBe("3d");
    expect(relativeTime("nonsense", now)).toBe("");
  });

  it("groups by day", () => {
    const now = new Date(2026, 9, 15, 12).getTime();
    const at = (d: number, h: number) => new Date(2026, 9, d, h).toISOString();
    expect(dayLabel(at(15, 8), now)).toBe("Today");
    expect(dayLabel(at(14, 8), now)).toBe("Yesterday");
    expect(dayLabel(at(10, 8), now)).toBe("Oct 10");
    const groups = groupByDay(
      [item({ id: "a", at: at(15, 9) }), item({ id: "b", at: at(15, 8) }), item({ id: "c", at: at(14, 9) })],
      now,
    );
    expect(groups.map((g) => [g.label, g.items.length])).toEqual([["Today", 2], ["Yesterday", 1]]);
  });

  it("only github.com addresses may be opened", () => {
    expect(isGithubUrl("https://github.com/o/r/pull/1")).toBe(true);
    expect(isGithubUrl("https://evil.example/o")).toBe(false);
    expect(isGithubUrl("http://github.com/o")).toBe(false);
    expect(isGithubUrl("")).toBe(false);
  });
});

describe("repos", () => {
  const repos: RepoStatus[] = [
    { repo: "koneksi-tech/koneksi-web", source: "koneksi-tech", reachable: true, oldest: "2026-10-13T00:00:00Z" },
    { repo: "koneksi-tech/koneksi-desktop", source: "koneksi-tech", reachable: true, oldest: "2026-09-16T00:00:00Z" },
    { repo: "koneksi-tech/koneksi-s3-gateway", source: "koneksi-tech", reachable: false, error: "Not found" },
    { repo: "jtfrancisco0121/notes", source: "personal", reachable: true, oldest: "2026-10-01T00:00:00Z" },
  ];

  it("counts repos per chip and filters the repo list", () => {
    expect(chipCounts(repos)).toEqual({ all: 4, org: 3, mine: 1 });
    expect(reposForChip(repos, "mine").map((r) => r.repo)).toEqual(["jtfrancisco0121/notes"]);
    expect(reposForChip(repos, "all")).toHaveLength(4);
  });

  it("flags unreachable repos", () => {
    expect(unreachable(repos).map((r) => r.repo)).toEqual(["koneksi-tech/koneksi-s3-gateway"]);
  });

  it("says how far back the feed reaches and names the short ones", () => {
    const note = reachNote(repos, { ...DEFAULT_FILTERS });
    expect(note).toContain("Reaches back to");
    expect(note).toContain("koneksi-web (Oct 13)");
    expect(note).toContain("300 events");
    expect(reachNote([], DEFAULT_FILTERS)).toBe("");
    const one = reachNote(repos, { ...DEFAULT_FILTERS, repo: "koneksi-tech/koneksi-desktop" });
    expect(one).not.toContain("less far back");
  });
});
