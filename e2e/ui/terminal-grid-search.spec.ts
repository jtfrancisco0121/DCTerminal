import type { Page } from "@playwright/test";
import { expect, roleTab, test, type TauriApp } from "./fixtures/tauri";

// Terminals inside grid cells, terminal search (Mod+Shift+F / Cmd+F), and the
// terminal context menu's Copy / Paste.

const shell = (id: string, label: string) =>
  roleTab(id, "terminal", label, { kind: "terminal", terminalLaunch: "shell", phase: "terminal" });

async function writes(app: TauriApp, id: string): Promise<string[]> {
  return (await app.calls("pty_write")).filter((c) => c.args.id === id).map((c) => String(c.args.data));
}

/** Replaces the async clipboard so Copy/Paste are observable and need no permission. */
async function fakeClipboard(page: Page, readText: string) {
  await page.evaluate((text) => {
    const w = window as unknown as { __copied: string[] };
    w.__copied = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          w.__copied.push(value);
        },
        readText: async () => text,
      },
    });
  }, readText);
}

const copied = (page: Page) => page.evaluate(() => (window as unknown as { __copied: string[] }).__copied);

test("grid view: each terminal cell renders only its own PTY output and writes to its own PTY", async ({
  app,
  page,
}) => {
  await app.open({ tabs: [shell("tab-1", "Shell A"), shell("tab-2", "Shell B")] });
  await app.waitForCall("pty_open", (a) => (a.input as { id: string }).id === "tab-1");
  await page.getByRole("button", { name: "Grid view" }).click();
  await app.waitForCall("pty_open", (a) => (a.input as { id: string }).id === "tab-2");

  const primary = page.locator('[data-pane="primary"]');
  const cellB = page.getByLabel("Grid cell: Shell B");
  await expect(cellB).toBeVisible();
  await expect(primary.locator(".xterm")).toHaveCount(1);
  await expect(cellB.locator(".xterm")).toHaveCount(1);

  await app.ptyOutput("tab-1", "output for A\r\n");
  await app.ptyOutput("tab-2", "output for B\r\n");
  await expect(primary.locator(".xterm-rows")).toContainText("output for A");
  await expect(cellB.locator(".xterm-rows")).toContainText("output for B");
  await expect(primary.locator(".xterm-rows")).not.toContainText("output for B");
  await expect(cellB.locator(".xterm-rows")).not.toContainText("output for A");

  // Each cell's PTY is sized to its own slot.
  await app.waitForCall("pty_resize", (a) => a.id === "tab-2");

  // Clicking B's cell makes B the active tab: it moves to the primary pane
  // with its scrollback, and A takes a cell.
  await cellB.locator(".terminal-slot").click();
  await expect(page.getByRole("tab", { name: "Shell B" })).toHaveAttribute("aria-selected", "true");
  const cellA = page.getByLabel("Grid cell: Shell A");
  await expect(primary.locator(".xterm-rows")).toContainText("output for B");
  await expect(cellA.locator(".xterm-rows")).toContainText("output for A");
  await app.ptyOutput("tab-2", "more for B\r\n");
  await expect(primary.locator(".xterm-rows")).toContainText("more for B");
  await expect(cellA.locator(".xterm-rows")).not.toContainText("more for B");

  // Typing after the click goes to B's PTY only.
  await expect(primary.getByRole("textbox", { name: "Terminal input" })).toBeFocused();
  await page.keyboard.type("pwd");
  await expect.poll(() => writes(app, "tab-2")).toEqual(["p", "w", "d"]);
  expect(await writes(app, "tab-1")).toEqual([]);
});

test("terminal search: Mod+Shift+F opens it, counts matches, Escape returns to the terminal", async ({
  app,
  page,
}) => {
  await app.open({ tabs: [shell("tab-1", "Terminal · demo")] });
  await app.waitForCall("pty_open");
  await app.ptyOutput("tab-1", "alpha beta\r\ngamma alpha\r\nALPHA\r\n");
  await expect(page.locator(".xterm-rows")).toContainText("gamma alpha");
  const terminal = page.getByRole("textbox", { name: "Terminal input" });
  await expect(terminal).toBeFocused();

  await expect.poll(async () => (await app.calls("pty_resize")).length).toBeGreaterThan(0);
  const rowsBefore = (await app.calls("pty_resize")).at(-1)!.args.rows as number;

  await page.keyboard.press("ControlOrMeta+Shift+F");
  const bar = page.getByRole("search");
  const input = bar.getByRole("searchbox", { name: "Search terminal" });
  await expect(input).toBeFocused();
  // The bar takes rows from the terminal. Let that refit land first: the
  // search addon re-runs a live search after a resize.
  await expect
    .poll(async () => (await app.calls("pty_resize")).at(-1)!.args.rows as number)
    .toBeLessThan(rowsBefore);
  // The search chord is the app's, not the shell's.
  expect(await writes(app, "tab-1")).toEqual([]);

  await input.fill("alpha");
  await expect(bar.locator(".search-status")).toHaveText("1 of 3");
  await input.press("Enter");
  await expect(bar.locator(".search-status")).toHaveText("2 of 3");
  await input.press("Enter");
  await expect(bar.locator(".search-status")).toHaveText("3 of 3");
  await input.press("Enter");
  await expect(bar.locator(".search-status")).toHaveText("1 of 3");
  await input.press("Shift+Enter");
  await expect(bar.locator(".search-status")).toHaveText("3 of 3");
  await bar.getByRole("button", { name: "Next match" }).click();
  await expect(bar.locator(".search-status")).toHaveText("1 of 3");
  // Match case applies once the query is typed with it on.
  await bar.getByRole("button", { name: "Match case" }).click();
  await expect(bar.getByRole("button", { name: "Match case" })).toHaveAttribute("aria-pressed", "true");
  await input.fill("ALPHA");
  await expect(bar.locator(".search-status")).toHaveText("1 of 1");
  await input.fill("Alpha");
  await expect(bar.locator(".search-status")).toHaveText("No results");
  await input.fill("zebra");
  await expect(bar.locator(".search-status")).toHaveText("No results");

  await input.press("Escape");
  await expect(bar).toBeHidden();
  await expect(terminal).toBeFocused();
});

test("terminal context menu: Copy puts the xterm selection on the clipboard", async ({ app, page }) => {
  await app.open({ tabs: [shell("tab-1", "Terminal · demo")] });
  await app.waitForCall("pty_open");
  await fakeClipboard(page, "");
  await app.ptyOutput("tab-1", "first\r\ncopy this line\r\nlast\r\n");
  const row = page.locator(".xterm-rows > div").filter({ hasText: "copy this line" });
  await expect(row).toBeVisible();
  const box = (await row.boundingBox())!;
  await page.mouse.click(box.x + 10, box.y + box.height / 2, { clickCount: 3 });

  await page.mouse.click(box.x + 10, box.y + box.height / 2, { button: "right" });
  await page.getByRole("menu").getByRole("menuitem", { name: "Copy" }).click();
  await expect(page.getByRole("menu")).toBeHidden();
  await expect.poll(() => copied(page)).toEqual([expect.stringMatching(/^copy this line\s*$/)]);
  // Copy never types into the shell.
  expect(await writes(app, "tab-1")).toEqual([]);
});

test("terminal context menu: Paste writes clipboard text, bracketed when the program asked for it", async ({
  app,
  page,
}) => {
  await app.open({ tabs: [shell("tab-1", "Terminal · demo")] });
  await app.waitForCall("pty_open");
  await fakeClipboard(page, "echo pasted\nsecond");
  const slot = page.locator(".terminal-slot");

  await slot.click({ button: "right" });
  await page.getByRole("menu").getByRole("menuitem", { name: "Paste" }).click();
  // xterm turns newlines into CR for a paste.
  await expect.poll(() => writes(app, "tab-1")).toEqual(["echo pasted\rsecond"]);

  await app.ptyOutput("tab-1", "\x1b[?2004htui-ready> ");
  await expect(page.locator(".xterm-rows")).toContainText("tui-ready>");
  await slot.click({ button: "right" });
  await page.getByRole("menu").getByRole("menuitem", { name: "Paste" }).click();
  await expect
    .poll(async () => (await writes(app, "tab-1")).at(-1))
    .toBe("\x1b[200~echo pasted\rsecond\x1b[201~");
});
