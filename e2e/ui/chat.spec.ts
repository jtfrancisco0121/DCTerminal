import { expect, test } from "./fixtures/tauri";

test("General chat: streamed reply renders and the turn ends Ready", async ({ app, page }) => {
  await app.open();
  const status = page.locator(".status-bar-status");
  await expect(status).toHaveText("Not started");

  const turn = await app.start("tab-1");
  const start = await app.waitForCall("role_session_start");
  expect(start.args).toMatchObject({ roleId: "role_general", tabId: "tab-1" });
  await expect(page.getByRole("tab", { name: /General.*Working/ })).toBeVisible();
  await expect(status).toHaveText("Agent working…");

  const log = page.getByRole("log");
  await turn.chunk("Hello ");
  await expect(log).toContainText("Hello");
  await turn.chunk("**streamed** world");
  await expect(log.locator("strong", { hasText: "streamed" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel turn" })).toBeEnabled();

  await turn.finish();
  await expect(status).toHaveText("Ready");
  await expect(page.getByText("Last turn: end_turn")).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel turn" })).toBeDisabled();
  await expect(page.getByRole("tab", { name: "General", exact: true })).toBeVisible();

  const composer = page.getByRole("textbox", { name: "Follow-up message" });
  await composer.fill("Thanks, one more thing");
  await page.getByRole("button", { name: "Send", exact: true }).first().click();
  const send = await app.waitForCall("dev_session_send");
  expect(send.args).toEqual({ prompt: "Thanks, one more thing", tabId: "tab-1", attachments: null });
  await expect(composer).toHaveValue("");
  await expect(status).toHaveText("Agent working…");
  await turn.reply("Done.");
  await expect(status).toHaveText("Ready");
  await expect(log.getByText("Done.", { exact: true })).toHaveCount(1);
});

// Chunks wait for the next animation frame; a finish in the same frame must not
// show a short reply such as "OK" twice ("OKOK").
test("a reply that finishes in the same frame as its chunks is shown once", async ({ app, page }) => {
  await app.open();
  const turn = await app.start("tab-1");
  await turn.burst(async (t) => {
    await t.chunk("OK");
    await t.finish();
  });
  await expect(page.locator(".status-bar-status")).toHaveText("Ready");
  await app.nextFrame();
  await expect(page.getByRole("log")).not.toContainText("OKOK", { timeout: 1000 });
});

test("a failed turn shows the error and leaves the tab usable", async ({ app, page }) => {
  await app.open();
  const turn = await app.start("tab-1");
  await turn.fail("agent crashed");
  await expect(page.getByText("agent crashed")).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel turn" })).toBeDisabled();
});
