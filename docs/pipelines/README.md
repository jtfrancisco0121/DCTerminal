

### QA rounds: the merge queue (R3)

Once a round runs, its view shows the **Merge queue**: one list per repo of the round's pull requests in the order they merge. You merge, as always (decision E10): the queue is read-only. It never merges, rebases or pushes; it can only open a pull request on GitHub in your browser.

- **Order.** A repo's order is the round's `mergeOrder` for it, then the plans it leaves out by wave and number, then within a plan its pull requests in that repo by their lanes' `dependsOn` (else lane order). A pull request's repo is its lane's `repo` from the plan run's `tasks.json`, else the plan's one repo, else the round's own folder. The pull requests come from each plan run's `prs.json` and `prs-<lane>.json`.
- **State.** Each pull request is read through your `gh` login (`gh api repos/{owner}/{repo}/pulls/{n}`, at most 4 calls at once, when the view opens and on **Refresh**; never while you are not looking): open, draft, merged or closed (not merged), its base branch, and whether GitHub says it is behind its base or conflicts with it. Without `gh`, or when GitHub cannot be read, a pull request's state is unknown and says why.
- **Next to merge.** In each repo, the first place that has not merged (or closed) is next, highlighted, only once everything before it merged, so the queue never suggests two merges to one repo at once. A plan with no pull request there yet holds the repo (it says so); a parked plan does not; a pull request whose state is unknown is never suggested and holds the rest.
- **Warnings.** A pull request behind its base says to rebase it on its base before it merges; one that conflicts says to rebase and fix the conflicts; one based on a branch of the queue that merged says to retarget it; a draft that is next says to mark it ready for review.
