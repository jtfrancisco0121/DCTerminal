import type { Page } from "@playwright/test";
import type { ChainRef } from "../../src/handoff/chains";
import { builtInRoles, CWD } from "./fixtures/data";
import { expect, roleTab, test, type TauriApp } from "./fixtures/tauri";

// Eagle-Eye roles opened as Terminal: hand-offs, verdict routing, loop-backs
// into a running PTY, plan-file detection, and restarts (StartupForm
// openTerminalHandoff / handoffLoopBack, pty/plans.rs).

const CHAIN = "ee_1700000000000";
const chain = (step: number, round?: number): ChainRef => ({
  chainId: CHAIN,
  kind: "eagle1",
  step,
  total: 4,
  ...(round ? { round } : {}),
});

const terminalTab = (id: string, roleId: string, label: string, extra = {}) =>
  roleTab(id, roleId, label, {
    kind: "terminal",
    terminalLaunch: "role",
    phase: "terminal",
    startupPromptSent: true,
    ...extra,
  });

const toolbar = (page: Page) => page.locator(".terminal-toolbar");
const screen = (page: Page) => page.locator(".terminal-screen .xterm-rows");

const IMPLEMENTER_ANSWERS = {
  cwd: CWD,
  taskType: "Bug Fix",
  title: "Login 500",
  description: "Expired tokens return 500.",
  approvedPlan: "1. Return 401 for expired tokens",
};

const PLANNER_ANSWERS = {
  cwd: CWD,
  taskType: "Bug",
  title: "Login 500",
  request: "Expired tokens return 500.",
  expectedBehavior: "Return 401.",
  currentBehavior: "Returns 500.",
};

/** Required fields of `roleId` (no showWhen) that `values` leaves empty. */
function missingRequired(roleId: string, values: Record<string, string>): string[] {
  const role = builtInRoles().find((r) => r.id === roleId)!;
  return role.fields
    .filter((f) => f.required && !f.showWhen && !String(values[f.key] ?? "").trim())
    .map((f) => f.key);
}

/** pty_write calls to `id` whose data contains `text`. */
async function writes(app: TauriApp, id: string, text: string): Promise<string[]> {
  return (await app.calls("pty_write"))
    .filter((c) => c.args.id === id && String(c.args.data).includes(text))
    .map((c) => String(c.args.data));
}

async function visit(app: TauriApp, page: Page, label: RegExp, id: string) {
  await page.getByRole("tab", { name: label }).click();
  await app.waitForCall("pty_open", (args) => (args.input as { id: string }).id === id);
}

test("Implementer terminal hands off to a PR Reviewer terminal with files, branch, and PR URL", async ({
  app,
  page,
}) => {
  await app.open({
    tabs: [terminalTab("tab-1", "role_implementer", "Implementer · Login 500")],
    answers: { "tab-1": IMPLEMENTER_ANSWERS },
    responses: {
      changes_list: {
        state: "ok",
        scope: "tab",
        repoRoot: CWD,
        baseTree: "a",
        nowTree: "b",
        baselineAt: null,
        files: [
          {
            path: "src/auth.ts",
            cwdPath: "src/auth.ts",
            status: "modified",
            oldBlob: "1",
            newBlob: "2",
            additions: 4,
            deletions: 1,
            binary: false,
          },
        ],
      },
      git_repo_info: {
        mainRoot: CWD,
        currentBranch: "fix/login",
        branches: ["main", "fix/login"],
        checkedOut: [],
        worktreesDir: "",
      },
    },
  });
  await app.waitForCall("pty_open");
  await app.ptyOutput(
    "tab-1",
    "Opened https://github.com/acme/app/pull/42\r\nDone: expired tokens now return 401.\r\n",
  );
  await expect(screen(page)).toContainText("now return 401");

  await toolbar(page).getByRole("button", { name: "Send to PR Reviewer" }).click();
  const dialog = page.getByRole("dialog", { name: "Send plan" });
  // An Implementer writes no plan file: selection or tail only.
  await expect(dialog.getByRole("radio", { name: /plan file/i })).toHaveCount(0);
  await expect(dialog.getByRole("radio", { name: "Last 200 lines" })).toBeChecked();
  await dialog.getByRole("radio", { name: "Terminal" }).check();
  await dialog.getByRole("button", { name: "Start PR Reviewer terminal" }).click();
  await expect(dialog).toBeHidden();

  const start = await app.waitForCall("role_terminal_start");
  const input = start.args.input as { roleId: string; values: Record<string, string>; handoffPlan: string };
  expect(input.roleId).toBe("role_pr_reviewer");
  expect(missingRequired("role_pr_reviewer", input.values)).toEqual([]);
  expect(input.values.originalTask).toContain("Title: Login 500");
  expect(input.values.approvedPlan).toBe(IMPLEMENTER_ANSWERS.approvedPlan);
  expect(input.handoffPlan).toBe(IMPLEMENTER_ANSWERS.approvedPlan);
  const context = input.values.additionalContext;
  expect(context).toContain("Done: expired tokens now return 401.");
  expect(context).toContain("- src/auth.ts +4 -1");
  expect(context).toContain("Branch: fix/login");
  expect(context).toContain("Pull request: https://github.com/acme/app/pull/42");
  expect((await app.waitForCall("changes_list")).args).toMatchObject({ tabId: "tab-1", scope: "tab" });
  await expect(page.getByRole("tab", { name: "PR Reviewer" })).toHaveAttribute("aria-selected", "true");
});

test("Developer terminal hands off its selection to a PR Reviewer chat draft", async ({ app, page }) => {
  await app.open({ tabs: [terminalTab("tab-1", "role_developer", "Developer")] });
  await app.waitForCall("pty_open");
  await app.ptyOutput("tab-1", "Fixed the flaky login test\r\n");
  await expect(screen(page)).toContainText("Fixed the flaky login test");
  await page.locator(".terminal-screen .terminal-slot").click({ button: "right" });
  await page.getByRole("menu").getByRole("menuitem", { name: "Send to PR Reviewer" }).click();
  const dialog = page.getByRole("dialog", { name: "Send plan" });
  await dialog.getByRole("button", { name: "Open PR Reviewer tab" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("tab", { name: "PR Reviewer" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("textbox", { name: /Approved Implementation Plan/ })).toHaveValue(
    "Fixed the flaky login test",
  );
  expect(await app.calls("role_terminal_start")).toHaveLength(0);
});

test("Plan Reviewer terminal: the verdict in its output picks the primary button and menu item", async ({
  app,
  page,
}) => {
  await app.open({
    tabs: [
      terminalTab("tab-1", "role_planner", "Planner · Login 500", { chain: chain(1) }),
      terminalTab("tab-2", "role_plan_reviewer", "Plan Reviewer", { chain: chain(2) }),
    ],
    activeTabId: "tab-2",
  });
  await app.waitForCall("pty_open");
  const actions = toolbar(page).locator(".handoff-actions");
  await expect(actions.getByRole("button", { name: "Next: Send to Implementer" })).toHaveClass(/primary-button/);

  await app.ptyOutput("tab-2", "## Review notes\r\nMissing a test.\r\nVerdict: REQUIRES REVISION\r\n");
  await expect(screen(page)).toContainText("REQUIRES REVISION");
  await actions.hover();
  await expect(actions.getByRole("button", { name: "Send back to Planner" })).toHaveClass(/primary-button/);
  await expect(actions.getByRole("button", { name: "Send to Implementer" })).toHaveClass(/secondary-button/);

  await app.ptyOutput("tab-2", "Re-checked.\r\nVerdict: APPROVED\r\n");
  await expect(screen(page)).toContainText("Re-checked.");
  await page.locator(".terminal-screen .terminal-slot").click({ button: "right" });
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: "Next: Send to Implementer" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Send to Planner" })).toBeVisible();
});

test("send back into the chain's running Planner terminal: one bracketed paste and Enter", async ({
  app,
  page,
}) => {
  await app.open({
    tabs: [
      terminalTab("tab-1", "role_planner", "Planner · Login 500", { chain: chain(1) }),
      terminalTab("tab-2", "role_plan_reviewer", "Plan Reviewer", { chain: chain(2) }),
    ],
    activeTabId: "tab-1",
  });
  await app.waitForCall("pty_open", (args) => (args.input as { id: string }).id === "tab-1");
  // The Planner's CLI turns bracketed paste on.
  await app.ptyOutput("tab-1", "\x1b[?2004hPlanner ready\r\n");
  await expect(screen(page)).toContainText("Planner ready");
  await visit(app, page, /^Plan Reviewer/, "tab-2");
  await app.ptyOutput("tab-2", "Add a regression test.\r\nVerdict: REQUIRES REVISION\r\n");
  await expect(screen(page)).toContainText("REQUIRES REVISION");

  await toolbar(page).locator(".handoff-actions").hover();
  await toolbar(page).getByRole("button", { name: "Send back to Planner" }).click();
  const dialog = page.getByRole("dialog", { name: "Send back to Planner" });
  await expect(dialog.getByText(/Pastes the review findings below into the chain's running Planner terminal/)).toBeVisible();
  await expect(dialog.getByLabel("Target tab")).toHaveText("To tab: Planner · Login 500");
  await expect(dialog.getByLabel("Follow-up message")).toContainText(
    "Review findings from the Plan Reviewer (round 1):",
  );
  // Nothing is written until the user confirms.
  expect(await writes(app, "tab-1", "Review findings")).toEqual([]);
  await dialog.getByRole("button", { name: "Send follow-up to Planner · Login 500" }).click();
  await expect(dialog).toBeHidden();

  await expect.poll(() => writes(app, "tab-1", "Review findings")).toHaveLength(1);
  const [data] = await writes(app, "tab-1", "Review findings");
  expect(data.startsWith("\x1b[200~Review findings from the Plan Reviewer (round 1):")).toBe(true);
  expect(data).toContain("Verdict: REQUIRES REVISION");
  expect(data.endsWith("\x1b[201~\r")).toBe(true);
  const loop = await app.waitForCall("chain_loop_back");
  expect(loop.args).toMatchObject({
    chainId: CHAIN,
    reviewerRoleId: "role_plan_reviewer",
    tabId: "tab-1",
    verdict: "REQUIRES REVISION",
  });
  expect(await app.calls("role_terminal_start")).toHaveLength(0);
  expect(await app.calls("new_draft_tab")).toHaveLength(0);
  await expect(page.getByRole("tab", { name: /^Planner/ })).toHaveAttribute("aria-selected", "true");
});

test("send back when the Planner's PTY has exited opens a new tab on the chain", async ({ app, page }) => {
  await app.open({
    tabs: [
      terminalTab("tab-1", "role_planner", "Planner · Login 500", { chain: chain(1) }),
      terminalTab("tab-2", "role_plan_reviewer", "Plan Reviewer", { chain: chain(2) }),
    ],
    activeTabId: "tab-1",
  });
  await app.waitForCall("pty_open", (args) => (args.input as { id: string }).id === "tab-1");
  await app.ptyExit("tab-1", 0);
  await expect(page.getByText("Process exited (0).")).toBeVisible();
  await visit(app, page, /^Plan Reviewer/, "tab-2");
  await app.ptyOutput("tab-2", "Verdict: REJECTED\r\n");
  await expect(screen(page)).toContainText("REJECTED");
  await toolbar(page).locator(".handoff-actions").hover();
  await toolbar(page).getByRole("button", { name: "Send back to Planner" }).click();
  const dialog = page.getByRole("dialog", { name: "Send plan" });
  await expect(dialog.getByText(/has no live session, so a new tab opens on the chain \(round 2\)/)).toBeVisible();
  await dialog.getByRole("button", { name: "Open Planner tab" }).click();
  await expect(dialog).toBeHidden();
  const loop = await app.waitForCall("chain_loop_back");
  expect(loop.args).toMatchObject({ chainId: CHAIN, reviewerRoleId: "role_plan_reviewer", tabId: "tab-3" });
  expect(await writes(app, "tab-1", "Review findings")).toEqual([]);
});

test("two Planner terminals: each hand-off asks for its own plan file and re-reads it on send", async ({
  app,
  page,
}) => {
  await app.open({
    tabs: [
      terminalTab("tab-1", "role_planner", "Planner · Alpha"),
      terminalTab("tab-2", "role_planner", "Planner · Beta"),
    ],
    activeTabId: "tab-1",
    handlers: {
      terminal_plan_file: (args, state) => {
        state.planReads = (state.planReads ?? 0) + 1;
        const name = (args.mentioned ?? [])[0] ?? "none.md";
        return {
          path: `/Users/e2e/.claude-account1/plans/${name}`,
          name,
          modifiedMs: 1,
          text: state.planReads > 1 ? `# ${name} (edited)` : `# ${name}`,
        };
      },
    },
  });
  await app.waitForCall("pty_open", (args) => (args.input as { id: string }).id === "tab-1");
  await app.ptyOutput("tab-1", "Plan saved to ~/.claude-account1/plans/alpha-plan.md\r\n");
  await expect(screen(page)).toContainText("alpha-plan.md");
  await visit(app, page, /Beta/, "tab-2");
  await app.ptyOutput("tab-2", "Plan saved to ~/.claude-account1/plans/beta-plan.md\r\n");
  await expect(screen(page)).toContainText("beta-plan.md");

  await toolbar(page).getByRole("button", { name: "Send to Plan Reviewer" }).click();
  const read = await app.waitForCall("terminal_plan_file");
  expect(read.args).toMatchObject({ tabId: "tab-2", mentioned: ["beta-plan.md"], claimed: ["alpha-plan.md"] });
  const dialog = page.getByRole("dialog", { name: "Send plan" });
  await expect(dialog.getByRole("radio", { name: "Newest plan file (beta-plan.md)" })).toBeChecked();
  await dialog.getByRole("button", { name: "Open Plan Reviewer tab" }).click();
  const saved = await app.waitForCall("handoff_save");
  // The file was edited after the dialog opened: the send carries the new text.
  expect(saved.args.input).toMatchObject({ scope: "plan_file", planText: "# beta-plan.md (edited)" });
});

test("a terminal target whose form is incomplete is not started", async ({ app, page }) => {
  await app.open({
    tabs: [terminalTab("tab-1", "role_plan_reviewer", "Plan Reviewer")],
    answers: { "tab-1": { cwd: CWD, originalTask: "Make login faster", plan: "1. Cache" } },
    handlers: {
      validate_and_preview: (args, state) => {
        const role = state.roles.find((r: { id: string }) => r.id === args.roleId);
        const errors = role.fields
          .filter(
            (f: { required: boolean; showWhen?: unknown; key: string }) =>
              f.required && !f.showWhen && !String(args.values[f.key] ?? "").trim(),
          )
          .map((f: { key: string; label: string }) => ({ key: f.key, message: `${f.label} is required` }));
        return { errors, merged: errors.length ? null : { text: "ok", chars: 2, unresolved: [] } };
      },
    },
  });
  await app.waitForCall("pty_open");
  await app.ptyOutput("tab-1", "## Reviewed plan\r\n1. Cache the session\r\nVerdict: APPROVED\r\n");
  await expect(screen(page)).toContainText("Verdict: APPROVED");
  await toolbar(page).getByRole("button", { name: /Send to Implementer$/ }).click();
  const dialog = page.getByRole("dialog", { name: "Send plan" });
  await dialog.getByRole("radio", { name: "Terminal" }).check();
  await dialog.getByRole("button", { name: "Start Implementer terminal" }).click();
  await expect(dialog.getByText(/The Implementer terminal cannot start: .*Task Type.* is required/)).toBeVisible();
  await expect(dialog).toBeVisible();
  expect(await app.calls("role_terminal_start")).toHaveLength(0);
  expect(await app.calls("handoff_save")).toHaveLength(0);
});

test("Planner terminal → Implementer terminal gets every required field from the Planner's own form", async ({
  app,
  page,
}) => {
  await app.open({
    // The form on screen is another tab's; the terminal's saved answers are used.
    tabs: [terminalTab("tab-1", "role_planner", "Planner · Login 500"), roleTab("tab-2", "role_general", "General")],
    activeTabId: "tab-1",
    answers: { "tab-1": PLANNER_ANSWERS },
  });
  await app.waitForCall("pty_open");
  await app.ptyOutput("tab-1", "## Plan\r\n1. Return 401 for expired tokens\r\n");
  await expect(screen(page)).toContainText("Return 401");
  await toolbar(page).getByRole("button", { name: "Send to Implementer" }).click();
  const dialog = page.getByRole("dialog", { name: "Send plan" });
  await dialog.getByRole("radio", { name: "Terminal" }).check();
  await dialog.getByRole("button", { name: "Start Implementer terminal" }).click();
  await expect(dialog).toBeHidden();
  const start = await app.waitForCall("role_terminal_start");
  const input = start.args.input as { values: Record<string, string>; handoffPlan: string };
  expect(missingRequired("role_implementer", input.values)).toEqual([]);
  expect(input.values).toMatchObject({ taskType: "Bug Fix", title: "Login 500", cwd: CWD });
  expect(input.values.approvedPlan).toBe("## Plan\n1. Return 401 for expired tokens");
  expect(input.handoffPlan).toBe("## Plan\n1. Return 401 for expired tokens");
});

test("a chained Planner terminal: exit mid-turn, hand off from the tail, restart keeps the chain and start time", async ({
  app,
  page,
}) => {
  await app.open({
    tabs: [terminalTab("tab-1", "role_planner", "Planner · Login 500", { chain: chain(1) })],
  });
  await app.waitForCall("pty_open");
  await app.ptyOutput("tab-1", "## Plan\r\n1. Half-written step");
  await app.ptyExit("tab-1", 130);
  await expect(page.getByText("Process exited (130).")).toBeVisible();

  await toolbar(page).getByRole("button", { name: "Next: Send to Plan Reviewer" }).click();
  const first = await app.waitForCall("terminal_plan_file");
  const dialog = page.getByRole("dialog", { name: "Send plan" });
  await expect(dialog.locator(".handoff-preview")).toHaveText("## Plan\n1. Half-written step");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();

  await page.getByRole("button", { name: "Restart" }).click();
  await expect.poll(async () => (await app.calls("pty_open")).length).toBe(2);
  await expect(page.getByText("Process exited (130).")).toBeHidden();
  await expect(toolbar(page).getByTitle("Open chain overview")).toHaveText("Eagle-Eye 1 · step 1 of 4");
  await app.ptyOutput("tab-1", "back again\r\n");
  await toolbar(page).getByRole("button", { name: "Next: Send to Plan Reviewer" }).click();
  await expect.poll(async () => (await app.calls("terminal_plan_file")).length).toBe(2);
  const second = (await app.calls("terminal_plan_file"))[1];
  expect(second.args.startedAtMs).toBe(first.args.startedAtMs);
});

test("terminal scratch pad sends --- steps one at a time", async ({ app, page }) => {
  await app.open({ tabs: [terminalTab("tab-1", "role_planner", "Planner")] });
  await app.waitForCall("pty_open");
  const editor = page.getByRole("textbox", { name: "Scratch pad editor" });
  await editor.fill("first step\n---\nsecond step");
  await page.locator(".terminal-scratch").getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => writes(app, "tab-1", "step")).toEqual(["first step\r"]);
  await expect(editor).toHaveValue("second step");
});
