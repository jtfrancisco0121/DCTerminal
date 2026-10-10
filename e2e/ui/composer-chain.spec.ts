// Scratch pad `---` chains (runChain in src/StartupForm.tsx, cursor rules in
// src/scratch/pad.ts, turn waits in src/scratch/turnWait.ts).
import { expect, test } from "./fixtures/tauri";
import { caretToEnd, PNG_1X1, quietChat, readyChat, sentPrompts } from "./composer-helpers";

const THREE_STEPS = "Plan the change\n---\nWrite the code\n---\nRun the tests";

test("each step waits for the previous turn; the pad clears when the chain is done", async ({ app, page }) => {
  const { turn, editor, pad, padSend, status } = await quietChat(app, page);
  await editor.fill(THREE_STEPS);
  await expect(padSend).toHaveText("Send steps");
  await expect(pad).toContainText("--- starts the next step after the turn ends");
  await padSend.click();

  await expect.poll(() => sentPrompts(app)).toEqual(["Plan the change"]);
  await expect(pad.getByText("Waiting for this turn to end (1/3).")).toBeVisible();
  await expect(pad.getByRole("button", { name: "Stop chain" })).toBeVisible();
  await expect(status).toHaveText("Agent working…");
  // Streaming is not the end of the turn: the next step is held back.
  await turn.chunk("Planning…");
  await app.nextFrame();
  expect(await sentPrompts(app)).toEqual(["Plan the change"]);
  await expect(editor).toHaveValue(THREE_STEPS);

  await turn.finish();
  await expect.poll(() => sentPrompts(app)).toEqual(["Plan the change", "Write the code"]);
  await expect(pad.getByText("Waiting for this turn to end (2/3).")).toBeVisible();
  await expect(editor).toHaveValue(THREE_STEPS);

  await turn.reply("Code written.");
  await expect.poll(() => sentPrompts(app)).toEqual(["Plan the change", "Write the code", "Run the tests"]);
  await expect(pad.getByText("Waiting for this turn to end (3/3).")).toBeVisible();

  await turn.reply("All green.");
  await expect(editor).toHaveValue("");
  await expect(pad.getByRole("button", { name: "Stop chain" })).toBeHidden();
  await expect(pad.locator(".scratch-pad-status")).toHaveCount(0);
  await expect(status).toHaveText("Ready");
  expect(await sentPrompts(app)).toHaveLength(3);
  // Every step is a normal send: recorded in Recent sends, from the chat.
  const recorded = (await app.calls("prompt_record_send")).map((c) => c.args);
  expect(recorded).toEqual([
    { text: "Plan the change", source: "chat" },
    { text: "Write the code", source: "chat" },
    { text: "Run the tests", source: "chat" },
  ]);
});

test("a failed step stops the chain and keeps the pad", async ({ app, page }) => {
  const { turn, editor, pad } = await quietChat(app, page);
  await editor.fill(THREE_STEPS);
  await pad.getByRole("button", { name: "Send steps" }).click();
  await expect.poll(() => sentPrompts(app)).toEqual(["Plan the change"]);

  await turn.fail("rate limited");
  await expect(pad.getByText("Chain stopped (error).")).toBeVisible();
  await expect(page.getByText("rate limited")).toBeVisible();
  await expect(editor).toHaveValue(THREE_STEPS);
  await app.nextFrame();
  expect(await sentPrompts(app)).toEqual(["Plan the change"]);
  await expect(pad.getByRole("button", { name: "Stop chain" })).toBeHidden();
});

test("a refusal stop reason counts as a failed step", async ({ app, page }) => {
  const { turn, editor, pad } = await quietChat(app, page);
  await editor.fill("one\n---\ntwo");
  await pad.getByRole("button", { name: "Send steps" }).click();
  await expect.poll(() => sentPrompts(app)).toEqual(["one"]);
  await turn.finish("refusal");
  await expect(pad.getByText("Chain stopped (error).")).toBeVisible();
  expect(await sentPrompts(app)).toEqual(["one"]);
  await expect(editor).toHaveValue("one\n---\ntwo");
});

test("Stop chain cancels the turn and sends nothing more", async ({ app, page }) => {
  const { turn, editor, pad } = await quietChat(app, page);
  await editor.fill(THREE_STEPS);
  await pad.getByRole("button", { name: "Send steps" }).click();
  await expect.poll(() => sentPrompts(app)).toEqual(["Plan the change"]);

  await pad.getByRole("button", { name: "Stop chain" }).click();
  await app.waitForCall("dev_session_cancel");
  await expect(pad.getByText("Chain stopped (cancelled).")).toBeVisible();
  // The agent acknowledges the cancel the way ACP does.
  await turn.finish("cancelled");
  await expect(page.locator(".status-bar-status")).toHaveText("Ready");
  await app.nextFrame();
  expect(await sentPrompts(app)).toEqual(["Plan the change"]);
  await expect(editor).toHaveValue(THREE_STEPS);
});

test("a pad edited while the chain runs is not cleared at the end", async ({ app, page }) => {
  const { turn, editor, pad } = await quietChat(app, page);
  await editor.fill("first\n---\nsecond");
  await pad.getByRole("button", { name: "Send steps" }).click();
  await expect.poll(() => sentPrompts(app)).toEqual(["first"]);

  await caretToEnd(editor);
  await editor.pressSequentially("\nnotes for later");
  await turn.reply("one");
  await expect.poll(() => sentPrompts(app)).toEqual(["first", "second"]);
  await turn.reply("two");
  await expect(pad.locator(".scratch-pad-status")).toHaveCount(0);
  await expect(editor).toHaveValue("first\n---\nsecond\nnotes for later");
});

test("a permission request pauses the chain until the turn ends", async ({ app, page }) => {
  const { turn, editor, pad } = await quietChat(app, page);
  await editor.fill("step A\n---\nstep B");
  await pad.getByRole("button", { name: "Send steps" }).click();
  await expect.poll(() => sentPrompts(app)).toEqual(["step A"]);

  await turn.permission("Run npm test");
  await expect(
    pad.getByText("Chain paused until the permission request finishes. The next step is not sent yet."),
  ).toBeVisible();
  // The pad cannot send while a permission card waits.
  await expect(pad.getByRole("button", { name: "Send steps" })).toBeDisabled();
  await page.getByRole("button", { name: "Allow once" }).click();
  await app.waitForCall("respond_permission_request");
  expect(await sentPrompts(app)).toEqual(["step A"]);

  await turn.reply("Tests pass.");
  await expect.poll(() => sentPrompts(app)).toEqual(["step A", "step B"]);
  await turn.reply("Done.");
  await expect(editor).toHaveValue("");
});

test("pasted images go with the first step only", async ({ app, page }) => {
  const { turn, editor, pad } = await quietChat(app, page);
  await app.pasteImage(editor, { name: "ui.png", mime: "image/png", base64: PNG_1X1 });
  await expect(pad.getByRole("list", { name: "Attached images" }).getByRole("listitem")).toHaveCount(1);
  await editor.fill("look at this\n---\nnow fix it");
  await pad.getByRole("button", { name: "Send steps" }).click();

  const first = await app.waitForCall("dev_session_send");
  expect(first.args).toEqual({ prompt: "look at this", tabId: "tab-1", attachments: ["att-1"] });
  await expect(page.getByRole("list", { name: "Attached images" })).toHaveCount(0);
  await turn.reply("I see it.");
  const second = await app.waitForCall("dev_session_send", (a) => a.prompt === "now fix it");
  expect(second.args.attachments).toBeNull();
  await turn.reply("Fixed.");
  await expect(editor).toHaveValue("");
});

test("a chain with a /model step: the alert shows and Send steps is disabled", async ({ app, page }) => {
  const { editor, pad } = await quietChat(app, page);
  await editor.fill("tidy up\n---\n/model opus");
  await expect(pad.getByRole("alert")).toHaveText("/model is not sent from DCTerminal. Use the model picker.");
  await expect(pad.getByRole("button", { name: "Send steps" })).toBeDisabled();
  // Ctrl+Enter handled by the pad itself (on macOS Ctrl is not the app's Mod key) is refused too.
  await editor.press("Control+Enter");
  await app.nextFrame();
  expect(await sentPrompts(app)).toEqual([]);
  await expect(editor).toHaveValue("tidy up\n---\n/model opus");
});

test("a chain with a /model step: the Mod+Enter shortcut sends nothing either", async ({ app, page }) => {
  const { editor, pad } = await quietChat(app, page);
  await editor.fill("tidy up\n---\n/model opus");
  await expect(pad.getByRole("button", { name: "Send steps" })).toBeDisabled();
  await editor.press("ControlOrMeta+Enter");
  await app.nextFrame();
  await app.nextFrame();
  expect(await sentPrompts(app)).toEqual([]);
});

test("trailing separators: a pad with one real step sends just that step", async ({ app, page }) => {
  const { turn, editor, pad } = await quietChat(app, page);
  await editor.fill("only step\n-----\n   \n---");
  await expect(pad.getByRole("button", { name: "Send steps" })).toBeVisible();
  await pad.getByRole("button", { name: "Send steps" }).click();
  await expect.poll(() => sentPrompts(app)).toHaveLength(1);
  await expect(editor).toHaveValue("");
  await turn.reply("ok");
  expect(await sentPrompts(app)).toEqual(["only step"]);
});

test("after an earlier turn, step 2 still waits for step 1 to finish", async ({ app, page }) => {
  // The usual path: the startup turn runs and finishes before the chain.
  const { editor, pad } = await readyChat(app, page);
  await editor.fill("first\n---\nsecond");
  await pad.getByRole("button", { name: "Send steps" }).click();
  await expect.poll(async () => (await sentPrompts(app)).length).toBeGreaterThan(0);
  await app.nextFrame();
  await app.nextFrame();
  expect(await sentPrompts(app)).toEqual(["first"]);
});
