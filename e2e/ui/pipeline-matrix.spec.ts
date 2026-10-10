import type { Page } from "@playwright/test";
import type { Role } from "../../src/bridge";
import { CWD } from "./fixtures/data";
import { expect, roleTab, test } from "./fixtures/tauri";

// The hand-off matrix through the UI: what the dialog says it fills, and what
// the target form or role_terminal_start gets. The full table of combinations
// is src/handoff/matrix.test.ts.

const PLANNER_BUG = {
  taskType: "Bug",
  title: "Login 500",
  request: "Expired tokens return 500 instead of 401.",
  expectedBehavior: "The API returns 401 with a refresh hint.",
  currentBehavior: "The handler panics on an expired token.",
  additionalContext: "Auth lives in src/auth/middleware.ts.",
};

const PLAN = [
  "## Fix expired-token handling",
  "",
  "| Step | File |",
  "|---|---|",
  "| 1 | middleware.ts |",
  "",
  "```bash",
  "# run the auth tests",
  "npm test -- auth",
  "```",
  "",
  "1. Catch TokenExpired in the middleware",
  "2. Add the regression test",
].join("\n");

const dialogFor = (page: Page, name = "Send plan") => page.getByRole("dialog", { name });
const fills = (page: Page, name = "Send plan") => dialogFor(page, name).getByRole("group", { name: "Filled from the hand-off" });

/** Planner may also hand off to a custom role whose form has a required select. */
const withOddForm = (roles: Role[]): Role[] => [
  ...roles.map((role) =>
    role.id === "role_planner"
      ? { ...role, handoffTargets: ["role_plan_reviewer", "role_implementer", "role_developer", "role_custom_odd"] }
      : role,
  ),
  {
    ...roles.find((role) => role.id === "role_implementer")!,
    id: "role_custom_odd",
    name: "Odd Form",
    isBuiltIn: false,
    templateText: "Ask:\n{{ask_md}}\n\nSteps:\n{{steps_v2}}\n\nPriority: {{prio}}",
    fields: [
      { key: "ask_md", label: "What was asked", type: "multiline", required: true },
      { key: "steps_v2", label: "The plan (markdown)", type: "multiline", required: true },
      { key: "prio", label: "Priority", type: "select", required: true, options: ["P1", "P2"] },
    ],
  },
];

test("Planner (Cursor) → Implementer terminal: every field filled, plan sent once, provider kept", async ({
  app,
  page,
}) => {
  await app.open({
    tabs: [roleTab("tab-1", "role_planner", "Planner", { provider: "cursor" })],
    answers: { "tab-1": PLANNER_BUG },
  });
  const turn = await app.start("tab-1");
  await turn.reply(`\r\n${PLAN.replace(/\n/g, "\r\n")}\r\n`);
  await expect(page.locator(".status-bar-status")).toHaveText("Ready");

  await page.getByRole("button", { name: "Send to Implementer" }).first().click();
  const dialog = dialogFor(page);
  await expect(dialog.getByRole("radio", { name: "Whole latest plan message" })).toBeEnabled();
  await dialog.getByRole("radio", { name: "Whole latest plan message" }).check();
  await expect(fills(page)).toContainText(
    "Fills: Task Type, Title, Description, Approved Implementation Plan, Additional Context",
  );
  await dialog.getByRole("radio", { name: "Terminal" }).check();
  await dialog.getByRole("button", { name: "Start Implementer terminal" }).click();
  await expect(dialog).toBeHidden();

  const start = await app.waitForCall("role_terminal_start");
  const input = start.args.input as { values: Record<string, string>; handoffPlan: string };
  expect(input.values).toEqual({
    cwd: CWD,
    taskType: "Bug Fix",
    title: "Login 500",
    // The task as asked; Title and Task Type have their own fields.
    description: [
      PLANNER_BUG.request,
      `Expected behavior:\n${PLANNER_BUG.expectedBehavior}`,
      `Current behavior:\n${PLANNER_BUG.currentBehavior}`,
    ].join("\n\n"),
    approvedPlan: PLAN,
    additionalContext: PLANNER_BUG.additionalContext,
  });
  // The plan field holds it, so the terminal prompt does not add it a second time.
  expect(input.handoffPlan).toBe(PLAN);
  const provider = await app.waitForCall("set_tab_provider", (args) => args.provider === "cursor");
  expect(provider.args.tabId).toBe("tab-2");
  // Nothing was started for the user beyond the terminal they asked for.
  expect(await app.calls("role_session_start")).toHaveLength(1);
});

test("Planner → custom role with a required select: named in the dialog, terminal refused", async ({
  app,
  page,
}) => {
  await app.open({
    tabs: [roleTab("tab-1", "role_planner", "Planner")],
    roles: withOddForm,
    answers: { "tab-1": PLANNER_BUG },
  });
  const turn = await app.start("tab-1");
  await turn.reply(PLAN);
  await expect(page.locator(".status-bar-status")).toHaveText("Ready");

  await page.getByRole("button", { name: "Send to Odd Form" }).first().click();
  const dialog = dialogFor(page);
  await expect(fills(page)).toContainText("Fills: What was asked, The plan (markdown)");
  await expect(fills(page)).toContainText("Left empty: Priority (required)");
  await expect(dialog.getByRole("note", { name: "Fields to fill in" })).toHaveText(
    "The Odd Form tab opens with Priority empty. Fill it in before Start.",
  );

  await dialog.getByRole("radio", { name: "Terminal" }).check();
  await expect(fills(page)).toContainText("A terminal starts right away, so fill Priority first");
  await dialog.getByRole("button", { name: "Start Odd Form terminal" }).click();
  await expect(dialog.locator(".error")).toHaveText(
    "The Odd Form terminal cannot start: Priority is required. Open it as Chat to fill these in.",
  );
  expect(await app.calls("role_terminal_start")).toHaveLength(0);
  expect(await app.calls("handoff_save")).toHaveLength(0);

  // As a chat tab the form opens filled, for the user to pick the priority.
  await dialog.getByRole("radio", { name: "Chat" }).check();
  await dialog.getByRole("button", { name: "Open Odd Form tab" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("textbox", { name: /What was asked/ })).toHaveValue(
    // No context field on this form: the behaviors travel with the request.
    /^Expired tokens return 500 instead of 401\.\n\nExpected behavior:\nThe API returns 401/,
  );
  await expect(page.getByRole("textbox", { name: /The plan \(markdown\)/ })).toHaveValue(PLAN);
  const saved = await app.waitForCall("handoff_save");
  expect(saved.args.input).toMatchObject({ planField: "steps_v2", targetRoleId: "role_custom_odd" });
});

const FINDING = [
  "## [HIGH] Token leak",
  "",
  "### Category",
  "Security",
  "",
  "### Location",
  "src/auth/token.rs:42",
  "",
  "### Problem",
  "Refresh tokens are written to the log.",
  "",
  "### Recommended Direction",
  "Redact tokens before logging.",
].join("\n");

const AUDIT = [
  "# Codebase Audit",
  "",
  FINDING,
  "",
  "## [LOW] Flaky auth test",
  "",
  "### Category",
  "Testing",
  "",
  "### Problem",
  "The expiry test depends on the clock.",
].join("\n");

test("Codebase Audit finding → Planner: Bug from its Category, behaviors in their own fields", async ({
  app,
  page,
}) => {
  await app.open({ tabs: [roleTab("tab-1", "role_codebase_audit", "Codebase Audit")] });
  const turn = await app.start("tab-1");
  await turn.reply(AUDIT);
  await expect(page.locator(".status-bar-status")).toHaveText("Ready");

  const log = page.getByRole("log");
  await expect(log.getByRole("heading", { name: "[LOW] Flaky auth test" })).toBeVisible();
  await log.evaluate((root) => {
    const headings = [...root.querySelectorAll("h2")];
    const from = headings.find((h) => h.textContent?.includes("Token leak"));
    const to = headings.find((h) => h.textContent?.includes("Flaky auth test"));
    if (!from || !to) throw new Error("finding headings not rendered");
    const range = document.createRange();
    range.setStartBefore(from);
    range.setEndBefore(to);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });

  await page.getByRole("button", { name: "Send to Planner" }).first().click();
  const dialog = dialogFor(page, "Send for planning");
  await expect(dialog.getByRole("radio", { name: "Selected card or finding" })).toBeChecked();
  await expect(fills(page, "Send for planning")).toContainText(
    "Fills: Task Type, Title, Request / Problem, Expected Behavior, Current Behavior, Additional Context",
  );
  await dialog.getByRole("button", { name: "Open Planner tab" }).click();
  await expect(dialog).toBeHidden();

  await expect(page.getByRole("combobox", { name: /Task Type/ })).toHaveValue("Bug");
  await expect(page.getByRole("textbox", { name: /^Title/ })).toHaveValue("Token leak");
  await expect(page.getByRole("textbox", { name: /Current Behavior/ })).toHaveValue(
    "Refresh tokens are written to the log.",
  );
  await expect(page.getByRole("textbox", { name: /Expected Behavior/ })).toHaveValue(
    "Redact tokens before logging.",
  );
  // What has its own field is not repeated in the request.
  const request = page.getByRole("textbox", { name: /Request \/ Problem/ });
  await expect(request).toHaveValue(/Token leak/);
  await expect(request).not.toHaveValue(/Redact tokens/);
  await expect(request).not.toHaveValue(/Flaky auth test/);
  await expect(page.getByRole("textbox", { name: "Additional Context" })).toHaveValue(
    /Location:\nsrc\/auth\/token\.rs:42/,
  );
});

const REVIEW = [
  "### Verdict",
  "**CHANGES REQUESTED**",
  "",
  "## Reviewed plan",
  "1. Catch TokenExpired",
  "",
  "## Review notes",
  "- Cover refresh tokens too",
].join("\n");

test("Plan Reviewer → Planner (new tab): the Planner form comes back whole, the review waits in the scratch pad", async ({
  app,
  page,
}) => {
  const originalTask = [
    "Title: Login 500",
    "Task type: Bug",
    `Request:\n${PLANNER_BUG.request}`,
    `Expected behavior:\n${PLANNER_BUG.expectedBehavior}`,
    `Current behavior:\n${PLANNER_BUG.currentBehavior}`,
  ].join("\n\n");
  await app.open({
    tabs: [roleTab("tab-1", "role_plan_reviewer", "Plan Reviewer")],
    answers: {
      "tab-1": {
        originalTask,
        plan: "1. Catch TokenExpired",
        additionalContext: PLANNER_BUG.additionalContext,
      },
    },
  });
  const turn = await app.start("tab-1");
  await turn.reply(REVIEW);
  await expect(page.locator(".status-bar-status")).toHaveText("Ready");

  await page.getByRole("button", { name: /Send (back )?to Planner/ }).first().click();
  const dialog = dialogFor(page);
  await expect(fills(page)).toContainText("scratch pad (plan)");
  await dialog.getByRole("button", { name: "Open Planner tab" }).click();
  await expect(dialog).toBeHidden();

  await expect(page.getByRole("combobox", { name: /Task Type/ })).toHaveValue("Bug");
  await expect(page.getByRole("textbox", { name: /^Title/ })).toHaveValue("Login 500");
  await expect(page.getByRole("textbox", { name: /Request \/ Problem/ })).toHaveValue(PLANNER_BUG.request);
  await expect(page.getByRole("textbox", { name: /Expected Behavior/ })).toHaveValue(
    PLANNER_BUG.expectedBehavior,
  );
  await expect(page.getByRole("textbox", { name: /Current Behavior/ })).toHaveValue(
    PLANNER_BUG.currentBehavior,
  );
  await expect(page.getByRole("textbox", { name: "Additional Context" })).toHaveValue(
    PLANNER_BUG.additionalContext,
  );
  const pad = await app.waitForCall("scratch_save", (args) => args.tabId === "tab-2");
  expect(pad.args.content).toBe(REVIEW);
});

test("Planner → Developer: Title and What to work on are filled, the plan goes to the scratch pad", async ({
  app,
  page,
}) => {
  await app.open({
    tabs: [roleTab("tab-1", "role_planner", "Planner")],
    answers: { "tab-1": { ...PLANNER_BUG, taskType: "Feature" } },
  });
  const turn = await app.start("tab-1");
  await turn.reply(PLAN);
  await expect(page.locator(".status-bar-status")).toHaveText("Ready");

  await page.getByRole("button", { name: "Send to Developer" }).first().click();
  await expect(fills(page)).toContainText("Fills: Title, What to work on, scratch pad (plan)");
  await dialogFor(page).getByRole("button", { name: "Open Developer tab" }).click();
  await expect(dialogFor(page)).toBeHidden();

  await expect(page.getByRole("textbox", { name: /^Title/ })).toHaveValue("Login 500");
  const work = page.getByRole("textbox", { name: "What to work on" });
  await expect(work).toHaveValue(new RegExp(`^${PLANNER_BUG.request.replace(/\./g, "\\.")}\\n\\nExpected behavior:`));
  // A Feature hides Current Behavior, so an old Bug answer stays behind.
  await expect(work).not.toHaveValue(/handler panics/);
  const pad = await app.waitForCall("scratch_save", (args) => args.tabId === "tab-2");
  expect(pad.args.content).toBe(PLAN);
});
