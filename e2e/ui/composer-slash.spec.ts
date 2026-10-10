// `/` autocomplete beyond composer.spec.ts: the scratch pad, arrow keys, Escape,
// mouse, filtering and argument hints (src/composer/SlashCommandMenu.tsx,
// src/composer/slashCommands.ts).
import { expect, test } from "./fixtures/tauri";
import { quietChat, sentPrompts, type Chat } from "./composer-helpers";

const COMMANDS = [
  { name: "compact", description: "Clear history but keep a summary", hint: "<instructions>" },
  { name: "context", description: "Show context usage" },
  { name: "review", description: "Review a pull request", hint: "<pr number>" },
  { name: "security-review", description: "Look for vulnerabilities" },
  { name: "model", description: "Set the model" },
];

let chat: Chat;

test.beforeEach(async ({ app, page }) => {
  chat = await quietChat(app, page);
  await chat.turn.commands(COMMANDS);
  await app.nextFrame();
});

test("the pad offers the same commands and Enter picks one", async ({ app, page }) => {
  const { editor, pad } = chat;
  await editor.fill("/");
  const menu = page.getByRole("listbox", { name: "Slash commands" });
  await expect(menu.getByRole("option")).toHaveText([/^\/compact/, /^\/context/, /^\/review/, /^\/security-review/]);
  await editor.pressSequentially("rev");
  // Name prefix matches come before other name matches.
  await expect(menu.getByRole("option")).toHaveText([/^\/review/, /^\/security-review/]);
  await editor.press("Enter");
  await expect(editor).toHaveValue("/review ");
  await expect(menu).toBeHidden();
  await editor.pressSequentially("42");
  await pad.getByRole("button", { name: "Send" }).click();
  await expect.poll(() => sentPrompts(app)).toEqual(["/review 42"]);
});

test("a command can start any line of the pad", async ({ page }) => {
  const { editor } = chat;
  await editor.fill("first explain the bug\n/con");
  const menu = page.getByRole("listbox", { name: "Slash commands" });
  await expect(menu.getByRole("option")).toHaveText([/^\/context/]);
  await editor.press("Tab");
  await expect(editor).toHaveValue("first explain the bug\n/context ");
  // Mid-line, a slash is just text.
  await editor.pressSequentially("and/or ");
  await expect(menu).toBeHidden();
});

test("arrow keys move the selection and wrap; the active option follows", async ({ page }) => {
  const { composer } = chat;
  await composer.fill("/");
  const menu = page.getByRole("listbox", { name: "Slash commands" });
  const options = menu.getByRole("option");
  await expect(options).toHaveCount(4);
  await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");
  await composer.press("ArrowDown");
  await composer.press("ArrowDown");
  await expect(options.nth(2)).toHaveAttribute("aria-selected", "true");
  await expect(options.nth(0)).toHaveAttribute("aria-selected", "false");
  const activeId = await options.nth(2).getAttribute("id");
  await expect(composer).toHaveAttribute("aria-activedescendant", activeId!);
  await composer.press("ArrowUp");
  await composer.press("ArrowUp");
  await composer.press("ArrowUp");
  // Wrapped from the first option to the last.
  await expect(options.nth(3)).toHaveAttribute("aria-selected", "true");
  await composer.press("Enter");
  await expect(composer).toHaveValue("/security-review ");
});

test("arrow keys in an open menu do not walk the send history", async ({ app }) => {
  const { composer, turn } = chat;
  await composer.fill("an earlier prompt");
  await composer.press("ControlOrMeta+Enter");
  await turn.reply("ok");
  await composer.fill("/");
  await composer.press("ArrowUp");
  await expect(composer).toHaveValue("/");
  expect(await sentPrompts(app)).toEqual(["an earlier prompt"]);
});

test("Escape closes the menu until the text changes, and Enter then sends nothing", async ({ app, page }) => {
  const { composer } = chat;
  const menu = page.getByRole("listbox", { name: "Slash commands" });
  await composer.fill("/co");
  await expect(menu).toBeVisible();
  await composer.press("Escape");
  await expect(menu).toBeHidden();
  await expect(composer).toHaveValue("/co");
  await expect(composer).not.toHaveAttribute("aria-activedescendant");
  // Typing more opens it again.
  await composer.pressSequentially("m");
  await expect(menu.getByRole("option")).toHaveText([/^\/compact/]);
  await composer.press("Escape");
  await expect(menu).toBeHidden();
  // Enter is a newline again, not a pick.
  await composer.press("Enter");
  await expect(composer).toHaveValue("/com\n");
  expect(await sentPrompts(app)).toEqual([]);
});

test("Escape that closes the menu during a turn does not cancel the turn", async ({ app, page }) => {
  test.fail(
    true,
    "known bug: the app's capture-phase keydown listener cancels the in-flight turn on Escape before the " +
      "slash menu's own Escape handler runs (src/useAppShortcuts.ts:98-106, 109; " +
      "src/composer/SlashCommandMenu.tsx:89)",
  );
  const { composer, editor, padSend, status } = chat;
  // A pad send leaves the composer editable while the turn runs.
  await editor.fill("long job");
  await padSend.click();
  await expect(status).toHaveText("Agent working…");
  await composer.fill("/co");
  const menu = page.getByRole("listbox", { name: "Slash commands" });
  await expect(menu).toBeVisible();
  await composer.press("Escape");
  await expect(menu).toBeHidden();
  await app.nextFrame();
  expect(await app.calls("dev_session_cancel")).toHaveLength(0);
  await expect(status).toHaveText("Agent working…");
});

test("the mouse: hover moves the selection, a click inserts and keeps focus", async ({ page }) => {
  const { composer } = chat;
  await composer.fill("/");
  const menu = page.getByRole("listbox", { name: "Slash commands" });
  const context = menu.getByRole("option", { name: /\/context/ });
  await context.hover();
  await expect(context).toHaveAttribute("aria-selected", "true");
  await context.click();
  await expect(composer).toHaveValue("/context ");
  await expect(composer).toBeFocused();
  await expect(menu).toBeHidden();
});

test("argument hints and descriptions are shown; a description can match", async ({ page }) => {
  const { composer } = chat;
  await composer.fill("/");
  const menu = page.getByRole("listbox", { name: "Slash commands" });
  const compact = menu.getByRole("option", { name: /\/compact/ });
  await expect(compact.locator(".slash-menu-hint")).toHaveText("<instructions>");
  await expect(compact).toContainText("Clear history but keep a summary");
  await expect(menu.getByRole("option", { name: /\/context/ }).locator(".slash-menu-hint")).toHaveCount(0);
  // "vulner" is only in /security-review's description.
  await composer.pressSequentially("vulner");
  await expect(menu.getByRole("option")).toHaveText([/^\/security-review/]);
});

test("no match hides the menu and Enter types a newline", async ({ app, page }) => {
  const { composer } = chat;
  await composer.fill("/zzz");
  await expect(page.getByRole("listbox", { name: "Slash commands" })).toBeHidden();
  await expect(composer).not.toHaveAttribute("aria-controls");
  await composer.press("Enter");
  await expect(composer).toHaveValue("/zzz\n");
  // An unknown command is still sent as typed.
  await composer.press("ControlOrMeta+Enter");
  await expect.poll(() => sentPrompts(app)).toEqual(["/zzz"]);
});

test("a later available_commands_update replaces the list", async ({ page }) => {
  const { composer, turn } = chat;
  await turn.commands([{ name: "init", description: "Create CLAUDE.md" }]);
  await composer.fill("/");
  const menu = page.getByRole("listbox", { name: "Slash commands" });
  await expect(menu.getByRole("option")).toHaveText([/^\/init/]);
});
