import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import type { TerminalSessionLog } from "../../src/bridge";
import type { ChainRef } from "../../src/handoff/chains";
import { expect, roleTab, test, type TauriApp } from "./fixtures/tauri";

// Claude Code role terminals: one derived state (exited → needs you →
// working → idle, src/terminal/claudeState.ts) on the tab chip, status bar,
// grid cells, hand-off loop-back and toasts. Inputs are the tab's Claude
// session log (`terminal_session_log`, polled per src/terminal/sessionLogPoll.ts)
// and the PTY permission-dialog detector (src/terminal/permissionDialog.ts).

// Log reads are polled (every 3 s while output streams, then quiet reads), so
// state changes that wait on a read get a longer budget.
test.describe.configure({ timeout: 45_000 });
const READ = { timeout: 10_000 };

type OpenTool = { id: string; name: string; title: string };

const claudeTerminal = (id: string, roleId: string, label: string, extra = {}) =>
  roleTab(id, roleId, label, {
    kind: "terminal",
    terminalLaunch: "role",
    phase: "terminal",
    startupPromptSent: true,
    provider: "claude",
    permissionMode: roleId === "role_planner" ? "plan" : "auto",
    ...extra,
  });

/** A session log mid-turn; `over` sets what the step needs. */
function sessionLog(over: Partial<TerminalSessionLog> = {}): TerminalSessionLog {
  return {
    sessionId: "claude-sess-1",
    path: "/Users/e2e/.claude/projects/demo/claude-sess-1.jsonl",
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

/**
 * Records every toast and every tab chip `data-status` change, so a test can
 * count notifications and prove a chip never flickered between redraws.
 * `terminal_session_log` answers from `window.__logs[tabId]`.
 */
async function openWithLogs(
  app: TauriApp,
  page: Page,
  options: Parameters<TauriApp["open"]>[0] & { logs?: Record<string, TerminalSessionLog> },
) {
  await page.addInitScript((logs) => {
    const w = window as unknown as {
      __logs: Record<string, unknown>;
      __toasts: { title: string; body: string }[];
      __chipHistory: Record<string, string[]>;
    };
    w.__logs = logs;
    w.__toasts = [];
    w.__chipHistory = {};
    const seen = new WeakSet<Element>();
    const scan = () => {
      for (const el of document.querySelectorAll(".agent-toast")) {
        if (seen.has(el)) continue;
        seen.add(el);
        w.__toasts.push({
          title: el.querySelector(".agent-toast-title")?.textContent ?? "",
          body: el.querySelector(".agent-toast-text")?.textContent ?? "",
        });
      }
      for (const el of document.querySelectorAll(".tab-chip[data-status]")) {
        const label = el.querySelector(".tab-chip-text")?.textContent ?? "";
        const status = el.getAttribute("data-status") ?? "";
        const history = (w.__chipHistory[label] ??= []);
        if (history.at(-1) !== status) history.push(status);
      }
    };
    new MutationObserver(scan).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-status"],
    });
  }, options.logs ?? {});
  const { logs: _logs, ...rest } = options;
  await app.open({
    ...rest,
    responses: {
      get_notification_settings: { enabled: true, system: false, toastWhenFocused: true },
      ...rest.responses,
    },
    handlers: {
      terminal_session_log: (args) =>
        (window as unknown as { __logs: Record<string, unknown> }).__logs[args.tabId] ?? null,
      ...rest.handlers,
    },
  });
}

async function setLog(page: Page, tabId: string, log: TerminalSessionLog | null) {
  await page.evaluate(
    ([id, value]) => {
      (window as unknown as { __logs: Record<string, unknown> }).__logs[id as string] = value;
    },
    [tabId, log] as const,
  );
}

const toasts = (page: Page) =>
  page.evaluate(() => (window as unknown as { __toasts: { title: string; body: string }[] }).__toasts);
const chipHistory = (page: Page, label: string) =>
  page.evaluate(
    (l) => (window as unknown as { __chipHistory: Record<string, string[]> }).__chipHistory[l] ?? [],
    label,
  );

const chip = (page: Page, label: string) =>
  page.locator(".tab-chip").filter({ has: page.locator(".tab-chip-text", { hasText: new RegExp(`^${label}$`) }) });

async function expectChip(page: Page, label: string, status: string, text: string, opts = READ) {
  await expect(chip(page, label)).toHaveAttribute("data-status", status, opts);
  if (text) await expect(chip(page, label).locator(".sr-only")).toHaveText(`, ${text}`);
  else await expect(chip(page, label).locator(".sr-only")).toHaveCount(0);
}

/** Opens `active` (a Claude role terminal), waits for its PTY, then moves to `background`. */
async function sendToBackground(app: TauriApp, page: Page, id: string, background: string) {
  await app.waitForCall("pty_open", (a) => (a.input as { id: string }).id === id);
  await page.getByRole("tab", { name: new RegExp(`^${background}`) }).click();
  await expect(page.getByRole("tab", { name: new RegExp(`^${background}`) })).toHaveAttribute("aria-selected", "true");
}

/** PTY output so the log poller reads again (a quiet, finished tab is not re-read). */
const nudge = (app: TauriApp, id: string, text = "\x1b[2K⏺ Running…\r\n") => app.ptyOutput(id, text);

const IMPL = "Implementer · Login 500";
const twoTabs = () => [claudeTerminal("tab-1", "role_implementer", IMPL), roleTab("tab-2", "role_general", "General")];

// ---- permission dialogs as Claude Code draws them --------------------------
const OPTIONS = (second: string) =>
  `\x1b[38;5;153m❯\x1b[39m \x1b[38;5;153m1. Yes\x1b[39m\r\n` +
  `  2. ${second}\r\n` +
  `  3. No, and tell Claude what to do differently \x1b[2m(esc)\x1b[22m\r\n`;
const box = (body: string) => `\x1b[H\x1b[J\x1b[38;5;244m╭──────────────────╮\x1b[39m\r\n${body}\x1b[38;5;244m╰──────────────────╯\x1b[39m\r\n`;

const DIALOGS: { name: string; tool: OpenTool; screen: string }[] = [
  {
    name: "Bash: Do you want to proceed?",
    tool: { id: "toolu_bash", name: "Bash", title: "Bash: npm test" },
    screen: box(
      `\x1b[1mBash command\x1b[22m\r\n\r\n  npm test\r\n  \x1b[2mRun the unit tests\x1b[22m\r\n\r\n` +
        `Do you want to proceed?\r\n${OPTIONS("Yes, and don't ask again for npm test commands in /Users/e2e/Projects/demo")}`,
    ),
  },
  {
    name: "Edit: Do you want to make this edit to <file>?",
    tool: { id: "toolu_edit", name: "Edit", title: "Edit: src/auth.ts" },
    screen: box(
      `\x1b[1mEdit file\x1b[22m\r\n\x1b[32m+ return res.status(401)\x1b[39m\r\n` +
        `Do you want to make this edit to \x1b[1mauth.ts\x1b[22m?\r\n${OPTIONS("Yes, allow all edits during this session (shift+tab)")}`,
    ),
  },
  {
    name: "WebFetch: Do you want to allow Claude to fetch this content?",
    tool: { id: "toolu_fetch", name: "WebFetch", title: "WebFetch: https://docs.example.com" },
    screen: box(
      `\x1b[1mFetch\x1b[22m\r\n  https://docs.example.com\r\n` +
        `Do you want to allow Claude to fetch this content?\r\n${OPTIONS("Yes, and don't ask again for docs.example.com")}`,
    ),
  },
  {
    name: "network: Do you want to allow this connection?",
    tool: { id: "toolu_net", name: "Bash", title: "Bash: curl https://api.example.com" },
    screen: box(
      `\x1b[1mNetwork request outside of sandbox\x1b[22m\r\n  Host: api.example.com\r\n` +
        `Do you want to allow this connection?\r\n${OPTIONS("Yes, and don't ask again for api.example.com")}`,
    ),
  },
];

// ---- 1, 2: plan and question ------------------------------------------------

test("ExitPlanMode open in a background terminal: needs you for a plan, one toast", async ({ app, page }) => {
  const label = "Planner · Login 500";
  await openWithLogs(app, page, {
    tabs: [claudeTerminal("tab-1", "role_planner", label), roleTab("tab-2", "role_general", "General")],
  });
  await sendToBackground(app, page, "tab-1", "General");
  await setLog(
    page,
    "tab-1",
    sessionLog({ openTool: { id: "toolu_plan", name: "ExitPlanMode", title: "ExitPlanMode" }, permissionMode: "plan" }),
  );
  await nudge(app, "tab-1");

  await expectChip(page, label, "needs", "Needs you: plan to review");
  await expect(chip(page, label)).toHaveClass(/tab-chip-needs/);
  await expect(page.locator(".status-bar-message-warn")).toHaveText(`${label}: Needs you: plan to review`);
  const toast = page.getByRole("alert").filter({ hasText: `${label} has a plan to review` });
  await expect(toast).toBeVisible();
  await expect(toast).toContainText("Open the tab to accept or reject the plan.");

  // More reads and more output: still one toast for this prompt.
  await nudge(app, "tab-1");
  await expect.poll(async () => (await app.calls("terminal_session_log")).length, READ).toBeGreaterThan(3);
  expect((await toasts(page)).filter((t) => t.title.includes("plan to review"))).toHaveLength(1);
});

test("AskUserQuestion open in a background terminal: needs you for a question", async ({ app, page }) => {
  await openWithLogs(app, page, { tabs: twoTabs() });
  await sendToBackground(app, page, "tab-1", "General");
  await setLog(page, "tab-1", sessionLog({ openTool: { id: "toolu_q", name: "AskUserQuestion", title: "Which branch?" } }));
  await nudge(app, "tab-1");

  await expectChip(page, IMPL, "needs", "Needs you: agent asked a question");
  const toast = page.getByRole("alert").filter({ hasText: `${IMPL} has a question` });
  await expect(toast).toContainText("Claude Code has a question for you");
  expect(await toasts(page)).toHaveLength(1);
});

// ---- 3: the four permission dialogs -----------------------------------------

for (const dialog of DIALOGS) {
  test(`permission dialog (${dialog.name}): needs you, steady across redraws, one toast`, async ({ app, page }) => {
    await openWithLogs(app, page, { tabs: twoTabs() });
    await sendToBackground(app, page, "tab-1", "General");
    await setLog(page, "tab-1", sessionLog({ openTool: dialog.tool }));
    await nudge(app, "tab-1");
    // The open tool alone is "working": no dialog on screen yet.
    await expectChip(page, IMPL, "busy", "Working");

    await app.ptyOutput("tab-1", dialog.screen);
    await expectChip(page, IMPL, "needs", "Needs you: permission request");
    const toast = page.getByRole("alert").filter({ hasText: `${IMPL} needs permission` });
    await expect(toast).toContainText(`Claude Code needs your permission: ${dialog.tool.title}`);

    // Claude Code redraws the dialog (spinner ticks, resize, arrow keys).
    for (let i = 0; i < 4; i++) {
      await app.ptyOutput("tab-1", i % 2 ? dialog.screen : `\x1b[3A\r\x1b[2K${OPTIONS("Yes, and don't ask again")}`);
      await expect(chip(page, IMPL)).toHaveAttribute("data-status", "needs");
      await page.waitForTimeout(250);
    }
    await expect(chip(page, IMPL)).toHaveAttribute("data-status", "needs");
    const history = await chipHistory(page, IMPL);
    expect(history.slice(history.indexOf("needs"))).toEqual(["needs"]);
    expect((await toasts(page)).filter((t) => t.title.endsWith("needs permission"))).toHaveLength(1);
    expect(await toasts(page)).toHaveLength(1);
  });
}

test("a real Claude Code 2.1.287 capture (Bash proceed) reads as a permission request", async ({ app, page }) => {
  const capture = new Uint8Array(
    readFileSync(new URL("../../src/terminal/fixtures/claude-2.1.287-proceed.bin", import.meta.url)),
  );
  await openWithLogs(app, page, { tabs: twoTabs() });
  await sendToBackground(app, page, "tab-1", "General");
  await setLog(page, "tab-1", sessionLog({ openTool: { id: "toolu_touch", name: "Bash", title: "Bash: touch captured.txt" } }));
  // Fed in uneven packets, like the PTY reader delivers them.
  for (let i = 0; i < capture.length; i += 777) await app.ptyBytes("tab-1", capture.subarray(i, i + 777));

  await expectChip(page, IMPL, "needs", "Needs you: permission request");
  await expect(page.getByRole("alert").filter({ hasText: `${IMPL} needs permission` })).toContainText(
    "Claude Code needs your permission: Bash: touch captured.txt",
  );
});

// ---- 4, 5: no false "needs you" ---------------------------------------------

test("'Do you want to' without the numbered options is not a dialog: still working", async ({ app, page }) => {
  await openWithLogs(app, page, { tabs: twoTabs() });
  await sendToBackground(app, page, "tab-1", "General");
  await setLog(page, "tab-1", sessionLog({ openTool: { id: "toolu_bash", name: "Bash", title: "Bash: npm test" } }));
  await app.ptyOutput("tab-1", "⏺ \x1b[1mDo you want to\x1b[22m keep the old login handler? I'll check the callers first.\r\n");
  await expectChip(page, IMPL, "busy", "Working");
  await app.ptyOutput("tab-1", "Do you want to proceed?\r\n  Running npm test…\r\n");
  await page.waitForTimeout(1500);
  await expectChip(page, IMPL, "busy", "Working");
  expect(await chipHistory(page, IMPL)).not.toContain("needs");
  expect(await toasts(page)).toEqual([]);
});

test("a quiet long-running tool with no dialog stays working, never needs you", async ({ app, page }) => {
  await openWithLogs(app, page, { tabs: twoTabs() });
  await sendToBackground(app, page, "tab-1", "General");
  await setLog(page, "tab-1", sessionLog({ openTool: { id: "toolu_long", name: "Bash", title: "Bash: cargo test" } }));
  await nudge(app, "tab-1", "⏺ Bash(cargo test)\r\n  ⎿  Running…\r\n");
  await expectChip(page, IMPL, "busy", "Working");

  // No output for well over the 3 s quiet window; quiet log reads keep coming.
  const reads = (await app.calls("terminal_session_log")).length;
  await page.waitForTimeout(5000);
  expect((await app.calls("terminal_session_log")).length).toBeGreaterThan(reads);
  await expectChip(page, IMPL, "busy", "Working");
  expect(await chipHistory(page, IMPL)).not.toContain("needs");
  expect(await toasts(page)).toEqual([]);
});

// ---- 6: answered and rejected -----------------------------------------------

test("answering or rejecting the dialog clears needs you back to working", async ({ app, page }) => {
  await openWithLogs(app, page, { tabs: twoTabs() });
  await sendToBackground(app, page, "tab-1", "General");
  const [bash, edit] = DIALOGS;
  await setLog(page, "tab-1", sessionLog({ openTool: bash.tool }));
  await nudge(app, "tab-1");
  await expectChip(page, IMPL, "busy", "Working");
  await app.ptyOutput("tab-1", bash.screen);
  await expectChip(page, IMPL, "needs", "Needs you: permission request");

  // Open the tab and answer "1" (Yes): the tool runs, its result lands in the log.
  await page.getByRole("tab", { name: new RegExp(`^${IMPL}`) }).click();
  await expect(page.locator(".status-bar-status")).toHaveText("Needs you: permission request");
  await expect(page.locator(".status-bar-status")).toHaveClass(/status-tone-needs/);
  await expect(page.getByRole("textbox", { name: "Terminal input" })).toBeFocused();
  await page.keyboard.press("1");
  await setLog(page, "tab-1", sessionLog({ openTool: null }));
  await page.waitForTimeout(600);
  await nudge(app, "tab-1", "⏺ Bash(npm test)\r\n  ⎿  42 passing\r\n");
  await expectChip(page, IMPL, "busy", "Working");
  await expect(page.locator(".status-bar-status")).toHaveText("Role terminal · working");

  // A second prompt, rejected with Esc: working again.
  await setLog(page, "tab-1", sessionLog({ openTool: edit.tool }));
  await nudge(app, "tab-1");
  await page.waitForTimeout(3500);
  await app.ptyOutput("tab-1", edit.screen);
  await expectChip(page, IMPL, "needs", "Needs you: permission request");
  await page.keyboard.press("Escape");
  await setLog(page, "tab-1", sessionLog({ openTool: null, lastReply: "Okay, I won't edit auth.ts." }));
  await page.waitForTimeout(600);
  await nudge(app, "tab-1", "⎿  User rejected the edit\r\n");
  await expectChip(page, IMPL, "busy", "Working");
  // One toast, from while the tab was in the background; the second prompt was on screen.
  expect(await toasts(page)).toEqual([
    { title: `${IMPL} needs permission`, body: "Claude Code needs your permission: Bash: npm test" },
  ]);
});

// ---- 7, 9: finished ----------------------------------------------------------

test("a background terminal whose turn ends: unseen dot and a toast with the last reply line", async ({ app, page }) => {
  await openWithLogs(app, page, { tabs: twoTabs() });
  await sendToBackground(app, page, "tab-1", "General");
  const promptAt = new Date().toISOString();
  await setLog(page, "tab-1", sessionLog({ lastPromptAt: promptAt }));
  await nudge(app, "tab-1");
  await expectChip(page, IMPL, "busy", "Working");

  await setLog(
    page,
    "tab-1",
    sessionLog({ lastPromptAt: promptAt, turnDone: true, lastReply: "Fixed the 500.\n\nOpened PR #42.\n" }),
  );
  await expectChip(page, IMPL, "unseen", "Finished, not viewed yet");
  await expect(chip(page, IMPL).locator(".tab-unseen-dot")).toBeVisible();
  const toast = page.getByRole("status").filter({ hasText: `${IMPL} finished` });
  await expect(toast).toContainText("Opened PR #42.");
  expect((await toasts(page)).filter((t) => t.title === `${IMPL} finished`)).toHaveLength(1);
});

test("a reviewer terminal's finished toast carries its verdict", async ({ app, page }) => {
  const label = "PR Reviewer · Login 500";
  await openWithLogs(app, page, {
    tabs: [claudeTerminal("tab-1", "role_pr_reviewer", label), roleTab("tab-2", "role_general", "General")],
  });
  await sendToBackground(app, page, "tab-1", "General");
  const promptAt = new Date().toISOString();
  await setLog(page, "tab-1", sessionLog({ lastPromptAt: promptAt }));
  await nudge(app, "tab-1");
  await expectChip(page, label, "busy", "Working");
  await setLog(
    page,
    "tab-1",
    sessionLog({
      lastPromptAt: promptAt,
      turnDone: true,
      lastReply: "## Review\n\nLooks good.\n\nVerdict: APPROVED\n\nThanks for the tests.",
    }),
  );
  await expect(page.getByRole("status").filter({ hasText: `${label} finished` })).toContainText(
    "Verdict: APPROVED",
    READ,
  );
  await expectChip(page, label, "unseen", "Finished, not viewed yet");
});

test("off screen, not in a chain: a first turn already done at the first log read still reports finished", async ({
  app,
  page,
}) => {
  await openWithLogs(app, page, { tabs: twoTabs() });
  await sendToBackground(app, page, "tab-1", "General");
  // No log until now (the session file did not exist); the first one is already done.
  await setLog(
    page,
    "tab-1",
    sessionLog({ lastPromptAt: new Date().toISOString(), turnDone: true, lastReply: "Done: tokens expire cleanly." }),
  );
  await nudge(app, "tab-1");
  await expect(page.getByRole("status").filter({ hasText: `${IMPL} finished` })).toContainText(
    "Done: tokens expire cleanly.",
    READ,
  );
  await expectChip(page, IMPL, "unseen", "Finished, not viewed yet");
  await expect(chip(page, IMPL).locator(".tab-unseen-dot")).toBeVisible();
});

// ---- 8: exited --------------------------------------------------------------

test("a Claude terminal that exits: Exited · code 1, error toast, no finished toast", async ({ app, page }) => {
  await openWithLogs(app, page, { tabs: twoTabs() });
  await app.waitForCall("pty_open", (a) => (a.input as { id: string }).id === "tab-1");
  // The user typed and the CLI printed output: that alone is never "finished".
  await expect(page.getByRole("textbox", { name: "Terminal input" })).toBeFocused();
  await page.keyboard.type("fix the login\r");
  await page.waitForTimeout(600);
  await app.ptyOutput("tab-1", "⏺ Working on it…\r\n");
  await page.getByRole("tab", { name: /^General/ }).click();
  await page.waitForTimeout(3500);

  await app.ptyExit("tab-1", 1);
  await expectChip(page, IMPL, "exited", "Exited · code 1");
  await expect(chip(page, IMPL)).toHaveClass(/tab-chip-error/);
  const toast = page.getByRole("alert").filter({ hasText: `${IMPL} stopped with an error` });
  await expect(toast).toContainText("Claude Code exited (code 1).");

  await page.getByRole("tab", { name: new RegExp(`^${IMPL}`) }).click();
  await expect(page.locator(".status-bar-status")).toHaveText("Exited · code 1");
  await expect(page.locator(".status-bar-status")).toHaveClass(/status-tone-error/);
  await page.waitForTimeout(1500);
  const titles = (await toasts(page)).map((t) => t.title);
  expect(titles).toEqual([`${IMPL} stopped with an error`]);
});

// ---- 10: grid ---------------------------------------------------------------

test("grid: four Claude terminals in four states", async ({ app, page }) => {
  const labels = ["Alpha", "Bravo", "Charlie", "Delta"];
  const promptAt = new Date().toISOString();
  await openWithLogs(app, page, {
    tabs: labels.map((label, i) => claudeTerminal(`tab-${i + 1}`, "role_implementer", label)),
    logs: {
      "tab-1": sessionLog({ lastPromptAt: promptAt, turnDone: true, lastReply: "All done." }),
      "tab-2": sessionLog({ openTool: DIALOGS[0].tool }),
      "tab-3": sessionLog({ openTool: { id: "toolu_long", name: "Bash", title: "Bash: cargo build" } }),
      "tab-4": sessionLog(),
    },
  });
  await app.waitForCall("pty_open", (a) => (a.input as { id: string }).id === "tab-1");
  await page.getByRole("button", { name: "Grid view" }).click();
  for (const id of ["tab-2", "tab-3", "tab-4"]) {
    await app.waitForCall("pty_open", (a) => (a.input as { id: string }).id === id);
  }
  await app.ptyOutput("tab-2", DIALOGS[0].screen);
  await app.ptyExit("tab-4", 1);

  const cell = (label: string) => page.getByLabel(`Grid cell: ${label}`);
  await expect(page.locator('[data-pane="primary"]')).toHaveClass(/grid-cell-idle/, READ);
  await expect(cell("Bravo")).toHaveClass(/grid-cell-needs/, READ);
  await expect(cell("Bravo").locator(".grid-cell-status")).toHaveText("Needs you: permission request");
  await expect(cell("Charlie")).toHaveClass(/grid-cell-busy/, READ);
  await expect(cell("Charlie").locator(".grid-cell-status")).toHaveText("Working");
  await expect(cell("Delta")).toHaveClass(/grid-cell-error/);
  await expect(cell("Delta").locator(".grid-cell-status")).toHaveText("Exited · code 1");
  await expectChip(page, "Alpha", "idle", "");
});

// ---- 11: hand-off loop-back ---------------------------------------------------

test("send back is blocked while the chain's Planner terminal waits on its plan", async ({ app, page }) => {
  const CHAIN = "ee_1700000000000";
  const chain = (step: number): ChainRef => ({ chainId: CHAIN, kind: "eagle1", step, total: 4 });
  const planner = "Planner · Login 500";
  await openWithLogs(app, page, {
    tabs: [
      claudeTerminal("tab-1", "role_planner", planner, { chain: chain(1) }),
      claudeTerminal("tab-2", "role_plan_reviewer", "Plan Reviewer", { chain: chain(2) }),
    ],
    activeTabId: "tab-1",
    logs: {
      "tab-1": sessionLog({ openTool: { id: "toolu_plan", name: "ExitPlanMode", title: "ExitPlanMode" } }),
    },
  });
  await app.waitForCall("pty_open", (a) => (a.input as { id: string }).id === "tab-1");
  await app.ptyOutput("tab-1", "\x1b[?2004hPlanner ready\r\n");
  await page.getByRole("tab", { name: /^Plan Reviewer/ }).click();
  await app.waitForCall("pty_open", (a) => (a.input as { id: string }).id === "tab-2");
  await expectChip(page, planner, "needs", "Needs you: plan to review");

  await app.ptyOutput("tab-2", "Add a regression test.\r\nVerdict: REQUIRES REVISION\r\n");
  await expect(page.locator(".terminal-screen .xterm-rows")).toContainText("REQUIRES REVISION");
  await page.locator(".terminal-toolbar .handoff-actions").hover();
  await page.locator(".terminal-toolbar").getByRole("button", { name: "Send back to Planner" }).click();
  const dialog = page.getByRole("dialog", { name: "Send back to Planner" });
  await expect(
    dialog.getByText(`The ${planner} tab is waiting for you on a plan to review. Answer it in that tab, then send.`),
  ).toBeVisible();
  await expect(dialog.getByText(/still working/)).toHaveCount(0);
});

// ---- 12: permission mode ------------------------------------------------------

test("status bar shows the role terminal's permission mode: auto, and plan for the Planner", async ({ app, page }) => {
  await openWithLogs(app, page, {
    tabs: [
      claudeTerminal("tab-1", "role_implementer", IMPL),
      claudeTerminal("tab-2", "role_planner", "Planner · Login 500"),
    ],
  });
  await app.waitForCall("pty_open", (a) => (a.input as { id: string }).id === "tab-1");
  const mode = page.getByTestId("status-permissions");
  await expect(mode).toHaveText("Mode: auto");
  await expect(mode).toHaveAttribute("title", /--permission-mode auto/);
  await page.getByRole("tab", { name: /^Planner/ }).click();
  await expect(mode).toHaveText("Mode: plan");
  await expect(mode).toHaveAttribute("title", /--permission-mode plan/);
});
