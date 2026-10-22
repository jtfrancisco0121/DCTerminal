/**
 * The pull requests a plan ships as (its `HANDOFF: Pull requests` list,
 * role-planner.md, or on an engine-2 run the Planner's `tasks.json`), and
 * each lane's own note. Pure: the overview reads it to offer a fan-out;
 * `fanOut.ts` acts on it.
 */
import type { PlannedTask } from "../bridge";
import { contractPullRequestList } from "../handoff/contract";

export type PlannedPr = {
  /** `pr1`. */
  id: string;
  /** "PR1 — Token refresh". */
  title: string;
  dependsOn: string[];
  /** A release, deploy or config change the Implementer leaves to you. */
  manual: boolean;
  /** What it covers (from the Planner's tasks). */
  summary?: string;
  /** L1: the Settings › Repos name its worktree is made in; absent for the run's own folder. */
  repo?: string;
};

const HEADER = /^[ \t]*(?:[-*+]|\d+[.)])?[ \t]*`?\**[ \t]*PR[ \t]*(\d+)\**[ \t]*(?:[—–-]+|:)[ \t]*([^`:\n]*)/i;

/**
 * The pull requests of a plan's `Pull requests` list (role-planner.md):
 * "* `PR1 — <title>`: …, `Depends on: none`". Lines under an entry belong
 * to it. "One pull request." gives none.
 */
export function parsePullRequestPlan(list: string): PlannedPr[] {
  const entries: { n: string; title: string; body: string[] }[] = [];
  for (const line of list.split(/\r?\n/)) {
    const head = HEADER.exec(line);
    if (head) {
      const title = head[2]
        .replace(/[`*]+/g, "")
        .replace(/[,;]?\s*(?:depends\s+on|manual\s+step)\b.*$/i, "")
        .replace(/[\s,;.]+$/, "")
        .trim();
      entries.push({ n: head[1], title, body: [line] });
    } else if (entries.length) {
      entries[entries.length - 1].body.push(line);
    }
  }
  const seen = new Set<string>();
  return entries.flatMap((entry) => {
    const id = `pr${Number(entry.n)}`;
    if (seen.has(id)) return [];
    seen.add(id);
    const text = entry.body.join("\n");
    const depends = /depends\s+on\s*:?\s*([^\n`]*)/i.exec(text)?.[1] ?? "";
    const dependsOn = [...depends.matchAll(/\bPR[ \t]*(\d+)\b/gi)]
      .map((m) => `pr${Number(m[1])}`)
      .filter((dep, i, all) => dep !== id && all.indexOf(dep) === i);
    return [
      {
        id,
        title: entry.title ? `PR${Number(entry.n)} — ${entry.title}` : `PR${Number(entry.n)}`,
        dependsOn,
        manual: /\bmanual\s+step\b/i.test(text),
      },
    ];
  });
}

/**
 * The lanes a reply's plan fans out into: its pull requests that are not
 * manual steps. A dependency on a manual step or an unknown PR is dropped
 * (the Implementer still reads it in the plan). Fewer than two: no fan-out.
 */
export function lanesFromReply(reply: string): PlannedPr[] {
  const list = contractPullRequestList(reply) ?? "";
  return lanesOf(parsePullRequestPlan(list));
}

/** Pull requests that are not manual steps, keeping only dependencies on each other; fewer than two: none. */
function lanesOf(planned: PlannedPr[]): PlannedPr[] {
  const prs = planned.filter((pr) => !pr.manual);
  const ids = new Set(prs.map((pr) => pr.id));
  const lanes = prs.map((pr) => ({ ...pr, dependsOn: pr.dependsOn.filter((dep) => ids.has(dep)) }));
  return lanes.length >= 2 ? lanes : [];
}

/**
 * The lanes of the Planner's tasks (`tasks.json`, engine 2), the same way
 * `lanesFromReply` reads a list: read directly, nothing parsed.
 */
export function lanesFromTasks(tasks: readonly PlannedTask[]): PlannedPr[] {
  return lanesOf(
    tasks.map((task) => ({
      id: task.id,
      title: `${task.id.toUpperCase()} — ${task.title}`,
      dependsOn: [...task.dependsOn],
      manual: task.manual,
      summary: task.summary,
      ...(task.repo?.trim() ? { repo: task.repo.trim() } : {}),
    })),
  );
}

/** A git branch name for a lane's worktree: `ee-1760…-pr1`. */
export function laneBranch(runId: string, laneId: string): string {
  return `${runId}-${laneId}`.replace(/[^A-Za-z0-9._/-]+/g, "-").replace(/^-+/, "");
}

/**
 * The lane's own instructions, added to the Implementer's context. A lane
 * in a repo (L1) says which; a dependency in another repo has no branch
 * here to start from, so the note says where it was built instead.
 */
export function laneNote(lane: PlannedPr, all: readonly PlannedPr[], runId: string): string {
  const others = all.filter((pr) => pr.id !== lane.id).map((pr) => pr.title);
  const repoOf = (pr: PlannedPr) => pr.repo?.trim() || null;
  const deps = all.filter((pr) => lane.dependsOn.includes(pr.id));
  const here = deps.filter((pr) => repoOf(pr) === repoOf(lane));
  const elsewhere = deps.filter((pr) => repoOf(pr) !== repoOf(lane));
  const branches = here.map((pr) => `\`${laneBranch(runId, pr.id)}\``);
  const where = (pr: PlannedPr) => (repoOf(pr) ? `the ${repoOf(pr)} repo` : "this run's own folder");
  return [
    `This tab implements only ${lane.title}, in its own git worktree on branch \`${laneBranch(runId, lane.id)}\`${repoOf(lane) ? ` of the ${repoOf(lane)} repo` : ""}.`,
    lane.summary?.trim() ? `Its scope: ${lane.summary.trim()}` : "",
    others.length
      ? `${others.join("; ")} ${others.length === 1 ? "is" : "are"} built in other tabs at the same time: do not implement ${others.length === 1 ? "it" : "them"} here.`
      : "",
    here.length
      ? `It builds on ${here.map((pr) => pr.title).join("; ")}, already approved: start from branch ${branches[0]}${branches.length > 1 ? ` and merge in ${branches.slice(1).join(", ")}` : ""} as the plan says.`
      : "",
    elsewhere.length
      ? `It builds on ${elsewhere.map((pr) => `${pr.title} (in ${where(pr)}, branch \`${laneBranch(runId, pr.id)}\`)`).join("; ")}, already approved: build against what ${elsewhere.length === 1 ? "it adds; its branch is" : "they add; their branches are"} not in this worktree's repo, so do not merge ${elsewhere.length === 1 ? "it" : "them"} here.`
      : "",
    "Open exactly one draft pull request for it, and report only that one under HANDOFF: Pull requests.",
  ]
    .filter(Boolean)
    .join(" ");
}
