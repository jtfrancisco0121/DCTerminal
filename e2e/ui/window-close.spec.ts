import { expect, test, type TauriApp } from "./fixtures/tauri";
import type { Page } from "@playwright/test";

const CLOSE = "tauri://close-requested";

/** The window's close button, as Tauri delivers it to the page. */
async function requestClose(app: TauriApp, page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate((event) => window.__E2E.listenerCount(event), CLOSE))
    .toBeGreaterThan(0);
  await app.emit(CLOSE, {});
}

const destroyed = async (app: TauriApp) => (await app.calls("plugin:window|destroy")).length;

test.describe("closing the window", () => {
  test("with a running agent it asks first, and Cancel keeps the window", async ({ app, page }) => {
    await app.open();
    await app.start("tab-1");
    await requestClose(app, page);
    const dialog = page.getByRole("alertdialog", { name: "Close window?" });
    await expect(dialog).toContainText("1 running agent or terminal in this window will be stopped.");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    // The handler resolves right after the dialog closes; give it a moment.
    await page.waitForTimeout(300);
    expect(await destroyed(app)).toBe(0);
  });

  test("Close window stops the work and closes it, once", async ({ app, page }) => {
    await app.open();
    await app.start("tab-1");
    await requestClose(app, page);
    // A second click on the close button while the question is open is ignored.
    await app.emit(CLOSE, {});
    const dialog = page.getByRole("alertdialog", { name: "Close window?" });
    await expect(dialog).toHaveCount(1);
    await dialog.getByRole("button", { name: "Close window" }).click();
    await expect.poll(() => destroyed(app)).toBe(1);
    await page.waitForTimeout(300);
    expect(await destroyed(app)).toBe(1);
  });

  test("with nothing running it closes at once", async ({ app, page }) => {
    await app.open();
    await requestClose(app, page);
    await expect.poll(() => destroyed(app)).toBe(1);
    await expect(page.getByRole("alertdialog", { name: "Close window?" })).toHaveCount(0);
  });
});
