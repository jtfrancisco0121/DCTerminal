import { expect, roleTab, test } from "./fixtures/tauri";

const PLAN = "## Plan\n\n1. Add an effort picker\n2. Send it with session/set_config_option\n";

test("plan approval: Send to Plan Reviewer works while the turn waits on the plan", async ({
  app,
  page,
}) => {
  await app.open({
    tabs: [roleTab("tab-1", "role_planner", "Planner")],
    answers: {
      "tab-1": {
        taskType: "Feature",
        title: "Effort controls",
        request: "Let users pick reasoning effort",
        expectedBehavior: "An effort picker in the chat header",
        currentBehavior: "",
      },
    },
  });
  const turn = await app.start("tab-1");
  await turn.chunk(PLAN);
  // ExitPlanMode arrives while session/prompt is still open: the turn is in flight.
  await turn.plan(PLAN);

  const card = page.locator(".session-cards");
  await expect(card.getByRole("heading", { name: "Ready to code?" })).toBeVisible();
  await expect(page.getByRole("tab", { name: /Planner.*plan to review/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel turn" })).toBeEnabled();
  const send = card.getByRole("button", { name: "Send to Plan Reviewer" });
  await expect(send).toBeEnabled();
  await expect(card.getByRole("button", { name: "Keep planning" })).toBeEnabled();

  await send.click();
  const dialog = page.getByRole("dialog", { name: "Send plan" });
  await expect(dialog.getByRole("radio", { name: "Plan Reviewer" })).toBeChecked();
  await expect(dialog.getByRole("radio", { name: "Plan mode (Ready to code?)" })).toBeChecked();
  await dialog.getByRole("button", { name: "Open Plan Reviewer tab" }).click();
  await expect(dialog).toBeHidden();

  await expect(page.getByRole("tab", { name: "Plan Reviewer" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("textbox", { name: /Original Task/ })).toHaveValue(
    "Let users pick reasoning effort",
  );
  await expect(page.getByRole("textbox", { name: /Proposed Implementation Plan/ })).toHaveValue(
    PLAN.trim(),
  );
  await expect(page.getByRole("textbox", { name: "Additional Context" })).toHaveValue(
    /An effort picker in the chat header/,
  );

  const saved = await app.waitForCall("handoff_save");
  expect(saved.args.input).toMatchObject({
    sourceTabId: "tab-1",
    sourceRoleId: "role_planner",
    targetRoleId: "role_plan_reviewer",
    scope: "plan_mode",
    planText: PLAN.trim(),
  });
  // The Planner's pending ExitPlanMode is answered "keep planning", not accepted.
  const answered = await app.waitForCall("respond_plan_request");
  expect(answered.args).toEqual({ tabId: "tab-1", jsonRpcId: 7, outcome: "cancelled" });
  const bound = await app.waitForCall("handoff_bind_tab");
  expect(bound.args).toEqual({ id: "handoff-1", tabId: "tab-2" });
  expect(await app.calls("role_session_start")).toHaveLength(1);
});

const REPORT = [
  "# Recommendations",
  "",
  "## Feature: Effort controls",
  "",
  "### Problem",
  "Users cannot change reasoning effort.",
  "",
  "### Proposed Solution",
  "Add an effort picker next to the model picker.",
  "",
  "### Existing Capability",
  "The ACP session reports effort options.",
  "",
  "## Feature: Persist Up-arrow history",
  "",
  "### Problem",
  "Composer history is lost on restart.",
  "",
  "### Proposed Solution",
  "Save it with the scratch pad.",
  "",
].join("\n");

test("Recommendation → Planner from one selected feature card", async ({ app, page }) => {
  await app.open({ tabs: [roleTab("tab-1", "role_recommendation", "Recommendation")] });
  const turn = await app.start("tab-1");
  await turn.reply(REPORT);
  await expect(page.locator(".status-bar-status")).toHaveText("Ready");

  const log = page.getByRole("log");
  await expect(log.getByRole("heading", { name: "Feature: Persist Up-arrow history" })).toBeVisible();
  await log.evaluate((root) => {
    const headings = [...root.querySelectorAll("h2")];
    const from = headings.find((h) => h.textContent?.includes("Effort controls"));
    const to = headings.find((h) => h.textContent?.includes("Persist Up-arrow"));
    if (!from || !to) throw new Error("feature card headings not rendered");
    const range = document.createRange();
    range.setStartBefore(from);
    range.setEndBefore(to);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });

  await page.getByRole("button", { name: "Send to Planner" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Send for planning" });
  await expect(dialog.getByRole("radio", { name: "Selected card or finding" })).toBeChecked();
  await dialog.getByRole("button", { name: "Open Planner tab" }).click();
  await expect(dialog).toBeHidden();

  await expect(page.getByRole("tab", { name: "Planner" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("textbox", { name: /^Title/ })).toHaveValue("Effort controls");
  await expect(page.getByRole("combobox", { name: /Task Type/ })).toHaveValue("Feature");
  await expect(page.getByRole("textbox", { name: /Expected Behavior/ })).toHaveValue(
    "Add an effort picker next to the model picker.",
  );
  const request = page.getByRole("textbox", { name: /Request \/ Problem/ });
  await expect(request).toHaveValue(/Effort controls/);
  await expect(request).not.toHaveValue(/Persist Up-arrow/);

  const synced = await app.waitForCall(
    "sync_active_tab_form",
    (args) => args.roleId === "role_planner",
  );
  expect(synced.args.values).toMatchObject({
    title: "Effort controls",
    taskType: "Feature",
    currentBehavior: "Users cannot change reasoning effort.",
    expectedBehavior: "Add an effort picker next to the model picker.",
  });
  expect(String((synced.args.values as Record<string, string>).additionalContext)).toContain(
    "The ACP session reports effort options.",
  );
});
