# Orchestrator design (v1)

Chat-only multi-tab pipelines with an optional **overview tab** (eagle-eye). Terminal tabs stay manual.

Two pipeline **kinds** share the same `PipelineRun` machinery but differ in stages and entry conditions.

## Pipeline kinds

| Kind | When to use | Stages | Plan state at start |
|------|-------------|--------|---------------------|
| `full` | Need a plan written and reviewed in-app | Planner → Plan Reviewer → Implementer → PR Reviewer | Empty → `candidatePlan` → promote → `approvedPlan` |
| `execute` | Plan already final (doc, prior session, external) | Implementer → PR Reviewer | `approvedPlan` (+ optional task context) supplied by operator |

### Full pipeline (`full`)

1. **Planner** — produces `candidatePlan` (and task context).
2. **Plan Reviewer** — reads request + `candidatePlan`; verdict drives next step.
3. **Promote** — operator **Approve for implementation** copies/edits into `approvedPlan` (only after `APPROVED` / `APPROVED WITH CHANGES` + “update then proceed”, or equivalent UX).
4. **Implementer** — operator **Start** after approval. Nothing auto-starts (locked decision: hand-offs are always user-triggered).
5. **PR Reviewer** — hand-off after implementer turn completes (prefill + manual Start in v1 unless we add auto-open).

Verdict mapping (Plan Reviewer output):

- `APPROVED` / `APPROVED WITH CHANGES` → enable promote → Implementer.
- `REQUIRES REVISION` → hand back to Planner with review attached.

### Execute pipeline (`execute`)

Skips Planner and Plan Reviewer.

1. Operator provides **final** plan text (and optional original task / description) on the Implementer tab or via overview “Paste approved plan”.
2. **Implementer** — operator **Start** (or optional “Start execution pipeline” CTA that starts the worker).
3. **PR Reviewer** — same hand-off as today (`mapImplementerToReviewer`: task + `approvedPlan`).

No `candidatePlan` / promote step. Treat input as already approved; do not block on Plan Reviewer.

### What both kinds share

- Same **cwd** across stage tabs.
- `PipelineRun` record: `kind`, `stage`, tab IDs per role, `approvedPlan`, optional `originalRequest`, timestamps.
- Overview tab: lanes per stage, activity, Jump / Continue CTAs, optional split + live transcript.
- Out of scope v1: ADE task backlog, terminal automation, image prompts.

## Workspace presets (today)

Until `PipelineRun` exists, use palette presets:

| Preset | Tabs | Active tab |
|--------|------|------------|
| Pipeline workspace | Overview + Planner, Plan Reviewer, Implementer, PR Reviewer | Overview |
| Execution pipeline workspace | Overview + Implementer, PR Reviewer | Overview |

Hand-off targets for each role come from `src/handoff/transitions.ts` (Phase 1 of `CLAUDE-FIRST-PLAN.md`).

## Eagle-Eye chains and runs

Each Eagle-Eye chain keeps one `PipelineRun` whose id is the chain id (`eagle1` → `full`, `eagle2` → `execute`). Tagging a tab with a chain (palette **Start Eagle-Eye 1/2**, the start-screen checkbox, or a hand-off along the chain) records that stage's tab, and the hand-off text, on the run (`handoffs[roleId]`). Runs carry the PR Reviewer stage. Chains from before runs existed are rebuilt from their tabs when the overview opens. At startup, runs are pruned to those with a tab left plus the 50 most recent.

The overview opens from the palette (**Open chain overview…**, when the active tab has a chain) or by clicking the chain label on a chat header or terminal toolbar. Per stage: role, tab, status, text handed in (collapsed), Jump, Watch in split, and the verdict parsed from the latest Plan Reviewer / PR Reviewer reply (`src/handoff/verdict.ts`). It shows `originalRequest`, **Pull from Planner** (chat reply, or a terminal's selection → new plan file → tail), and **Pull from Plan Reviewer** (its Reviewed plan). Read-only display: nothing starts or sends.

## Hand-off reuse

- Planner → Plan Reviewer / Implementer: existing `mapHandoff` + new target in UI.
- Plan Reviewer → Planner: review text as context + prior `candidatePlan`.
- Implementer → PR Reviewer: **already implemented** in `src/handoff/map.ts` (`mapImplementerToReviewer`).

## Execute pipeline edge cases

- **Plan-only implementer form** — `approvedPlan` without `description` is allowed for hand-off (`implementerAnswersReady`).
- **Large plans** — same char limits as hand-off store.
- **Re-run** — new `PipelineRun` or reset stage to Implementer; do not silently overwrite PR tab mid-review.
- **Switching kind** — do not convert a `full` run mid-flight; start a new run.

## Acceptance (v1)

- [ ] `full`: review → promote → Start Implementer → PR hand-off path works end-to-end on dogfood repo.
- [ ] `execute`: paste plan → Implementer → PR Reviewer without Planner/Plan Reviewer tabs.
- [x] Overview shows correct lanes for 2-stage vs 4-stage runs (Vitest `PipelineOverview.test.tsx`; live GUI not checked).
- [x] Eagle-Eye chains create one run each; hand-offs record tab + text per stage, PR Reviewer included; old `state.json` loads (Rust `store::chain_runs` tests).
- [x] Review verdict parsed from the latest Plan Reviewer / PR Reviewer reply, shown read-only.
- [ ] Terminal tabs never auto-chained.
