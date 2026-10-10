import { expect, test } from "./fixtures/tauri";

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

test.beforeEach(async ({ app, page }) => {
  await app.open();
  const turn = await app.start("tab-1");
  await turn.commands([
    { name: "compact", description: "Clear history but keep a summary", hint: "<instructions>" },
    { name: "context", description: "Show context usage" },
    { name: "model", description: "Set the model" },
    { name: "review", description: "Review a pull request" },
  ]);
  await turn.reply("Ready when you are.");
  await expect(page.locator(".status-bar-status")).toHaveText("Ready");
});

test("slash menu: commands from available_commands_update, Tab completes", async ({ app, page }) => {
  const composer = page.getByRole("textbox", { name: "Follow-up message" });
  await composer.fill("/");
  const menu = page.getByRole("listbox", { name: "Slash commands" });
  await expect(menu.getByRole("option")).toHaveText([
    /^\/compact/,
    /^\/context/,
    /^\/review/,
  ]);
  // /model fights the model picker, so it is never offered.
  await expect(menu.getByRole("option", { name: /\/model/ })).toHaveCount(0);

  await composer.pressSequentially("comp");
  await expect(menu.getByRole("option")).toHaveCount(1);
  await expect(menu.getByRole("option", { name: /\/compact/ })).toHaveAttribute("aria-selected", "true");
  await composer.press("Tab");
  await expect(composer).toHaveValue("/compact ");
  await expect(menu).toBeHidden();
  await expect(composer).toBeFocused();

  await composer.pressSequentially("keep the plan");
  await page.getByRole("button", { name: "Send", exact: true }).first().click();
  const send = await app.waitForCall("dev_session_send");
  expect(send.args.prompt).toBe("/compact keep the plan");
});

test("slash menu: a typed /model is refused before it is sent", async ({ app, page }) => {
  const composer = page.getByRole("textbox", { name: "Follow-up message" });
  await composer.fill("/model opus");
  await expect(page.getByRole("listbox", { name: "Slash commands" })).toBeHidden();
  await expect(page.getByRole("alert")).toHaveText(
    "/model is not sent from DCTerminal. Use the model picker.",
  );
  await expect(page.getByRole("button", { name: "Send", exact: true }).first()).toBeDisabled();
  await composer.press("ControlOrMeta+Enter");
  await composer.fill("/model");
  await composer.press("ControlOrMeta+Enter");
  await expect(composer).toHaveValue("/model");

  // The same key does send an allowed message, and only that one reaches the agent.
  await composer.fill("/context");
  await page.getByRole("listbox", { name: "Slash commands" }).waitFor();
  await composer.press("Escape");
  await composer.press("ControlOrMeta+Enter");
  await app.waitForCall("dev_session_send");
  expect((await app.calls("dev_session_send")).map((c) => c.args.prompt)).toEqual(["/context"]);
});

test("pasting an image adds a chip and the send carries it", async ({ app, page }) => {
  const composer = page.getByRole("textbox", { name: "Follow-up message" });
  await app.pasteImage(composer, { name: "screenshot.png", mime: "image/png", base64: PNG_1X1 });

  // The composer and the scratch pad show the same staged images.
  const lists = page.getByRole("list", { name: "Attached images" });
  await expect(lists).toHaveCount(2);
  const chips = lists.first();
  await expect(chips.getByRole("listitem")).toHaveCount(1);
  await expect(chips).toContainText("screenshot.png");
  const staged = await app.waitForCall("attachment_add");
  expect(staged.args).toEqual({ tabId: "tab-1", mime: "image/png", data: PNG_1X1 });

  await composer.fill("What is wrong here?");
  await page.getByRole("button", { name: "Send", exact: true }).first().click();
  const send = await app.waitForCall("dev_session_send");
  expect(send.args).toEqual({ prompt: "What is wrong here?", tabId: "tab-1", attachments: ["att-1"] });
  await expect(lists).toHaveCount(0);
  await expect(page.getByRole("log")).toContainText("screenshot.png");
});

test("removing a pasted image drops it from the send", async ({ app, page }) => {
  const composer = page.getByRole("textbox", { name: "Follow-up message" });
  await app.pasteImage(composer, { name: "a.png", mime: "image/png", base64: PNG_1X1 });
  await page.getByRole("button", { name: "Remove a.png" }).first().click();
  await expect(page.getByRole("list", { name: "Attached images" })).toHaveCount(0);
  await app.waitForCall("attachment_remove");
  await composer.fill("text only");
  await page.getByRole("button", { name: "Send", exact: true }).first().click();
  const send = await app.waitForCall("dev_session_send");
  expect(send.args.attachments).toBeNull();
});
