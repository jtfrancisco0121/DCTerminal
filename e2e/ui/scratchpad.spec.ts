import { expect, test, type TauriApp } from "./fixtures/tauri";
import type { Page } from "@playwright/test";

async function readyChat(app: TauriApp, page: Page) {
  await app.open();
  const turn = await app.start("tab-1");
  await turn.reply("Ready.");
  await expect(page.locator(".status-bar-status")).toHaveText("Ready");
  return page.getByRole("region", { name: "Scratch pad" });
}

async function openRecentSends(page: Page) {
  await page.getByRole("button", { name: "Prompts" }).click();
  const dialog = page.getByRole("dialog", { name: "Prompt library" });
  await dialog.getByRole("tab", { name: /Recent sends/ }).click();
  return dialog.getByRole("listbox", { name: "Recent sends" });
}

test("pad Send: prompt goes to the agent, pad clears, Recent sends lists it", async ({ app, page }) => {
  const pad = await readyChat(app, page);
  const editor = pad.getByRole("textbox", { name: "Scratch pad editor" });
  await editor.fill("Summarize the open questions");
  await pad.getByRole("button", { name: "Send", exact: true }).click();

  const send = await app.waitForCall("dev_session_send");
  expect(send.args).toEqual({ prompt: "Summarize the open questions", tabId: "tab-1", attachments: null });
  await expect(editor).toHaveValue("");
  const recorded = await app.waitForCall("prompt_record_send");
  expect(recorded.args).toEqual({ text: "Summarize the open questions", source: "chat" });
  await expect(page.getByRole("log")).toContainText("Summarize the open questions");

  const recent = await openRecentSends(page);
  await expect(recent.getByRole("option")).toHaveCount(1);
  await expect(recent.getByRole("option").first()).toContainText("Summarize the open questions");
});

test("Mod+Shift+. sends the pad to the tab's terminal pane and clears it", async ({ app, page }) => {
  const pad = await readyChat(app, page);
  const editor = pad.getByRole("textbox", { name: "Scratch pad editor" });
  await editor.fill("git status");
  await editor.press("ControlOrMeta+Shift+Period");

  const opened = await app.waitForCall("pty_open");
  expect(opened.args.input).toMatchObject({ id: "tab-1::pane", launch: "shell" });
  const written = await app.waitForCall("pty_write");
  expect(written.args).toEqual({ id: "tab-1::pane", data: "git status\n" });
  await expect(editor).toHaveValue("");
  const recorded = await app.waitForCall("prompt_record_send");
  expect(recorded.args).toEqual({ text: "git status", source: "terminal" });
  expect(await app.calls("dev_session_send")).toHaveLength(0);

  const recent = await openRecentSends(page);
  await expect(recent.getByRole("option").first()).toContainText("git status");
});
