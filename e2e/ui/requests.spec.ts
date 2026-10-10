import { expect, test } from "./fixtures/tauri";

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
