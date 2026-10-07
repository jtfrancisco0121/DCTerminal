# New Tab Landing Overhaul Implementation Plan

> **For agentic workers:** Implement task-by-task. Steps use checkbox (`- [ ]`) syntax. Tick items after each commit/push.

**Goal:** Replace the blank-tab / New tab landing so there is no top horizontal role navbar; use a dense two-column Start a session layout matching JT's approved mockup.

**Architecture:** Keep all blank-tab logic in `StartupForm.tsx` (drafts, Start, Preview, history resume). Restructure only the idle/blank JSX and CSS: role selection becomes a tile grid inside the start card; folder + model + Start sit on one toolbar row; history stays a right-hand list. No backend or ACP changes.

**Tech Stack:** Tauri 2 + React/TS, existing `FolderPicker`, `CursorHistoryList`, model picker, seeded roles, Vitest, `App.css` CSS variables / themes.

## Global Constraints

- Base: current `master` (includes PR #12 merge `301f906`).
- No CI / GitHub Actions.
- Never write to `~/.cursor` or into user project repos.
- Keep `npm audit` at 0; tests pass on Node 22/24/26; run `npm run check` before every push.
- Main device is JT's Mac; Mac `npm run check` + install before asking him to smoke.
- No Cursor cloud agents unless JT explicitly asks (usage).
- Merge only after JT approves.
- Density: no wasted blank space; keep the bottom status bar.

## Approved UX (JT signed off)

- Drop the long horizontal role pill strip as the primary chrome on New tab.
- Left: **Start a session** card
  - Row: folder chip · model chip (default `composer-2.5`) · green **Start**
  - **Role** tile grid with colored dots (PR Reviewer, Developer, Implementer, Planner, Recommendation, Codebase Audit, General, plus Terminal and Cursor CLI entries)
  - Selected role outlined
  - **Chat** / **Terminal** toggles when a role is selected
  - Optional **Title** (short)
  - Compact **What to work on** (~3 rows, not a tall empty box)
- Right: **Cursor CLI history** for the folder (Resume / Open in Cursor CLI)
- Keep macOS tab strip (`+ New tab`, gear) and bottom status strip (Not started · model · folder · Run Everything warn)
- Narrow widths: history stacks under the start card

## Current code (what to change)

| Area | Location |
|------|----------|
| Blank-tab root | `src/StartupForm.tsx` ~4048: `empty-state-card start-screen` |
| Role strip in start row | `start-row` + `role-choices` / `role-choice` / `role-dot` (~4068–4131) |
| Folder / Start / Preview | same `start-row` (`FolderPicker` compact, `startButtons`, `blankModelPicker`) |
| Role fields + body | `start-body` / `start-main` (`composerFields`, `idleActions`, handoff banner) |
| History | `aside.start-history` + `CursorHistoryList` |
| Styles | `src/App.css` (`.start-screen`, `.start-row`, `.role-choice`, `.start-body-with-history`, …) |
| Tests | `src/StartupForm.test.tsx`, `src/components/CursorHistoryList.test.tsx` |
| Roles data | seeded role defs (colors/names already used by `roles.map`) |

---

## Task 1: Layout shell (no behavior change)

**Files:** `src/StartupForm.tsx`, `src/App.css`, `src/StartupForm.test.tsx`

- [ ] Restructure blank-tab markup into:
  - `start-session` header row: folder · model · Start (and Preview if still needed)
  - `role-tiles` grid (roles + Terminal + Cursor CLI)
  - `surface-toggles` (Chat / Terminal) when a role is picked
  - `start-fields` (Title + What to work on / existing `composerFields`, compacted)
  - `start-history` aside unchanged in behavior
- [ ] Remove reliance on roles living primarily as a single scrolling `start-row` navbar of pills; roles move into the tile grid.
- [ ] CSS: two-column `start-body-with-history` (~60/40), dense padding, tile min size, selected outline; stack under ~760–900 px.
- [ ] Test: blank tab renders Start a session structure; history aside still present when folder is set.
- [ ] Commit: `ui: restructure New tab landing shell (no top role navbar)`

## Task 2: Role tiles + surface toggles

**Files:** `src/StartupForm.tsx`, optional `src/components/RoleTiles.tsx` (+ test), `src/App.css`

- [ ] Role tiles call existing `chooseRole` / `setLaunchChoice` / `rememberSurface` paths (no new state model).
- [ ] Selected tile uses `aria-pressed` + visible outline; color from `item.color`.
- [ ] Terminal and Cursor CLI remain launch choices (not seeded roles) but look like tiles in the same grid.
- [ ] Chat / Terminal toggles only when a role is selected (same as today's remembered surface).
- [ ] Tests: click role tile updates draft role; Chat vs Terminal remembered; Terminal / Cursor CLI launch choice still works.
- [ ] Commit: `feat: role tile grid on New tab landing`

## Task 3: Compact fields + Start toolbar

**Files:** `src/StartupForm.tsx`, `src/startupFields.ts` (only if field layout helpers need tweaks), `src/App.css`, tests

- [ ] Title field short (single line); primary prompt / "What to work on" ~3 rows default (reuse role field defs, tighten textarea rows / CSS).
- [ ] Keep Preview / Validate if it still applies; place it near Start without recreating a second toolbar.
- [ ] Preserve handoff banner and "plan from Planner" scratch path when present.
- [ ] Start / Start Cursor CLI / Start terminal disabled rules unchanged (`busy`, folder, `cliFound`).
- [ ] Tests: Start still launches chat/terminal; validation errors still surface.
- [ ] Commit: `ui: compact Title and prompt fields on blank tab`

## Task 4: History panel polish

**Files:** `src/components/CursorHistoryList.tsx`, CSS, tests

- [ ] Keep Resume / Open in Cursor CLI behavior.
- [ ] Denser rows (match mockup); panel titled Recent / Cursor CLI history for this folder.
- [ ] Hidden when no folder or when pure Terminal/Cursor-CLI launch choice if that is current behavior — do not regress.
- [ ] Commit: `ui: denser history list on New tab landing`

## Task 5: Docs + verify

**Files:** `docs/PROGRESS.md`, `README.md` (start-screen mention), this plan

- [ ] Update PROGRESS snapshot: New tab landing overhaul.
- [ ] Tick all boxes in this plan after push.
- [ ] `npm run check` and `npm audit` = 0 on box; same on JT's Mac with Homebrew Node (`PATH=/opt/homebrew/bin:$PATH`).
- [ ] Message JT with PR link and smoke list (New tab → pick role tile → folder → Start; history Resume; Chat/Terminal toggle; no top role navbar).
- [ ] Commit: `docs: New tab landing plan progress`

## Out of scope

- Signed `.dmg` / distribution
- Redesigning Settings, status bar, or tab chip chrome (already done in PR #12)
- Changing role permission policy or ACP protocol
- Adding new roles

## Smoke checklist (JT)

- [ ] New tab shows no top horizontal role navbar
- [ ] Role tiles select a role; outline matches selection
- [ ] Chat / Terminal toggles work; Start opens the right surface
- [ ] Folder + model + Start work; default model still `composer-2.5`
- [ ] History list resumes / opens Cursor CLI
- [ ] Handoff-created draft tabs still show plan content
- [ ] Themes (GitHub Dark / Light) still look correct on the landing

## Agent handoff fields (copy/paste)

**Task Type:** Feature

**Title:** Overhaul the New tab landing page (drop the top role navbar)

**Description:** Redesign the blank-tab / New tab landing so it matches the approved mockup: no horizontal role pill bar across the top. Use a dense two-column layout instead. Left side is Start a session: folder, model, and Start on one row; a role tile grid with colored dots; Chat / Terminal toggles; a short Title field; and a compact What to work on box. Right side is Cursor CLI history for the folder (Resume / Open in Cursor CLI). Keep the existing tab strip and the bottom status bar. Goal is less wasted space and a clearer start flow.

**Approved Implementation Plan:** Follow `docs/NEW-TAB-LANDING-PLAN.md` tasks 1–5 in order. Tick checkboxes after each push. One draft PR to master.

**Additional Context:** JT approved the mockup that replaces the top role navbar with role tiles. Density matters. Main device is Mac. Base is master after PR #12. Primary files: `StartupForm.tsx`, `App.css`, `CursorHistoryList`. No cloud agents unless JT asks. Merge only after JT approves.
