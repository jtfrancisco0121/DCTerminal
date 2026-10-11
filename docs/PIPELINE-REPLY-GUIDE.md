# Pipeline Reply Guide

How to get replies from the Planner, Plan Reviewer, Implementer and PR Reviewer that fill the next role's fields correctly. The short version: every reply must end with its `HANDOFF:` sections, and you check them before you press Send.

Planner → Plan Reviewer → Implementer → PR Reviewer

An HTML version with copy buttons is in [PIPELINE-REPLY-GUIDE.html](PIPELINE-REPLY-GUIDE.html).

## Before you start a chain

- [ ] Run `./install.sh` after pulling, so the roles have the newest prompts.
- [ ] If you ever edited a built-in role, press **Settings › Roles › &lt;role&gt; › Reset built-in**. Edited roles keep your old prompt and may not write the HANDOFF sections.
- [ ] Run `gh auth status` once. The Implementer opens PRs and the PR Reviewer posts on them through `gh`.
- [ ] Start roles in the parent folder (`~/Documents/Koneksi`) when the work spans several repos. Each role runs git inside the right repo.
- [ ] A tab keeps the prompt it started with. Changes to roles apply to new tabs only.

## What each reply must end with

DCTerminal reads these sections to fill the next role's form and decide the next button. If they're missing, it falls back to guessing, and the next role gets less.

| Role | Required sections, in order |
| --- | --- |
| Planner | `HANDOFF: Plan` · `HANDOFF: Pull requests` · `HANDOFF: Open questions` |
| Plan Reviewer | `HANDOFF: Verdict` · `HANDOFF: Reviewed plan` · `HANDOFF: Pull requests` · `HANDOFF: Review notes` |
| Implementer | `HANDOFF: Implementation summary` · `Files changed` · `Tests run` · `Deviations from the plan` · `Pull requests` |
| PR Reviewer | `HANDOFF: Verdict` · `HANDOFF: Findings for the Implementer` |

If a reply is missing them, don't send it. Paste this into the same terminal:

```
Your reply is missing the HANDOFF sections. Repeat your result, complete and self-contained, ending with the HANDOFF sections your instructions list, using those headings exactly. Put nothing after them.
```

## Which "What to send" option to pick

| Option | Use it when |
| --- | --- |
| Claude's plan (ExitPlanMode) | The role worked in plan mode and the newest plan is the bordered box in the terminal. Usual choice for the Planner. |
| Claude's last reply | The role answered in a normal reply (Plan Reviewer, Implementer, PR Reviewer), or the plan box is older than the latest answer. |
| Newest plan file | Only if the plan box and last reply are both wrong but the saved plan file is right. |
| Selected text | You want to send just one part you highlighted. |
| Last 200 lines | Last resort. Sends raw scrollback, so fields fill less precisely. |

**Always scroll to the bottom of the preview** before pressing Send. You should see the plan's `Pull requests:` list and, for a Planner, its `Open questions:`. If the preview looks like an older version, switch to *Claude's last reply*.

## Planner

Check before sending:

- [ ] The plan is complete on its own, not "see section 9".
- [ ] `Pull requests` lists each unit with its repo, scope and `Depends on`, or says `One pull request.`
- [ ] Manual steps (releases, deploys) are marked `Manual step`.
- [ ] **Open questions are answered.** Product decisions are yours. The Plan Reviewer can only weigh in on technical ones.

Answering open questions:

```
Answers to your open questions:
1. …
2. …
3. Defer to the backlog.

Update the plan with these answers and resubmit it, ending with the HANDOFF: Plan, HANDOFF: Pull requests and HANDOFF: Open questions sections.
```

Asking for changes:

```
Revise the plan: … (what to change and why).

Resubmit the full revised plan, not a list of changes, ending with the three HANDOFF sections.
```

Work that should ship as several PRs:

```
Split this into pull requests: one per repository, with dependent changes stacked in order and independent ones marked Depends on: none. Mark releases and deploys as Manual step. Put the list in HANDOFF: Pull requests.
```

Then press **Send to Plan Reviewer** → Terminal → *Claude's plan (ExitPlanMode)*.

## Plan Reviewer

| Verdict | What you do |
| --- | --- |
| `APPROVED` | Press **Next: Send to Implementer** → *Claude's last reply*. |
| `APPROVED WITH CHANGES` | Check that `Reviewed plan` is the full plan with the changes applied. If it only lists the changes, use the prompt below first. |
| `REQUIRES REVISION` | Press **Send to Planner**. The findings go back to the same Planner tab as a new round. |

It recommended changes but didn't apply them:

```
Apply all your recommended changes and write the full revised plan. Make the remaining choices yourself and say why. End with the four HANDOFF sections: Verdict, Reviewed plan, Pull requests, Review notes.
```

To make a decision yourself instead, add a line before the last sentence, for example "Stability check: use #150." Things it couldn't verify belong in `Review notes`, and the Implementer will see them.

## Implementer

Check before sending:

- [ ] Final status is `IMPLEMENTED` or `IMPLEMENTED WITH DEVIATIONS`, not `BLOCKED`.
- [ ] `Pull requests` has one line per PR: link, branch and base. Stacked PRs show the branch they're based on.
- [ ] Manual steps are listed as waiting for you. Do them before merging the PRs that need them.
- [ ] `Tests run` shows real commands and results. A skipped test is not a pass.

No PR was opened:

```
Publish the verified work as draft pull requests, one per unit in the plan's pull-request list, following section 17. Then repeat the HANDOFF sections with every PR link under HANDOFF: Pull requests.
```

It stopped as BLOCKED:

```
Answer to your blocker: …

Continue with the remaining units. Don't let one blocked unit stop the others. End with the HANDOFF sections.
```

Then press **Next: Send to PR Reviewer** → *Claude's last reply*. The reviewer receives every PR link, not just the first.

## PR Reviewer

| Verdict | What happens |
| --- | --- |
| `REQUEST CHANGES` | Press **Send back to Implementer**. The Implementer fixes only the PRs named, pushes to the same branches, and you send it back for round 2. Round 2 checks the earlier findings first. |
| `APPROVED` | The chain is complete. The review is posted on each PR, and approved PRs are marked ready. **You merge**, in dependency order (PR1 before anything stacked on it). |

With several PRs, the overall verdict is `APPROVED` only when every PR passes. PRs that already pass are marked ready right away, even if others need changes.

Findings aren't grouped by PR:

```
Group HANDOFF: Findings for the Implementer by pull request: one PR<n> — <URL> line per PR with its verdict, then that PR's numbered findings with file, line and expected fix.
```

## Common mistakes

- **Sending with open questions.** The next role guesses or asks again. Answer them in the Planner first, or write "defer" for each one.
- **Sending a list of changes.** The Implementer needs the whole plan. Ask for "the full revised plan, not a list of changes".
- **Picking an old plan.** After a revision, check the end of the preview matches the newest answer before sending.
- **Typing `/clear` in a role tab.** It starts a new Claude session, and DCTerminal loses track of the replies. Start a new tab instead.
- **Quitting mid-turn.** Tabs come back, but Claude restarts fresh. Let the Implementer finish and push first.
- **Merging out of order.** Merge a PR before anything stacked on it, and do any manual steps they need first.
