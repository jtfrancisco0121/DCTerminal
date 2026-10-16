import { expect, test } from "./fixtures/tauri";
import { CWD } from "./fixtures/data";
import { chord, expectActive } from "./tabs-helpers";

// Mod+T follows Settings › Terminal › "New tab opens". With "Ask" (the app's
// default) it shows the new-tab picker; the fixture default is "start".

const picker = (page: import("@playwright/test").Page) => page.getByRole("dialog", { name: "New tab" });

test("Mod+T asks, and C opens Claude in the active tab's folder", async ({ app, page }) => {
  await app.open({ newTabOpens: "ask" });
  await chord(page, "KeyT");
  const dialog = picker(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("listbox", { name: "Open in the new tab" })).toBeFocused();
  await expect(dialog.getByRole("option", { name: /Claude here/ })).toContainText("demo");
  await page.keyboard.press("c");
  const start = await app.waitForCall("shell_terminal_start");
  expect(start.args).toMatchObject({ input: { launch: "claude-cli", cwd: CWD, tabId: null } });
  await expect(dialog).toHaveCount(0);
  await expectActive(page, "Claude Code · demo");
});

test("S opens a shell; arrows and Enter pick a row; Esc closes", async ({ app, page }) => {
  await app.open({ newTabOpens: "ask" });
  await chord(page, "KeyT");
  await page.keyboard.press("Escape");
  await expect(picker(page)).toHaveCount(0);
  expect(await app.calls("shell_terminal_start")).toHaveLength(0);

  await chord(page, "KeyT");
  // Wait for the folder, so the rows act on a loaded picker.
  await expect(picker(page).getByRole("option", { name: /Shell here/ })).toContainText("demo");
  await page.keyboard.press("ArrowDown");
  await expect(picker(page).getByRole("option", { name: /Shell here/ })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  const start = await app.waitForCall("shell_terminal_start");
  expect(start.args).toMatchObject({ input: { launch: "shell", cwd: CWD } });
});

test("R opens the role launcher, whose pick opens a draft tab", async ({ app, page }) => {
  await app.open({ newTabOpens: "ask" });
  await chord(page, "KeyT");
  await page.keyboard.press("r");
  await expect(picker(page)).toHaveCount(0);
  const launcher = page.getByRole("dialog", { name: "New tab with role" });
  await expect(launcher).toBeVisible();
  expect(await app.calls("new_draft_tab")).toHaveLength(0);
  await page.keyboard.press("Enter");
  await expect(launcher).toHaveCount(0);
  await app.waitForCall("new_draft_tab");
  expect(await app.calls("shell_terminal_start")).toHaveLength(0);
});

test("a number opens Claude in that recent project", async ({ app, page }) => {
  await app.open({
    newTabOpens: "ask",
    responses: {
      projects_list: {
        favorites: [],
        recent: [
          { path: "/Users/e2e/Projects/api", available: true, favorite: false },
          { path: "/Users/e2e/Projects/web", available: true, favorite: false },
        ],
      },
    },
  });
  await chord(page, "KeyT");
  await expect(picker(page).getByText("Recent projects")).toBeVisible();
  await page.keyboard.press("2");
  const start = await app.waitForCall("shell_terminal_start");
  expect(start.args).toMatchObject({ input: { launch: "claude-cli", cwd: "/Users/e2e/Projects/web" } });
});

test("Don't ask again saves Claude as the new-tab choice", async ({ app, page }) => {
  await app.open({ newTabOpens: "ask" });
  await chord(page, "KeyT");
  await picker(page).getByRole("checkbox", { name: /Don't ask again/ }).check();
  const saved = await app.waitForCall("set_terminal_settings");
  expect(saved.args).toMatchObject({ terminal: { newTabOpens: "claude" } });
});

test("with Claude chosen, Mod+T opens Claude straight away", async ({ app, page }) => {
  await app.open({ newTabOpens: "claude" });
  await chord(page, "KeyT");
  const start = await app.waitForCall("shell_terminal_start");
  expect(start.args).toMatchObject({ input: { launch: "claude-cli", cwd: CWD } });
  await expect(picker(page)).toHaveCount(0);
});

test("with Start screen chosen, Mod+T opens the start screen", async ({ app, page }) => {
  await app.open({ newTabOpens: "start" });
  await chord(page, "KeyT");
  await app.waitForCall("new_draft_tab");
  await expect(picker(page)).toHaveCount(0);
  expect(await app.calls("shell_terminal_start")).toHaveLength(0);
});
