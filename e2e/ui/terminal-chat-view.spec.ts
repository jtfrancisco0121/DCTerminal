import type { Page } from "@playwright/test";
import type { ChatEntry, TerminalSessionLog } from "../../src/bridge";
import { expect, roleTab, test, type TauriApp } from "./fixtures/tauri";

// Chat view of a Claude terminal tab (src/views/TerminalChatView.tsx); its
// composer and permission buttons write to the PTY (src/terminal/ptyAnswers.ts).
// The entries come from the tab's session log over `terminal_chat_watch`
// (src/terminal/chatEntriesStore.ts); `app.chatSet` plays the backend's part.
// The PTY keeps running while the chat view is shown.

test.describe.configure({ timeout: 45_000 });
const READ = { timeout: 10_000 };

const IMPL = "Implementer · Login 500";
// After any PTY start: an entry older than the PTY came from an earlier
// process, so the chat view would not count it as running.
const AT = "2099-10-16T10:00:00.000Z";

const claudeTerminal = (id: string, label: string, extra = {}) =>
  roleTab(id, "role_implementer", label, {
    kind: "terminal",
    terminalLaunch: "role",
    phase: "terminal",
    startupPromptSent: true,
    provider: "claude",
    permissionMode: "auto",
    ...extra,
  });

const subAgent = (seq: number, description: string, status: "running" | "done"): ChatEntry => ({
  seq,
  rev: seq + 1,
  at: AT,
  kind: "subAgent",
  toolId: `agent-${seq}`,
  description,
  agentType: "Explore",
  background: false,
  status,
  endedAt: status === "done" ? "2099-10-16T10:00:42.000Z" : null,
});

const CONVERSATION: ChatEntry[] = [
  { seq: 0, rev: 1, at: AT, kind: "user", text: "Fix the login 500" },
  { seq: 1, rev: 2, at: AT, kind: "assistant", text: "Looking at **the auth handler** first." },
  {
    seq: 2, rev: 3, at: AT, kind: "tool", toolId: "r1", name: "Read", title: "Read: /repo/src/auth.ts",
    toolKind: "read", status: "done", endedAt: AT,
  },
  subAgent(3, "Explore the session store", "done"),
  {
    seq: 4, rev: 5, at: AT, kind: "plan", toolId: "p1", plan: "# Fix\n- Return 401 on a missing token",
    status: "done", endedAt: AT,
  },
];

function sessionLog(over: Partial<TerminalSessionLog> = {}): TerminalSessionLog {
  return {
    sessionId: "claude-tab-1",
    path: "/Users/e2e/.claude/projects/demo/claude-tab-1.jsonl",
    turnDone: false,
    lastReply: "",
    plan: null,
    planAt: null,
    lastPromptAt: new Date().toISOString(),
    toolCalls: [],
    openTool: null,
    permissionMode: "auto",
    ...over,
  };
}

const header = (page: Page) => page.getByRole("group", { name: "Implementer terminal" });
const viewSwitch = (page: Page) => header(page).getByRole("radiogroup", { name: "Show as" });
// The radio inputs are visually hidden (pointer-events: none); the user clicks
// the option's label, as in every `.segmented` control.
const pickView = (page: Page, name: "Terminal" | "Chat") =>
  viewSwitch(page)
    .locator("label")
    .filter({ has: page.getByRole("radio", { name, exact: true }) })
    .click();
const chatView = (page: Page) => page.getByTestId("terminal-chat-view");
const xterm = (page: Page) => page.locator(".terminal-screen .xterm-rows");

async function openTerminal(app: TauriApp, page: Page, handlers = {}) {
  await app.open({ tabs: [claudeTerminal("tab-1", IMPL)], handlers });
  await app.waitForCall("pty_open", (a) => (a.input as { id: string }).id === "tab-1");
  await expect(xterm(page)).toBeVisible();
}

async function showChat(app: TauriApp, page: Page) {
  await pickView(page, "Chat");
  await app.waitForCall("terminal_chat_watch", (a) => a.tabId === "tab-1");
  await expect(chatView(page)).toBeVisible();
}

test("Chat shows the terminal's conversation; switching back keeps the same PTY", async ({ app, page }) => {
  await openTerminal(app, page);
  await app.ptyOutput("tab-1", "before the switch\r\n");
  await expect(viewSwitch(page).getByRole("radio", { name: "Terminal" })).toBeChecked();

  await showChat(app, page);
  await expect(xterm(page)).toHaveCount(0);
  await expect(chatView(page)).toContainText("No conversation yet");
  expect(await app.chatSet("tab-1", CONVERSATION)).toBe(true);

  const log = chatView(page).getByRole("log", { name: "Conversation" });
  await expect(log).toContainText("Fix the login 500");
  await expect(log.locator("strong", { hasText: "the auth handler" })).toBeVisible();
  await expect(log).toContainText("Read: /repo/src/auth.ts");
  await expect(page.getByTestId("terminal-chat-subagent")).toContainText("Explore the session store");
  await expect(page.getByTestId("terminal-chat-subagent")).toContainText("42s");
  const plan = log.getByRole("region", { name: "Plan" });
  await expect(plan).toContainText("Return 401 on a missing token");
  await expect(plan).toContainText("Approved");
  // The composer replaces the scratch pad.
  await expect(chatView(page).getByRole("textbox", { name: "Message Claude" })).toBeVisible();
  await expect(page.locator(".terminal-scratch")).toHaveCount(0);

  // Output that arrived while the chat view was up is in the terminal when it comes back.
  await app.ptyOutput("tab-1", "while chat was shown\r\n");
  await pickView(page, "Terminal");
  await expect(xterm(page)).toContainText("before the switch");
  await expect(xterm(page)).toContainText("while chat was shown");
  expect(await app.calls("pty_open")).toHaveLength(1);
  expect(await app.calls("pty_kill")).toHaveLength(0);
});

test("the chosen view is kept per tab across tab switches", async ({ app, page }) => {
  await app.open({
    tabs: [claudeTerminal("tab-1", IMPL), roleTab("tab-2", "role_general", "General")],
  });
  await app.waitForCall("pty_open", (a) => (a.input as { id: string }).id === "tab-1");
  await showChat(app, page);
  await app.chatSet("tab-1", CONVERSATION);
  await expect(chatView(page)).toContainText("Fix the login 500");

  await page.getByRole("tab", { name: /^General/ }).click();
  await expect(chatView(page)).toHaveCount(0);
  await page.getByRole("tab", { name: new RegExp(`^${IMPL}`) }).click();
  await expect(chatView(page)).toContainText("Fix the login 500");
  await expect(viewSwitch(page).getByRole("radio", { name: "Chat" })).toBeChecked();
  expect(await app.calls("pty_open")).toHaveLength(1);
});

test("the header counts running sub-agents in either view", async ({ app, page }) => {
  await openTerminal(app, page);
  // The header subscribes on its own, so the count shows in the terminal view too.
  await app.waitForCall("terminal_chat_watch", (a) => a.tabId === "tab-1");
  await app.chatSet("tab-1", [
    { seq: 0, rev: 1, at: AT, kind: "user", text: "Audit the repo" },
    subAgent(1, "Scan the API", "running"),
    subAgent(2, "Scan the UI", "running"),
  ]);
  await expect(header(page)).toContainText("2 sub-agents running", READ);

  await app.chatSet("tab-1", [
    { seq: 0, rev: 1, at: AT, kind: "user", text: "Audit the repo" },
    subAgent(1, "Scan the API", "done"),
    subAgent(2, "Scan the UI", "running"),
  ]);
  await expect(header(page)).toContainText("1 sub-agent running", READ);

  await showChat(app, page);
  const agents = page.getByTestId("terminal-chat-subagent");
  await expect(agents).toHaveCount(2);
  await expect(agents.nth(1)).toContainText("Running");

  await app.chatSet("tab-1", [subAgent(1, "Scan the API", "done"), subAgent(2, "Scan the UI", "done")]);
  await expect(header(page)).not.toContainText("sub-agent", READ);
});

test("Needs you shows a banner that switches back to the terminal", async ({ app, page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __log: unknown }).__log = null;
  });
  await openTerminal(app, page, {
    terminal_session_log: () => (window as unknown as { __log: unknown }).__log,
  });
  await showChat(app, page);
  await app.chatSet("tab-1", [
    { seq: 0, rev: 1, at: AT, kind: "user", text: "Pick a branch" },
    {
      seq: 1, rev: 2, at: AT, kind: "question", toolId: "toolu_q", status: "running", endedAt: null,
      questions: [{ header: "Branch", question: "Which branch?", options: ["main", "dev"], multiSelect: false }],
    },
  ]);
  await expect(chatView(page).getByRole("region", { name: "Question" })).toContainText("Waiting for you in the terminal");

  await page.evaluate((log) => {
    (window as unknown as { __log: unknown }).__log = log;
  }, sessionLog({ openTool: { id: "toolu_q", name: "AskUserQuestion", title: "Which branch?" } }));
  // PTY output makes the poller read the log again.
  await app.ptyOutput("tab-1", "\x1b[2K⏺ Asking…\r\n");

  const banner = chatView(page).getByRole("alert");
  await expect(banner).toContainText("Claude is waiting for you in the terminal", READ);
  await banner.getByRole("button", { name: "Show terminal" }).click();
  await expect(chatView(page)).toHaveCount(0);
  await expect(xterm(page)).toBeVisible();
  await expect(viewSwitch(page).getByRole("radio", { name: "Terminal" })).toBeChecked();
  expect(await app.calls("pty_open")).toHaveLength(1);
});

test("plain terminals have no Chat switch", async ({ app, page }) => {
  await app.open({
    tabs: [
      roleTab("tab-1", "terminal", "Terminal · demo", {
        kind: "terminal",
        terminalLaunch: "shell",
        phase: "terminal",
      }),
    ],
  });
  await app.waitForCall("pty_open");
  await expect(page.getByRole("radiogroup", { name: "Show as" })).toHaveCount(0);
  expect(await app.calls("terminal_chat_watch")).toHaveLength(0);
});

test("the composer types into the same PTY: one paste and Enter", async ({ app, page }) => {
  await openTerminal(app, page);
  await showChat(app, page);
  const field = chatView(page).getByRole("textbox", { name: "Message Claude" });
  await field.fill("Fix the login 500\nand add a test");
  await field.press("ControlOrMeta+Enter");
  const write = await app.waitForCall("pty_write", (a) => String(a.data).includes("add a test"));
  expect(write.args.id).toBe("tab-1");
  expect(write.args.data).toBe("\x1b[200~Fix the login 500\nand add a test\x1b[201~\r");
  await expect(field).toHaveValue("");
});

test("a permission dialog is answered with buttons from the chat view", async ({ app, page }) => {
  await openTerminal(app, page);
  await showChat(app, page);
  await app.ptyOutput(
    "tab-1",
    "Bash command\r\n  touch x\r\nDo you want to proceed?\r\n❯ 1. Yes\r\n  2. Yes, and don't ask again\r\n  3. No\r\n",
  );
  const card = chatView(page).getByRole("region", { name: "Permission" });
  await expect(card).toContainText("Do you want to proceed?", READ);
  await card.getByRole("button", { name: "Yes", exact: true }).click();
  await app.waitForCall("pty_write", (a) => a.id === "tab-1" && a.data === "1");
});

test("New tab with role… opens a draft tab with the role and surface picked", async ({ app, page }) => {
  await openTerminal(app, page);
  await page.keyboard.press("ControlOrMeta+Alt+KeyR");
  const launcher = page.getByRole("dialog", { name: "New tab with role" });
  await expect(launcher).toBeVisible();
  await launcher.getByRole("textbox", { name: "Search roles" }).fill("planner");
  await page.keyboard.press("Tab");
  await expect(launcher.getByRole("radio", { name: "Chat" })).toHaveAttribute("aria-checked", "true");
  await expect(launcher).toContainText("Autopilot needs Terminal");
  await page.keyboard.press("Enter");
  await expect(launcher).toHaveCount(0);
  await app.waitForCall("new_draft_tab");
});
