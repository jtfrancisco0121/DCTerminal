# DCTerminal Improvements Plan

Checklist for the ADE-inspired controls pass. Tick items in this file after they are pushed so the checklist always matches the PR branch.

**Base:** current `master` (includes #11 + model-picker fix).  
**Out of scope:** signed `.dmg`/distribution, ADE orchestrator/fleet, project-setup writers, token/cost panel.

**Rules:** no CI/Actions; never write `~/.cursor` or user repos (worktrees only when the user asks); `npm audit` = 0; tests pass on Node 22/24/26; `npm run check` before every push; Mac test before asking JT to smoke; one draft PR; merge via JT approval. Ping JT after every commit/push.

---

## Features

- [ ] **F1. Background-tab notifications** — System + in-app toast when an agent finishes a turn, needs permission, or asks a question; respect window focus; Settings toggle.  
  *Accept:* Background tab firing those events shows toast; focused window stays quiet (or quieter per toggle); Settings Notifications can disable.

- [ ] **F2. Tab status** — Pulse while busy; unseen-finished dot; needs-you flag; rename tab; jump-to-tab search (Mod+K or similar).  
  *Accept:* Busy/finished/needs-you visible on chips; rename persists; palette/switcher finds tabs by name/folder.

- [ ] **F3. Git worktree per tab** — "New tab in worktree…" creates/picks a branch, `git worktree add` under `<repo>-worktrees/<branch>` only on user ask; show branch in header; remove with confirm and refuse dirty trees.  
  *Accept:* Worktree tab cwd is the sibling folder; header shows branch; remove confirms and blocks on uncommitted changes; never runs unless user chose the action.

- [ ] **F4. Diff panel** — Per turn/tab: changed files (git diff vs turn start or tool diffs); side-by-side or unified; Accept / Revert file / Revert all / Open in file panel; Revert confirms.  
  *Accept:* Diff list matches agent edits; Revert restores file after confirm; Open focuses file panel.

- [ ] **F5. Search** — Search chats/transcripts (incl. saved history) with jump-to-hit; Mod+F in terminal tabs (xterm search addon).  
  *Accept:* Chat search jumps to message; terminal Mod+F finds buffer text.

- [ ] **F6. Prompt library** — Named saved prompts, recent sends, insert into scratch pad; stored in DCTerminal app data dir.  
  *Accept:* Save/load/insert works across restarts; data under app support path, not the repo.

- [ ] **F7. Workspaces** — Save/restore named sets of tabs and folders.  
  *Accept:* Save workspace restores tab titles, folders, and roles on load.

- [ ] **F8. First-run setup** — Detect `agent` CLI, check login, pick folder, start a role.  
  *Accept:* Fresh profile walks detect → login hint → folder → role → Start.

- [ ] **F9. Command palette** — Actions for hand-off, worktree, split, model, history, search, prompts, workspaces.  
  *Accept:* Palette lists and runs those actions.

## UI (dense)

- [ ] **U1. Slimmer tab chips + one-line session header** — Details on hover.  
  *Accept:* Chips shorter; header one line; hover shows path/role/model.

- [ ] **U2. Scratch pad 2–3 rows, drag-to-expand** — Same in chat and terminal; Keep Hide/Show.  
  *Accept:* Default ~3 rows; drag grows; Hide/Show still works.

- [ ] **U3. One status bar** — Status, model, folder, Run Everything warning (no stacked banners).  
  *Accept:* Single bottom/status strip carries those facts.

- [ ] **U4. Role-rules-off badge → warn icon + tooltip**  
  *Accept:* No long text badge; icon + tooltip only.

- [ ] **U5. Compact start screen** — Role, folder, Start on one row; history as side list.  
  *Accept:* Startup fits one row + side history.

- [ ] **U6. Settings left category menu** — Roles, Models, Terminal, Permissions, Notifications, Shortcuts, Data.  
  *Accept:* Settings uses left nav with those categories.

- [ ] **U7. Easier shortcuts** — Optional bottom shortcut bar + first-use tips.  
  *Accept:* Toggleable bar; first-run tip once.

- [ ] **U8. Theme CSS variables** — GitHub Dark default + one alternative.  
  *Accept:* Themes switch via CSS vars; default is GitHub Dark.

## Docs & quality

- [ ] **Tests** — Coverage for each feature above (unit/component as fits).  
  *Accept:* New/updated tests green under `npm run check`.

- [ ] **README shortcuts + docs/PROGRESS.md** — Document new shortcuts; progress snapshot before push.  
  *Accept:* README lists new shortcuts; PROGRESS updated on push.

## Skip (explicit)

- Signed `.dmg` / distribution
- ADE orchestrator / fleet
- Project-setup writers that mutate repos
- Token / cost panel
