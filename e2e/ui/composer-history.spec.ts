// Chat composer keys, Up/Down history (scratch.history, saved in scratch.json),
// and sending while a turn is in flight (src/SessionTerminal.tsx, sendText /
// sendFromPad in src/StartupForm.tsx).
import { expect, test } from "./fixtures/tauri";
import { caretToEnd, quietChat, quietStart, reload, sentPrompts } from "./composer-helpers";

test("Enter adds a line; Mod+Enter and Ctrl+Enter send", async ({ app, page }) => {
  const { composer, turn } = await quietChat(app, page);
  await composer.fill("line one");
  await composer.press("Enter");
  await composer.pressSequentially("line two");
  await expect(composer).toHaveValue("line one\nline two");
  expect(await sentPrompts(app)).toEqual([]);

  await composer.press("ControlOrMeta+Enter");
  await expect.poll(() => sentPrompts(app)).toEqual(["line one\nline two"]);
  await expect(composer).toHaveValue("");
  await turn.reply("ok");

  // Ctrl+Enter is handled by the composer itself (on macOS the app's Mod key is Cmd).
  await composer.fill("second");
  await composer.press("Control+Enter");
  await expect.poll(() => sentPrompts(app)).toEqual(["line one\nline two", "second"]);
  await turn.reply("ok");
  // Shift+Mod+Enter is not a send.
  await composer.fill("third");
  await composer.press("ControlOrMeta+Shift+Enter");
  await app.nextFrame();
  expect(await sentPrompts(app)).toHaveLength(2);
});

test("Send is disabled for an empty or blank message, and Mod+Enter does nothing", async ({ app, page }) => {
  const { composer, composerSend } = await quietChat(app, page);
  await expect(composerSend).toBeDisabled();
  await composer.fill("   \n\t ");
  await expect(composerSend).toBeDisabled();
  await composer.press("ControlOrMeta+Enter");
  await composer.press("Control+Enter");
  await app.nextFrame();
  expect(await sentPrompts(app)).toEqual([]);
  await composer.fill("  padded  ");
  await expect(composerSend).toBeEnabled();
  await composerSend.click();
  // The prompt is trimmed before it is sent.
  await expect.poll(() => sentPrompts(app)).toEqual(["padded"]);
});

test("Up recalls the most recent send first", async ({ app, page }) => {
  test.fail(
    true,
    "known bug: composerHistory reverses scratch.history (already newest first) into oldest first, " +
      "but historyNavigate expects newest first, so Up recalls the oldest send (src/StartupForm.tsx:582)",
  );
  const { composer, turn } = await quietChat(app, page);
  for (const text of ["first prompt", "second prompt", "third prompt"]) {
    await composer.fill(text);
    await composer.press("ControlOrMeta+Enter");
    await expect(composer).toHaveValue("");
    await turn.reply("ok");
  }
  await composer.press("ArrowUp");
  await expect(composer).toHaveValue("third prompt");
});

test("Up/Down walk the history; the end of the list stops and Down past the start clears", async ({ app, page }) => {
  // Order-agnostic: two sends, so both directions are checked without depending on
  // which end Up starts from.
  const { composer, turn } = await quietChat(app, page);
  for (const text of ["alpha", "beta"]) {
    await composer.fill(text);
    await composer.press("ControlOrMeta+Enter");
    await expect(composer).toHaveValue("");
    await turn.reply("ok");
  }
  const seen: string[] = [];
  await composer.press("ArrowUp");
  seen.push(await composer.inputValue());
  // Move the caret back to the start so the next Up walks history (multi-line drafts keep Up for the caret).
  await composer.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(0, 0));
  await composer.press("ArrowUp");
  seen.push(await composer.inputValue());
  expect([...seen].sort()).toEqual(["alpha", "beta"]);
  // At the end of the list Up stays put.
  await composer.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(0, 0));
  await composer.press("ArrowUp");
  await expect(composer).toHaveValue(seen[1]);
  await composer.press("ArrowDown");
  await expect(composer).toHaveValue(seen[0]);
  await composer.press("ArrowDown");
  await expect(composer).toHaveValue("");
  // With no history entry selected, Down is left to the textarea.
  await composer.press("ArrowDown");
  await expect(composer).toHaveValue("");
});

test("Up does not replace a draft unless the caret is at its start", async ({ app, page }) => {
  const { composer, turn } = await quietChat(app, page);
  await composer.fill("sent before");
  await composer.press("ControlOrMeta+Enter");
  await turn.reply("ok");
  await composer.fill("line a\nline b");
  // Caret at the end of line b: Up moves the caret, the draft is kept.
  await composer.press("ArrowUp");
  await expect(composer).toHaveValue("line a\nline b");
  await composer.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(0, 0));
  await composer.press("ArrowUp");
  await expect(composer).toHaveValue("sent before");
});

test("a recalled entry can be edited and sent; history keeps one copy of each text", async ({ app, page }) => {
  const { composer, turn } = await quietChat(app, page);
  await composer.fill("run the tests");
  await composer.press("ControlOrMeta+Enter");
  await turn.reply("ok");

  await composer.press("ArrowUp");
  await expect(composer).toHaveValue("run the tests");
  await caretToEnd(composer);
  await composer.pressSequentially(" again");
  await composer.press("ControlOrMeta+Enter");
  await expect.poll(() => sentPrompts(app)).toEqual(["run the tests", "run the tests again"]);
  await turn.reply("ok");

  // Sending a text again does not add a duplicate (pushHistory moves it to the front).
  await composer.fill("run the tests");
  await composer.press("ControlOrMeta+Enter");
  await turn.reply("ok");
  const saved = await app.waitForCall("scratch_save", (a) => (a.history as string[]).length === 2);
  expect(saved.args.history).toEqual(["run the tests", "run the tests again"]);
});

test("history is saved with the pad and comes back after a reload", async ({ app, page }) => {
  const { composer, turn } = await quietChat(app, page);
  await composer.fill("remember me");
  await composer.press("ControlOrMeta+Enter");
  await turn.reply("ok");
  const saved = await app.waitForCall("scratch_save", (a) => (a.history as string[]).includes("remember me"));
  expect(saved.args).toMatchObject({ tabId: "tab-1", history: ["remember me"] });

  // The fake backend restarts empty on reload; the WebView mirror carries the history.
  await reload(page);
  await quietStart(app, page, "tab-1");
  await composer.press("ArrowUp");
  await expect(composer).toHaveValue("remember me");
});

test("history from scratch.json is offered by Up", async ({ app, page }) => {
  const { composer } = await quietChat(app, page, {
    responses: {
      scratch_load: {
        pads: [{ tabId: "tab-1", content: "", updatedAt: "2026-01-01T00:00:00Z", history: ["from disk"] }],
        knownTabIds: ["tab-1"],
      },
    },
  });
  await composer.press("ArrowUp");
  await expect(composer).toHaveValue("from disk");
  await composer.press("ArrowDown");
  await expect(composer).toHaveValue("");
});

test("a composer send keeps the composer read-only and the pad Send off until the turn ends", async ({ app, page }) => {
  const { composer, padSend, editor, turn, status } = await quietChat(app, page);
  await composer.fill("first");
  await composer.press("ControlOrMeta+Enter");
  await expect(status).toHaveText("Agent working…");
  await expect(composer).toHaveAttribute("readonly", "");
  await expect(composer).toHaveAttribute("aria-busy", "true");
  await editor.fill("queued idea");
  await expect(padSend).toBeDisabled();
  await editor.press("Control+Enter");
  await app.nextFrame();
  expect(await sentPrompts(app)).toEqual(["first"]);

  await turn.reply("done");
  await expect(composer).not.toHaveAttribute("readonly");
  await expect(padSend).toBeEnabled();
  // Nothing was queued: the pad text is still a draft.
  await expect(editor).toHaveValue("queued idea");
  expect(await sentPrompts(app)).toEqual(["first"]);
});

test("after a pad send, a composer Send during the turn is held back and the text stays", async ({ app, page }) => {
  const { composer, composerSend, editor, padSend, turn, status } = await quietChat(app, page);
  await editor.fill("from the pad");
  await padSend.click();
  await expect(status).toHaveText("Agent working…");
  await expect(editor).toHaveValue("");

  await composer.fill("follow-up while busy");
  await composerSend.click();
  await composer.press("ControlOrMeta+Enter");
  await app.nextFrame();
  expect(await sentPrompts(app)).toEqual(["from the pad"]);
  await expect(composer).toHaveValue("follow-up while busy");

  await turn.reply("done");
  await expect(status).toHaveText("Ready");
  // Nothing is queued: the held text goes only when sent again.
  await app.nextFrame();
  expect(await sentPrompts(app)).toEqual(["from the pad"]);
  await composerSend.click();
  await expect.poll(() => sentPrompts(app)).toEqual(["from the pad", "follow-up while busy"]);
});

test("a chain is not started while a turn is in flight", async ({ app, page }) => {
  const { editor, padSend, turn } = await quietChat(app, page);
  await editor.fill("busy");
  await padSend.click();
  await expect.poll(() => sentPrompts(app)).toEqual(["busy"]);
  await editor.fill("one\n---\ntwo");
  await padSend.click();
  await app.nextFrame();
  expect(await sentPrompts(app)).toEqual(["busy"]);
  await expect(editor).toHaveValue("one\n---\ntwo");
  await expect(page.getByText(/Waiting for this turn to end/)).toHaveCount(0);
  await turn.reply("ok");
});

test("pad Send while a pad-sent turn is in flight does not end the running turn", async ({ app, page }) => {
  test.fail(
    true,
    "known bug: after a pad send the pad Send stays enabled and sendFromPad does not check promptInFlight; " +
      "Rust rejects the second prompt and the catch in sendText sets promptInFlight false, so the running " +
      "turn looks finished (status Ready, Cancel disabled) (src/StartupForm.tsx:2157-2176, 2063-2072)",
  );
  const { editor, padSend, status } = await quietChat(app, page);
  await editor.fill("long job");
  await padSend.click();
  await expect(status).toHaveText("Agent working…");
  // What dev_session_send does in Rust while session.prompt_in_flight is set.
  await app.handle("dev_session_send", () => {
    throw new Error("a prompt is already running — wait or cancel the turn");
  });
  await editor.fill("one more thing");
  await padSend.click();
  await expect(page.getByText("a prompt is already running — wait or cancel the turn")).toBeVisible();
  // The rejected text goes back into the pad.
  await expect(editor).toHaveValue("one more thing");
  await expect(status).toHaveText("Agent working…", { timeout: 1000 });
  await expect(page.getByRole("button", { name: "Cancel turn" })).toBeEnabled({ timeout: 1000 });
});

