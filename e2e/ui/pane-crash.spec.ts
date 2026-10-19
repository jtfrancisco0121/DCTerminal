import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/tauri";
import { chord, expectActive, namedTabs, startReady, tabChip } from "./tabs-helpers";

// A render error in one pane stays in that pane (src/components/PaneBoundary.tsx).
// The crash is forced with the dev-only `window.__dctCrashPane(paneId)`
// (src/components/devPaneCrash.ts); the production build strips it.

const secondPane = (page: Page, name: string) => page.getByLabel(`Second pane: ${name}`);

async function crashPane(page: Page, paneId: string) {
  await page.evaluate((id) => {
    (window as unknown as { __dctCrashPane: (id: string) => void }).__dctCrashPane(id);
  }, paneId);
}

test("a crash in the second pane leaves the main pane and the tab bar working", async ({ app, page }) => {
  await app.open({ tabs: namedTabs(2) });
  await startReady(app, page, "tab-1", "alpha says hi");
  await tabChip(page, "Beta").click();
  await startReady(app, page, "tab-2", "beta says hi");
  await tabChip(page, "Alpha").click();
  await chord(page, "Backslash");
  await page
    .getByRole("dialog", { name: "Split right with tab" })
    .getByRole("option", { name: /^Beta/ })
    .click();
  const beta = secondPane(page, "Beta");
  await expect(beta.getByRole("log")).toContainText("beta says hi");

  await crashPane(page, "tab-2");
  const fallback = beta.getByRole("alert");
  await expect(fallback).toContainText("Chat view hit an error.");
  await expect(fallback).toContainText("Forced pane crash (dev): tab-2");
  // The pane keeps its own buttons; the main pane and the tab bar are untouched.
  await expect(beta.getByRole("button", { name: "Close split" })).toBeVisible();
  const main = page.locator("[data-pane='primary']");
  await expect(main.getByRole("log")).toContainText("alpha says hi");
  await expect(main.getByRole("alert")).toHaveCount(0);
  await expect(tabChip(page, "Alpha")).toBeVisible();
  await expect(tabChip(page, "Beta")).toBeVisible();
  // The main pane still takes input.
  const composer = main.getByRole("textbox", { name: "Follow-up message" });
  await composer.fill("still here");
  await expect(composer).toHaveValue("still here");

  // The error is in the log drawer.
  await chord(page, "KeyK");
  await page.getByRole("dialog", { name: "Command palette" }).getByPlaceholder("Type a command").fill("session logs");
  await page.getByRole("dialog", { name: "Command palette" }).getByRole("button", { name: /^Show session logs/ }).click();
  const drawer = page.getByRole("dialog", { name: "Session logs" });
  await expect(drawer.getByRole("region", { name: "Interface errors" })).toContainText(
    "Chat view: Forced pane crash (dev): tab-2",
  );
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);

  // Reload this pane re-mounts only that pane: the chat comes back.
  await beta.getByRole("button", { name: "Reload this pane" }).click();
  await expect(beta.getByRole("alert")).toHaveCount(0);
  await expect(beta.getByRole("log")).toContainText("beta says hi");
  await expect(main.getByRole("log")).toContainText("alpha says hi");

  // And the tab bar still switches tabs.
  await tabChip(page, "Beta").click();
  await expectActive(page, "Beta");
});
