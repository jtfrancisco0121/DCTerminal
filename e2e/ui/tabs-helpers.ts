import type { Page } from "@playwright/test";
import { expect, roleTab, type TauriApp } from "./fixtures/tauri";

/** "Meta" on macOS, "Control" elsewhere: the app reads `navigator.platform` (keymap.ts). */
export async function modKey(page: Page): Promise<"Meta" | "Control"> {
  return (await page.evaluate(() => /mac/i.test(navigator.platform))) ? "Meta" : "Control";
}

/** Presses `Mod+<rest>`, e.g. `chord(page, "Alt+KeyG")`. */
export async function chord(page: Page, rest: string): Promise<void> {
  await page.keyboard.press(`${await modKey(page)}+${rest}`);
}

export const tabChip = (page: Page, name: string | RegExp) =>
  page.getByRole("tab", { name: typeof name === "string" ? new RegExp(`^${name}\\b`) : name });

export async function expectActive(page: Page, name: string): Promise<void> {
  await expect(tabChip(page, name)).toHaveAttribute("aria-selected", "true");
}

/** Tabs named Alpha, Beta, … (all General role drafts). */
export function namedTabs(count: number) {
  const names = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta", "Theta"];
  return names.slice(0, count).map((name, i) => roleTab(`tab-${i + 1}`, "role_general", name));
}

/** Starts a tab (it must be active) and finishes its startup turn with `reply`. */
export async function startReady(app: TauriApp, page: Page, tabId: string, reply: string): Promise<void> {
  await (await app.start(tabId)).reply(reply);
  await expect(page.locator(".status-bar-status")).toHaveText("Ready");
}

/** Latest `set_layout` payload matching `match`. */
export async function layoutWhere(
  app: TauriApp,
  match: (layout: { splitMode: string; secondaryTabId: string | null; gridTabIds?: string[] }) => boolean,
) {
  const call = await app.waitForCall("set_layout", (args) => match(args.layout as never));
  return call.args.layout as { splitMode: string; secondaryTabId: string | null; gridTabIds: string[] };
}

/** Cell tops of the grid, rounded, in DOM order. */
export async function cellTops(page: Page): Promise<number[]> {
  return page
    .locator("[data-pane]")
    .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
}

/** Count of cells in each visual row (grouped by top edge). */
export function rowsOf(tops: number[]): number[] {
  const counts = new Map<number, number>();
  for (const top of tops) {
    const key = [...counts.keys()].find((k) => Math.abs(k - top) < 4) ?? top;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([, n]) => n);
}
