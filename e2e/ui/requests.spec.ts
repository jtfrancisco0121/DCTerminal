import { expect, test } from "./fixtures/tauri";
import { chord, namedTabs, startReady, tabChip } from "./tabs-helpers";

test("permission request: the card answers with the chosen option", async ({ app, page }) => {
  await app.open();
  const turn = await app.start("tab-1");
  await turn.permission("Run rm -rf build");
  const card = page.getByRole("dialog", { name: "Run rm -rf build" });
  await expect(card).toBeVisible();
  await expect(page.getByRole("tab", { name: /General.*Needs you/ })).toBeVisible();
  await card.getByRole("button", { name: "Allow once" }).click();
  const answer = await app.waitForCall("respond_permission_request");
  expect(answer.args).toEqual({ tabId: "tab-1", jsonRpcId: 9, outcome: "selected", optionId: "allow-once" });
  await expect(card).toBeHidden();
  await turn.reply("Removed.");
  await expect(page.locator(".status-bar-status")).toHaveText("Ready");
});

test("question request: choosing an answer replies to the agent", async ({ app, page }) => {
  await app.open();
  const turn = await app.start("tab-1");
  await turn.question("How should we roll out the change?", [
    { id: "flag", label: "Feature flag" },
    { id: "direct", label: "Direct deploy" },
  ]);
  const card = page.getByRole("dialog", { name: "Question" });
  await expect(card).toContainText("How should we roll out the change?");
  await card.getByRole("button", { name: "Feature flag" }).click();
  const answer = await app.waitForCall("respond_question_request");
  expect(answer.args).toEqual({ tabId: "tab-1", jsonRpcId: 8, outcome: "answered", choiceId: "flag" });
  await expect(card).toBeHidden();
});

test("events for another tab do not reach the open chat", async ({ app, page }) => {
  await app.open();
  const turn = await app.start("tab-1");
  await app.turn("tab-9").chunk("not for you");
  await turn.chunk("for tab one");
  await expect(page.getByRole("log")).toContainText("for tab one");
  await expect(page.getByRole("log")).not.toContainText("not for you");
});

test("a send the backend rejects shows its error", async ({ app, page }) => {
  await app.open({
    handlers: {
      dev_session_send: () => {
        throw new Error("no active agent session");
      },
    },
  });
  const turn = await app.start("tab-1");
  await turn.reply("Ready.");
  await page.getByRole("textbox", { name: "Follow-up message" }).fill("hello?");
  await page.getByRole("button", { name: "Send", exact: true }).first().click();
  await expect(page.getByText("no active agent session")).toBeVisible();
  await expect(page.locator(".status-bar-status")).not.toHaveText("Agent working…");
});

test("permission keys: modifiers never approve, only the focused pane answers, Escape closes a dialog first", async ({
  app,
  page,
}) => {
  await app.open({ tabs: namedTabs(2) });
  await startReady(app, page, "tab-1", "alpha ready");
  await tabChip(page, "Beta").click();
  await startReady(app, page, "tab-2", "beta ready");
  await chord(page, "Backslash");
  const picker = page.getByRole("dialog", { name: "Split right with tab" });
  await picker.getByRole("option", { name: /^Alpha/ }).click();
  await expect(picker).toHaveCount(0);

  await app.turn("tab-1").permission("Alpha wants rm", 11);
  await app.turn("tab-2").permission("Beta wants rm", 12);
  // Located by pane: both cards share the id `perm-title`, so their accessible names collide.
  const alphaCard = page.getByLabel("Second pane: Alpha").locator(".permission-card");
  const betaCard = page.locator("[data-pane='primary'] .permission-card");
  await expect(alphaCard).toBeVisible();
  await expect(betaCard).toBeVisible();
  // Focus the main pane (Beta) on something that is not a text field.
  await page.locator("[data-pane='primary']").getByRole("log").click();
  await expect(page.locator("[data-pane='primary']")).toHaveClass(/split-pane-focused/);

  // Cmd+A / Ctrl+A select text; they never answer a permission.
  await page.keyboard.press("Meta+a");
  await page.keyboard.press("Control+a");

  // Mod+/ opens a dialog; Escape closes it and leaves both permissions pending.
  await chord(page, "Slash");
  const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(help).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(help).toBeHidden();
  expect(await app.calls("respond_permission_request")).toHaveLength(0);
  expect(await app.calls("dev_session_cancel")).toHaveLength(0);
  await expect(alphaCard).toBeVisible();
  await expect(betaCard).toBeVisible();

  // A bare `a` answers only the focused pane's card.
  await page.keyboard.press("a");
  const answer = await app.waitForCall("respond_permission_request");
  expect(answer.args).toMatchObject({ tabId: "tab-2", outcome: "selected", optionId: "allow-once" });
  await expect(betaCard).toBeHidden();
  await expect(alphaCard).toBeVisible();
  expect(await app.calls("respond_permission_request")).toHaveLength(1);
});
