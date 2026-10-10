import { expect, test } from "./fixtures/tauri";
import { chord, expectActive, namedTabs, startReady } from "./tabs-helpers";

// Every binding in src/keymap.ts that works in a browser page. The pane and
// grid chords (Mod+\, Mod+Alt+\ / S / O / W / G) are in tabs-split.spec.ts,
// Mod+T / Mod+W / F2 / F6 in tabs.spec.ts, Mod+K / Mod+P / Mod+/ in
// tabs-palette.spec.ts. Terminal chords (Mod+Shift+` / .) need a PTY and are
// left to the terminal suite.

test("Mod+PageDown / PageUp / Tab / Shift+Tab cycle tabs and wrap", async ({ app, page }) => {
  await app.open({ tabs: namedTabs(3) });
  await chord(page, "PageDown");
  await expectActive(page, "Beta");
  await chord(page, "Tab");
  await expectActive(page, "Gamma");
  await chord(page, "PageDown");
  await expectActive(page, "Alpha");
  await chord(page, "PageUp");
  await expectActive(page, "Gamma");
  await chord(page, "Shift+Tab");
  await expectActive(page, "Beta");
});

test("Mod+1…9 jump to a tab by position; a missing position does nothing", async ({ app, page }) => {
  await app.open({ tabs: namedTabs(3) });
  await chord(page, "Digit3");
  await expectActive(page, "Gamma");
  await chord(page, "Digit1");
  await expectActive(page, "Alpha");
  const before = (await app.calls("select_active_tab")).length;
  await chord(page, "Digit9");
  await chord(page, "Digit2");
  await expectActive(page, "Beta");
  // Only Mod+1 and Mod+2 selected anything after the first two jumps.
  expect((await app.calls("select_active_tab")).length).toBe(before + 1);
});

test("Mod+J, Mod+. , Mod+L and Mod+Enter move text from the pad to the agent", async ({ app, page }) => {
  await app.open();
  await startReady(app, page, "tab-1", "ready");
  const pad = page.getByRole("textbox", { name: "Scratch pad editor" });
  const composer = page.getByRole("textbox", { name: "Follow-up message" });

  await chord(page, "KeyJ");
  await expect(pad).toBeFocused();
  await pad.pressSequentially("check the logs");
  await chord(page, "Period");
  await expect(composer).toHaveValue("check the logs");

  await pad.focus();
  await chord(page, "KeyL");
  await expect(composer).toBeFocused();
  await chord(page, "Enter");
  const send = await app.waitForCall("dev_session_send");
  expect(send.args).toMatchObject({ prompt: "check the logs", tabId: "tab-1" });
  await expect(composer).toHaveValue("");
});

test("Escape cancels a running turn; with nothing running it does not", async ({ app, page }) => {
  await app.open();
  const turn = await app.start("tab-1");
  await turn.chunk("working");
  await page.keyboard.press("Escape");
  const cancel = await app.waitForCall("dev_session_cancel");
  expect(cancel.args).toMatchObject({ tabId: "tab-1" });
  await turn.finish("cancelled");
  await expect(page.locator(".status-bar-status")).toHaveText("Ready");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Cancel turn" })).toBeDisabled();
  expect(await app.calls("dev_session_cancel")).toHaveLength(1);
});

test("Mod+B toggles the file panel and saves it in the layout", async ({ app, page }) => {
  await app.open({
    responses: {
      files_list: {
        root: "/Users/e2e/Projects/demo",
        path: "",
        entries: [{ name: "README.md", path: "README.md", isDir: false, size: 12 }],
        truncated: false,
      },
    },
  });
  const files = page.getByRole("complementary", { name: "Files" });
  await chord(page, "KeyB");
  await expect(files).toBeVisible();
  await expect(files.getByText("README.md")).toBeVisible();
  await app.waitForCall("set_layout", (args) => (args.layout as { filePanelOpen: boolean }).filePanelOpen);
  await chord(page, "KeyB");
  await expect(files).toHaveCount(0);
  await app.waitForCall("set_layout", (args) => !(args.layout as { filePanelOpen: boolean }).filePanelOpen);
});

test("Mod+, opens and closes Settings", async ({ app, page }) => {
  await app.open();
  const gear = page.getByRole("button", { name: "Settings", exact: true });
  await expect(gear).toHaveAttribute("aria-pressed", "false");
  await chord(page, "Comma");
  await expect(gear).toHaveAttribute("aria-pressed", "true");
  await chord(page, "Comma");
  await expect(gear).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("heading", { name: "Start a session" })).toBeVisible();
});

test("Mod+F finds in a running chat; Mod+Shift+F searches every chat", async ({ app, page }) => {
  await app.open({ tabs: namedTabs(2) });
  // A draft tab has no chat to search, so Mod+F falls back to Search all chats.
  await chord(page, "KeyF");
  const search = page.getByRole("dialog", { name: "Search chats" });
  await expect(search).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(search).toHaveCount(0);

  await startReady(app, page, "tab-1", "needle in the haystack");
  await chord(page, "KeyF");
  const find = page.getByRole("searchbox", { name: "Find in chat" });
  await expect(find).toBeFocused();
  await expect(search).toHaveCount(0);
  await page.getByRole("button", { name: "Close find" }).click();
  await expect(find).toHaveCount(0);

  await chord(page, "Shift+KeyF");
  await expect(search).toBeVisible();
  await expect(search.getByRole("searchbox", { name: "Search chats" })).toBeFocused();
});

test("Mod+Shift+N asks for a new window", async ({ app, page }) => {
  await app.open();
  await chord(page, "Shift+KeyN");
  const opened = await app.waitForCall("open_account_window");
  expect(opened.args).toEqual({ accountId: "default" });
});
