// Pasted and dropped images beyond composer.spec.ts (src/attachments/*,
// src/components/AttachmentChips.tsx).
import { expect, roleTab, test } from "./fixtures/tauri";
import { dropFiles, PNG_1X1, quietChat, sentPrompts } from "./composer-helpers";

const png = (name: string) => ({ name, mime: "image/png", base64: PNG_1X1 });

test("several images: each gets a chip, one is removed, the send carries the rest", async ({ app, page }) => {
  const { composer, editor, composerSend, log } = await quietChat(app, page);
  await app.pasteImage(composer, png("one.png"));
  await app.pasteImage(editor, png("two.png"));
  await app.pasteImage(composer, { name: "three.gif", mime: "image/gif", base64: PNG_1X1 });

  // The composer and the pad show one shared set.
  const lists = page.getByRole("list", { name: "Attached images" });
  await expect(lists).toHaveCount(2);
  for (const list of await lists.all()) {
    await expect(list.getByRole("listitem")).toHaveText([/one\.png/, /two\.png/, /three\.gif/]);
  }
  await expect.poll(async () => (await app.calls("attachment_add")).length).toBe(3);
  expect((await app.calls("attachment_add")).map((c) => c.args.mime)).toEqual(["image/png", "image/png", "image/gif"]);

  // Removing from the pad's chips removes it everywhere and unstages it.
  await page.getByRole("region", { name: "Scratch pad" }).getByRole("button", { name: "Remove two.png" }).click();
  const removed = await app.waitForCall("attachment_remove");
  expect(removed.args).toEqual({ tabId: "tab-1", id: "att-2" });
  await expect(lists.first().getByRole("listitem")).toHaveText([/one\.png/, /three\.gif/]);

  await composer.fill("compare these");
  await composerSend.click();
  const send = await app.waitForCall("dev_session_send");
  expect(send.args).toEqual({ prompt: "compare these", tabId: "tab-1", attachments: ["att-1", "att-3"] });
  await expect(lists).toHaveCount(0);
  await expect(log).toContainText("one.png");
  await expect(log).toContainText("three.gif");
  await expect(log).not.toContainText("two.png");
});

test("an image-only message can be sent from the composer", async ({ app, page }) => {
  const { composer, composerSend, log } = await quietChat(app, page);
  await expect(composerSend).toBeDisabled();
  await app.pasteImage(composer, png("only.png"));
  await expect(page.getByRole("list", { name: "Attached images" }).first()).toBeVisible();
  await expect(composerSend).toBeEnabled();
  await composerSend.click();
  const send = await app.waitForCall("dev_session_send");
  expect(send.args).toEqual({ prompt: "", tabId: "tab-1", attachments: ["att-1"] });
  await expect(log).toContainText("only.png");
  // An image-only send is not a text prompt: Recent sends and history skip it.
  expect(await app.calls("prompt_record_send")).toHaveLength(0);
});

test("an image-only message can be sent from the pad", async ({ app, page }) => {
  const { editor, padSend } = await quietChat(app, page);
  await app.pasteImage(editor, png("pad.png"));
  await expect(page.getByRole("list", { name: "Attached images" }).first()).toBeVisible();
  await padSend.click();
  const send = await app.waitForCall("dev_session_send");
  expect(send.args).toEqual({ prompt: "", tabId: "tab-1", attachments: ["att-1"] });
});

test("a dropped image file is attached (HTML5 drop; Tauri's own drag-drop is off)", async ({ app, page }) => {
  const { composer, composerSend } = await quietChat(app, page);
  await dropFiles(composer, [png("dropped.png")]);
  await expect(page.getByRole("list", { name: "Attached images" }).first()).toContainText("dropped.png");
  await composer.fill("see drop");
  await composerSend.click();
  const send = await app.waitForCall("dev_session_send");
  expect(send.args.attachments).toEqual(["att-1"]);
});

test("pasting or dropping a file that is not an image attaches nothing", async ({ app, page }) => {
  const { composer, editor } = await quietChat(app, page);
  await app.pasteImage(composer, { name: "notes.pdf", mime: "application/pdf", base64: PNG_1X1 });
  await dropFiles(editor, [{ name: "data.txt", mime: "text/plain", base64: "aGVsbG8=" }]);
  // A later image still works, so the earlier events were handled.
  await app.pasteImage(composer, png("real.png"));
  await expect(page.getByRole("list", { name: "Attached images" }).first().getByRole("listitem")).toHaveText([
    /real\.png/,
  ]);
  expect((await app.calls("attachment_add")).map((c) => c.args.mime)).toEqual(["image/png"]);
  await expect(page.locator(".attachment-chips-error")).toHaveCount(0);
});

test("an unsupported image type and a sixth image are refused with a message", async ({ app, page }) => {
  const { composer } = await quietChat(app, page);
  await app.pasteImage(composer, { name: "scan.bmp", mime: "image/bmp", base64: PNG_1X1 });
  const error = page.getByRole("alert").filter({ hasText: "scan.bmp is not a PNG, JPEG, GIF or WebP image." });
  await expect(error.first()).toBeVisible();
  expect(await app.calls("attachment_add")).toHaveLength(0);

  for (let i = 1; i <= 5; i += 1) {
    await app.pasteImage(composer, png(`shot-${i}.png`));
    await expect(page.getByRole("list", { name: "Attached images" }).first().getByRole("listitem")).toHaveCount(i);
  }
  await app.pasteImage(composer, png("shot-6.png"));
  await expect(page.getByRole("alert").filter({ hasText: "At most 5 images can go with one message." }).first()).toBeVisible();
  await expect(page.getByRole("list", { name: "Attached images" }).first().getByRole("listitem")).toHaveCount(5);
  expect(await app.calls("attachment_add")).toHaveLength(5);
});

test("a send that fails gives the images back", async ({ app, page }) => {
  const { composer, composerSend } = await quietChat(app, page);
  await app.pasteImage(composer, png("keep.png"));
  await expect(page.getByRole("list", { name: "Attached images" }).first()).toBeVisible();
  await app.handle("dev_session_send", () => {
    throw new Error("agent not connected");
  });
  await composer.fill("with picture");
  await composerSend.click();
  await expect(page.getByText("agent not connected")).toBeVisible();
  await expect(page.getByRole("list", { name: "Attached images" }).first()).toContainText("keep.png");
});

test("a Cursor chat (no image support) takes no images", async ({ app, page }) => {
  const { composer, editor, composerSend } = await quietChat(app, page, {
    tabs: [roleTab("tab-1", "role_general", "General", { provider: "cursor" })],
  });
  await app.pasteImage(composer, png("cursor.png"));
  await app.pasteImage(editor, png("cursor-pad.png"));
  await dropFiles(composer, [png("cursor-drop.png")]);
  await composer.fill("text still works");
  await expect(composerSend).toBeEnabled();
  await expect(page.getByRole("list", { name: "Attached images" })).toHaveCount(0);
  expect(await app.calls("attachment_add")).toHaveLength(0);
  await composerSend.click();
  const send = await app.waitForCall("dev_session_send");
  expect(send.args).toEqual({ prompt: "text still works", tabId: "tab-1", attachments: null });
  expect(await sentPrompts(app)).toEqual(["text still works"]);
});
