import type { Page } from "@playwright/test";
import { expect, roleTab, test, type TauriApp } from "./fixtures/tauri";

// Accessibility smoke for the main screens: every interactive control must
// have an accessible name. Uses Playwright's own accessibility tree
// (ariaSnapshot), so no extra dependency. Named nodes print as
// `- button "Name"`; unnamed ones as `- button`, `- button [disabled]`,
// or `- textbox: value`.

const INTERACTIVE = [
  "button",
  "checkbox",
  "combobox",
  "link",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
];
const UNNAMED = new RegExp(`^\\s*- (${INTERACTIVE.join("|")})(?=$|[\\s:\\[])(?! ")`);

async function unnamedControls(page: Page): Promise<string[]> {
  const tree = await page.locator("body").ariaSnapshot();
  return tree.split("\n").filter((line) => UNNAMED.test(line)).map((line) => line.trim());
}

async function expectAllNamed(page: Page) {
  // Let the screen settle first so a half-rendered tree is not judged.
  await expect.poll(() => unnamedControls(page)).toEqual([]);
  const tree = await page.locator("body").ariaSnapshot();
  // Sanity check that the tree was read at all.
  expect(tree).toMatch(/- button "/);
}

test("start form: every control is named", async ({ app, page }) => {
  await app.open();
  await expect(page.getByRole("button", { name: "Start", exact: true })).toBeVisible();
  await expectAllNamed(page);
});

test("chat with a permission card and a background toast: every control is named", async ({ app, page }) => {
  await app.open({
    tabs: [roleTab("tab-1", "role_general", "Alpha"), roleTab("tab-2", "role_general", "Beta")],
    responses: { get_notification_settings: { enabled: true, system: false, toastWhenFocused: true } },
  });
  await app.start("tab-1");
  await page.getByRole("tab", { name: /^Beta/ }).click();
  const beta = await app.start("tab-2");
  await beta.chunk("Checking the build");
  await beta.toolCall({ id: "t1", title: "Run build", kind: "execute", input: { command: "npm run build" } });
  await beta.permission("Run npm run build");
  await app.turn("tab-1").reply("Alpha is done.");
  await expect(page.getByRole("dialog", { name: "Run npm run build" })).toBeVisible();
  await expect(page.locator(".agent-toast")).toHaveCount(1);
  await expectAllNamed(page);
});

const cardScreens: { name: string; role: string; raise: (app: TauriApp) => Promise<void>; visible: (page: Page) => ReturnType<Page["getByRole"]> }[] = [
  {
    name: "question card",
    role: "role_general",
    raise: (app) =>
      app.turn("tab-1").question("Which package manager?", [
        { id: "npm", label: "npm" },
        { id: "pnpm", label: "pnpm" },
      ]),
    visible: (page) => page.getByRole("dialog", { name: "Question" }),
  },
  {
    name: "plan card",
    role: "role_planner",
    raise: async (app) => {
      await app.turn("tab-1").chunk("## Plan\n1. Add tests");
      await app.turn("tab-1").plan("## Plan\n1. Add tests");
    },
    visible: (page) => page.getByRole("button", { name: "Keep planning" }),
  },
];

for (const screen of cardScreens) {
  test(`chat with a ${screen.name}: every control is named`, async ({ app, page }) => {
    await app.open({ tabs: [roleTab("tab-1", screen.role, "Work")] });
    await app.start("tab-1");
    await screen.raise(app);
    await expect(screen.visible(page)).toBeVisible();
    await expectAllNamed(page);
  });
}

test("settings and the role editor: every control is named", async ({ app, page }) => {
  await app.open();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("region", { name: "Roles" })).toBeVisible();
  await expectAllNamed(page);
});

test("grid view: every control is named", async ({ app, page }) => {
  await app.open({
    tabs: [roleTab("tab-1", "role_general", "Alpha"), roleTab("tab-2", "role_general", "Beta")],
  });
  await (await app.start("tab-1")).reply("alpha ready");
  await page.getByRole("tab", { name: /^Beta/ }).click();
  await (await app.start("tab-2")).reply("beta ready");
  await page.getByRole("button", { name: "Grid view" }).click();
  await expect(page.getByLabel("Grid cell: Alpha")).toBeVisible();
  await expectAllNamed(page);
});
