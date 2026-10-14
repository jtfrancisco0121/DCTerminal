/**
 * Built-in reply templates: ready prompts for common situations in the
 * pipeline role terminals (missing HANDOFF sections, open questions, unfinished
 * PRs, round-2 reviews...). Read-only; "Save a copy" in the prompt library makes
 * an editable saved prompt. `when` marks inline code with backticks.
 */

export type ReplyTemplateRole =
  | "any"
  | "role_planner"
  | "role_plan_reviewer"
  | "role_implementer"
  | "role_pr_reviewer";

export type ReplyTemplate = {
  id: string;
  roleId: ReplyTemplateRole;
  title: string;
  /** "Use when" hint, plain text with `inline code`. */
  when: string;
  /** Inserted verbatim; `<placeholders>` and `…` are for the user to fill. */
  body: string;
};

/** Pipeline (hand-off) order; "any" comes last when no role is given. */
export const REPLY_TEMPLATE_ROLES: readonly ReplyTemplateRole[] = [
  "role_planner",
  "role_plan_reviewer",
  "role_implementer",
  "role_pr_reviewer",
  "any",
];

export const REPLY_TEMPLATE_ROLE_LABELS: Readonly<Record<ReplyTemplateRole, string>> = {
  any: "Any role",
  role_planner: "Planner",
  role_plan_reviewer: "Plan Reviewer",
  role_implementer: "Implementer",
  role_pr_reviewer: "PR Reviewer",
};

/**
 * Group order for a tab: its own role first, then "Any role", then the rest in
 * pipeline order. A role without templates (or none) keeps the pipeline order.
 */
export function replyTemplateRoleOrder(roleId?: string | null): ReplyTemplateRole[] {
  const own = REPLY_TEMPLATE_ROLES.find((r) => r !== "any" && r === roleId);
  if (!own) return [...REPLY_TEMPLATE_ROLES];
  return [own, "any", ...REPLY_TEMPLATE_ROLES.filter((r) => r !== own && r !== "any")];
}

/** Split `when` into text and inline-code parts (backtick-delimited). */
export function whenParts(when: string): { text: string; code: boolean }[] {
  return when
    .split("`")
    .map((text, i) => ({ text, code: i % 2 === 1 }))
    .filter((part) => part.text);
}

export const REPLY_TEMPLATES: readonly ReplyTemplate[] = [
  {
    id: "any.missing-handoff-sections",
    roleId: "any",
    title: "Missing HANDOFF sections",
    when: "The reply ends without its `HANDOFF:` headings, or Send fills almost nothing.",
    body: "Your reply is missing the HANDOFF sections. Repeat your result, complete and self-contained, ending with the HANDOFF sections your instructions list, using those headings exactly. Put nothing after them.",
  },
  {
    id: "any.reply-cut-off-or-only-summarised",
    roleId: "any",
    title: "Reply cut off or only summarised",
    when: "The reply trails off, or says “as discussed” instead of the content.",
    body: "Your last reply is incomplete: it stops partway or summarises instead of giving the full result. Write it again in full and self-contained, ending with your HANDOFF sections. Put nothing after them.",
  },
  {
    id: "any.handoff-sections-point-back-to-earlier-text",
    roleId: "any",
    title: "HANDOFF sections point back to earlier text",
    when: "A HANDOFF section says “see above” or names a section number.",
    body: "Your HANDOFF sections refer to earlier text (\"see above\", \"as in section 9\"). The next role only receives the HANDOFF sections, so rewrite each one complete on its own. Put nothing after them.",
  },
  {
    id: "any.ask-for-a-quick-status",
    roleId: "any",
    title: "Ask for a quick status",
    when: "A long turn and you can't tell where it is.",
    body: "Pause and give me a status in five lines or fewer: what's done, what's in progress, what's left, and anything you need from me. Then continue.",
  },
  {
    id: "any.session-restarted",
    roleId: "any",
    title: "Session restarted",
    when: "The app or tab restarted mid-turn and Claude came back fresh.",
    body: "This session restarted and you no longer have the earlier conversation. Rebuild where the work stands from the files, git and gh, not from memory. Tell me in a few lines what's done and what isn't, then continue from there.",
  },
  {
    id: "any.working-outside-the-task",
    roleId: "any",
    title: "Working outside the task",
    when: "It's refactoring, renaming or “improving” things nobody asked for.",
    body: "Stop and stay within the task. If you changed anything the task didn't ask for, list it and undo it. Don't start new work outside the task; note any ideas as follow-ups in your reply instead.",
  },
  {
    id: "any.working-in-the-wrong-folder-or-repo",
    roleId: "any",
    title: "Working in the wrong folder or repo",
    when: "Paths or git output show the wrong repository.",
    body: "You're working in the wrong place. The task is in <repo or folder>. Run every git and gh command inside that folder, re-check anything you concluded from the wrong one, then continue.",
  },
  {
    id: "planner.answering-open-questions",
    roleId: "role_planner",
    title: "Answering open questions",
    when: "`HANDOFF: Open questions` isn't `None.`",
    body: "Answers to your open questions:\n1. …\n2. …\n3. Defer to the backlog.\n\nUpdate the plan with these answers and resubmit it, ending with the HANDOFF: Plan, HANDOFF: Pull requests and HANDOFF: Open questions sections.",
  },
  {
    id: "planner.you-want-its-advice-on-the-open-questions",
    roleId: "role_planner",
    title: "You want its advice on the open questions",
    when: "You can't answer a question without knowing the trade-offs.",
    body: "For each open question, give your recommended answer, the alternatives, and what each choice changes in the plan. I'll decide. Don't change the plan yet.",
  },
  {
    id: "planner.asking-for-changes",
    roleId: "role_planner",
    title: "Asking for changes",
    when: "You read the plan and want something different.",
    body: "Revise the plan: … (what to change and why).\n\nResubmit the full revised plan, not a list of changes, ending with the three HANDOFF sections.",
  },
  {
    id: "planner.steps-aren-t-backed-by-the-code",
    roleId: "role_planner",
    title: "Steps aren't backed by the code",
    when: "The plan names files or functions that don't exist, or reads like a guess.",
    body: "Some steps aren't backed by the code. For each step, name the files and functions you actually read, with file:line, and mark anything you're assuming as an assumption. Fix any step the code doesn't support, then resubmit the full plan with the three HANDOFF sections.",
  },
  {
    id: "planner.test-plan-or-acceptance-criteria-are-thin",
    roleId: "role_planner",
    title: "Test plan or acceptance criteria are thin",
    when: "Tests say “add tests” without naming them, or criteria can't be verified.",
    body: "The test plan is too thin. For each step, list the tests to add or update (happy path, edge cases, errors, regression) with the exact commands to run them, and make each acceptance criterion something that can be checked. Resubmit the full plan with the three HANDOFF sections.",
  },
  {
    id: "planner.work-that-should-ship-as-several-prs",
    roleId: "role_planner",
    title: "Work that should ship as several PRs",
    when: "One huge PR, or the work spans repos.",
    body: "Split this into pull requests: one per repository, with dependent changes stacked in order and independent ones marked Depends on: none. Mark releases and deploys as Manual step. Put the list in HANDOFF: Pull requests.",
  },
  {
    id: "planner.too-many-small-prs",
    roleId: "role_planner",
    title: "Too many small PRs",
    when: "The list has PRs too small to review on their own.",
    body: "Use fewer pull requests: combine units in the same repository that only make sense together. Keep a separate PR only where it helps the reviewer or the release order needs it. Update HANDOFF: Pull requests and resubmit the full plan.",
  },
  {
    id: "planner.too-big-for-one-plan",
    roleId: "role_planner",
    title: "Too big for one plan",
    when: "The plan covers several features or would take many days.",
    body: "This is too much for one plan. Split it into phases that each ship on their own. Plan phase 1 in full, and list the later phases briefly under Out of scope. Resubmit with the three HANDOFF sections.",
  },
  {
    id: "planner.the-code-changed-since-it-planned",
    roleId: "role_planner",
    title: "The code changed since it planned",
    when: "Other PRs merged before this plan was implemented.",
    body: "The main branch has changed since you planned (<what merged>). Re-check every step against the current code, update anything that no longer fits, and resubmit the full plan with the three HANDOFF sections.",
  },
  {
    id: "planner.revising-after-the-plan-reviewer",
    roleId: "role_planner",
    title: "Revising after the Plan Reviewer",
    when: "A send-back arrived and it answered only some findings, or listed edits instead of the plan.",
    body: "Address every finding from the review. For each one, say in one line what you changed and in which step, or why you disagree. Then resubmit the full revised plan, not a list of changes, ending with the three HANDOFF sections.",
  },
  {
    id: "planner.it-started-changing-code",
    roleId: "role_planner",
    title: "It started changing code",
    when: "It edits files instead of planning (most likely in a chat tab).",
    body: "Stop. This role only plans; don't change any files. If you already changed some, list them and undo the changes. Then finish the plan and end with the three HANDOFF sections.",
  },
  {
    id: "plan-reviewer.it-recommended-changes-but-didn-t-apply-them",
    roleId: "role_plan_reviewer",
    title: "It recommended changes but didn't apply them",
    when: "`APPROVED WITH CHANGES`, but `Reviewed plan` only lists the changes.",
    body: "Apply all your recommended changes and write the full revised plan. Make the remaining choices yourself and say why. End with the HANDOFF sections: Verdict, Reviewed plan, Pull requests, Review notes and Result.",
  },
  {
    id: "plan-reviewer.it-didn-t-check-the-plan-against-the-code",
    roleId: "role_plan_reviewer",
    title: "It didn't check the plan against the code",
    when: "The review only comments on wording and cites no files.",
    body: "Check the plan against the code, not just its wording. For each step, confirm that the files, functions and behavior it relies on exist as described, citing file:line, and add a finding for anything that doesn't match. Then repeat your verdict and the HANDOFF sections.",
  },
  {
    id: "plan-reviewer.severities-look-inflated",
    roleId: "role_plan_reviewer",
    title: "Severities look inflated",
    when: "Everything is HIGH, or style nits block the plan.",
    body: "Re-rate your findings honestly. Anything that would break behavior, data or security is HIGH or above. A missing test or an unclear step is MEDIUM. Style and preferences are LOW. Update the verdict if that changes it, and repeat the HANDOFF sections, including HANDOFF: Result.",
  },
  {
    id: "plan-reviewer.you-disagree-with-a-finding",
    roleId: "role_plan_reviewer",
    title: "You disagree with a finding",
    when: "A finding is wrong or not worth the change.",
    body: "I'm overruling finding <n>: <why>. Drop it, apply the rest, and repeat your verdict and the HANDOFF sections with the full reviewed plan.",
  },
  {
    id: "plan-reviewer.it-raised-product-decisions",
    roleId: "role_plan_reviewer",
    title: "It raised product decisions",
    when: "Findings ask what the product should do, which only you can answer.",
    body: "These are product decisions. My answers:\n1. …\n2. …\n\nApply them to the reviewed plan, don't raise them again, and repeat your verdict and the HANDOFF sections.",
  },
  {
    id: "plan-reviewer.verdict-lines-disagree-or-result-is-missing",
    roleId: "role_plan_reviewer",
    title: "Verdict lines disagree, or Result is missing",
    when: "The chain overview shows the wrong verdict, or autopilot treats everything as blocking.",
    body: "Your verdict isn't consistent: the review says <X>, but HANDOFF: Verdict or HANDOFF: Result says <Y>, or one of them is missing. Settle on one verdict and repeat every HANDOFF section, including the HANDOFF: Result JSON.",
  },
  {
    id: "plan-reviewer.the-pull-request-list-is-missing-or-wrong",
    roleId: "role_plan_reviewer",
    title: "The pull-request list is missing or wrong",
    when: "Fan-out offers the wrong number of Implementers, or none.",
    body: "HANDOFF: Pull requests is missing or doesn't match the plan. Repeat the Planner's list, corrected: each unit's repository, the steps it covers, Depends on, and any Manual step. Every step must belong to exactly one unit. Then repeat the other HANDOFF sections.",
  },
  {
    id: "plan-reviewer.second-round-re-reviews-everything",
    roleId: "role_plan_reviewer",
    title: "Second round re-reviews everything",
    when: "Round 2 ignores the earlier findings or raises brand-new nits.",
    body: "This is the revised plan. First check each finding from your last review and say which are resolved and which aren't. Then review only what changed, and repeat your verdict and the HANDOFF sections.",
  },
  {
    id: "implementer.no-pr-was-opened",
    roleId: "role_implementer",
    title: "No PR was opened",
    when: "`HANDOFF: Pull requests` says `None.` or is missing.",
    body: "Publish the verified work as draft pull requests, one per unit in the plan's pull-request list, following section 17. Then repeat the HANDOFF sections with every PR link under HANDOFF: Pull requests.",
  },
  {
    id: "implementer.it-stopped-as-blocked",
    roleId: "role_implementer",
    title: "It stopped as BLOCKED",
    when: "Final status is `BLOCKED`, or it stopped to ask a question.",
    body: "Answer to your blocker: …\n\nContinue with the remaining units. Don't let one blocked unit stop the others. End with the HANDOFF sections.",
  },
  {
    id: "implementer.some-prs-are-unfinished-or-not-started",
    roleId: "role_implementer",
    title: "Some PRs are unfinished or not started",
    when: "Fewer PRs than the plan lists, or work stopped partway.",
    body: "Not every unit in the plan's pull-request list is done. Finish them all before you hand off.\n\n1. Check the real state first, with git and gh, not from memory. List every unit with one of: published (PR link), branch pushed but no PR, partly built locally, or not started.\n2. Finish the partly built units first, on their existing branches and worktrees. Then build the units not started, in dependency order: a unit that depends on another branches from it and waits for it.\n3. For each unit, run the checks, then open it as a draft PR following section 17.\n\nLeave units that are already published alone unless a later unit needs a change in them. Never rebase or force-push a pushed branch. If a unit is blocked, mark it with the reason and carry on with the rest.\n\nEnd with the HANDOFF sections. Under HANDOFF: Pull requests, list every PR, including the earlier ones, plus any unit still missing and why.",
  },
  {
    id: "implementer.check-for-missing-prs-else-hand-off",
    roleId: "role_implementer",
    title: "Check for missing PRs, else hand off",
    when: "You're not sure everything shipped, and want the final hand-off either way.",
    body: "Check whether any unit in the plan's pull-request list still has no PR. Use git and gh to see the real state, not your memory.\n\n- If some are missing or unfinished: build them in dependency order on their existing branches, run the checks, and open each as a draft PR following section 17. Never rebase or force-push a pushed branch. If a unit is blocked, mark it with the reason and carry on.\n- If none are missing: change nothing. Just confirm it in one line.\n\nEither way, end with the final HANDOFF sections for the whole run: Implementation summary with the Final Status, Files changed, Tests run, Deviations from the plan, and Pull requests listing every PR (link, branch and base) plus any Manual step still waiting for me. Put nothing after them.",
  },
  {
    id: "implementer.tests-fail-or-were-skipped",
    roleId: "role_implementer",
    title: "Tests fail or were skipped",
    when: "A check failed, was skipped, or wasn't run.",
    body: "HANDOFF: Tests run shows failing or skipped checks. Fix the failures your change caused. For anything that already failed before your change, prove it: run the same command on the base branch and show the result. Don't skip or disable tests. Then repeat the HANDOFF sections.",
  },
  {
    id: "implementer.it-deviated-from-the-plan",
    roleId: "role_implementer",
    title: "It deviated from the plan",
    when: "`IMPLEMENTED WITH DEVIATIONS` and you don't agree with a change.",
    body: "Explain each deviation from the plan: what you did instead, and why the plan's way didn't work. Undo any deviation that wasn't necessary. Then repeat the HANDOFF sections with HANDOFF: Deviations from the plan updated.",
  },
  {
    id: "implementer.fixing-a-pr-reviewer-send-back",
    roleId: "role_implementer",
    title: "Fixing a PR Reviewer send-back",
    when: "Round 2+: it rewrote approved PRs or skipped findings.",
    body: "Fix only the findings listed, on the PRs they name and their existing branches. For each finding, say in one line what you changed and in which commit. Don't touch PRs that were approved. Rerun the checks, push, and end with the HANDOFF sections listing every PR.",
  },
  {
    id: "implementer.you-did-a-manual-step",
    roleId: "role_implementer",
    title: "You did a manual step",
    when: "A `Manual step — waiting for the user` is done.",
    body: "I've done the manual step: <what>. Continue with the units that were waiting for it, and end with the HANDOFF sections, listing every PR.",
  },
  {
    id: "implementer.a-pr-below-the-stack-was-merged",
    roleId: "role_implementer",
    title: "A PR below the stack was merged",
    when: "You merged PR1 and the stacked PRs now show its changes or conflicts.",
    body: "PR<n> is merged into <main branch>. Update the PRs stacked on it: merge <main branch> into each dependent branch, resolve any conflicts, rerun the checks and push. If GitHub hasn't already changed their base, run gh pr edit <pr> --base <main branch>. Never rebase or force-push. End with the HANDOFF sections.",
  },
  {
    id: "implementer.a-branch-conflicts-with-main",
    roleId: "role_implementer",
    title: "A branch conflicts with main",
    when: "GitHub shows “This branch has conflicts”.",
    body: "<branch> conflicts with <main branch>. Merge <main branch> into it and resolve the conflicts, keeping the intent of both sides. Rerun the checks and push. Never rebase or force-push. Say which files conflicted and how you resolved each one.",
  },
  {
    id: "implementer.github-access-is-fixed",
    roleId: "role_implementer",
    title: "GitHub access is fixed",
    when: "Push or `gh` failed earlier, and you've fixed it.",
    body: "I've fixed GitHub access (gh auth login / the remote). Push the committed work and open the draft PRs now, following section 17. Then repeat the HANDOFF sections with every PR link.",
  },
  {
    id: "pr-reviewer.findings-aren-t-grouped-by-pr",
    roleId: "role_pr_reviewer",
    title: "Findings aren't grouped by PR",
    when: "Several PRs, but the findings are one mixed list.",
    body: "Group HANDOFF: Findings for the Implementer by pull request: one PR<n> — <URL> line per PR with its verdict, then that PR's numbered findings with file, line and expected fix.",
  },
  {
    id: "pr-reviewer.it-reviewed-only-some-prs",
    roleId: "role_pr_reviewer",
    title: "It reviewed only some PRs",
    when: "Some PR links in the form have no verdict.",
    body: "You reviewed <k> of the <N> pull requests. Review the rest (<list>), each on its own, then repeat the HANDOFF sections with a verdict line for every PR.",
  },
  {
    id: "pr-reviewer.a-stacked-pr-was-reviewed-against-the-wrong-base",
    roleId: "role_pr_reviewer",
    title: "A stacked PR was reviewed against the wrong base",
    when: "It reports problems from the PR underneath.",
    body: "PR<n> is stacked on <branch>. Review only its own changes (gh pr diff <n>, or git diff <base>...<branch>). Drop findings that belong to the PR below it, and repeat the HANDOFF sections.",
  },
  {
    id: "pr-reviewer.findings-are-vague",
    roleId: "role_pr_reviewer",
    title: "Findings are vague",
    when: "Findings say “consider” or “might” without a failing case.",
    body: "Make each finding actionable: the file and line, what's wrong, a concrete input or scenario that breaks it, and the fix you expect. Then repeat the HANDOFF sections.",
  },
  {
    id: "pr-reviewer.you-think-a-finding-is-wrong",
    roleId: "role_pr_reviewer",
    title: "You think a finding is wrong",
    when: "A false positive, or something the framework already handles.",
    body: "I think finding <n> is not a problem: <reason>. Re-check it against the code. If you agree, drop it. If not, show the line and the input that breaks it. Then update the verdict and repeat the HANDOFF sections.",
  },
  {
    id: "pr-reviewer.only-low-findings-are-left",
    roleId: "role_pr_reviewer",
    title: "Only LOW findings are left",
    when: "Round 3+ and nothing left blocks a merge.",
    body: "Only LOW findings are left. Approve the PRs that have nothing above LOW and mark them ready. List the LOW items as follow-ups in your review summary, keep them in HANDOFF: Result with severity LOW, and write None. under Findings for the Implementer for those PRs.",
  },
  {
    id: "pr-reviewer.second-round-re-reviews-everything",
    roleId: "role_pr_reviewer",
    title: "Second round re-reviews everything",
    when: "Round 2 ignores the earlier findings or starts over.",
    body: "This is round <n>. First check each finding from the last round and say which are resolved and which aren't, with the commit or line that resolves it. Review only the new commits, and skip PRs you already approved that have no new commits. Then repeat the HANDOFF sections.",
  },
  {
    id: "pr-reviewer.the-review-wasn-t-posted-on-github",
    roleId: "role_pr_reviewer",
    title: "The review wasn't posted on GitHub",
    when: "The PR on GitHub has no review from this round.",
    body: "Post your review on each pull request now, following section 8: request changes or approve, with your review as the body, and mark the approved ones ready. If gh fails, show the exact error. Then repeat the HANDOFF sections.",
  },
  {
    id: "pr-reviewer.it-merged-pushed-or-edited-a-pr",
    roleId: "role_pr_reviewer",
    title: "It merged, pushed or edited a PR",
    when: "A PR was merged or a branch changed by the reviewer.",
    body: "Stop. This role never merges, pushes, closes or edits a pull request or its branch. It only posts reviews and marks approved PRs ready. Tell me exactly what you did, with the commands, and don't undo anything until I say so.",
  },
];
