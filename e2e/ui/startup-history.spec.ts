import type { Page } from "@playwright/test";
import type { CursorHistoryEntry } from "../../src/cursorHistory";
import { CWD } from "./fixtures/data";
import { expect, roleTab, test, type PageHandler } from "./fixtures/tauri";

// Session history beside the start card (CursorHistoryList) and the restore
// actions of a tab that already ran (Continue session / Start new session).

const OTHER = "/Users/e2e/Projects/other";
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

const claudeEntry = (extra: Partial<CursorHistoryEntry> = {}): CursorHistoryEntry => ({
  id: "0b6c2a51-claude",
  source: "claude",
  cwd: OTHER,
  title: "Fix the login redirect",
  updatedAt: hoursAgo(2),
  ...extra,
});

const claudeHistory = (entries: CursorHistoryEntry[]) => ({
  entries,
  configDir: "/Users/e2e/.claude",
  configDisplay: "~/.claude",
  exists: true,
});

const history = (page: Page, name: string) => page.getByRole("region", { name });
const row = (page: Page, region: string, title: string) =>
  history(page, region).getByRole("listitem").filter({ hasText: title });

/** shell_terminal_start that opens a terminal tab the way pty/mod.rs does. */
const openTerminalTab: PageHandler = (a, s) => {
  s.tabCounter += 1;
  const id = `tab-${s.tabCounter}`;
  s.tabs.push({
    id,
    label: a.input.launch === "claude-cli" ? "Claude Code" : "Cursor CLI",
    roleId: "",
    cwd: a.input.cwd,
    phase: "running",
    mergedPromptChars: 0,
    startupPromptSent: false,
    hasTranscript: false,
    folderStatus: "ok",
    color: "",
    kind: "terminal",
    terminalLaunch: a.input.launch,
    acpSessionId: null,
    model: null,
    provider: a.input.launch === "claude-cli" ? "claude" : "cursor",
    chain: null,
    resumeSessionId: a.input.resumeSessionId,
  });
  s.activeTabId = id;
  return { errors: [], tabId: id, pid: 4242, usedPromptFile: false };
};

test.describe("Claude Code history", () => {
  test("lists the folder's sessions with Resume and Open in Claude Code", async ({ app, page }) => {
    await app.open({
      responses: {
        list_claude_history: claudeHistory([
          claudeEntry(),
          claudeEntry({ id: "second", title: "Untitled", updatedAt: null, roleName: "Planner", userText: "Add effort" }),
        ]),
      },
    });
    expect((await app.waitForCall("list_claude_history")).args).toEqual({ cwd: CWD, windowId: "main" });
    const region = history(page, "Claude Code history");
    await expect(region.getByRole("heading", { name: "Claude Code history" })).toBeVisible();
    await expect(region.getByText("Saved sessions for this folder. Read from ~/.claude.")).toBeVisible();
    await expect(region.locator(".history-title")).toHaveText(["Fix the login redirect", "Planner · Add effort"]);
    await expect(row(page, "Claude Code history", "Fix the login redirect")).toContainText("claude · 2 hours ago");
    for (const title of ["Fix the login redirect", "Planner · Add effort"]) {
      await expect(row(page, "Claude Code history", title).getByRole("button")).toHaveText([
        "Resume",
        "Open in Claude Code",
      ]);
    }
  });

  test("an empty folder and a failed read", async ({ app, page }) => {
    await app.open();
    const region = history(page, "Claude Code history");
    await expect(region.getByText("No saved sessions for this folder.")).toBeVisible();

    await app.handle("list_claude_history", () => {
      throw new Error("projects folder is unreadable");
    });
    // Re-read by switching the history list away and back.
    const toggle = page.getByRole("group", { name: "History provider" });
    await toggle.getByRole("button", { name: "Cursor" }).click();
    await expect(history(page, "Cursor CLI history")).toBeVisible();
    await toggle.getByRole("button", { name: "Claude" }).click();
    await expect(region.getByText("projects folder is unreadable")).toBeVisible();
  });

  test("Resume opens a new tab in the session's folder and loads that session", async ({ app, page }) => {
    await app.open({ responses: { list_claude_history: claudeHistory([claudeEntry()]) } });
    await row(page, "Claude Code history", "Fix the login redirect").getByRole("button", { name: "Resume" }).click();

    const draft = await app.waitForCall("new_draft_tab");
    expect(draft.args).toEqual({ roleId: "role_general", cwd: OTHER, windowId: "main" });
    const start = await app.waitForCall("role_session_start");
    expect(start.args).toEqual({
      roleId: "role_general",
      values: { cwd: OTHER },
      tabId: "tab-2",
      resendStartup: false,
      resumeSessionId: "0b6c2a51-claude",
      windowId: "main",
    });
    await expect(page.getByRole("button", { name: "Stop session" }).first()).toBeVisible();
    await expect(page.getByRole("tab", { name: "General" })).toHaveCount(2);
    await expect(page.getByRole("tab", { selected: true })).toHaveCount(1);
    expect((await page.evaluate(() => window.__E2E.state.activeTabId)) as string).toBe("tab-2");
    // The first tab is untouched.
    expect((await app.calls("role_session_start")).every((c) => c.args.tabId === "tab-2")).toBe(true);
  });

  test("Open in Claude Code resumes the session in a terminal tab", async ({ app, page }) => {
    await app.open({
      responses: { list_claude_history: claudeHistory([claudeEntry()]) },
      handlers: { shell_terminal_start: openTerminalTab },
    });
    await row(page, "Claude Code history", "Fix the login redirect")
      .getByRole("button", { name: "Open in Claude Code" })
      .click();
    const call = await app.waitForCall("shell_terminal_start");
    expect(call.args.input).toEqual({
      tabId: null,
      cwd: OTHER,
      launch: "claude-cli",
      resumeSessionId: "0b6c2a51-claude",
      cols: 80,
      rows: 24,
      windowId: "main",
    });
    await expect(page.getByRole("tab", { name: /Claude Code/ })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("heading", { name: "Start a session" })).toBeHidden();
    expect(await app.calls("role_session_start")).toHaveLength(0);
  });

  test("Open in Claude Code: a terminal that does not start says why", async ({ app, page }) => {
    await app.open({
      responses: {
        list_claude_history: claudeHistory([claudeEntry()]),
        shell_terminal_start: {
          errors: [{ key: "_session", message: "claude was not found on PATH" }],
          tabId: null,
          pid: null,
          usedPromptFile: false,
        },
      },
    });
    await row(page, "Claude Code history", "Fix the login redirect")
      .getByRole("button", { name: "Open in Claude Code" })
      .click();
    await expect(page.locator(".start-session-card").getByText("claude was not found on PATH")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Start a session" })).toBeVisible();
  });
});

test.describe("Cursor history", () => {
  const cursorRows: CursorHistoryEntry[] = [
    { id: "acp-1", source: "acp", cwd: CWD, title: "Planner", updatedAt: hoursAgo(3), roleName: "Planner", userText: "Plan the cache" },
    { id: "cli-1", source: "cli", cwd: CWD, title: "Tidy the README", updatedAt: hoursAgo(30) },
  ];

  test("the Cursor list: ACP sessions resume here, CLI chats open in Cursor CLI", async ({ app, page }) => {
    await app.open({
      responses: { list_cursor_cli_history: cursorRows },
      handlers: { shell_terminal_start: openTerminalTab },
    });
    const toggle = page.getByRole("group", { name: "History provider" });
    await expect(toggle.getByRole("button", { name: "Claude" })).toHaveAttribute("aria-pressed", "true");
    await toggle.getByRole("button", { name: "Cursor" }).click();
    await expect(toggle.getByRole("button", { name: "Cursor" })).toHaveAttribute("aria-pressed", "true");
    expect((await app.waitForCall("list_cursor_cli_history")).args).toEqual({ cwd: CWD });

    const region = history(page, "Cursor CLI history");
    await expect(region.getByText("Saved sessions for this folder.", { exact: true })).toBeVisible();
    await expect(region.locator(".history-title")).toHaveText(["Planner · Plan the cache", "Tidy the README"]);
    const acp = row(page, "Cursor CLI history", "Plan the cache");
    const cli = row(page, "Cursor CLI history", "Tidy the README");
    await expect(acp).toContainText("Session · 3 hours ago");
    await expect(cli).toContainText("Chat · yesterday");
    await expect(acp.getByRole("button")).toHaveText(["Resume"]);
    await expect(cli.getByRole("button")).toHaveText(["Open in Cursor CLI"]);
    // Only the list changed: the tab is still a Claude tab.
    await expect(
      page.getByRole("radiogroup", { name: "Provider for this tab" }).getByRole("radio", { name: "Claude" }),
    ).toBeChecked();

    await cli.getByRole("button", { name: "Open in Cursor CLI" }).click();
    const call = await app.waitForCall("shell_terminal_start");
    expect(call.args.input).toMatchObject({ tabId: null, cwd: CWD, launch: "cursor-cli", resumeSessionId: "cli-1" });
    await expect(page.getByRole("tab", { name: /Cursor CLI/ })).toHaveAttribute("aria-selected", "true");
  });

  test("Resume on an ACP session starts it in a new tab", async ({ app, page }) => {
    await app.open({ responses: { list_cursor_cli_history: cursorRows } });
    await page.getByRole("group", { name: "History provider" }).getByRole("button", { name: "Cursor" }).click();
    await row(page, "Cursor CLI history", "Plan the cache").getByRole("button", { name: "Resume" }).click();
    const start = await app.waitForCall("role_session_start");
    expect(start.args).toMatchObject({ tabId: "tab-2", resumeSessionId: "acp-1", values: { cwd: CWD } });
    await expect(page.getByRole("button", { name: "Stop session" }).first()).toBeVisible();
  });

  test("a failed Cursor read shows its error", async ({ app, page }) => {
    await app.open({
      handlers: {
        list_cursor_cli_history: () => {
          throw new Error("Cursor's home folder was not found");
        },
      },
    });
    await page.getByRole("group", { name: "History provider" }).getByRole("button", { name: "Cursor" }).click();
    await expect(history(page, "Cursor CLI history").getByText("Cursor's home folder was not found")).toBeVisible();
  });
});

test.describe("a tab that already ran", () => {
  const TRANSCRIPT = "You: list the files\nAgent: README.md, src/, package.json";
  /** select_active_tab with the saved transcript on tab-1 (TabRecord.transcript). */
  const selectWithTranscript: PageHandler = (a, s) => {
    s.activeTabId = a.tabId;
    const t = s.tabs.find((x: { id: string }) => x.id === a.tabId);
    return {
      tab: {
        id: t.id,
        label: t.label,
        roleId: t.roleId,
        roleSnapshot: { name: t.label, templateVersion: 1, mode: "agent", injection: "send_on_start" },
        cwd: t.cwd,
        answers: { cwd: t.cwd, ...(s.answers[t.id] ?? {}) },
        mergedPrompt: "",
        mergedPromptHash: "",
        phase: t.phase,
        order: 0,
        createdAt: "2026-10-01T09:00:00Z",
        transcript: t.id === "tab-1" ? "You: list the files\nAgent: README.md, src/, package.json" : null,
        startupPromptSent: t.startupPromptSent,
        kind: "role",
        terminalLaunch: "",
      },
    };
  };
  const ranTab = (acpSessionId: string | null) =>
    roleTab("tab-1", "role_general", "General", {
      phase: "awaitingInput",
      acpSessionId,
      startupPromptSent: true,
      hasTranscript: true,
    });

  test("Continue session loads the stored session; the last transcript is read-only", async ({
    app,
    page,
  }) => {
    await app.open({
      tabs: [ranTab("sess-old")],
      answers: { "tab-1": { title: "List files" } },
      handlers: { select_active_tab: selectWithTranscript },
    });
    const transcript = page.locator("details.startup-form-details");
    await expect(transcript.locator("summary")).toHaveText("Last session transcript (read-only)");
    await transcript.locator("summary").click();
    await expect(transcript.locator("pre")).toHaveText(TRANSCRIPT);
    await expect(transcript.getByRole("textbox")).toHaveCount(0);
    // Fields stay folded until Start new session.
    await expect(page.getByRole("button", { name: "Validate & preview" })).toBeHidden();
    await expect(page.getByRole("button", { name: "Start new session" })).toHaveAttribute("aria-expanded", "false");

    await page.getByRole("button", { name: "Continue session" }).click();
    const start = await app.waitForCall("role_session_start");
    expect(start.args).toEqual({
      roleId: "role_general",
      values: { cwd: CWD, title: "List files" },
      tabId: "tab-1",
      resendStartup: false,
      resumeSessionId: "sess-old",
      windowId: "main",
    });
    await expect(page.getByRole("button", { name: "Stop session" }).first()).toBeVisible();
  });

  test("Start new session opens the form and starts fresh; Re-send startup prompt can be turned off", async ({
    app,
    page,
  }) => {
    await app.open({
      tabs: [ranTab("sess-old")],
      handlers: { select_active_tab: selectWithTranscript },
    });
    const newSession = page.getByRole("button", { name: "Start new session" });
    await newSession.click();
    await expect(newSession).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("textbox", { name: "Title", exact: true })).toBeVisible();
    const resend = page.getByRole("checkbox", { name: /Re-send startup prompt/ });
    // Re-sending the role's startup prompt is the default for a new session here.
    await expect(resend).toBeChecked();
    await resend.uncheck();
    await page.getByRole("textbox", { name: "Title", exact: true }).fill("Second pass");

    await startRowButton(page).click();
    const start = await app.waitForCall("role_session_start");
    expect(start.args).toEqual({
      roleId: "role_general",
      values: { cwd: CWD, title: "Second pass" },
      tabId: "tab-1",
      resendStartup: false,
      resumeSessionId: null,
      windowId: "main",
    });
  });

  test("saved text without a session id cannot be continued", async ({ app, page }) => {
    await app.open({
      tabs: [ranTab(null)],
      handlers: { select_active_tab: selectWithTranscript },
    });
    await expect(page.getByText("This tab has saved text, but it cannot be continued. Start a new session.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue session" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Start new session" })).toBeVisible();
    await page.locator("details.startup-form-details summary").click();
    await expect(page.locator("details.startup-form-details pre")).toHaveText(TRANSCRIPT);
  });
});

function startRowButton(page: Page) {
  return page.getByRole("group", { name: "Start a session" }).getByRole("button", { name: "Start", exact: true });
}
