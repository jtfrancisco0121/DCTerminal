import { expect, roleTab, test, type TauriApp } from "./fixtures/tauri";
import type { Page } from "@playwright/test";

async function twoReadyTabsInGrid(app: TauriApp, page: Page) {
  await app.open({
    tabs: [roleTab("tab-1", "role_general", "Alpha"), roleTab("tab-2", "role_general", "Beta")],
  });
  await (await app.start("tab-1")).reply("alpha ready");
  await page.getByRole("tab", { name: "Beta" }).click();
  await (await app.start("tab-2")).reply("beta ready");
  await expect(page.locator(".status-bar-status")).toHaveText("Ready");
  await page.getByRole("button", { name: "Grid view" }).click();
}

const cellFor = (page: Page, name: string) =>
  page.locator("[data-pane]").filter({ has: page.getByRole("heading", { name, level: 2 }) });

test("grid view: every tab gets a cell whose input sends to that tab", async ({ app, page }) => {
  await twoReadyTabsInGrid(app, page);
  await expect(page.getByRole("button", { name: "Close grid view" })).toHaveAttribute("aria-pressed", "true");
  const layout = await app.waitForCall("set_layout", (args) =>
    ((args.layout as { gridTabIds?: string[] }).gridTabIds ?? []).length === 2,
  );
  expect((layout.args.layout as { gridTabIds: string[] }).gridTabIds.sort()).toEqual(["tab-1", "tab-2"]);

  // The active tab is the primary pane; the others are labelled "Grid cell: <tab>".
  await expect(page.locator('[data-pane="primary"]').getByRole("heading", { name: "Beta" })).toBeVisible();
  await expect(page.getByLabel("Grid cell: Alpha")).toBeVisible();
  const alpha = cellFor(page, "Alpha");
  const beta = cellFor(page, "Beta");
  await expect(beta.getByRole("heading", { name: "Beta" })).toBeVisible();
  await expect(alpha.getByRole("heading", { name: "Alpha" })).toBeVisible();
  await expect(alpha.getByRole("log")).toContainText("alpha ready");
  await expect(beta.getByRole("log")).toContainText("beta ready");

  // Clicking into a cell makes its tab active (see the focus bug test below).
  const alphaInput = alpha.getByRole("textbox", { name: "Follow-up message" });
  await alphaInput.click();
  await expect(page.getByRole("tab", { name: "Alpha" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("Grid cell: Beta")).toBeVisible();
  await alphaInput.fill("to alpha");
  await alpha.getByRole("button", { name: "Send", exact: true }).first().click();
  const toAlpha = await app.waitForCall("dev_session_send");
  expect(toAlpha.args).toMatchObject({ prompt: "to alpha", tabId: "tab-1" });
  await expect(alpha.getByRole("log")).toContainText("to alpha");
  await expect(beta.getByRole("log")).not.toContainText("to alpha");

  const betaInput = beta.getByRole("textbox", { name: "Follow-up message" });
  await betaInput.click();
  await expect(page.getByRole("tab", { name: "Beta" })).toHaveAttribute("aria-selected", "true");
  await betaInput.fill("to beta");
  await beta.getByRole("button", { name: "Send", exact: true }).first().click();
  const toBeta = await app.waitForCall("dev_session_send", (args) => args.prompt === "to beta");
  expect(toBeta.args.tabId).toBe("tab-2");

  // A reply on one tab lands only in that tab's cell.
  await app.turn("tab-1").reply("alpha answer");
  await expect(alpha.getByRole("log")).toContainText("alpha answer");
  await expect(beta.getByRole("log")).not.toContainText("alpha answer");

  await page.getByRole("button", { name: "Close grid view" }).click();
  await expect(page.locator('[data-pane^="grid"]')).toHaveCount(0);
  await expect(alpha).toHaveCount(0);
});

// Known bug: the inactive cell's composer is replaced by the active pane's
// composer when the click activates the tab (renderGridCell → handleSelectTab in
// StartupForm.tsx), so focus falls back to <body> and the first keystrokes are lost.
test("clicking an inactive cell's composer leaves focus in it", async ({ app, page }) => {
  test.fail(true, "known bug: focus is lost when a grid cell becomes the active tab");
  await twoReadyTabsInGrid(app, page);
  const alphaInput = cellFor(page, "Alpha").getByRole("textbox", { name: "Follow-up message" });
  await alphaInput.click();
  await expect(page.getByRole("tab", { name: "Alpha" })).toHaveAttribute("aria-selected", "true");
  await expect(alphaInput).toBeFocused({ timeout: 1000 });
});
