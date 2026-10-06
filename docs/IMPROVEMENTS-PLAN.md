# DCTerminal Improvements Plan

Checklist for the ADE-inspired controls pass. Tick items in this file after they are pushed so the checklist always matches the PR branch.

**Base:** current `master` (includes #11 + model-picker fix).  
**Out of scope:** signed `.dmg`/distribution, ADE orchestrator/fleet, project-setup writers, token/cost panel.

**Rules:** no CI/Actions; never write `~/.cursor` or user repos (worktrees only when the user asks); `npm audit` = 0; tests pass on Node 22/24/26; `npm run check` before every push; Mac test before asking JT to smoke; one draft PR; merge via JT approval. Ping JT after every commit/push.

---

## Features

- [x] **F1. Background-tab notifications** — System + in-app toast when an agent finishes a turn, needs permission, or asks a question; respect window focus; Settings toggle.  
  *Accept:* Background tab firing those events shows toast; focused window stays quiet (or quieter per toggle); Settings Notifications can disable.
  *Done (`a0dfece`):* chat (ACP) tabs only — terminal tabs are not tracked yet (F2 territory). "Asks a question" = turn ends on a `?` line, or a `cursor/create_plan` review; `cursor/ask_question` is still auto-cancelled by the backend. Mac smoke still needed for the OS permission prompt and focus/blur behavior in WKWebView.

- [x] **F2. Tab status** — Pulse while busy; unseen-finished dot; needs-you flag; rename tab; jump-to-tab search (Mod+K or similar).  
  *Accept:* Busy/finished/needs-you visible on chips; rename persists; palette/switcher finds tabs by name/folder.
  *Done (`68f8595`):* chat tabs use ACP signals (prompt in flight, permission, plan, finished/question/error). Terminal tabs get busy + finished dot from output activity (3 s quiet, keystroke echo and terminal query replies ignored; no finished dot before the user typed). Rename is inline (double-click or F2) and survives form edits, Start, and close/reopen (`customLabel` in `state.json`). Go to tab stays on Mod+P (Mod+Shift is reserved for the terminal); Mod+K palette also matches tabs by folder. No toasts for terminal tabs (F1 scope unchanged).

- [x] **F3. Git worktree per tab** — "New tab in worktree…" creates/picks a branch, `git worktree add` under `<repo>-worktrees/<branch>` only on user ask; show branch in header; remove with confirm and refuse dirty trees.  
  *Accept:* Worktree tab cwd is the sibling folder; header shows branch; remove confirms and blocks on uncommitted changes; never runs unless user chose the action.
  *Done (`ead19f1`):* "⎇ Worktree" button on the tab bar and **New tab in worktree…** in the palette open a dialog (repository, new branch + start point or a free existing branch, role). Only **Create** runs `git worktree add` (plain, never `--force`), into `<main repo>-worktrees/<branch>` (`/` in the branch becomes `-`; works from inside another worktree) and opens a draft tab there. Opening the dialog only reads branches. Branch shows on the chip, session header, and terminal toolbar, read from the worktree's `HEAD` file (no git process on refresh). **Remove this tab's worktree…** (palette, worktree tabs only) refuses any `git status --porcelain` output (untracked included), asks to confirm, closes the tab, then `git worktree remove`; the backend also refuses while the tab is open or unconfirmed. Branch and commits are kept. Mac smoke still needed.

- [x] **F4. Diff panel** — Per turn/tab: changed files (git diff vs turn start or tool diffs); side-by-side or unified; Accept / Revert file / Revert all / Open in file panel; Revert confirms.  
  *Accept:* Diff list matches agent edits; Revert restores file after confirm; Open focuses file panel.
  *Done (`9b7fd8e`):* git-based. Right before each `session/prompt`, the tab's repo is snapshotted into app data (`changes/<tab>`: scratch copy of the index, `git add -A` + `write-tree` with `GIT_OBJECT_DIRECTORY` there and the repo's objects only as an alternate; clean/smudge filters, fsmonitor, auto-gc off), so the repo's index, refs, objects and files are never written. Scopes: **This turn** (last prompt start) and **Whole tab** (first snapshot). The user's own uncommitted work from before the turn is part of the baseline, so it is not listed. Unified or side-by-side view (remembered). **Accept** keeps the file and marks it reviewed (tied to its content, so a later edit shows again); **Revert file** / **Revert all…** (skips accepted) confirm first, are off while the agent works (backend refuses too), skip a file that changed after it was shown, and run `git restore --worktree --source=<snapshot>` (new files removed, deleted files back; index untouched). **Open in file panel** opens the file panel, expands to the file, opens and focuses it. Terminal tabs have no turn hook: **Snapshot now** sets the baseline. Tool-call diffs were not available in the ACP cache, so non-git folders show "not in a git repository". Mac smoke still needed.

- [x] **F5. Search** — Search chats/transcripts (incl. saved history) with jump-to-hit; Mod+F in terminal tabs (xterm search addon).  
  *Accept:* Chat search jumps to message; terminal Mod+F finds buffer text.  
  *Done (`6cd8339`):* **Find in chat** (Mod+F in a live chat tab): find bar over the transcript, case-insensitive, "n of m", Enter / Shift+Enter or arrows step, the current message is scrolled into view (collapsed tool blocks open) and matches are painted with the CSS Custom Highlight API; auto-scroll pauses while it is open. **Search all chats** (Mod+Shift+F outside a terminal, the palette, or the find bar's button): live chats first, then the saved transcripts of open tabs, closed tabs, and archived transcripts whose tab is gone (new read-only `history_search` command; Rust and TS use the same matcher so the hit index lines up). Picking a live hit opens that tab's find bar on that exact match; an open or closed tab (closed tabs are reopened by id) shows its saved transcript with the hit highlighted; an archived transcript is previewed in the dialog. Only DCTerminal's own transcripts are searched (Cursor's `~/.cursor` store is not opened). **Terminal search** follows ADE's SearchAddon bar: search as you type, Match case / Whole word / Regex, "n of m" (decorations, so `allowProposedApi` is on), Enter / Shift+Enter, Esc closes and refocuses the terminal. Keys: ⌘F on macOS; on Windows/Linux Ctrl+F stays with the shell and Ctrl+Shift+F opens it (palette **Find in tab** everywhere). Mac smoke still needed.

- [x] **F6. Prompt library** — Named saved prompts, recent sends, insert into scratch pad; stored in DCTerminal app data dir.  
  *Accept:* Save/load/insert works across restarts; data under app support path, not the repo.  
  *Done (`c95b7c4`):* `prompts.json` in DCTerminal's app data dir (the same resolved dir as `scratch.json`/`handoffs.json`: app support on macOS, `%APPDATA%` on Windows, `DCT_DATA_DIR` override for tests); never the repo or `~/.cursor`. Written atomically with `.bak`; a corrupt file is moved aside, a newer schema is kept as `.corrupt-schema-N`. **Saved prompts**: unique names (case-insensitive), edit keeps the id, up to 500 prompts / 200k chars each, last-used time. **Recent sends**: every chat send (composer, pad, chain steps) and every terminal pad **Send** (not plain paste), newest first, 50 kept, the same text moves to the front. **Prompt library** dialog (**Prompts** button on chat and terminal scratch pads, or the palette **Prompt library…** / **Save scratch pad as prompt…**): Saved / Recent sends lists, filter, preview, **Insert into scratch pad** (at the pad's last cursor or selection, else appended after a blank line; Enter or double-click), New / Edit / Delete, **Save as prompt…** on a recent send, and the storage path shown in the footer. Restart persistence is covered by the Rust store test (reopen from disk). Keyboard shortcut and full palette pass left for F9.

- [x] **F7. Workspaces** — Save/restore named sets of tabs and folders.  
  *Accept:* Save workspace restores tab titles, folders, and roles on load.  
  *Done (`e5c2946`):* `workspaces.json` in DCTerminal's app data dir (ADE's workspace-preset shape, adapted to `state.json` tabs); never the repo or `~/.cursor`. A workspace keeps each open tab's title, folder, role (+ snapshot), kind (chat / shell / Cursor CLI / role terminal), color, model, form answers, and which tab was active. Names are unique (case-insensitive); saving over a name asks first and keeps the id. **Open** adds the tabs next to the open ones; **Replace open tabs** saves live transcripts, asks if agents or terminals are running, stops them, and closes the old tabs into Reopen closed tab. Restored chat tabs are drafts with the saved title kept (custom label), so nothing starts until Start; terminal tabs start their shell/`agent` when shown, as after an app restart; a specific chat is never resumed (`resumeSessionId` dropped). Tabs whose role was deleted are skipped and listed in a notice. Worktree tabs come back as plain tabs in the worktree folder (no git is run). Palette: **Open workspace…**, **Save tabs as workspace…**. Split layout is not part of a workspace yet.

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
