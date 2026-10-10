// Prompt library (Prompts button): save, search, insert, edit, delete, and
// Recent sends (src/components/PromptLibraryDialog.tsx, src/prompts/library.ts,
// prompts.json behind prompt_* commands).
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/tauri";
import { promptLibraryHandlers, quietChat, selectText } from "./composer-helpers";

async function openLibrary(page: Page) {
  await page.getByRole("region", { name: "Scratch pad" }).getByRole("button", { name: "Prompts" }).click();
  return page.getByRole("dialog", { name: "Prompt library" });
}

async function savePrompt(page: Page, name: string, body: string) {
  const dialog = page.getByRole("dialog", { name: "Prompt library" });
  await dialog.getByRole("button", { name: "New prompt" }).click();
  await expect(dialog.getByRole("textbox", { name: "Prompt name" })).toBeFocused();
  await dialog.getByRole("textbox", { name: "Prompt name" }).fill(name);
  await dialog.getByRole("textbox", { name: "Prompt text" }).fill(body);
  await dialog.getByRole("button", { name: "Save prompt" }).click();
  await expect(dialog.getByRole("textbox", { name: "Prompt name" })).toBeHidden();
}

test("save prompts, filter them, and insert one into the pad", async ({ app, page }) => {
  // A pad restored from scratch.json and never focused: no cursor is known yet.
  const { editor } = await quietChat(app, page, {
    handlers: promptLibraryHandlers,
    responses: {
      scratch_load: {
        pads: [{ tabId: "tab-1", content: "Existing notes", updatedAt: "2026-01-01T00:00:00Z", history: [] }],
        knownTabIds: ["tab-1"],
      },
    },
  });
  await expect(editor).toHaveValue("Existing notes");
  const dialog = await openLibrary(page);
  await expect(dialog).toContainText("No saved prompts yet.");
  await expect(dialog).toContainText("/tmp/dct-e2e/prompts.json");

  await savePrompt(page, "Review checklist", "Review this diff for:\n- tests\n- naming");
  await savePrompt(page, "Release notes", "Write release notes from the merged PRs.");
  const saved = (await app.calls("prompt_save")).map((c) => c.args);
  expect(saved).toEqual([
    { id: null, name: "Review checklist", body: "Review this diff for:\n- tests\n- naming" },
    { id: null, name: "Release notes", body: "Write release notes from the merged PRs." },
  ]);
  await expect(dialog.getByRole("tab", { name: "Saved (2)" })).toBeVisible();
  const list = dialog.getByRole("listbox", { name: "Saved prompts" });
  await expect(list.getByRole("option")).toHaveText(["Review checklist", "Release notes"]);

  // Every word must match the name or the body.
  const filter = dialog.getByRole("searchbox", { name: "Filter prompts" });
  await filter.fill("merged release");
  await expect(list.getByRole("option")).toHaveText(["Release notes"]);
  await filter.fill("naming");
  await expect(list.getByRole("option")).toHaveText(["Review checklist"]);
  await filter.fill("nothing like this");
  await expect(dialog.getByText("Nothing matches.")).toBeVisible();
  await filter.fill("naming");
  await expect(dialog.getByLabel("Prompt preview")).toHaveText("Review this diff for:\n- tests\n- naming");

  await dialog.getByRole("button", { name: "Insert into scratch pad" }).click();
  await expect(dialog).toBeHidden();
  // Without a known cursor it goes after a blank line.
  await expect(editor).toHaveValue("Existing notes\n\nReview this diff for:\n- tests\n- naming");
  await expect(editor).toBeFocused();
  const used = await app.waitForCall("prompt_mark_used");
  expect(used.args).toEqual({ id: "p1" });
});

test("insert replaces the pad selection and works from the keyboard", async ({ app, page }) => {
  const { editor } = await quietChat(app, page, { handlers: promptLibraryHandlers });
  const dialog = await openLibrary(page);
  await savePrompt(page, "Alpha", "ALPHA BODY");
  await savePrompt(page, "Beta", "BETA BODY");
  await dialog.getByRole("searchbox", { name: "Filter prompts" }).press("Escape");
  await expect(dialog).toBeHidden();

  await editor.fill("before PLACEHOLDER after");
  await selectText(editor, "PLACEHOLDER");
  await openLibrary(page);
  const filter = dialog.getByRole("searchbox", { name: "Filter prompts" });
  await expect(filter).toBeFocused();
  await filter.press("ArrowDown");
  await expect(dialog.getByRole("option", { name: "Beta" })).toHaveAttribute("aria-selected", "true");
  await filter.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(editor).toHaveValue("before BETA BODY after");
});

test("edit and delete a saved prompt; Cancel on the confirm keeps it", async ({ app, page }) => {
  await quietChat(app, page, { handlers: promptLibraryHandlers });
  const dialog = await openLibrary(page);
  await savePrompt(page, "Standup", "What did I do yesterday?");

  await dialog.getByRole("button", { name: "Edit" }).click();
  await dialog.getByRole("textbox", { name: "Prompt name" }).fill("Daily standup");
  await dialog.getByRole("button", { name: "Save prompt" }).click();
  await expect(dialog.getByRole("option")).toHaveText(["Daily standup"]);
  expect((await app.waitForCall("prompt_save", (a) => a.id === "p1")).args).toEqual({
    id: "p1",
    name: "Daily standup",
    body: "What did I do yesterday?",
  });

  page.once("dialog", (d) => {
    expect(d.message()).toBe('Delete the prompt "Daily standup"?');
    void d.dismiss();
  });
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(dialog.getByRole("option")).toHaveText(["Daily standup"]);
  expect(await app.calls("prompt_delete")).toHaveLength(0);

  page.once("dialog", (d) => void d.accept());
  await dialog.getByRole("button", { name: "Delete" }).click();
  const deleted = await app.waitForCall("prompt_delete");
  expect(deleted.args).toEqual({ id: "p1" });
  await expect(dialog.getByRole("tab", { name: "Saved (0)" })).toBeVisible();
  await expect(dialog).toContainText("No saved prompts yet.");
});

test("a duplicate name is refused with the backend's message", async ({ app, page }) => {
  await quietChat(app, page, { handlers: promptLibraryHandlers });
  const dialog = await openLibrary(page);
  await savePrompt(page, "Fix tests", "Fix the failing tests.");
  await dialog.getByRole("button", { name: "New prompt" }).click();
  // Save stays off until both fields have text.
  await expect(dialog.getByRole("button", { name: "Save prompt" })).toBeDisabled();
  await dialog.getByRole("textbox", { name: "Prompt name" }).fill("fix TESTS");
  await expect(dialog.getByRole("button", { name: "Save prompt" })).toBeDisabled();
  await dialog.getByRole("textbox", { name: "Prompt text" }).fill("Another body");
  await dialog.getByRole("textbox", { name: "Prompt text" }).press("ControlOrMeta+Enter");
  await expect(dialog.getByText('A prompt named "Fix tests" already exists.')).toBeVisible();
  // The form stays open with the text; Cancel goes back to the list.
  await expect(dialog.getByRole("textbox", { name: "Prompt text" })).toHaveValue("Another body");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog.getByRole("textbox", { name: "Prompt name" })).toBeHidden();
  await expect(dialog.getByRole("tab", { name: "Saved (1)" })).toBeVisible();
  expect(await app.calls("prompt_save")).toHaveLength(2);
});

test("Escape in the prompt form closes the form, not the whole library", async ({ app, page }) => {
  await quietChat(app, page, { handlers: promptLibraryHandlers });
  const dialog = await openLibrary(page);
  await dialog.getByRole("button", { name: "New prompt" }).click();
  await dialog.getByRole("textbox", { name: "Prompt name" }).fill("Draft");
  await dialog.getByRole("textbox", { name: "Prompt name" }).press("Escape");
  await expect(dialog.getByRole("textbox", { name: "Prompt name" })).toBeHidden();
  await expect(dialog).toBeVisible({ timeout: 1000 });
  await expect(dialog.getByRole("searchbox", { name: "Filter prompts" })).toBeVisible({ timeout: 1000 });
});

test("Recent sends: newest first, filter, save as prompt, insert, and clear", async ({ app, page }) => {
  const { composer, editor, turn } = await quietChat(app, page, { handlers: promptLibraryHandlers });
  for (const text of ["explain the build", "write a migration"]) {
    await composer.fill(text);
    await composer.press("ControlOrMeta+Enter");
    await turn.reply("ok");
  }
  const dialog = await openLibrary(page);
  await dialog.getByRole("tab", { name: "Recent sends (2)" }).click();
  const recent = dialog.getByRole("listbox", { name: "Recent sends" });
  await expect(recent.getByRole("option")).toHaveCount(2);
  await expect(recent.getByRole("option").nth(0)).toContainText("write a migration");
  await expect(recent.getByRole("option").nth(0)).toContainText("chat ·");

  await dialog.getByRole("searchbox", { name: "Filter prompts" }).fill("build");
  await expect(recent.getByRole("option")).toHaveCount(1);
  await dialog.getByRole("button", { name: "Save as prompt…" }).click();
  await expect(dialog.getByRole("textbox", { name: "Prompt name" })).toHaveValue("explain the build");
  await dialog.getByRole("button", { name: "Save prompt" }).click();
  await expect(dialog.getByRole("tab", { name: "Saved (1)" })).toBeVisible();

  // Double-click inserts a recent send (no prompt id, so nothing is marked used).
  await recent.getByRole("option").first().dblclick();
  await expect(dialog).toBeHidden();
  await expect(editor).toHaveValue("explain the build");
  expect(await app.calls("prompt_mark_used")).toHaveLength(0);

  await openLibrary(page);
  await dialog.getByRole("tab", { name: /Recent sends/ }).click();
  page.once("dialog", (d) => void d.accept());
  await dialog.getByRole("button", { name: "Clear recent sends" }).click();
  await app.waitForCall("prompt_clear_recent");
  await expect(dialog.getByRole("tab", { name: "Recent sends (0)" })).toBeVisible();
  await expect(dialog).toContainText("Prompts you send from a chat or a terminal pad show up here.");
});

test("a library that cannot be read shows the error", async ({ app, page }) => {
  await quietChat(app, page, {
    handlers: {
      prompt_library_get: () => {
        throw new Error("prompts.json is not valid JSON");
      },
    },
  });
  const dialog = await openLibrary(page);
  await expect(dialog.getByText("prompts.json is not valid JSON")).toBeVisible();
  await dialog.getByRole("searchbox", { name: "Filter prompts" }).press("Escape");
  await expect(dialog).toBeHidden();
});
