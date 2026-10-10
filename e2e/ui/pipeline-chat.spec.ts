/**
 * Eagle-Eye pipeline in chat tabs: realistic Claude turns (plan mode,
 * Keep planning, revised plans, split replies, reviewer heading variants),
 * hand-off dialogs, send-backs into live tabs, and restarts mid-chain.
 *
 * handoff.spec.ts and eagle-eye.spec.ts cover the happy paths.
 */
import type { Page } from "@playwright/test";
import type { ChainRef } from "../../src/handoff/chains";
import { expect, roleTab, test, type TauriApp } from "./fixtures/tauri";

const PLANNER_ANSWERS = {
  taskType: "Feature",
  title: "Effort controls",
  request: "Let users pick reasoning effort",
  expectedBehavior: "An effort picker in the chat header",
  currentBehavior: "Effort is fixed per model",
};

const PLAN_V1 = "## Plan\n\n1. Add an effort picker\n2. Send it with session/set_config_option";
const PLAN_V2 = [
  "## Plan",
  "",
  "1. Add an effort picker next to the model picker",
  "2. Send it with session/set_config_option",
  "3. Hide it when the agent reports no effort options",
].join("\n");

const statusBar = (page: Page) => page.locator(".status-bar-status");
const planCard = (page: Page) => page.locator(".session-cards");
const chain = (step: number, round?: number): ChainRef => ({
  chainId: "ee_1",
  kind: "eagle1",
  step,
  total: 4,
  ...(round ? { round } : {}),
});

async function openPlanner(app: TauriApp, extra: Parameters<TauriApp["open"]>[0] = {}) {
  await app.open({
    tabs: [roleTab("tab-1", "role_planner", "Planner")],
    answers: { "tab-1": PLANNER_ANSWERS },
    ...extra,
  });
}

async function sendFollowUp(page: Page, text: string) {
  await page.getByRole("textbox", { name: "Follow-up message" }).fill(text);
  await page.getByRole("button", { name: "Send", exact: true }).first().click();
}

async function openPlanDialog(page: Page, button = "Send to Plan Reviewer") {
  await page.getByRole("button", { name: button, exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Send plan" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe("plan card lifecycle", () => {
  test.slow();

  test("Keep planning, then a revised plan in chat: the hand-off sends the newest plan", async ({
    app,
    page,
  }) => {
    await openPlanner(app);
    const turn = await app.start("tab-1");
    await turn.chunk(PLAN_V1);
    await turn.plan(PLAN_V1);
    await planCard(page).getByRole("button", { name: "Keep planning" }).click();
    expect((await app.waitForCall("respond_plan_request")).args).toMatchObject({ outcome: "cancelled" });
    await turn.reply("Nothing has been approved yet. Tell me what to change.");
    await expect(statusBar(page)).toHaveText("Ready");

    // The user asks for a change; Claude answers with the revised plan in chat only.
    await sendFollowUp(page, "Also hide the picker when there are no effort options.");
    await app.waitForCall("dev_session_send");
    await turn.reply(`Nothing has been approved yet. Here is the revised plan:\n\n${PLAN_V2}`);
    await expect(statusBar(page)).toHaveText("Ready");

    const dialog = await openPlanDialog(page);
    await expect(dialog.getByRole("radio", { name: "Latest plan and to-dos" })).toBeChecked();
    await expect(dialog.getByRole("radio", { name: "Claude's earlier plan (Ready to code?)" })).toBeEnabled();
    await dialog.getByRole("button", { name: "Open Plan Reviewer tab" }).click();
    await expect(dialog).toBeHidden();
    // The lead-in is not part of the plan.
    await expect(page.getByRole("textbox", { name: /Proposed Implementation Plan/ })).toHaveValue(PLAN_V2);
  });

  test("Keep planning, then a second ExitPlanMode: the hand-off sends the second plan", async ({
    app,
    page,
  }) => {
    await openPlanner(app);
    const turn = await app.start("tab-1");
    await turn.plan(PLAN_V1, 7);
    await planCard(page).getByRole("button", { name: "Keep planning" }).click();
    await app.waitForCall("respond_plan_request");
    await turn.finish();
    await sendFollowUp(page, "Hide it without options.");
    await app.waitForCall("dev_session_send");
    await turn.chunk("Updated.");
    await turn.plan(PLAN_V2, 11);
    await expect(planCard(page).locator("pre.plan-markdown")).toContainText("Hide it when the agent reports");

    const dialog = await openPlanDialog(page);
    await expect(dialog.getByRole("radio", { name: "Claude's plan (Ready to code?)" })).toBeChecked();
    await dialog.getByRole("button", { name: "Open Plan Reviewer tab" }).click();
    await expect(page.getByRole("textbox", { name: /Proposed Implementation Plan/ })).toHaveValue(PLAN_V2);
    // The pending (second) request is answered "keep planning", never accepted.
    const answers = (await app.calls("respond_plan_request")).map((c) => c.args);
    expect(answers).toEqual([
      { tabId: "tab-1", jsonRpcId: 7, outcome: "cancelled" },
      { tabId: "tab-1", jsonRpcId: 11, outcome: "cancelled" },
    ]);
  });

  test("the plan request is already gone: the hand-off still opens the target", async ({
    app,
    page,
  }) => {
    await openPlanner(app, {
      handlers: {
        respond_plan_request: () => {
          throw new Error("no pending plan request for this id");
        },
      },
    });
    const turn = await app.start("tab-1");
    await turn.plan(PLAN_V1);
    const dialog = await openPlanDialog(page);
    await dialog.getByRole("button", { name: "Open Plan Reviewer tab" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("tab", { name: "Plan Reviewer" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("textbox", { name: /Proposed Implementation Plan/ })).toHaveValue(PLAN_V1);
    expect(await app.calls("handoff_save")).toHaveLength(1);
  });

  test("the turn errors after the plan: the hand-off sends the plan and answers nothing", async ({
    app,
    page,
  }) => {
    await openPlanner(app);
    const turn = await app.start("tab-1");
    await turn.chunk("Here is my plan.");
    await turn.plan(PLAN_V1);
    await turn.fail("Claude exited unexpectedly");
    await expect(page.getByText("Claude exited unexpectedly")).toBeVisible();

    const dialog = await openPlanDialog(page);
    await expect(dialog.getByRole("radio", { name: "Claude's plan (Ready to code?)" })).toBeChecked();
    await dialog.getByRole("button", { name: "Open Plan Reviewer tab" }).click();
    await expect(page.getByRole("textbox", { name: /Proposed Implementation Plan/ })).toHaveValue(PLAN_V1);
    expect(await app.calls("respond_plan_request")).toHaveLength(0);
  });

  test("a permission card and the plan card at once: hand-off answers only the plan", async ({
    app,
    page,
  }) => {
    await openPlanner(app);
    const turn = await app.start("tab-1");
    await turn.plan(PLAN_V1);
    await turn.permission("Run npm test");
    await expect(page.getByRole("dialog", { name: "Run npm test" })).toBeVisible();

    const dialog = await openPlanDialog(page);
    await dialog.getByRole("button", { name: "Open Plan Reviewer tab" }).click();
    await expect(dialog).toBeHidden();
    expect((await app.waitForCall("respond_plan_request")).args).toMatchObject({ outcome: "cancelled" });
    // The permission stays for the user; nothing answers it for them.
    expect(await app.calls("respond_permission_request")).toHaveLength(0);
    await page.getByRole("tab", { name: /^Planner/ }).click();
    await expect(page.getByRole("dialog", { name: "Run npm test" })).toBeVisible();
  });
});

test.describe("hand-off source text", () => {
  test("the plan lives in a file and chat has only a summary: the plan file is the default", async ({
    app,
    page,
  }) => {
    const path = "/Users/e2e/.claude/plans/effort-picker.md";
    await openPlanner(app, {
      responses: {
        terminal_plan_file: { path, name: "effort-picker.md", modifiedMs: 1, text: PLAN_V2 },
      },
    });
    const turn = await app.start("tab-1");
    await turn.toolCall({ id: "w1", title: `Write ${path}`, kind: "edit", status: "completed" });
    await turn.reply("I wrote the plan to the plan file. It has three steps.");
    await expect(statusBar(page)).toHaveText("Ready");

    const dialog = await openPlanDialog(page);
    await expect(dialog.getByRole("radio", { name: "Plan file (effort-picker.md)" })).toBeChecked();
    await dialog.getByRole("button", { name: "Open Plan Reviewer tab" }).click();
    await expect(page.getByRole("textbox", { name: /Proposed Implementation Plan/ })).toHaveValue(PLAN_V2);
  });

  test("a review split by a tool call, with bold headings and a prose verdict", async ({ app, page }) => {
    await app.open({
      tabs: [roleTab("tab-1", "role_plan_reviewer", "Plan Reviewer", { chain: chain(2) })],
      answers: { "tab-1": { originalTask: "Title: Effort controls", plan: PLAN_V1 } },
    });
    const turn = await app.start("tab-1");
    await turn.chunk("**Verdict:** I approve this plan with changes.\n\nLet me confirm one thing.");
    await turn.toolCall({ id: "r1", title: "Read src/bridge.ts", kind: "read", status: "completed" });
    await turn.chunk(`**Revised Plan**\n\n${PLAN_V2}\n\n**Review Notes**\n\n- Step 3 was missing.`);
    await turn.finish();
    await expect(statusBar(page)).toHaveText("Ready");

    await expect(page.getByRole("button", { name: "Next: Send to Implementer" })).toHaveClass(/primary-button/);
    await page.getByRole("button", { name: "Next: Send to Implementer" }).click();
    const dialog = page.getByRole("dialog", { name: "Send plan" });
    await dialog.getByRole("button", { name: "Open Implementer tab" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("textbox", { name: /Approved Implementation Plan/ })).toHaveValue(PLAN_V2);
    await expect(page.getByRole("textbox", { name: "Additional Context" })).toHaveValue(
      /^Review notes:\n- Step 3 was missing\./,
    );
  });

  test("a PR review that mentions the approved plan is not read as approved", async ({ app, page }) => {
    await app.open({
      tabs: [roleTab("tab-1", "role_pr_reviewer", "PR Reviewer", { chain: chain(4) })],
      answers: { "tab-1": { originalTask: "Effort controls", approvedPlan: PLAN_V2 } },
    });
    const turn = await app.start("tab-1");
    await turn.reply(
      "## 1. Review Summary\nThe PR follows the approved plan.\n\n## 2. Findings\n- The picker stays visible during a turn.",
    );
    await expect(statusBar(page)).toHaveText("Ready");
    await expect(page.getByText("Chain complete: the PR Reviewer approved.")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Send to Implementer", exact: true })).toBeVisible();
  });

  test("a Plan Reviewer reply selected from the rendered transcript still splits", async ({
    app,
    page,
  }) => {
    await app.open({
      tabs: [roleTab("tab-1", "role_plan_reviewer", "Plan Reviewer")],
      answers: { "tab-1": { originalTask: "Title: Effort controls", plan: PLAN_V1 } },
    });
    const turn = await app.start("tab-1");
    await turn.reply(
      `## Verdict\n\n**APPROVED**\n\n## Reviewed plan\n\n${PLAN_V2}\n\n## Review notes\n\n- Watch the hidden state.`,
    );
    await expect(statusBar(page)).toHaveText("Ready");
    const log = page.getByRole("log");
    await log.evaluate((root) => {
      const from = [...root.querySelectorAll("h2")].find((h) => h.textContent === "Reviewed plan");
      if (!from) throw new Error("heading not rendered");
      const range = document.createRange();
      range.setStartBefore(from);
      range.setEndAfter(root.querySelector("li:last-of-type") ?? from);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await page.getByRole("button", { name: "Next: Send to Implementer", exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: "Send plan" });
    await dialog.getByRole("radio", { name: "Selection" }).check();
    await dialog.getByRole("button", { name: "Open Implementer tab" }).click();
    await expect(dialog).toBeHidden();
    const plan = page.getByRole("textbox", { name: /Approved Implementation Plan/ });
    await expect(plan).toHaveValue(/Add an effort picker next to the model picker/);
    await expect(plan).not.toHaveValue(/Reviewed plan|Review notes|Watch the hidden state/);
  });
});

test.describe("target tab", () => {
  test("double click on Open: one tab, one hand-off", async ({ app, page }) => {
    await app.open({
      tabs: [roleTab("tab-1", "role_implementer", "Implementer")],
      answers: { "tab-1": { taskType: "Feature", title: "Effort", description: "Add effort", approvedPlan: PLAN_V2 } },
      handlers: {
        // A slow repo read leaves a window between the first click and the dialog closing.
        changes_list: () => new Promise((done) => setTimeout(() => done(null), 300)),
      },
    });
    const turn = await app.start("tab-1");
    await turn.reply("Implemented the picker.");
    await expect(statusBar(page)).toHaveText("Ready");
    await page.getByRole("button", { name: "Send to PR Reviewer", exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: "Send plan" });
    await dialog.getByRole("button", { name: "Open PR Reviewer tab" }).dblclick();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("tab", { name: "PR Reviewer" })).toHaveCount(1);
    await expect.poll(async () => (await app.calls("new_draft_tab")).length).toBe(1);
    expect(await app.calls("handoff_save")).toHaveLength(1);
  });

  test("fields edited before Start are what the target starts with", async ({ app, page }) => {
    await openPlanner(app);
    const turn = await app.start("tab-1");
    await turn.reply(PLAN_V1);
    await expect(statusBar(page)).toHaveText("Ready");
    const dialog = await openPlanDialog(page);
    await dialog.getByRole("button", { name: "Open Plan Reviewer tab" }).click();
    await expect(dialog).toBeHidden();
    const plan = page.getByRole("textbox", { name: /Proposed Implementation Plan/ });
    await expect(plan).toHaveValue(PLAN_V1);
    await plan.fill(`${PLAN_V1}\n3. Edited by hand`);
    // A double click starts it once.
    await page.getByRole("button", { name: "Start", exact: true }).dblclick();
    const started = await app.waitForCall("role_session_start", (a) => a.tabId === "tab-2");
    expect((started.args.values as Record<string, string>).plan).toBe(`${PLAN_V1}\n3. Edited by hand`);
    expect((await app.calls("role_session_start")).map((c) => c.args.tabId)).toEqual(["tab-1", "tab-2"]);
  });

  test("a required field the hand-off cannot fill is named before the tab opens", async ({
    app,
    page,
  }) => {
    // Off a chain, nothing carries the Planner's task type to the Implementer.
    await app.open({
      tabs: [roleTab("tab-1", "role_plan_reviewer", "Plan Reviewer")],
      answers: { "tab-1": { originalTask: "Title: Effort controls", plan: PLAN_V1 } },
    });
    const turn = await app.start("tab-1");
    await turn.reply(`## Verdict\nAPPROVED\n\n## Reviewed plan\n${PLAN_V2}`);
    await expect(statusBar(page)).toHaveText("Ready");
    await page.getByRole("button", { name: "Next: Send to Implementer", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Send plan" });
    await expect(dialog.getByRole("note", { name: "Fields to fill in" })).toHaveText(
      "The Implementer tab opens with Task Type empty. Fill it in before Start.",
    );
    await dialog.getByRole("button", { name: "Open Implementer tab" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("combobox", { name: /Task Type/ })).toHaveValue("");
    expect(await app.calls("role_session_start")).toHaveLength(1);
  });

  test("Escape closes the hand-off dialog without opening anything", async ({ app, page }) => {
    await openPlanner(app);
    const turn = await app.start("tab-1");
    await turn.reply(PLAN_V1);
    await expect(statusBar(page)).toHaveText("Ready");
    const dialog = await openPlanDialog(page);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    expect(await app.calls("handoff_save")).toHaveLength(0);
    expect(await app.calls("new_draft_tab")).toHaveLength(0);
  });
});

test.describe("send-back into a live tab", () => {
  test.slow();

  const REVIEW = (verdict: string, n: number) =>
    `## Verdict\n${verdict}\n\n## Reviewed plan\n${PLAN_V2}\n\n## Review notes\n- Finding ${n}`;

  async function reviewChain(app: TauriApp, page: Page) {
    await app.open({
      tabs: [
        roleTab("tab-1", "role_planner", "Planner", { chain: chain(1) }),
        roleTab("tab-2", "role_plan_reviewer", "Plan Reviewer", { chain: chain(2) }),
      ],
      answers: {
        "tab-1": PLANNER_ANSWERS,
        "tab-2": { originalTask: "Title: Effort controls", plan: PLAN_V1 },
      },
    });
    const planner = await app.start("tab-1");
    await planner.plan(PLAN_V1);
    await planner.finish();
    await expect(statusBar(page)).toHaveText("Ready");
    await page.getByRole("tab", { name: /^Plan Reviewer/ }).click();
    const reviewer = await app.start("tab-2");
    await reviewer.reply(REVIEW("REQUIRES REVISION", 1));
    await expect(statusBar(page)).toHaveText("Ready");
    return { planner, reviewer };
  }

  test("the Planner is mid-turn: the send-back waits, then goes when the turn ends", async ({
    app,
    page,
  }) => {
    const { planner } = await reviewChain(app, page);
    // The Planner is busy with something else.
    await page.getByRole("tab", { name: /^Planner/ }).click();
    await sendFollowUp(page, "Also think about Cursor.");
    await app.waitForCall("dev_session_send");
    await page.getByRole("tab", { name: /^Plan Reviewer/ }).click();

    await page.getByRole("button", { name: "Send back to Planner", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Send back to Planner" });
    await expect(dialog.getByText("The Planner tab is still working. Wait for its turn to end.")).toBeVisible();
    const send = dialog.getByRole("button", { name: "Send follow-up to Planner" });
    await expect(send).toBeDisabled();
    await planner.reply("Cursor has no effort levels.");
    await expect(send).toBeEnabled();
    await send.click();
    await expect(dialog).toBeHidden();
    const sent = (await app.calls("dev_session_send")).at(-1)!;
    expect(sent.args.prompt).toMatch(/^Review findings from the Plan Reviewer \(round 1\):\n\n## Verdict\nREQUIRES REVISION/);
  });

  test("a send-back keeps the draft the user was typing in the Planner", async ({ app, page }) => {
    await reviewChain(app, page);
    await page.getByRole("tab", { name: /^Planner/ }).click();
    const composer = page.getByRole("textbox", { name: "Follow-up message" });
    await composer.fill("Half-written note to the Planner");
    await page.getByRole("tab", { name: /^Plan Reviewer/ }).click();
    await page.getByRole("button", { name: "Send back to Planner", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Send back to Planner" });
    await dialog.getByRole("button", { name: "Send follow-up to Planner" }).click();
    await expect(dialog).toBeHidden();
    const sent = await app.waitForCall("dev_session_send");
    expect(sent.args).toMatchObject({ tabId: "tab-1", attachments: null });
    expect(String(sent.args.prompt)).toMatch(/^Review findings from the Plan Reviewer \(round 1\)/);
    await expect(page.getByRole("tab", { name: /^Planner/ })).toHaveAttribute("aria-selected", "true");
    await expect(composer).toHaveValue("Half-written note to the Planner");
  });

  test("the Planner waits on a plan card: the send-back says so instead of 'still working'", async ({
    app,
    page,
  }) => {
    const { planner } = await reviewChain(app, page);
    await page.getByRole("tab", { name: /^Planner/ }).click();
    await sendFollowUp(page, "Tighten step 2.");
    await app.waitForCall("dev_session_send");
    await planner.plan(PLAN_V2, 12);
    await page.getByRole("tab", { name: /^Plan Reviewer/ }).click();
    await page.getByRole("button", { name: "Send back to Planner", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Send back to Planner" });
    await expect(
      dialog.getByText("The Planner tab is waiting on a plan card. Answer it in that tab, then send."),
    ).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Send follow-up to Planner" })).toBeDisabled();
    await dialog.getByRole("button", { name: "Cancel" }).click();

    await page.getByRole("tab", { name: /^Planner/ }).click();
    await planCard(page).getByRole("button", { name: "Keep planning" }).click();
    expect((await app.waitForCall("respond_plan_request", (a) => a.jsonRpcId === 12)).args.outcome).toBe(
      "cancelled",
    );
    await planner.finish();
    await expect(statusBar(page)).toHaveText("Ready");
    await page.getByRole("tab", { name: /^Plan Reviewer/ }).click();
    await page.getByRole("button", { name: "Send back to Planner", exact: true }).click();
    await page.getByRole("button", { name: "Send follow-up to Planner" }).click();
    await expect(dialog).toBeHidden();
    expect(await app.calls("dev_session_send")).toHaveLength(2);
  });

  test("the Planner's session exited: the send-back opens a new Planner tab on the chain", async ({
    app,
    page,
  }) => {
    const { planner } = await reviewChain(app, page);
    await page.getByRole("tab", { name: /^Planner/ }).click();
    await sendFollowUp(page, "One more thing");
    await app.waitForCall("dev_session_send");
    await page.evaluate((sessionId) => {
      window.__E2E.emit("role_session/prompt-finished", {
        sessionId,
        tabId: "tab-1",
        success: false,
        result: null,
        error: "Claude exited",
        agentExited: true,
      });
    }, planner.sessionId);
    await page.getByRole("tab", { name: /^Plan Reviewer/ }).click();
    await page.getByRole("button", { name: "Send back to Planner", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Send plan" });
    await expect(dialog).toContainText("has no live session, so a new tab opens on the chain (round 2)");
    expect(await app.calls("dev_session_send")).toHaveLength(1);
  });

  test("round 2 and 3: each send-back names its round and the Planner's revised reply goes forward", async ({
    app,
    page,
  }) => {
    const { planner } = await reviewChain(app, page);
    for (const round of [1, 2]) {
      await page.getByRole("button", { name: "Send back to Planner", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Send back to Planner" });
      await expect(dialog.getByLabel("Follow-up message")).toContainText(
        `Review findings from the Plan Reviewer (round ${round}):`,
      );
      await dialog.getByRole("button", { name: "Send follow-up to Planner" }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByRole("tab", { name: /^Planner/ })).toHaveAttribute("aria-selected", "true");
      // Claude revises in chat this time, no ExitPlanMode: the revised reply goes forward.
      const revised = `${PLAN_V2}\n${round + 3}. Round ${round + 1} fix`;
      await planner.reply(revised);
      await expect(statusBar(page)).toHaveText("Ready");
      await page.getByRole("button", { name: "Next: Send to Plan Reviewer", exact: true }).click();
      const next = page.getByRole("dialog", { name: "Send plan" });
      await expect(next.getByRole("radio", { name: "Latest plan and to-dos" })).toBeChecked();
      await next.getByRole("button", { name: "Open Plan Reviewer tab" }).click();
      await expect(next).toBeHidden();
      await expect(page.getByRole("textbox", { name: /Proposed Implementation Plan/ })).toHaveValue(revised);
      const tabId = `tab-${round + 2}`;
      const tagged = await app.waitForCall("set_tab_chain", (a) => a.tabId === tabId);
      expect(tagged.args.chain).toEqual(chain(2, round + 1));
      const reviewer = await app.start(tabId);
      await reviewer.reply(REVIEW("REQUIRES REVISION", round + 1));
      await expect(statusBar(page)).toHaveText("Ready");
    }
    const loops = (await app.calls("chain_loop_back")).map((c) => c.args.tabId);
    expect(loops).toEqual(["tab-1", "tab-1"]);
  });
});

test.describe("restart mid-chain", () => {
  test.slow();

  test("Continue replays only messages: the hand-off still finds the plan file", async ({ app, page }) => {
    const path = "/Users/e2e/.claude/plans/effort-picker.md";
    await app.open({
      tabs: [
        roleTab("tab-1", "role_planner", "Planner", {
          chain: chain(1),
          phase: "awaitingInput",
          acpSessionId: "sess-old",
          startupPromptSent: true,
          hasTranscript: true,
        }),
      ],
      answers: { "tab-1": PLANNER_ANSWERS },
      responses: {
        terminal_plan_file: { path, name: "effort-picker.md", modifiedMs: 1, text: PLAN_V2 },
      },
      handlers: {
        select_active_tab: (a: any, state: any) => {
          const tab = state.tabs.find((t: any) => t.id === a.tabId);
          state.activeTabId = a.tabId;
          return {
            tab: {
              id: tab.id,
              label: tab.label,
              roleId: tab.roleId,
              roleSnapshot: { name: "Planner", templateVersion: 1, mode: "plan", injection: "send_on_start" },
              cwd: tab.cwd,
              answers: { cwd: tab.cwd, ...(state.answers[tab.id] ?? {}) },
              mergedPrompt: "",
              mergedPromptHash: "",
              phase: tab.phase,
              order: 0,
              createdAt: "2026-10-10T09:00:00Z",
              transcript: `You › plan it\n\n▸ Write /Users/e2e/.claude/plans/effort-picker.md (completed)\n\nThe plan is in the plan file.`,
              startupPromptSent: true,
              kind: "role",
              terminalLaunch: "",
            },
          };
        },
        role_session_start: (a: any, state: any) => {
          const tab = state.tabs.find((t: any) => t.id === a.tabId);
          tab.phase = "running";
          const chunk = (kind: string, text: string) => ({
            tabId: tab.id,
            sessionId: "sess-old",
            kind,
            textDelta: text,
            rawJson: JSON.stringify({ sessionId: "sess-old", update: { sessionUpdate: kind, content: { type: "text", text } } }),
          });
          return {
            errors: [],
            session: { sessionId: "sess-old", modeId: "plan", cwd: tab.cwd, model: "default", effort: null, effortOptions: [], supportsImages: true },
            mergedChars: 0,
            injectionStrategy: "send_on_start",
            startupInjected: true,
            injectionInFlight: false,
            tabId: tab.id,
            resumedSession: true,
            skippedStartupInjection: true,
            folderWarning: null,
            loadedViaSessionLoad: true,
            replayMessageCount: 2,
            replayTruncated: false,
            replay: [chunk("user_message_chunk", "plan it"), chunk("agent_message_chunk", "The plan is in the plan file.")],
            modelVia: "unchanged",
          };
        },
      },
    });
    await expect(page.getByRole("tab", { name: /^Planner/ })).toHaveAttribute("title", /Eagle-Eye 1 · step 1 of 4/);
    await page.getByRole("button", { name: "Continue session" }).click();
    await app.waitForCall("role_session_start");
    await expect(page.getByRole("log")).toContainText("The plan is in the plan file.");

    const dialog = await openPlanDialog(page, "Next: Send to Plan Reviewer");
    await expect(dialog.getByRole("radio", { name: "Plan file (effort-picker.md)" })).toBeChecked();
    await dialog.getByRole("button", { name: "Open Plan Reviewer tab" }).click();
    await expect(page.getByRole("textbox", { name: /Proposed Implementation Plan/ })).toHaveValue(PLAN_V2);
    const tagged = await app.waitForCall("set_tab_chain", (a) => a.tabId === "tab-2");
    expect(tagged.args.chain).toEqual(chain(2));
  });
});

test.describe("transcript", () => {
  test("a long transcript keeps its scroll position across a tab switch", async ({ app, page }) => {
    await app.open({
      tabs: [
        roleTab("tab-1", "role_planner", "Planner"),
        roleTab("tab-2", "role_general", "General"),
      ],
      answers: { "tab-1": PLANNER_ANSWERS },
    });
    const turn = await app.start("tab-1");
    const long = Array.from({ length: 120 }, (_, i) => `${i + 1}. Step number ${i + 1} of the plan`).join("\n");
    await turn.chunk(`## Plan\n\n${long}`);
    await turn.finish();
    await expect(statusBar(page)).toHaveText("Ready");
    const log = page.getByRole("log");
    const scroller = page.locator("[data-session-screen]").first();
    await expect(log).toContainText("Step number 120");
    await scroller.evaluate((el) => {
      el.scrollTop = 400;
      el.dispatchEvent(new Event("scroll"));
    });
    const before = await scroller.evaluate((el) => el.scrollTop);
    expect(before).toBeGreaterThan(0);
    await page.getByRole("tab", { name: /^General/ }).click();
    await expect(page.getByRole("tab", { name: /^General/ })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: /^Planner/ }).click();
    await expect(log).toContainText("Step number 120");
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(before);
  });
});
