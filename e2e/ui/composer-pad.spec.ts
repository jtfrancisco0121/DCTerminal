// Scratch pad: Transfer into the composer, sending a selection, and drafts kept
// per tab and across reloads (transferPad / padAfterSend / padSelection in
// src/scratch/pad.ts, persistence in src/useScratchPads.ts).
import type { Page } from "@playwright/test";
import { expect, roleTab, test } from "./fixtures/tauri";
import { caretToEnd, quietChat, quietStart, readyChat, reload, selectText, sentPrompts } from "./composer-helpers";

const LOCAL_DRAFT_KEY = "dcterminal.scratch.v1";

test("Transfer moves the whole pad into an empty composer and focuses it", async ({ app, page }) => {
  const { pad, editor, composer } = await readyChat(app, page);
  await editor.fill("Draft line one\nDraft line two\n\n");
  await pad.getByRole("button", { name: "Transfer" }).click();

  await expect(composer).toHaveValue("Draft line one\nDraft line two");
  await expect(composer).toBeFocused();
  await expect(editor).toHaveValue("");
  // Nothing is sent by a transfer.
  expect(await app.calls("dev_session_send")).toHaveLength(0);
});

test("Mod+. moves only the selection, appended after a blank line", async ({ app, page }) => {
  const { editor, composer } = await readyChat(app, page);
  await composer.fill("Context first");
  await editor.fill("keep this\n\nmove this part\n\nkeep that too");
  await selectText(editor, "move this part");
  await editor.press("ControlOrMeta+Period");

  await expect(composer).toHaveValue("Context first\n\nmove this part");
  await expect(composer).toBeFocused();
  // The moved text leaves the pad, with the blank line around it collapsed to one.
  await expect(editor).toHaveValue("keep this\n\nkeep that too");
});

test("a selection inside a line is cut out of that line only", async ({ app, page }) => {
  const { pad, editor, composer } = await readyChat(app, page);
  await editor.fill("Fix the flaky login test today");
  await selectText(editor, "flaky ");
  await pad.getByRole("button", { name: "Transfer" }).click();
  await expect(composer).toHaveValue("flaky");
  await expect(editor).toHaveValue("Fix the login test today");
});

test("Transfer with a blank pad changes nothing", async ({ app, page }) => {
  const { pad, editor, composer } = await readyChat(app, page);
  await composer.fill("as typed");
  await editor.fill("   \n  ");
  await pad.getByRole("button", { name: "Transfer" }).click();
  await expect(composer).toHaveValue("as typed");
  await expect(editor).toHaveValue("   \n  ");
});

test("pad Send with text in the composer sends the composer and keeps the pad", async ({ app, page }) => {
  const { editor, composer, padSend, turn } = await readyChat(app, page);
  await editor.fill("still drafting");
  await composer.fill("ship it");
  await padSend.click();
  const send = await app.waitForCall("dev_session_send");
  expect(send.args).toEqual({ prompt: "ship it", tabId: "tab-1", attachments: null });
  await expect(composer).toHaveValue("");
  await expect(editor).toHaveValue("still drafting");
  await turn.reply("ok");
});

test("To terminal sends only the selected lines and cuts them from the pad", async ({ app, page }) => {
  const { pad, editor } = await readyChat(app, page);
  await editor.fill("echo one\nnpm test\necho three");
  await selectText(editor, "npm test");
  await pad.getByRole("button", { name: "To terminal" }).click();

  const written = await app.waitForCall("pty_write");
  expect(written.args).toEqual({ id: "tab-1::pane", data: "npm test\n" });
  await expect(editor).toHaveValue("echo one\necho three");
  const recorded = await app.waitForCall("prompt_record_send");
  expect(recorded.args).toEqual({ text: "npm test", source: "terminal" });
  expect(await sentPrompts(app)).toEqual([]);
});

/** Seeds the WebView's scratch mirror once, before the app's first load. */
async function seedLocalDrafts(page: Page, pads: Record<string, unknown>): Promise<void> {
  await page.addInitScript(
    ([key, blob]) => {
      if (!sessionStorage.getItem("e2e-seeded")) {
        sessionStorage.setItem("e2e-seeded", "1");
        localStorage.setItem(key, blob);
      }
    },
    [LOCAL_DRAFT_KEY, JSON.stringify({ pads })] as const,
  );
}

test("each tab keeps its own pad", async ({ app, page }) => {
  const { editor } = await quietChat(app, page, {
    tabs: [roleTab("tab-1", "role_general", "General"), roleTab("tab-2", "role_general", "Second")],
  });
  await editor.fill("notes for the first tab");
  await page.getByRole("tab", { name: "Second" }).click();
  await quietStart(app, page, "tab-2");
  await expect(editor).toHaveValue("");
  await editor.fill("second tab notes");
  await page.getByRole("tab", { name: "General" }).click();
  await expect(editor).toHaveValue("notes for the first tab");
  await page.getByRole("tab", { name: "Second" }).click();
  await expect(editor).toHaveValue("second tab notes");

  // Both drafts reach scratch.json (debounced write-through, one entry per tab).
  await app.waitForCall("scratch_save", (a) => a.tabId === "tab-1" && a.content === "notes for the first tab");
  await app.waitForCall("scratch_save", (a) => a.tabId === "tab-2" && a.content === "second tab notes");
});

test("the pad survives a reload from its local copy", async ({ app, page }) => {
  const { editor, composer } = await quietChat(app, page);
  await editor.fill("half-written plan");
  // Blur flushes the WebView copy right away.
  await composer.focus();
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key) ?? "", LOCAL_DRAFT_KEY))
    .toContain("half-written plan");

  // The reload resets the fake backend (scratch_load returns no pads), so the text
  // can only come back from the local mirror.
  await reload(page);
  await quietStart(app, page, "tab-1");
  await expect(editor).toHaveValue("half-written plan");
});

test("the pad comes back from scratch.json", async ({ app, page }) => {
  const { editor } = await quietChat(app, page, {
    handlers: {
      scratch_load: () => ({
        pads: [{ tabId: "tab-1", content: "saved on disk", updatedAt: new Date().toISOString(), history: [] }],
        knownTabIds: ["tab-1"],
      }),
    },
  });
  await expect(editor).toHaveValue("saved on disk");
});

test("a local draft for a tab the backend no longer knows is not resurrected", async ({ app, page }) => {
  const now = Date.now();
  // A WebView copy left over from a deleted tab, plus a newer local draft for tab-1.
  await seedLocalDrafts(page, {
    "tab-gone": { content: "ghost draft", updatedAt: now, history: ["ghost"] },
    "tab-1": { content: "local wins", updatedAt: now + 60_000, history: [] },
  });
  const { editor } = await quietChat(app, page, {
    handlers: {
      scratch_load: () => ({
        pads: [{ tabId: "tab-1", content: "older disk copy", updatedAt: "2020-01-01T00:00:00Z", history: [] }],
        knownTabIds: ["tab-1"],
      }),
    },
  });
  // Newer updatedAt wins between the local copy and the disk copy.
  await expect(editor).toHaveValue("local wins");

  await caretToEnd(editor);
  await editor.pressSequentially("!");
  await app.waitForCall("scratch_save", (a) => a.tabId === "tab-1" && a.content === "local wins!");
  expect((await app.calls("scratch_save")).map((c) => c.args.tabId)).not.toContain("tab-gone");
  const local = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "{}"), LOCAL_DRAFT_KEY);
  expect(Object.keys(local.pads)).toEqual(["tab-1"]);
});

test("a closed tab is still known, so its local draft is kept", async ({ app, page }) => {
  await seedLocalDrafts(page, {
    "tab-closed": { content: "reopen me later", updatedAt: Date.now(), history: [] },
  });
  const { editor } = await quietChat(app, page, {
    // Rust lists open and closed tabs from every window in knownTabIds.
    responses: { scratch_load: { pads: [], knownTabIds: ["tab-1", "tab-closed"] } },
  });
  await editor.fill("x");
  await app.waitForCall("scratch_save", (a) => a.tabId === "tab-closed" && a.content === "reopen me later");
});

test("without knownTabIds from the backend, local drafts are all kept", async ({ app, page }) => {
  await seedLocalDrafts(page, {
    "tab-other": { content: "other window draft", updatedAt: Date.now(), history: [] },
    "tab-1": { content: "mine", updatedAt: Date.now(), history: [] },
  });
  // An older backend: no knownTabIds in scratch_load.
  const { editor } = await quietChat(app, page, { responses: { scratch_load: { pads: [] } } });
  await expect(editor).toHaveValue("mine");
  await editor.pressSequentially("!");
  await app.waitForCall("scratch_save", (a) => a.tabId === "tab-other" && a.content === "other window draft");
});
