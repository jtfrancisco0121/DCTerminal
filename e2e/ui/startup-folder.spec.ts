import type { Page } from "@playwright/test";
import { CWD } from "./fixtures/data";
import { expect, roleTab, test } from "./fixtures/tauri";

// The folder picker on the "Start a session" card (src/components/FolderPicker.tsx, compact).

const OTHER = "/Users/e2e/Projects/other";

const startRow = (page: Page) => page.getByRole("group", { name: "Start a session" });
const folderButton = (page: Page) => startRow(page).getByRole("button", { name: /Choose folder…$/ });
const savedFolders = (page: Page) => page.getByRole("menu", { name: "Saved folders" });

test("Choose folder… asks the native dialog for a directory and uses the pick", async ({ app, page }) => {
  await app.open({
    handlers: { "plugin:dialog|open": () => "/Users/e2e/Projects/other" },
  });
  await expect(folderButton(page)).toHaveAccessibleName(`Working folder ${CWD}. Choose folder…`);
  await expect(folderButton(page)).toHaveText("demo");

  await folderButton(page).click();
  const dialog = await app.waitForCall("plugin:dialog|open");
  expect(dialog.args).toEqual({
    options: {
      directory: true,
      multiple: false,
      title: "Choose a working folder",
      defaultPath: CWD,
    },
  });
  await expect(folderButton(page)).toHaveAccessibleName(`Working folder ${OTHER}. Choose folder…`);
  await expect(folderButton(page)).toHaveText("other");
  await expect(folderButton(page)).toHaveAttribute("title", OTHER);
  // The history panel follows the folder.
  await app.waitForCall("list_claude_history", (args) => args.cwd === OTHER);

  // Start sends the picked folder.
  await app.start("tab-1");
  const start = await app.waitForCall("role_session_start");
  expect((start.args.values as Record<string, string>).cwd).toBe(OTHER);
});

test("Choose folder…: a cancelled dialog keeps the folder; a dialog error is shown", async ({
  app,
  page,
}) => {
  await app.open({ handlers: { "plugin:dialog|open": () => null } });
  await folderButton(page).click();
  await app.waitForCall("plugin:dialog|open");
  await expect(folderButton(page)).toHaveAccessibleName(`Working folder ${CWD}. Choose folder…`);

  await app.handle("plugin:dialog|open", () => {
    throw new Error("dialog is unavailable");
  });
  await folderButton(page).click();
  await expect(page.locator(".folder-picker").getByText("dialog is unavailable")).toBeVisible();
  await expect(folderButton(page)).toHaveText("demo");
});

test("Recent menu reloads the saved folders each time it opens and picks one", async ({ app, page }) => {
  await app.open();
  const recent = startRow(page).getByRole("button", { name: "Recent" });
  await expect(recent).toHaveAttribute("aria-expanded", "false");
  await recent.click();
  await expect(recent).toHaveAttribute("aria-expanded", "true");
  await expect(savedFolders(page).getByRole("menuitem")).toHaveText([CWD]);
  await recent.click();
  await expect(savedFolders(page)).toBeHidden();

  // Another tab opened a folder in the meantime; the menu shows it without a remount.
  const before = (await app.calls("projects_list")).length;
  await app.respond("projects_list", {
    favorites: [],
    recent: [
      { path: OTHER, available: true, favorite: false },
      { path: CWD, available: true, favorite: false },
      { path: "/Users/e2e/Projects/gone", available: false, favorite: false },
    ],
  });
  await recent.click();
  await expect.poll(async () => (await app.calls("projects_list")).length).toBeGreaterThan(before);
  await expect(savedFolders(page).getByRole("menuitem")).toHaveText([
    OTHER,
    CWD,
    "/Users/e2e/Projects/gone (unavailable)",
  ]);

  await savedFolders(page).getByRole("menuitem", { name: OTHER }).click();
  await expect(savedFolders(page)).toBeHidden();
  await expect(folderButton(page)).toHaveAccessibleName(`Working folder ${OTHER}. Choose folder…`);
  // Picking only fills the field; nothing starts.
  expect(await app.calls("role_session_start")).toHaveLength(0);
});

test("Recent menu: Remove forgets a folder and the list refreshes", async ({ app, page }) => {
  await app.open({
    handlers: {
      projects_list: (_a, s) => {
        s.e2eRecent ??= [
          { path: "/Users/e2e/Projects/demo", available: true, favorite: false },
          { path: "/Users/e2e/Projects/other", available: true, favorite: false },
        ];
        return { favorites: [], recent: s.e2eRecent };
      },
      projects_remove: (a, s) => {
        s.e2eRecent = s.e2eRecent.filter((p: { path: string }) => p.path !== a.path);
        return null;
      },
    },
  });
  await startRow(page).getByRole("button", { name: "Recent" }).click();
  const menu = savedFolders(page);
  await expect(menu.getByRole("menuitem")).toHaveText([CWD, OTHER]);
  await menu.getByRole("listitem").filter({ hasText: OTHER }).getByRole("button", { name: "Remove" }).click();
  const removed = await app.waitForCall("projects_remove");
  expect(removed.args).toEqual({ path: OTHER, favorite: false });
  await expect(menu.getByRole("menuitem")).toHaveText([CWD]);
});

test("the star favorites the working folder and the menu lists it under Favorites", async ({
  app,
  page,
}) => {
  await app.open({
    handlers: {
      projects_list: (_a, s) => ({
        favorites: (s.e2eFavorites ?? []).map((path: string) => ({ path, available: true, favorite: true })),
        recent: [{ path: s.cwd, available: true, favorite: false }],
      }),
      projects_toggle_favorite: (a, s) => {
        const favs: string[] = (s.e2eFavorites ??= []);
        const on = !favs.includes(a.path);
        s.e2eFavorites = on ? [...favs, a.path] : favs.filter((p) => p !== a.path);
        return on;
      },
    },
  });
  const star = startRow(page).getByRole("button", { name: "Star as favorite" });
  await expect(star).toHaveAttribute("aria-pressed", "false");
  await expect(star).toHaveText("☆");
  await star.click();

  const toggled = await app.waitForCall("projects_toggle_favorite");
  expect(toggled.args).toEqual({ path: CWD });
  const unstar = startRow(page).getByRole("button", { name: "Remove favorite" });
  await expect(unstar).toHaveAttribute("aria-pressed", "true");
  await expect(unstar).toHaveText("★");

  await startRow(page).getByRole("button", { name: "Recent" }).click();
  await expect(savedFolders(page).locator(".folder-picker-heading")).toHaveText(["Favorites", "Recent"]);
  await expect(savedFolders(page).getByRole("menuitem")).toHaveText([CWD, CWD]);

  await unstar.click();
  await expect(startRow(page).getByRole("button", { name: "Star as favorite" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(savedFolders(page).locator(".folder-picker-heading")).toHaveText(["Recent"]);
  expect(await app.calls("projects_toggle_favorite")).toHaveLength(2);
});

test("Enter path + Use path: empty and invalid paths show errors, a valid one is used", async ({
  app,
  page,
}) => {
  await app.open({
    handlers: {
      check_working_folder: (a) => {
        if (a.path === "/nope") {
          throw new Error("Working folder was not found (it may have been moved or deleted): /nope");
        }
        return a.path;
      },
    },
  });
  await startRow(page).getByRole("button", { name: "Recent" }).click();
  const menu = savedFolders(page);
  const input = menu.getByRole("textbox", { name: "Enter a folder path" });
  const use = menu.getByRole("button", { name: "Use path" });

  // Blank: rejected locally, the backend is not asked.
  await input.fill("   ");
  await use.click();
  await expect(page.locator(".folder-picker").getByText("Enter a folder path.")).toBeVisible();
  expect(await app.calls("check_working_folder")).toHaveLength(0);

  // Missing folder: the backend's message, and the folder is unchanged.
  await input.fill("/nope");
  await input.press("Enter");
  await expect(
    page.getByText("Working folder was not found (it may have been moved or deleted): /nope"),
  ).toBeVisible();
  await expect(menu).toBeVisible();
  await expect(folderButton(page)).toHaveText("demo");

  // Valid (trimmed before the check).
  await input.fill(`  ${OTHER}  `);
  await use.click();
  const checked = await app.waitForCall("check_working_folder", (args) => args.path !== "/nope");
  expect(checked.args).toEqual({ path: OTHER });
  await expect(menu).toBeHidden();
  await expect(page.getByText(/Working folder was not found/)).toBeHidden();
  await expect(folderButton(page)).toHaveAccessibleName(`Working folder ${OTHER}. Choose folder…`);
});

test("working-folder label: a blank tab asks for a folder, then shows the chosen one's name", async ({
  app,
  page,
}) => {
  await app.open({
    tabs: [roleTab("tab-1", "role_general", "General", { cwd: "", folderStatus: "empty" })],
    handlers: { "plugin:dialog|open": () => "/Users/e2e/Projects/other/" },
  });
  const button = startRow(page).getByRole("button", { name: "Choose folder…", exact: true });
  await expect(button).toHaveText("Choose folder…");
  await expect(startRow(page).getByRole("button", { name: "Star as favorite" })).toBeDisabled();
  // No folder yet: no form fields and no history panel.
  await expect(page.getByRole("button", { name: "Validate & preview" })).toBeHidden();
  await expect(page.getByRole("region", { name: "Claude Code history" })).toBeHidden();

  await button.click();
  // The name is the last path segment, ignoring a trailing slash.
  await expect(folderButton(page)).toHaveText("other");
  await expect(folderButton(page)).toHaveAccessibleName(
    "Working folder /Users/e2e/Projects/other/. Choose folder…",
  );
  await expect(startRow(page).getByRole("button", { name: "Star as favorite" })).toBeEnabled();
});

test("working-folder label: a folder that went missing is marked unavailable", async ({ app, page }) => {
  await app.open({
    tabs: [roleTab("tab-1", "role_general", "General", { folderStatus: "missing" })],
  });
  await expect(folderButton(page)).toContainText("unavailable");
  await expect(
    page.getByText(`Working folder was not found (it may have been moved or deleted): ${CWD}`),
  ).toBeVisible();
});
