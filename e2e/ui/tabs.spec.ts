import { expect, roleTab, test } from "./fixtures/tauri";
import { chord, expectActive, namedTabs, startReady, tabChip } from "./tabs-helpers";

// Tab lifecycle, attention marks, New window and New tab in worktree.
// Sources: src/TabBar.tsx, src/tabStatus.ts, src/StartupForm.tsx (handleNewTab,
// handleCloseTab, reopenTab, requestNewWindow, createWorktreeTab).

test.describe("tab lifecycle", () => {
  test("+ New tab opens a draft with the active role and makes it active", async ({ app, page }) => {
    await app.open({ tabs: [roleTab("tab-1", "role_planner", "Planner")] });
    await page.getByRole("button", { name: "New tab", exact: true }).click();
    const created = await app.waitForCall("new_draft_tab");
    expect(created.args).toMatchObject({ roleId: "role_planner", cwd: "" });
    await expect(page.getByRole("tab")).toHaveCount(2);
    // The mock names a new tab after its role; it is the second chip and selected.
    await expect(page.getByRole("tab").nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(tabChip(page, "Planner").first()).toHaveAttribute("aria-selected", "false");
    await expect(page.getByRole("heading", { name: "Start a session" })).toBeVisible();

    // Mod+T does the same.
    await chord(page, "KeyT");
    await expect(page.getByRole("tab")).toHaveCount(3);
    expect(await app.calls("new_draft_tab")).toHaveLength(2);
    await expect(page.getByRole("tab").nth(2)).toHaveAttribute("aria-selected", "true");
  });

  test("closing a draft tab removes its chip and selects the remaining tab", async ({ app, page }) => {
    await app.open({ tabs: namedTabs(2), activeTabId: "tab-2" });
    await expectActive(page, "Beta");
    await page.getByRole("button", { name: "Close Beta", exact: true }).click();
    const closed = await app.waitForCall("close_tab");
    expect(closed.args).toMatchObject({ tabId: "tab-2", windowId: "main" });
    await expect(tabChip(page, "Beta")).toHaveCount(0);
    await expectActive(page, "Alpha");
  });

  test("Mod+W on a running tab asks first; Cancel keeps it, OK stops and closes it", async ({ app, page }) => {
    await app.open({ tabs: namedTabs(2) });
    await startReady(app, page, "tab-1", "alpha ready");
    // The chip's close button says what it will do.
    await expect(page.getByRole("button", { name: "Stop and close Alpha" })).toBeVisible();

    const prompts: string[] = [];
    page.once("dialog", (dialog) => {
      prompts.push(dialog.message());
      void dialog.dismiss();
    });
    await chord(page, "KeyW");
    await expect.poll(() => prompts).toEqual(["Stop this tab's agent and close it?"]);
    expect(await app.calls("close_tab")).toHaveLength(0);
    await expectActive(page, "Alpha");

    page.once("dialog", (dialog) => void dialog.accept());
    await chord(page, "KeyW");
    const closed = await app.waitForCall("close_tab");
    expect(closed.args.tabId).toBe("tab-1");
    // The chat is saved before the tab goes away.
    const saved = await app.waitForCall("transcript_save");
    expect(saved.args).toMatchObject({ tabId: "tab-1" });
    expect(String(saved.args.text)).toContain("alpha ready");
    await expect(tabChip(page, "Alpha")).toHaveCount(0);
    await expectActive(page, "Beta");
  });

  test("Mod+W on a draft tab closes it without asking", async ({ app, page }) => {
    await app.open({ tabs: namedTabs(2) });
    let asked = false;
    page.on("dialog", (dialog) => {
      asked = true;
      void dialog.dismiss();
    });
    await chord(page, "KeyW");
    await app.waitForCall("close_tab", (args) => args.tabId === "tab-1");
    await expect(tabChip(page, "Alpha")).toHaveCount(0);
    expect(asked).toBe(false);
  });

  test("closing a tab mid-turn drops it; late events for it are ignored", async ({ app, page }) => {
    await app.open({ tabs: namedTabs(2) });
    const turn = await app.start("tab-1");
    await turn.chunk("half a thought");
    await expect(page.getByRole("log")).toContainText("half a thought");
    await expect(tabChip(page, /^Alpha.*Working/)).toBeVisible();

    await page.getByRole("button", { name: "Stop and close Alpha" }).click();
    await app.waitForCall("close_tab", (args) => args.tabId === "tab-1");
    const saved = await app.waitForCall("transcript_save");
    expect(String(saved.args.text)).toContain("half a thought");
    await expect(tabChip(page, "Alpha")).toHaveCount(0);
    await expectActive(page, "Beta");
    await expect(page.getByRole("heading", { name: "Start a session" })).toBeVisible();

    // The agent's last chunks and the finish land after the tab is gone.
    await turn.chunk(" and the rest");
    await turn.finish();
    await expect(page.getByText("and the rest")).toHaveCount(0);
    await expect(page.getByRole("tab")).toHaveCount(1);
    await expect(page.locator(".status-bar-status")).toHaveText("Not started");
  });

  test("reopen closed tab (button and F6) calls reopen_closed_tab", async ({ app, page }) => {
    await app.open({
      tabs: namedTabs(2),
      handlers: {
        close_tab: (a, s) => {
          const tab = s.tabs.find((t: { id: string }) => t.id === a.tabId);
          s.closed = [tab, ...(s.closed ?? [])];
          s.tabs = s.tabs.filter((t: { id: string }) => t.id !== a.tabId);
          if (s.activeTabId === a.tabId) s.activeTabId = s.tabs.at(-1)?.id ?? null;
          const closedTabs = s.closed.map((t: Record<string, string>) => ({
            id: t.id,
            label: t.label,
            roleId: t.roleId,
            cwd: t.cwd,
            color: t.color,
          }));
          return { activeTabId: s.activeTabId, tabs: s.tabs, closedTabs };
        },
        reopen_closed_tab: (_a, s) => {
          const tab = s.closed.shift();
          s.tabs.push(tab);
          s.activeTabId = tab.id;
          return {
            tab: {
              id: tab.id,
              label: tab.label,
              roleId: tab.roleId,
              roleSnapshot: { name: "General", templateVersion: 1, mode: "agent", injection: "send_on_start" },
              cwd: tab.cwd,
              answers: { cwd: tab.cwd },
              mergedPrompt: "",
              mergedPromptHash: "",
              phase: "draft",
              order: s.tabs.length - 1,
              createdAt: new Date().toISOString(),
              transcript: null,
              startupPromptSent: false,
              kind: "role",
              terminalLaunch: "",
            },
          };
        },
        get_app_state: (_a, s) => ({
          activeTabId: s.activeTabId,
          tabs: s.tabs,
          closedTabs: (s.closed ?? []).map((t: Record<string, string>) => ({
            id: t.id,
            label: t.label,
            roleId: t.roleId,
            cwd: t.cwd,
            color: t.color,
          })),
        }),
      },
    });
    await expect(page.getByRole("button", { name: "Reopen closed tab" })).toHaveCount(0);
    await page.getByRole("button", { name: "Close Alpha", exact: true }).click();
    await expect(tabChip(page, "Alpha")).toHaveCount(0);
    await page.getByRole("button", { name: "Reopen closed tab" }).click();
    const reopened = await app.waitForCall("reopen_closed_tab");
    expect(reopened.args).toEqual({ windowId: "main" });
    await expectActive(page, "Alpha");
    await expect(page.getByRole("button", { name: "Reopen closed tab" })).toHaveCount(0);

    // Inactive chips show their close button on hover.
    await tabChip(page, "Beta").hover();
    await page.getByRole("button", { name: "Close Beta", exact: true }).click();
    await expect(tabChip(page, "Beta")).toHaveCount(0);
    await page.keyboard.press("F6");
    await expect.poll(async () => (await app.calls("reopen_closed_tab")).length).toBe(2);
    await expectActive(page, "Beta");
  });

  test("F2 renames the active tab in place; Escape keeps the old name", async ({ app, page }) => {
    await app.open({ tabs: namedTabs(2) });
    await page.locator("body").click({ position: { x: 5, y: 300 } });
    await page.keyboard.press("F2");
    const field = page.getByRole("textbox", { name: "Rename Alpha" });
    await expect(field).toBeFocused();
    await field.fill("Research");
    await field.press("Escape");
    await expect(field).toHaveCount(0);
    await expect(tabChip(page, "Alpha")).toBeVisible();
    expect(await app.calls("set_tab_label")).toHaveLength(0);

    await tabChip(page, "Beta").dblclick();
    const beta = page.getByRole("textbox", { name: "Rename Beta" });
    await beta.fill("Docs pass");
    await beta.press("Enter");
    const renamed = await app.waitForCall("set_tab_label");
    expect(renamed.args).toMatchObject({ tabId: "tab-2", label: "Docs pass" });
  });

  // Tabs cannot be reordered: TabBar.tsx has no drag handlers or move command.
});

test.describe("active tab restore after a reload", () => {
  // The mock's state is reset by a reload, so these handlers keep the
  // backend's state.json (active tab and layout) in sessionStorage.
  const persisted = {
    get_app_state: (_a: unknown, s: { activeTabId: string; tabs: unknown[]; restored?: boolean }) => {
      const saved = sessionStorage.getItem("e2e-tabs-active");
      if (!s.restored && saved) s.activeTabId = saved;
      s.restored = true;
      sessionStorage.setItem("e2e-tabs-active", s.activeTabId);
      return { activeTabId: s.activeTabId, tabs: s.tabs, closedTabs: [] };
    },
    get_layout: (_a: unknown, s: { layout: unknown }) => {
      const saved = sessionStorage.getItem("e2e-tabs-layout");
      if (saved) s.layout = JSON.parse(saved);
      return s.layout;
    },
    set_layout: (a: { layout: unknown }, s: { layout: unknown }) => {
      s.layout = a.layout;
      sessionStorage.setItem("e2e-tabs-layout", JSON.stringify(a.layout));
      return a.layout;
    },
  };

  test("the selected tab and the split come back after a reload", async ({ app, page }) => {
    await app.open({ tabs: namedTabs(3), handlers: persisted });
    await expectActive(page, "Alpha");
    await tabChip(page, "Gamma").click();
    await expectActive(page, "Gamma");
    await app.waitForCall("select_active_tab", (args) => args.tabId === "tab-3");
    await app.waitForCall("get_app_state");
    await chord(page, "Backslash");
    await page.getByRole("dialog", { name: "Split right with tab" }).getByRole("option", { name: /^Alpha/ }).click();
    await expect(page.getByLabel("Second pane: Alpha")).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => sessionStorage.getItem("e2e-tabs-layout")))
      .toContain('"secondaryTabId":"tab-1"');

    await page.reload();
    await expect
      .poll(() => page.evaluate(() => window.__E2E.listenerCount("acp/session-update")))
      .toBeGreaterThan(0);
    await expectActive(page, "Gamma");
    await expect(page.getByLabel("Second pane: Alpha")).toBeVisible();
    await expect(page.getByRole("tab")).toHaveCount(3);
  });

  test("a grid comes back after a reload with the same cells", async ({ app, page }) => {
    await app.open({ tabs: namedTabs(3), activeTabId: "tab-2", handlers: persisted });
    await chord(page, "Alt+KeyG");
    await expect(page.locator("[data-pane]")).toHaveCount(3);
    await expect
      .poll(() => page.evaluate(() => sessionStorage.getItem("e2e-tabs-layout")))
      .toContain('"gridTabIds":["tab-2","tab-1","tab-3"]');
    await page.reload();
    await expect(page.locator("[data-pane]")).toHaveCount(3);
    await expectActive(page, "Beta");
    await expect(page.getByRole("button", { name: "Close grid view" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByLabel("Grid cell: Alpha")).toBeVisible();
    await expect(page.getByLabel("Grid cell: Gamma")).toBeVisible();
  });
});

test.describe("tab marks and attention", () => {
  test("plan and permission requests flag the chip with an aria label", async ({ app, page }) => {
    await app.open({ tabs: [roleTab("tab-1", "role_planner", "Planner"), ...namedTabs(2).slice(1)] });
    const turn = await app.start("tab-1");
    await expect(tabChip(page, /^Planner\s*, Working$/)).toBeVisible();

    await turn.plan("## Plan\n1. Do it");
    const planner = tabChip(page, /^Planner\s*, Needs you: plan to review/);
    await expect(planner).toBeVisible();
    await expect(planner.locator("..")).toHaveAttribute("data-status", "needs");
    await expect(planner.locator(".tab-needs-flag")).toHaveText("!");

    // A permission request outranks the plan.
    await turn.permission("Run npm test");
    await expect(tabChip(page, /^Planner\s*, Needs you: permission request/)).toBeVisible();
    await page.getByRole("button", { name: "Allow once" }).click();
    await app.waitForCall("respond_permission_request");
    await expect(tabChip(page, /^Planner\s*, Needs you: plan to review/)).toBeVisible();
  });

  test("a background turn that fails marks its tab until it is viewed", async ({ app, page }) => {
    await app.open({ tabs: namedTabs(2) });
    await startReady(app, page, "tab-1", "alpha ready");
    await tabChip(page, "Beta").click();
    await expectActive(page, "Beta");

    // A follow-up was in flight on Alpha when it failed in the background.
    await app.turn("tab-1").fail("agent crashed");
    const alpha = tabChip(page, /^Alpha\s*, Needs you: stopped with an error/);
    await expect(alpha).toBeVisible();
    await expect(alpha.locator("..")).toHaveClass(/tab-chip-attention/);

    await alpha.click();
    await expectActive(page, "Alpha");
    await expect(page.getByRole("tab", { name: "Alpha", exact: true })).toBeVisible();
  });

  test("a background turn that finishes is unseen until viewed", async ({ app, page }) => {
    await app.open({ tabs: namedTabs(2) });
    await startReady(app, page, "tab-1", "alpha ready");
    const composer = page.getByRole("textbox", { name: "Follow-up message" });
    await composer.fill("one more");
    await page.getByRole("button", { name: "Send", exact: true }).first().click();
    await app.waitForCall("dev_session_send");
    await tabChip(page, "Beta").click();
    await expect(tabChip(page, /^Alpha\s*, Working$/)).toBeVisible();
    await expect(tabChip(page, /^Alpha\s*, Working$/).locator("..")).toHaveAttribute("data-status", "busy");

    await app.turn("tab-1").reply("done in the background");
    const alpha = tabChip(page, /^Alpha\s*, Finished, not viewed yet$/);
    await expect(alpha).toBeVisible();
    await expect(alpha.locator(".tab-unseen-dot")).toHaveCount(1);
    await alpha.click();
    await expect(page.getByRole("tab", { name: "Alpha", exact: true })).toBeVisible();
    await expect(page.getByRole("log")).toContainText("done in the background");
  });
});

test.describe("new window", () => {
  test("one Claude account: New window opens it directly", async ({ app, page }) => {
    await app.open();
    await page.getByRole("button", { name: "New window" }).click();
    const opened = await app.waitForCall("open_account_window");
    expect(opened.args).toEqual({ accountId: "default" });
    await expect(page.getByRole("dialog", { name: "New window" })).toHaveCount(0);
  });

  test("two accounts: the picker opens and launches the chosen account", async ({ app, page }) => {
    const configDir = { path: "/Users/e2e/.claude", display: "~/.claude", source: "default", exists: true };
    await app.open({
      responses: {
        get_provider_settings: {
          settings: {
            default: "claude",
            roleProvider: {},
            claude: {
              accounts: [
                { id: "default", name: "Work", configDir: null },
                { id: "personal", name: "Personal", configDir: "/Users/e2e/.claude-personal" },
              ],
            },
            cursor: {},
          },
          claudeConfigDir: configDir,
          claudeConfigDirEnv: null,
          claudeAccounts: [
            { id: "default", name: "Work", config: configDir, envOverride: false },
            {
              id: "personal",
              name: "Personal",
              config: { ...configDir, path: "/Users/e2e/.claude-personal", display: "~/.claude-personal" },
              envOverride: false,
            },
          ],
        },
      },
    });
    // The backend's File > New Window menu item emits `new-window`.
    await app.emit("new-window", null);
    const picker = page.getByRole("dialog", { name: "New window" });
    await expect(picker.getByRole("button", { name: "Work" })).toBeVisible();
    await picker.getByRole("button", { name: "Personal" }).click();
    const opened = await app.waitForCall("open_account_window");
    expect(opened.args).toEqual({ accountId: "personal" });
    await expect(picker).toHaveCount(0);
  });

  test("a failed launch shows the backend's message", async ({ app, page }) => {
    await app.open({
      handlers: {
        open_account_window: () => {
          throw new Error("window limit reached");
        },
      },
    });
    await page.getByRole("button", { name: "New window" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "window limit reached" })).toBeVisible();
  });
});

test.describe("new tab in worktree", () => {
  const repo = {
    mainRoot: "/Users/e2e/Projects/demo",
    currentBranch: "main",
    branches: ["main", "feat/old", "feat/busy"],
    checkedOut: ["main", "feat/busy"],
    worktreesDir: "/Users/e2e/Projects/demo.worktrees",
  };

  test("Create runs worktree_tab_new with the form values and opens the tab", async ({ app, page }) => {
    await app.open({
      tabs: [roleTab("tab-1", "role_planner", "Planner")],
      responses: { git_repo_info: repo },
      handlers: {
        worktree_tab_new: (a, s) => {
          const path = `/Users/e2e/Projects/demo.worktrees/${a.branch.replace(/\//g, "-")}`;
          const tab = {
            id: "tab-wt",
            label: "Implementer",
            roleId: a.roleId,
            cwd: path,
            phase: "draft",
            mergedPromptChars: 0,
            startupPromptSent: false,
            hasTranscript: false,
            folderStatus: "ok",
            color: "",
            kind: "role",
            terminalLaunch: "",
            acpSessionId: null,
            model: null,
            provider: "claude",
            chain: null,
            worktreeBranch: a.branch,
            worktreePath: path,
          };
          s.tabs.push(tab);
          s.activeTabId = tab.id;
          return {
            tab: {
              id: tab.id,
              label: tab.label,
              roleId: a.roleId,
              roleSnapshot: { name: "Implementer", templateVersion: 1, mode: "agent", injection: "send_on_start" },
              cwd: path,
              answers: { cwd: path },
              mergedPrompt: "",
              mergedPromptHash: "",
              phase: "draft",
              order: s.tabs.length - 1,
              createdAt: new Date().toISOString(),
              transcript: null,
              startupPromptSent: false,
              kind: "role",
              terminalLaunch: "",
              worktree: { repoRoot: "/Users/e2e/Projects/demo", path, branch: a.branch },
            },
          };
        },
      },
    });
    await page.getByRole("button", { name: "New tab in worktree…" }).click();
    const dialog = page.getByRole("dialog", { name: "New tab in worktree" });
    const loaded = await app.waitForCall("git_repo_info");
    expect(loaded.args).toEqual({ path: "/Users/e2e/Projects/demo" });

    const create = dialog.getByRole("button", { name: "Create worktree and open tab" });
    await expect(create).toBeDisabled();
    // A branch that already exists is refused before git runs.
    const name = dialog.getByRole("textbox", { name: "New branch name" });
    await name.fill("feat/old");
    await expect(create).toBeDisabled();
    await name.fill("feat/effort");
    await expect(dialog.getByText("demo.worktrees")).toBeVisible();
    await dialog.getByRole("combobox", { name: "Start from" }).selectOption("feat/old");
    await dialog.getByRole("combobox", { name: "Role for the new tab" }).selectOption("role_implementer");
    expect(await app.calls("worktree_tab_new")).toHaveLength(0);
    await create.click();

    const made = await app.waitForCall("worktree_tab_new");
    expect(made.args).toEqual({
      roleId: "role_implementer",
      repoPath: "/Users/e2e/Projects/demo",
      branch: "feat/effort",
      createBranch: true,
      base: "feat/old",
      windowId: "main",
    });
    await expect(dialog).toHaveCount(0);
    const chip = tabChip(page, "Implementer");
    await expect(chip).toHaveAttribute("aria-selected", "true");
    await expect(chip).toContainText("⎇ feat/effort");
    await expect(page.getByRole("status").filter({ hasText: "Worktree created" })).toBeVisible();
  });

  test("Existing branch lists only free branches; git errors stay in the dialog", async ({ app, page }) => {
    await app.open({
      responses: { git_repo_info: repo },
      handlers: {
        worktree_tab_new: () => {
          throw new Error("fatal: 'feat/old' is already used by worktree");
        },
      },
    });
    await chord(page, "KeyK");
    await page.getByRole("dialog", { name: "Command palette" }).getByPlaceholder("Type a command").fill("worktree");
    await page.getByRole("dialog", { name: "Command palette" }).getByRole("button", { name: /New tab in worktree…/ }).click();
    const dialog = page.getByRole("dialog", { name: "New tab in worktree" });
    await dialog.getByRole("radio", { name: "Existing branch" }).check();
    const branch = dialog.getByRole("combobox", { name: "Branch" });
    await expect(branch.locator("option")).toHaveText(["Choose a branch", "feat/old"]);
    await branch.selectOption("feat/old");
    await dialog.getByRole("button", { name: "Create worktree and open tab" }).click();
    const made = await app.waitForCall("worktree_tab_new");
    expect(made.args).toMatchObject({ branch: "feat/old", createBranch: false, base: null });
    await expect(dialog.getByText("is already used by worktree")).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("tab")).toHaveCount(1);
  });

  test("a folder that is not a repository shows git's error", async ({ app, page }) => {
    await app.open();
    await page.getByRole("button", { name: "New tab in worktree…" }).click();
    const dialog = page.getByRole("dialog", { name: "New tab in worktree" });
    await expect(dialog.getByText("not a git repository")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Create worktree and open tab" })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  });
});
