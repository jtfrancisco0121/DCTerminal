import type { Page } from "@playwright/test";
import { expect, roleTab, test } from "./fixtures/tauri";

test.use({ viewport: { width: 900, height: 1440 } });

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => {
    const doc = document.scrollingElement ?? document.documentElement;
    return { scroll: doc.scrollWidth, client: doc.clientWidth };
  });
  expect(overflow.scroll, "page scrolls sideways").toBeLessThanOrEqual(overflow.client);
}

async function expectInViewport(page: Page, name: string, locator: ReturnType<Page["locator"]>) {
  const box = await locator.boundingBox();
  expect(box, `${name} is rendered`).not.toBeNull();
  const size = page.viewportSize()!;
  expect(box!.x, `${name} left edge`).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width, `${name} right edge`).toBeLessThanOrEqual(size.width + 1);
  expect(box!.y + box!.height, `${name} bottom edge`).toBeLessThanOrEqual(size.height + 1);
}

test("portrait 900x1440: start screen and a running chat fit the width", async ({ app, page }) => {
  await app.open({
    tabs: [
      roleTab("tab-1", "role_planner", "Planner"),
      roleTab("tab-2", "role_general", "General"),
    ],
    activeTabId: "tab-2",
  });
  await expect(page.getByRole("heading", { name: "Start a session" })).toBeVisible();
  await expectNoHorizontalScroll(page);
  await expectInViewport(page, "Start", page.getByRole("button", { name: "Start", exact: true }));

  const turn = await app.start("tab-2");
  await turn.reply(`A long line without breaks: ${"x".repeat(400)}\n\n| a | b |\n|---|---|\n| 1 | 2 |`);
  await expect(page.locator(".status-bar-status")).toHaveText("Ready");
  await expectNoHorizontalScroll(page);
  await expectInViewport(page, "composer", page.getByRole("textbox", { name: "Follow-up message" }));
  await expectInViewport(page, "scratch pad", page.getByRole("region", { name: "Scratch pad" }));
  await expectInViewport(page, "status bar", page.locator(".status-bar"));
  await expectInViewport(page, "Stop", page.getByRole("button", { name: "Stop session" }));

  await page.getByRole("tab", { name: "Planner" }).click();
  await page.getByRole("button", { name: "Grid view" }).click();
  await expect(page.locator("[data-pane]")).toHaveCount(2);
  await expectNoHorizontalScroll(page);
  // Portrait stacks the two cells in rows.
  const [first, second] = await page.locator("[data-pane]").evaluateAll((els) =>
    els.map((el) => el.getBoundingClientRect().top),
  );
  expect(Math.abs(first - second)).toBeGreaterThan(100);
});
