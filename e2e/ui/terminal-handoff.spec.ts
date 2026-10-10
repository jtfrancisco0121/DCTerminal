import type { Page } from "@playwright/test";
import { expect, roleTab, test } from "./fixtures/tauri";
import { CWD } from "./fixtures/data";

// Role terminals (a role opened as "Terminal") and the terminal hand-off
// capture: newest plan file, xterm selection, or the terminal tail
// (src/handoff/map.ts, fromTerminal branch).

const screen = (page: Page) => page.locator(".terminal-screen .xterm-rows");

const PLAN = "## Plan\n\n1. Add an effort picker\n2. Send it with session/set_config_option\n";

const plannerTerminal = () =>
  roleTab("tab-1", "role_planner", "Planner · Effort controls", {
    kind: "terminal",
    terminalLaunch: "role",
    phase: "terminal",
    startupPromptSent: true,
  });

async function openAsTerminal(page: Page, role: string) {
  await page.getByRole("group", { name: "Role" }).getByRole("button", { name: role, exact: true }).click();
  await page.getByRole("group", { name: "Open as" }).getByRole("button", { name: "Terminal" }).click();
}

test("Planner opened as Terminal: role_terminal_start with the form, then a role terminal", async ({ app, page }) => {
  await app.open();
  await openAsTerminal(page, "Planner");
  const surface = await app.waitForCall("set_terminal_settings");
  expect((surface.args.terminal as { roleSurface: Record<string, string> }).roleSurface).toEqual({
    role_planner: "terminal",
  });
  await expect(page.getByRole("group", { name: "Open as" }).getByRole("button", { name: "Terminal" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("textbox", { name: /^Title/ }).fill("Effort controls");
  await page.getByRole("textbox", { name: /Request \/ Problem/ }).fill("Let users pick reasoning effort");
  await page.getByRole("group", { name: "Start a session" }).getByRole("button", { name: "Start terminal" }).click();

  const start = await app.waitForCall("role_terminal_start");
  expect(start.args.input).toMatchObject({
    roleId: "role_planner",
    tabId: "tab-1",
    handoffPlan: null,
    cols: 80,
    rows: 24,
    windowId: "main",
  });
  expect((start.args.input as { values: Record<string, string> }).values).toMatchObject({
    cwd: CWD,
    title: "Effort controls",
    request: "Let users pick reasoning effort",
  });
  expect(start.args.onOutput).toEqual({ channel: expect.any(Number) });
  // No chat session and no second PTY: the role runs in the terminal.
  expect(await app.calls("role_session_start")).toHaveLength(0);
  expect(await app.calls("pty_open")).toHaveLength(0);

  await expect(page.getByRole("tab", { name: "Planner · Effort controls" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".status-bar-status")).toHaveText("Role terminal");
  await app.ptyOutput("tab-1", "Planning the effort picker…\r\n");
  await expect(screen(page)).toContainText("Planning the effort picker…");
  await expect(page.locator(".terminal-toolbar").getByRole("button", { name: "Send to Plan Reviewer" })).toBeVisible();
});

test("Plan Reviewer opened as Terminal starts a role terminal for that role", async ({ app, page }) => {
  await app.open();
  await openAsTerminal(page, "Plan Reviewer");
  await page.getByRole("textbox", { name: /Original Task/ }).fill("Effort controls");
  await page.getByRole("textbox", { name: /Proposed Implementation Plan/ }).fill(PLAN);
  await page.getByRole("group", { name: "Start a session" }).getByRole("button", { name: "Start terminal" }).click();
  const start = await app.waitForCall("role_terminal_start");
  expect(start.args.input).toMatchObject({ roleId: "role_plan_reviewer", tabId: "tab-1", handoffPlan: null });
  expect((start.args.input as { values: Record<string, string> }).values).toMatchObject({
    cwd: CWD,
    originalTask: "Effort controls",
    plan: PLAN,
  });
  await expect(page.locator(".status-bar-status")).toHaveText("Role terminal");
  await app.ptyOutput("tab-1", "Reviewing\r\n");
  await expect(screen(page)).toContainText("Reviewing");
});

test("restored Planner terminal reopens as a role PTY without re-sending the prompt", async ({ app, page }) => {
  await app.open({ tabs: [plannerTerminal()] });
  const opened = await app.waitForCall("pty_open");
  expect(opened.args.input).toMatchObject({
    id: "tab-1",
    cwd: CWD,
    launch: "role",
    roleId: "role_planner",
    prompt: null,
    resumeSessionId: null,
  });
  await app.ptyOutput("tab-1", "planner is back\r\n");
  await expect(screen(page)).toContainText("planner is back");
});

test("hand-off from a Planner terminal sends the newest plan file", async ({ app, page }) => {
  await app.open({
    tabs: [plannerTerminal()],
    responses: {
      terminal_plan_file: { path: "/Users/e2e/.claude/plans/effort.md", name: "effort.md", modifiedMs: 1, text: PLAN },
    },
  });
  await app.waitForCall("pty_open");
  await app.ptyOutput("tab-1", "Wrote plan to effort.md\r\n");
  await expect(screen(page)).toContainText("Wrote plan to effort.md");

  await page.locator(".terminal-toolbar").getByRole("button", { name: "Send to Plan Reviewer" }).click();
  const read = await app.waitForCall("terminal_plan_file");
  expect(read.args).toEqual({ startedAtMs: expect.any(Number), tabId: "tab-1" });
  const dialog = page.getByRole("dialog", { name: "Send plan" });
  await expect(dialog.getByRole("radio", { name: "Plan Reviewer" })).toBeChecked();
  await expect(dialog.getByRole("radio", { name: "Newest plan file (effort.md)" })).toBeChecked();
  await expect(dialog.getByRole("radio", { name: "Selected text" })).toBeDisabled();
  await expect(dialog.locator(".handoff-preview")).toContainText("1. Add an effort picker");
  await dialog.getByRole("button", { name: "Open Plan Reviewer tab" }).click();
  await expect(dialog).toBeHidden();

  const saved = await app.waitForCall("handoff_save");
  expect(saved.args.input).toMatchObject({
    sourceTabId: "tab-1",
    sourceRoleId: "role_planner",
    targetRoleId: "role_plan_reviewer",
    scope: "plan_file",
    planText: PLAN.trim(),
    cwd: CWD,
  });
  await expect(page.getByRole("tab", { name: "Plan Reviewer" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("textbox", { name: /Proposed Implementation Plan/ })).toHaveValue(PLAN.trim());
  const bound = await app.waitForCall("handoff_bind_tab");
  expect(bound.args).toEqual({ id: "handoff-1", tabId: "tab-2" });
  // A chat hand-off opens a draft: nothing is started.
  expect(await app.calls("role_terminal_start")).toHaveLength(0);
  expect(await app.calls("role_session_start")).toHaveLength(0);
});

test("hand-off from a terminal selection starts a Plan Reviewer terminal with that plan", async ({ app, page }) => {
  await app.open({ tabs: [plannerTerminal()] });
  await app.waitForCall("pty_open");
  await app.ptyOutput("tab-1", "thinking…\r\nStep: add the effort picker\r\nnoise after\r\n");
  const row = screen(page).locator("> div").filter({ hasText: "Step: add the effort picker" });
  await expect(row).toBeVisible();
  // xterm's selection layer sits over the rows: triple-click there selects the line.
  const box = (await row.boundingBox())!;
  await page.mouse.click(box.x + 10, box.y + box.height / 2, { clickCount: 3 });

  await page.locator(".terminal-toolbar").getByRole("button", { name: "Send to Plan Reviewer" }).click();
  const dialog = page.getByRole("dialog", { name: "Send plan" });
  // No plan file since the terminal started, so the selection is the default.
  await expect(dialog.getByRole("radio", { name: "Newest plan file" })).toBeDisabled();
  await expect(dialog.getByRole("radio", { name: "Selected text" })).toBeChecked();
  await expect(dialog.locator(".handoff-preview")).toHaveText("Step: add the effort picker");
  await dialog.getByRole("radio", { name: "Terminal" }).check();
  await dialog.getByRole("button", { name: "Start Plan Reviewer terminal" }).click();
  await expect(dialog).toBeHidden();

  const start = await app.waitForCall("role_terminal_start");
  expect(start.args.input).toMatchObject({
    roleId: "role_plan_reviewer",
    tabId: null,
    handoffPlan: "Step: add the effort picker",
  });
  expect((start.args.input as { values: Record<string, string> }).values).toMatchObject({
    cwd: CWD,
    plan: "Step: add the effort picker",
  });
  const saved = await app.waitForCall("handoff_save");
  expect(saved.args.input).toMatchObject({ scope: "selection", planText: "Step: add the effort picker" });
  const bound = await app.waitForCall("handoff_bind_tab");
  expect(bound.args).toEqual({ id: "handoff-1", tabId: "tab-2" });
  await expect(page.getByRole("tab", { name: /^Plan Reviewer/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".status-bar-status")).toHaveText("Role terminal");
  await app.ptyOutput("tab-2", "Reviewer got the plan\r\n");
  await expect(screen(page)).toContainText("Reviewer got the plan");
});

test("hand-off falls back to the terminal tail, stripped of ANSI codes", async ({ app, page }) => {
  await app.open({ tabs: [plannerTerminal()] });
  await app.waitForCall("pty_open");
  await app.ptyOutput("tab-1", "\x1b[1m## Plan\x1b[0m\r\n\x1b[32m1. Ship the picker\x1b[0m\r\n");
  await expect(screen(page)).toContainText("1. Ship the picker");

  // The terminal's context menu offers the same hand-off.
  await page.locator(".terminal-screen .terminal-slot").click({ button: "right" });
  await page.getByRole("menu").getByRole("menuitem", { name: "Send to Plan Reviewer" }).click();
  const dialog = page.getByRole("dialog", { name: "Send plan" });
  await expect(dialog.getByRole("radio", { name: "Last 200 lines" })).toBeChecked();
  await expect(dialog.getByRole("radio", { name: "Selected text" })).toBeDisabled();
  await expect(dialog.locator(".handoff-preview")).toHaveText("## Plan\n1. Ship the picker");
  await dialog.getByRole("button", { name: "Open Plan Reviewer tab" }).click();

  const saved = await app.waitForCall("handoff_save");
  expect(saved.args.input).toMatchObject({ scope: "terminal_tail", planText: "## Plan\n1. Ship the picker" });
  expect(String((saved.args.input as { planText: string }).planText)).not.toContain("\x1b");
  await expect(page.getByRole("textbox", { name: /Proposed Implementation Plan/ })).toHaveValue(
    "## Plan\n1. Ship the picker",
  );
});

test("an empty Planner terminal has no plan to send", async ({ app, page }) => {
  await app.open({ tabs: [plannerTerminal()] });
  await app.waitForCall("pty_open");
  await page.locator(".terminal-toolbar").getByRole("button", { name: "Send to Plan Reviewer" }).click();
  const dialog = page.getByRole("dialog", { name: "Send plan" });
  await expect(dialog.getByText("There is no plan to send yet.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Open Plan Reviewer tab" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  expect(await app.calls("handoff_save")).toHaveLength(0);
});
