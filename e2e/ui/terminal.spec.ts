import type { Page } from "@playwright/test";
import { expect, roleTab, test, type TauriApp } from "./fixtures/tauri";
import { CWD } from "./fixtures/data";

// Terminal tabs: launch arguments, PTY output into xterm, keyboard bytes,
// resize, exit/restart, and close. PTY output reaches the page through the
// Tauri Channel passed as `onOutput` (src/terminal/live.ts), which
// `app.ptyOutput` / `app.ptyExit` drive.

/** Rendered text of the xterm in the visible terminal tab (DOM renderer rows). */
const screen = (page: Page) => page.locator(".terminal-screen .xterm-rows");

/** Everything the frontend wrote to PTY `id`, in order. */
async function written(app: TauriApp, id: string): Promise<string> {
  return (await app.calls("pty_write"))
    .filter((c) => c.args.id === id)
    .map((c) => String(c.args.data))
    .join("");
}

/** Picks a tile in the Terminals row of the start card and presses its Start button. */
async function startFromTile(page: Page, tile: "Terminal" | "Claude Code" | "Cursor CLI") {
  await page.getByRole("group", { name: "Terminals" }).getByRole("button", { name: tile, exact: true }).click();
  const label = tile === "Terminal" ? "Start terminal" : `Start ${tile}`;
  await page.getByRole("group", { name: "Start a session" }).getByRole("button", { name: label }).click();
}

const terminalTab = (id: string, launch: string, label: string, extra = {}) =>
  roleTab(id, launch === "shell" ? "terminal" : launch, label, {
    kind: "terminal",
    terminalLaunch: launch,
    phase: "terminal",
    ...extra,
  });

test("Terminal tile: shell_terminal_start args, tab becomes a terminal, output renders", async ({ app, page }) => {
  await app.open();
  await startFromTile(page, "Terminal");

  const start = await app.waitForCall("shell_terminal_start");
  expect(start.args.input).toEqual({
    tabId: "tab-1",
    cwd: CWD,
    launch: "shell",
    resumeSessionId: null,
    cols: 80,
    rows: 24,
    windowId: "main",
  });
  expect(start.args.onOutput).toEqual({ channel: expect.any(Number) });
  await expect(page.getByRole("tab", { name: "Terminal · demo" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".status-bar-status")).toHaveText("Terminal");
  // The channel was opened with the start call, so no second process is spawned.
  expect(await app.calls("pty_open")).toHaveLength(0);

  await app.ptyOutput("tab-1", "hello \x1b[31mred\x1b[0m world\r\n$ ");
  await expect(screen(page)).toContainText("hello red world");
  await app.ptyOutput("tab-1", "second line\r\n");
  await expect(screen(page)).toContainText("second line");
  // UTF-8 split across two packets still decodes as one character.
  const bytes = new TextEncoder().encode("café ✓\r\n");
  await app.ptyBytes("tab-1", bytes.subarray(0, 4));
  await app.ptyBytes("tab-1", bytes.subarray(4));
  await expect(screen(page)).toContainText("café ✓");
});

test("Claude Code and Cursor CLI tiles pass their launch kind and no config dir", async ({ app, page }) => {
  await app.open({
    tabs: [roleTab("tab-1", "role_general", "General"), roleTab("tab-2", "role_general", "Second")],
  });
  await startFromTile(page, "Claude Code");
  const claude = await app.waitForCall("shell_terminal_start");
  expect(claude.args.input).toEqual({
    tabId: "tab-1",
    cwd: CWD,
    launch: "claude-cli",
    resumeSessionId: null,
    cols: 80,
    rows: 24,
    windowId: "main",
  });
  // The Claude config folder is chosen by the backend per account, never by the UI.
  expect(JSON.stringify(claude.args)).not.toMatch(/claude1|configDir|CLAUDE_CONFIG_DIR|\.claude/);
  await expect(page.getByRole("tab", { name: "Claude Code · demo" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".status-bar-status")).toHaveText("Claude Code");
  await app.ptyOutput("tab-1", "Welcome to Claude Code\r\n");
  await expect(screen(page)).toContainText("Welcome to Claude Code");

  await page.getByRole("tab", { name: "Second" }).click();
  await startFromTile(page, "Cursor CLI");
  const cursor = await app.waitForCall("shell_terminal_start", (a) => (a.input as { launch: string }).launch === "cursor-cli");
  expect(cursor.args.input).toMatchObject({ tabId: "tab-2", cwd: CWD, launch: "cursor-cli", resumeSessionId: null });
  await expect(page.getByRole("tab", { name: "Cursor CLI · demo" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".status-bar-status")).toHaveText("Cursor CLI");
  await app.ptyOutput("tab-2", "Cursor Agent ready\r\n");
  await expect(screen(page)).toContainText("Cursor Agent ready");
  await expect(screen(page)).not.toContainText("Welcome to Claude Code");
});

test("history: Open in Claude Code / Cursor CLI resumes that chat in a new terminal tab", async ({ app, page }) => {
  await app.open({
    responses: {
      list_claude_history: {
        entries: [
          { id: "claude-sess-1", source: "claude", cwd: CWD, title: "Fix the flaky build", updatedAt: null },
        ],
        configDir: "/Users/e2e/.claude",
        configDisplay: "~/.claude",
        exists: true,
      },
      list_cursor_cli_history: [
        { id: "cursor-chat-9", source: "cli", cwd: CWD, title: "Port the parser", updatedAt: null },
      ],
    },
  });
  const claudeHistory = page.getByRole("region", { name: "Claude Code history" });
  await claudeHistory.getByRole("button", { name: "Open in Claude Code" }).click();
  const claude = await app.waitForCall("shell_terminal_start");
  expect(claude.args.input).toMatchObject({
    tabId: null,
    cwd: CWD,
    launch: "claude-cli",
    resumeSessionId: "claude-sess-1",
  });
  expect(JSON.stringify(claude.args)).not.toMatch(/claude1|configDir/);
  await expect(page.getByRole("tab", { name: "Claude Code · demo" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: "General" })).toBeVisible();
  await app.ptyOutput("tab-2", "Resumed session claude-sess-1\r\n");
  await expect(screen(page)).toContainText("Resumed session claude-sess-1");

  await page.getByRole("tab", { name: "General" }).click();
  await page.getByRole("group", { name: "History provider" }).getByRole("button", { name: "Cursor" }).click();
  await page.getByRole("button", { name: "Open in Cursor CLI" }).click();
  const cursor = await app.waitForCall("shell_terminal_start", (a) => (a.input as { launch: string }).launch === "cursor-cli");
  expect(cursor.args.input).toMatchObject({ tabId: null, launch: "cursor-cli", resumeSessionId: "cursor-chat-9" });
  await expect(page.getByRole("tab", { name: "Cursor CLI · demo" })).toHaveAttribute("aria-selected", "true");
});

test("restored terminal tabs reopen their PTY with launch kind, role id and resume id", async ({ app, page }) => {
  await app.open({
    tabs: [
      terminalTab("tab-1", "claude-cli", "Claude Code · demo", { resumeSessionId: "claude-sess-7", provider: "claude" }),
      terminalTab("tab-2", "shell", "Terminal · demo"),
    ],
  });
  const opened = await app.waitForCall("pty_open", (a) => (a.input as { id: string }).id === "tab-1");
  expect(opened.args.input).toEqual({
    id: "tab-1",
    cwd: CWD,
    launch: "claude-cli",
    roleId: "claude-cli",
    // A restored tab must not re-send its startup prompt.
    prompt: null,
    resumeSessionId: "claude-sess-7",
    cols: expect.any(Number),
    rows: expect.any(Number),
    windowId: "main",
  });
  expect(JSON.stringify(opened.args)).not.toMatch(/claude1|configDir/);
  await app.ptyOutput("tab-1", "claude resumed\r\n");
  await expect(screen(page)).toContainText("claude resumed");

  await page.getByRole("tab", { name: "Terminal · demo" }).click();
  const shell = await app.waitForCall("pty_open", (a) => (a.input as { id: string }).id === "tab-2");
  expect(shell.args.input).toMatchObject({ id: "tab-2", launch: "shell", roleId: "terminal", resumeSessionId: null, prompt: null });
  await app.ptyOutput("tab-2", "plain shell\r\n");
  await expect(screen(page)).toContainText("plain shell");
  await expect(screen(page)).not.toContainText("claude resumed");

  // Switching back reuses the live PTY and keeps its scrollback.
  await page.getByRole("tab", { name: "Claude Code · demo" }).click();
  await expect(screen(page)).toContainText("claude resumed");
  expect((await app.calls("pty_open")).filter((c) => (c.args.input as { id: string }).id === "tab-1")).toHaveLength(1);
});

test("starting a terminal remembers its folder: Recent lists it in another tab", async ({ app, page }) => {
  const other = "/Users/e2e/Projects/other";
  await app.open({
    tabs: [roleTab("tab-1", "role_general", "General", { cwd: other })],
    // remember_folder (src-tauri/src/pty/mod.rs) runs inside the start
    // command; the mock records it in state.recentFolders.
    handlers: {
      projects_list: (_args, state) => ({
        favorites: [],
        recent: state.recentFolders.map((path: string) => ({ path, available: true, favorite: false })),
      }),
    },
  });
  await startFromTile(page, "Terminal");
  await app.waitForCall("shell_terminal_start");
  await expect(page.getByRole("tab", { name: "Terminal · other" })).toBeVisible();

  await page.getByRole("button", { name: "New tab", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Start a session" })).toBeVisible();
  await page.getByRole("group", { name: "Start a session" }).getByRole("button", { name: "Recent" }).click();
  await expect(page.getByRole("menu", { name: "Saved folders" }).getByRole("menuitem", { name: /other/ })).toBeVisible();
});

test("keyboard input reaches the PTY as the exact bytes a terminal sends", async ({ app, page }) => {
  await app.open({ tabs: [terminalTab("tab-1", "shell", "Terminal · demo")] });
  await app.waitForCall("pty_open");
  const input = page.getByRole("textbox", { name: "Terminal input" });
  await expect(input).toBeFocused();

  await page.keyboard.type("ls -la");
  await page.keyboard.press("Enter");
  await expect.poll(() => written(app, "tab-1")).toBe("ls -la\r");

  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Control+C");
  await page.keyboard.press("Escape");
  await expect.poll(() => written(app, "tab-1")).toBe("ls -la\r\x1b[A\x7f\t\x03\x1b");
  // Typing never goes to the agent chat.
  expect(await app.calls("dev_session_send")).toHaveLength(0);
});

test("the PTY is resized to the fitted grid and follows the window and pad", async ({ app, page }) => {
  await app.open({ tabs: [terminalTab("tab-1", "shell", "Terminal · demo")] });
  await app.waitForCall("pty_open");
  const first = await app.waitForCall("pty_resize");
  const size0 = first.args as { id: string; cols: number; rows: number };
  expect(size0.id).toBe("tab-1");
  expect(size0.cols).toBeGreaterThan(80);
  expect(size0.rows).toBeGreaterThan(10);

  // The newest resize is what the PTY has now.
  const latest = async () => (await app.calls("pty_resize")).at(-1)!.args as { cols: number; rows: number };

  await page.setViewportSize({ width: 900, height: 700 });
  await expect.poll(async () => (await latest()).cols).toBeLessThan(size0.cols);
  await expect.poll(async () => (await latest()).rows).toBeLessThan(size0.rows);
  await app.nextFrame();
  const size1 = await latest();

  // Hiding the scratch pad gives the terminal more rows, same width.
  await page.getByRole("region", { name: "Scratch pad" }).getByRole("button", { name: "Hide pad" }).click();
  await expect.poll(async () => (await latest()).rows).toBeGreaterThan(size1.rows);
  expect((await latest()).cols).toBe(size1.cols);
});

test("PTY exit shows the banner; Restart opens a fresh PTY on a new channel", async ({ app, page }) => {
  await app.open({ tabs: [terminalTab("tab-1", "shell", "Terminal · demo")] });
  const opened = await app.waitForCall("pty_open");
  await app.ptyOutput("tab-1", "old output\r\n");
  await expect(screen(page)).toContainText("old output");

  await app.ptyExit("tab-1", 130);
  await expect(page.getByText("Process exited (130).")).toBeVisible();
  const restart = page.locator(".terminal-exit").getByRole("button", { name: "Restart" });
  await restart.click();
  await expect(page.getByText(/Process exited/)).toBeHidden();
  await expect.poll(async () => (await app.calls("pty_open")).length).toBe(2);
  const reopened = (await app.calls("pty_open"))[1];
  expect(reopened.args.input).toMatchObject({ id: "tab-1", cwd: CWD, launch: "shell", prompt: null, resumeSessionId: null });
  expect(reopened.args.onOutput).not.toEqual(opened.args.onOutput);
  // The screen was reset, and the new process's output renders.
  await expect(screen(page)).not.toContainText("old output");
  await app.ptyOutput("tab-1", "new shell\r\n");
  await expect(screen(page)).toContainText("new shell");
});

test("a PTY that fails to open shows the error and Restart", async ({ app, page }) => {
  await app.open({
    tabs: [terminalTab("tab-1", "shell", "Terminal · demo")],
    handlers: {
      pty_open: () => {
        throw new Error("Working folder does not exist: /Users/e2e/Projects/demo");
      },
    },
  });
  await expect(page.locator(".terminal-exit .error")).toHaveText("Working folder does not exist: /Users/e2e/Projects/demo");
  await expect(page.locator(".terminal-exit").getByRole("button", { name: "Restart" })).toBeVisible();
});

test("closing a terminal tab closes it in the backend and disposes its xterm", async ({ app, page }) => {
  await app.open({
    tabs: [roleTab("tab-1", "role_general", "General"), terminalTab("tab-2", "shell", "Terminal · demo")],
    activeTabId: "tab-2",
  });
  await app.waitForCall("pty_open");
  await app.ptyOutput("tab-2", "bye\r\n");
  await expect(screen(page)).toContainText("bye");
  await expect(page.locator(".xterm")).toHaveCount(1);

  await page.getByRole("button", { name: "Close Terminal · demo" }).click();
  // close_tab kills the tab's PTY on the Rust side (kill_tab_pty).
  const closed = await app.waitForCall("close_tab");
  expect(closed.args).toEqual({ tabId: "tab-2", windowId: "main" });
  await expect(page.getByRole("tab", { name: "Terminal · demo" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "General" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".terminal-screen")).toHaveCount(0);
  await expect(page.locator(".xterm-rows").filter({ hasText: "bye" })).toHaveCount(0);
  // Late output from the dying process goes nowhere and throws nothing.
  await app.ptyOutput("tab-2", "late output\r\n");
  await app.ptyExit("tab-2", 0);
  await expect(page.locator(".xterm-rows").filter({ hasText: "late output" })).toHaveCount(0);
  await expect(page.getByText(/Process exited/)).toHaveCount(0);
});

test("closing a terminal tab removes its xterm host from the DOM", async ({ app, page }) => {
  test.fail(
    true,
    "known bug: handleCloseTab calls destroyTerminal (src/StartupForm.tsx:1805) while the TerminalView " +
      "is still mounted; its unmount cleanup then re-appends the disposed host to #terminal-park " +
      "(src/components/TerminalView.tsx:170-171), so every closed terminal leaks an empty .xterm-host",
  );
  await app.open({
    tabs: [roleTab("tab-1", "role_general", "General"), terminalTab("tab-2", "shell", "Terminal · demo")],
    activeTabId: "tab-2",
  });
  await app.waitForCall("pty_open");
  await expect(page.locator(".xterm-host")).toHaveCount(1);
  await page.getByRole("button", { name: "Close Terminal · demo" }).click();
  await app.waitForCall("close_tab");
  await expect(page.getByRole("tab", { name: "Terminal · demo" })).toHaveCount(0);
  await expect(page.locator(".xterm-host")).toHaveCount(0, { timeout: 2000 });
});

test("changing a live CLI terminal's model can stop its PTY (pty_kill)", async ({ app, page }) => {
  page.on("dialog", (dialog) => void dialog.accept());
  await app.open({
    tabs: [terminalTab("tab-1", "claude-cli", "Claude Code · demo", { provider: "claude" })],
  });
  await app.waitForCall("pty_open");
  await page.locator(".terminal-toolbar").getByRole("button", { name: "Model for Claude Code · demo" }).click();
  await page.getByRole("listbox", { name: "Model for Claude Code · demo" }).getByRole("option", { name: /Sonnet/ }).click();
  const model = await app.waitForCall("set_tab_model");
  expect(model.args).toEqual({ tabId: "tab-1", model: "sonnet" });
  const killed = await app.waitForCall("pty_kill");
  expect(killed.args).toEqual({ id: "tab-1" });
  await expect(page.getByText("The agent stopped. Press Restart to use the new model.")).toBeVisible();
});
