import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/tauri";
import {
  cellTops,
  chord,
  expectActive,
  layoutWhere,
  namedTabs,
  rowsOf,
  startReady,
  tabChip,
} from "./tabs-helpers";

// The classic split (WorkspaceSplit) and the grid's limits and layout.
// Basic grid send routing and focus are in grid.spec.ts.
// Sources: src/tabChrome.ts (openGrid, addToGrid, removeFromGrid, gridRows,
// reconcileSplit/reconcileGrid, swapSplit), src/components/GridSplit.tsx,
// src/components/WorkspaceSplit.tsx, StartupForm.tsx (renderSecondary).

const secondPane = (page: Page, name: string) => page.getByLabel(`Second pane: ${name}`);
const composerIn = (page: Page, pane: "primary" | "secondary") =>
  page.locator(`[data-pane='${pane}']`).getByRole("textbox", { name: "Follow-up message" });

async function splitWith(page: Page, name: string, down = false) {
  await chord(page, down ? "Alt+Backslash" : "Backslash");
  const picker = page.getByRole("dialog", { name: down ? "Split down with tab" : "Split right with tab" });
  await picker.getByRole("option", { name: new RegExp(`^${name}`) }).click();
  await expect(picker).toHaveCount(0);
}

test.describe("classic split", () => {
  test("Mod+\\ opens a second pane; Open in main pane swaps an idle tab in", async ({ app, page }) => {
    await app.open({ tabs: namedTabs(3) });
    await chord(page, "Backslash");
    const picker = page.getByRole("dialog", { name: "Split right with tab" });
    // The active tab is not offered.
    await expect(picker.getByRole("option")).toHaveText([/^Beta/, /^Gamma/]);
    await picker.getByRole("option", { name: /^Beta/ }).click();

    const beta = secondPane(page, "Beta");
    await expect(beta).toBeVisible();
    await expect(beta.getByText("This tab has no running session.")).toBeVisible();
    const layout = await layoutWhere(app, (l) => l.splitMode === "horizontal");
    expect(layout).toMatchObject({ secondaryTabId: "tab-2", gridTabIds: [] });
    // Side by side: the second pane starts to the right of the main one.
    const main = await page.locator("[data-pane='primary']").boundingBox();
    const second = await beta.boundingBox();
    expect(second!.x).toBeGreaterThan(main!.x + main!.width / 2);

    await beta.getByRole("button", { name: "Open in main pane" }).click();
    await expectActive(page, "Beta");
    await expect(secondPane(page, "Alpha")).toBeVisible();
    await layoutWhere(app, (l) => l.secondaryTabId === "tab-1");
  });

  test("swap by button, Mod+Alt+S, and by selecting the second pane's tab", async ({ app, page }) => {
    await app.open({ tabs: namedTabs(3) });
    await startReady(app, page, "tab-1", "alpha says hi");
    await tabChip(page, "Beta").click();
    await startReady(app, page, "tab-2", "beta says hi");
    await splitWith(page, "Alpha");
    const alphaPane = secondPane(page, "Alpha");
    await expect(alphaPane.getByRole("log")).toContainText("alpha says hi");

    await alphaPane.getByRole("button", { name: "Swap panes" }).click();
    await expectActive(page, "Alpha");
    await expect(secondPane(page, "Beta").getByRole("log")).toContainText("beta says hi");

    await chord(page, "Alt+KeyS");
    await expectActive(page, "Beta");
    await expect(secondPane(page, "Alpha")).toBeVisible();

    // Picking the tab that is in the second pane swaps instead of showing it twice.
    await tabChip(page, "Alpha").click();
    await expectActive(page, "Alpha");
    await expect(secondPane(page, "Beta")).toBeVisible();
    await expect(page.getByRole("log")).toHaveCount(2);

    // Picking a third tab keeps the second pane as it is.
    await tabChip(page, "Gamma").click();
    await expectActive(page, "Gamma");
    await expect(secondPane(page, "Beta")).toBeVisible();
  });

  test("Mod+Alt+O moves keys between panes; each composer sends to its own tab", async ({ app, page }) => {
    await app.open({ tabs: namedTabs(2) });
    await startReady(app, page, "tab-1", "alpha ready");
    await tabChip(page, "Beta").click();
    await startReady(app, page, "tab-2", "beta ready");
    await splitWith(page, "Alpha");

    await chord(page, "Alt+KeyO");
    const second = composerIn(page, "secondary");
    await expect(second).toBeFocused();
    await expect(secondPane(page, "Alpha")).toHaveClass(/split-pane-focused/);
    await second.fill("to alpha");
    await chord(page, "Enter");
    const toAlpha = await app.waitForCall("dev_session_send");
    expect(toAlpha.args).toMatchObject({ prompt: "to alpha", tabId: "tab-1" });
    await expect(secondPane(page, "Alpha").getByRole("log")).toContainText("to alpha");
    // The active tab is still Beta; only keys moved.
    await expectActive(page, "Beta");

    await chord(page, "Alt+KeyO");
    const main = composerIn(page, "primary");
    await expect(main).toBeFocused();
    await main.fill("to beta");
    await chord(page, "Enter");
    const toBeta = await app.waitForCall("dev_session_send", (args) => args.prompt === "to beta");
    expect(toBeta.args.tabId).toBe("tab-2");

    // Escape in the second pane cancels that pane's turn, not the main one's.
    await second.click();
    await page.keyboard.press("Escape");
    const cancel = await app.waitForCall("dev_session_cancel");
    expect(cancel.args).toMatchObject({ tabId: "tab-1" });
  });

  test("Mod+Alt+\\ splits down; Mod+Alt+W closes the split and the tabs keep running", async ({ app, page }) => {
    await app.open({ tabs: namedTabs(2) });
    await splitWith(page, "Beta", true);
    const beta = secondPane(page, "Beta");
    await expect(beta).toBeVisible();
    await layoutWhere(app, (l) => l.splitMode === "vertical" && l.secondaryTabId === "tab-2");
    const main = await page.locator("[data-pane='primary']").boundingBox();
    const second = await beta.boundingBox();
    expect(second!.y).toBeGreaterThan(main!.y + main!.height / 2);

    await chord(page, "Alt+KeyW");
    await expect(beta).toHaveCount(0);
    await layoutWhere(app, (l) => l.splitMode === "single" && l.secondaryTabId === null);
    await expect(page.getByRole("tab")).toHaveCount(2);

    // The Close button in the pane bar does the same.
    await splitWith(page, "Beta");
    await secondPane(page, "Beta").getByRole("button", { name: "Close split" }).click();
    await expect(secondPane(page, "Beta")).toHaveCount(0);
  });

  test("the palette lists split commands only while a split is open", async ({ app, page }) => {
    await app.open({ tabs: namedTabs(2) });
    const items = page.getByRole("dialog", { name: "Command palette" }).locator(".palette-item");
    await chord(page, "KeyK");
    await page.getByPlaceholder("Type a command").fill("pane");
    await expect(items.filter({ hasText: /^(Swap panes|Focus other pane|Close split)/ })).toHaveCount(0);
    await page.keyboard.press("Escape");

    await splitWith(page, "Beta");
    await chord(page, "KeyK");
    await page.getByPlaceholder("Type a command").fill("swap");
    await expect(items).toHaveText([/^Swap panes/]);
    await page.keyboard.press("Enter");
    await expectActive(page, "Beta");
    await expect(secondPane(page, "Alpha")).toBeVisible();
    await chord(page, "KeyK");
    await page.getByPlaceholder("Type a command").fill("close split");
    await page.keyboard.press("Enter");
    await expect(secondPane(page, "Alpha")).toHaveCount(0);
  });

  test("closing the second pane's tab closes the split", async ({ app, page }) => {
    await app.open({ tabs: namedTabs(3) });
    await splitWith(page, "Gamma");
    await expect(secondPane(page, "Gamma")).toBeVisible();
    await tabChip(page, "Gamma").hover();
    await page.getByRole("button", { name: "Close Gamma", exact: true }).click();
    await expect(tabChip(page, "Gamma")).toHaveCount(0);
    await expect(secondPane(page, "Gamma")).toHaveCount(0);
    await layoutWhere(app, (l) => l.splitMode === "single");
    await expectActive(page, "Alpha");
  });

  test("Mod+\\ with one tab explains there is nothing to split with", async ({ app, page }) => {
    await app.open();
    await chord(page, "Backslash");
    await expect(page.getByRole("alert").filter({ hasText: "Nothing to split with" })).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Split right with tab" })).toHaveCount(0);
  });
});

test.describe("grid limits (landscape)", () => {
  test("Mod+Alt+G shows at most six tabs, active first, in two rows of three", async ({ app, page }) => {
    await app.open({ tabs: namedTabs(7), activeTabId: "tab-3" });
    await chord(page, "Alt+KeyG");
    await expect(page.locator("[data-pane]")).toHaveCount(6);
    const layout = await layoutWhere(app, (l) => l.splitMode === "grid");
    expect(layout.gridTabIds).toEqual(["tab-3", "tab-1", "tab-2", "tab-4", "tab-5", "tab-6"]);
    expect(rowsOf(await cellTops(page))).toEqual([3, 3]);
    await expect(page.getByLabel("Grid cell: Eta")).toHaveCount(0);

    // A full grid offers no Add tab to grid.
    await chord(page, "KeyK");
    await page.getByPlaceholder("Type a command").fill("grid");
    await expect(page.getByRole("dialog", { name: "Command palette" }).locator(".palette-item")).toHaveText([
      /^Close grid view/,
    ]);
    await page.keyboard.press("Escape");

    // Selecting a tab that is not on screen puts it in the active tab's cell.
    await tabChip(page, "Eta").click();
    await expectActive(page, "Eta");
    const swapped = await layoutWhere(app, (l) => (l.gridTabIds ?? [])[0] === "tab-7");
    expect(swapped.gridTabIds).toEqual(["tab-7", "tab-1", "tab-2", "tab-4", "tab-5", "tab-6"]);
    await expect(page.getByLabel("Grid cell: Gamma")).toHaveCount(0);
    await expect(page.locator("[data-pane]")).toHaveCount(6);

    await chord(page, "Alt+KeyG");
    await expect(page.locator("[data-pane^='grid']")).toHaveCount(0);
    await layoutWhere(app, (l) => l.splitMode === "single" && (l.gridTabIds ?? []).length === 0);
  });

  test("removing cells reflows the rows and closes the grid below two", async ({ app, page }) => {
    await app.open({ tabs: namedTabs(5) });
    await chord(page, "Alt+KeyG");
    await expect(page.locator("[data-pane]")).toHaveCount(5);
    expect(rowsOf(await cellTops(page))).toEqual([3, 2]);

    await page.getByRole("button", { name: "Remove Gamma from grid" }).click();
    await expect(page.locator("[data-pane]")).toHaveCount(4);
    await expect.poll(async () => rowsOf(await cellTops(page))).toEqual([2, 2]);
    // The tab itself stays open.
    await expect(tabChip(page, "Gamma")).toBeVisible();

    // Removing the active cell makes its neighbour active.
    await page.getByRole("button", { name: "Remove Alpha from grid" }).click();
    await expectActive(page, "Beta");
    await expect(page.locator("[data-pane]")).toHaveCount(3);
    await expect.poll(async () => rowsOf(await cellTops(page))).toEqual([3]);
    await layoutWhere(app, (l) => JSON.stringify(l.gridTabIds) === JSON.stringify(["tab-2", "tab-4", "tab-5"]));

    await page.getByRole("button", { name: "Remove Delta from grid" }).click();
    await expect(page.locator("[data-pane]")).toHaveCount(2);
    await page.getByRole("button", { name: "Remove Epsilon from grid" }).click();
    await expect(page.locator("[data-pane^='grid']")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Grid view" })).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByRole("tab")).toHaveCount(5);
  });

  test("closing tabs in the grid drops their cells, then closes the grid", async ({ app, page }) => {
    await app.open({ tabs: namedTabs(3) });
    await chord(page, "Alt+KeyG");
    await expect(page.locator("[data-pane]")).toHaveCount(3);

    await tabChip(page, "Gamma").hover();
    await page.getByRole("button", { name: "Close Gamma", exact: true }).click();
    await expect(page.locator("[data-pane]")).toHaveCount(2);
    await layoutWhere(app, (l) => JSON.stringify(l.gridTabIds) === JSON.stringify(["tab-1", "tab-2"]));

    await tabChip(page, "Beta").hover();
    await page.getByRole("button", { name: "Close Beta", exact: true }).click();
    await expect(page.locator("[data-pane^='grid']")).toHaveCount(0);
    await layoutWhere(app, (l) => l.splitMode === "single");
    await expectActive(page, "Alpha");
  });

  test("a saved grid with more than six cells opens with six", async ({ app, page }) => {
    await app.open({
      tabs: namedTabs(7),
      responses: {
        get_layout: {
          splitMode: "grid",
          secondaryTabId: null,
          gridTabIds: ["tab-1", "tab-2", "tab-3", "tab-4", "tab-5", "tab-6", "tab-7"],
          primarySize: 50,
          filePanelOpen: false,
          filePanelWidth: 280,
        },
      },
    });
    await expect(page.locator("[data-pane]")).toHaveCount(6);
    await expect(page.getByLabel("Grid cell: Eta")).toHaveCount(0);
  });
});

test.describe("grid layout (portrait)", () => {
  test.use({ viewport: { width: 900, height: 1440 } });

  test("portrait fills rows first: 2 → 1+1, 6 → 2+2+2, 5 → 2+2+1, 3 → 1+1+1", async ({ app, page }) => {
    await app.open({ tabs: namedTabs(6) });
    await chord(page, "KeyK");
    await page.getByPlaceholder("Type a command").fill("add tab to grid");
    await page.keyboard.press("Enter");
    await page.getByRole("dialog", { name: "Add tab to grid" }).getByRole("option", { name: /^Beta/ }).click();
    await expect(page.locator("[data-pane]")).toHaveCount(2);
    expect(rowsOf(await cellTops(page))).toEqual([1, 1]);

    await chord(page, "Alt+KeyG");
    await expect(page.locator("[data-pane^='grid']")).toHaveCount(0);
    await chord(page, "Alt+KeyG");
    await expect(page.locator("[data-pane]")).toHaveCount(6);
    await expect.poll(async () => rowsOf(await cellTops(page))).toEqual([2, 2, 2]);

    await page.getByRole("button", { name: "Remove Zeta from grid" }).click();
    await expect.poll(async () => rowsOf(await cellTops(page))).toEqual([2, 2, 1]);
    await page.getByRole("button", { name: "Remove Epsilon from grid" }).click();
    await page.getByRole("button", { name: "Remove Delta from grid" }).click();
    await expect.poll(async () => rowsOf(await cellTops(page))).toEqual([1, 1, 1]);
  });
});
