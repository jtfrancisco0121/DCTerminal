import type { Page } from "@playwright/test";
import { expect, roleTab, test } from "./fixtures/tauri";
import { chord, expectActive, modKey, namedTabs, startReady, tabChip } from "./tabs-helpers";

// Command palette (Mod+K), tab switcher (Mod+P), shortcuts overlay (Mod+/) and
// the first-use tip. Sources: src/components/CommandPalette.tsx,
// src/tabChrome.ts (buildPalette), StartupForm.tsx (runPalette),
// src/components/TabSwitcher.tsx, ShortcutsOverlay.tsx, FirstUseTip.tsx, ShortcutBar.tsx.

const palette = (page: Page) => page.getByRole("dialog", { name: "Command palette" });
const entry = (page: Page, title: string) =>
  palette(page).getByRole("button", { name: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) });

async function openPalette(page: Page, query = "") {
  await chord(page, "KeyK");
  const input = palette(page).getByPlaceholder("Type a command");
  await expect(input).toBeFocused();
  if (query) await input.fill(query);
  return input;
}

test.describe("command palette", () => {
  test("Mod+K opens it; search narrows by every word; Escape closes it", async ({ app, page }) => {
    await app.open({ tabs: namedTabs(2) });
    const input = await openPalette(page);
    // Groups are listed in PALETTE_GROUPS order: Tabs first, Open tabs last.
    const items = palette(page).locator(".palette-item");
    await expect(items.first()).toHaveText(/^New tab\s*Tabs$/);
    await expect(items.last()).toHaveText(/^Switch to: Beta\s*Open tabs$/);
    // Commands that do not apply yet are left out, not listed.
    await expect(entry(page, "Swap panes")).toHaveCount(0);
    await expect(entry(page, "Close split")).toHaveCount(0);
    await expect(entry(page, "Reopen closed tab")).toHaveCount(0);

    await input.fill("split pane");
    await expect(items).toHaveText([/^Split right/, /^Split down/, /^Show tabs in a grid/, /^Add tab to grid…/]);
    await input.fill("side by side");
    await expect(items).toHaveText([/^Split right/]);
    // Keywords count: "tile" only appears in the grid command's keywords.
    await input.fill("tile");
    await expect(items).toHaveText([/^Show tabs in a grid/, /^Add tab to grid…/]);
    await input.fill("zzzz nothing");
    await expect(palette(page).getByText("No matching commands")).toBeVisible();
    // Model commands are search-only.
    await input.fill("");
    await expect(palette(page).getByText(/^Use model:/)).toHaveCount(0);
    await input.fill("use model haiku");
    await expect(items).toHaveText([/^Use model: Haiku/]);

    await page.keyboard.press("Escape");
    await expect(palette(page)).toHaveCount(0);
    // A click on the backdrop closes it too.
    await openPalette(page);
    await page.mouse.click(5, 5);
    await expect(palette(page)).toHaveCount(0);
  });

  test("arrow keys move the selection and Enter runs it", async ({ app, page }) => {
    await app.open({ tabs: namedTabs(3) });
    const input = await openPalette(page, "switch to");
    const items = palette(page).locator(".palette-item");
    await expect(items).toHaveCount(3);
    await expect(items.nth(0)).toHaveClass(/palette-item-active/);
    await input.press("ArrowDown");
    await input.press("ArrowDown");
    await input.press("ArrowDown"); // stops at the last item
    await expect(items.nth(2)).toHaveClass(/palette-item-active/);
    await input.press("ArrowUp");
    await expect(items.nth(1)).toHaveClass(/palette-item-active/);
    await input.press("Enter");
    await expect(palette(page)).toHaveCount(0);
    await expectActive(page, "Beta");
    const selected = await app.waitForCall("select_active_tab");
    expect(selected.args.tabId).toBe("tab-2");
  });

  test("toggleGrid and addToGrid run from the palette", async ({ app, page }) => {
    await app.open({ tabs: namedTabs(4) });
    await openPalette(page, "add tab to grid");
    await entry(page, "Add tab to grid…").click();
    const picker = page.getByRole("dialog", { name: "Add tab to grid" });
    // The active tab is not offered; it always has a cell.
    await expect(picker.getByRole("option")).toHaveCount(3);
    await picker.getByRole("option", { name: /^Gamma/ }).click();
    await expect(page.locator("[data-pane]")).toHaveCount(2);
    await expect(page.getByLabel("Grid cell: Gamma")).toBeVisible();

    await openPalette(page, "grid");
    await expect(entry(page, "Close grid view")).toBeVisible();
    // Swap / Focus other pane do not apply to a grid.
    await palette(page).getByPlaceholder("Type a command").fill("swap");
    await expect(palette(page).getByText("No matching commands")).toBeVisible();
    await palette(page).getByPlaceholder("Type a command").fill("add tab to grid");
    await entry(page, "Add tab to grid…").click();
    await expect(picker.getByRole("option")).toHaveText([/^Beta/, /^Delta/]);
    await picker.getByRole("option", { name: /^Delta/ }).click();
    await expect(page.locator("[data-pane]")).toHaveCount(3);

    await openPalette(page, "close grid");
    await page.keyboard.press("Enter");
    await expect(page.locator("[data-pane^='grid']")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Grid view" })).toHaveAttribute("aria-pressed", "false");

    await openPalette(page, "show tabs in a grid");
    await page.keyboard.press("Enter");
    // Reopening seeds the active tab first, then tabs in bar order.
    const layout = await app.waitForCall(
      "set_layout",
      (args) => ((args.layout as { gridTabIds: string[] }).gridTabIds ?? []).length === 4,
    );
    expect((layout.args.layout as { gridTabIds: string[] }).gridTabIds).toEqual(["tab-1", "tab-2", "tab-3", "tab-4"]);
  });

  test("grid on one tab explains why nothing happened", async ({ app, page }) => {
    await app.open();
    await openPalette(page, "show tabs in a grid");
    // With a single tab there is nobody to add.
    await expect(entry(page, "Add tab to grid…")).toHaveCount(0);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("alert").filter({ hasText: "Nothing to show in a grid" })).toContainText(
      "Open another tab first",
    );
    await expect(page.locator("[data-pane^='grid']")).toHaveCount(0);
  });

  test("sendToPlanner opens the planning dialog from a Recommendation chat", async ({ app, page }) => {
    await app.open({ tabs: [roleTab("tab-1", "role_recommendation", "Recommendation")] });
    await startReady(app, page, "tab-1", "## Feature: Dark mode\n\n### Problem\nToo bright.\n");
    await openPalette(page, "hand-off");
    // Only this role's targets: Planner and Developer, no Plan Reviewer.
    await expect(entry(page, "Send to Planner…")).toBeVisible();
    await expect(entry(page, "Hand off plan to Developer…")).toBeVisible();
    await expect(entry(page, "Hand off plan to Plan Reviewer…")).toHaveCount(0);
    await expect(entry(page, "Hand off plan…")).toHaveCount(0);
    await entry(page, "Send to Planner…").click();
    const dialog = page.getByRole("dialog", { name: "Send for planning" });
    await expect(dialog.getByRole("radio", { name: "Planner" })).toBeChecked();
    await expect(dialog.getByRole("button", { name: "Open Planner tab" })).toBeEnabled();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    expect(await app.calls("handoff_save")).toHaveLength(0);
  });

  test("handoff:<roleId> runs for a role's own hand-off targets", async ({ app, page }) => {
    await app.open({
      roles: (roles) =>
        roles.map((role) =>
          role.id === "role_general" ? { ...role, handoffTargets: ["role_codebase_audit"] } : role,
        ),
    });
    await startReady(app, page, "tab-1", "Here is what I found.");
    await openPalette(page, "hand off to");
    await expect(palette(page).locator(".palette-item")).toHaveText([/^Hand off to Codebase Audit…/]);
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Send plan" });
    await expect(dialog.getByRole("radio", { name: "Codebase Audit" })).toBeChecked();
    await expect(dialog.getByRole("button", { name: "Open Codebase Audit tab" })).toBeVisible();
    await app.waitForCall("get_role", (args) => args.roleId === "role_codebase_audit");
  });

  test("hand-off entries explain why they cannot run", async ({ app, page }) => {
    await app.open({ tabs: [roleTab("tab-1", "role_planner", "Planner"), roleTab("tab-2", "role_general", "General")], activeTabId: "tab-2" });
    // No plan source here: the palette offers a help entry that says why.
    await openPalette(page, "hand off plan…");
    await expect(palette(page).locator(".palette-item")).toHaveText([/^Hand off plan…/]);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("alert").filter({ hasText: "Nothing to hand off" })).toContainText(
      "Open a Planner or Plan Reviewer chat",
    );

    // On a Planner mid-turn the dialog opens with the reason and a disabled confirm.
    await tabChip(page, "Planner").click();
    const turn = await app.start("tab-1");
    await turn.chunk("Thinking about the plan");
    await openPalette(page, "plan reviewer");
    await entry(page, "Hand off plan to Plan Reviewer…").click();
    const dialog = page.getByRole("dialog", { name: "Send plan" });
    await expect(dialog.getByText("Wait until the Planner finishes this turn.")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Open Plan Reviewer tab" })).toBeDisabled();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await turn.finish();
    await openPalette(page, "plan reviewer");
    await entry(page, "Hand off plan to Plan Reviewer…").click();
    await expect(dialog.getByText("Wait until the Planner finishes this turn.")).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Open Plan Reviewer tab" })).toBeEnabled();
  });

  test("other shortcuts are ignored while the palette is open", async ({ app, page }) => {
    await app.open({ tabs: namedTabs(2) });
    await openPalette(page);
    await chord(page, "KeyT");
    await chord(page, "Digit2");
    await expect(palette(page)).toBeVisible();
    await expectActive(page, "Alpha");
    expect(await app.calls("new_draft_tab")).toHaveLength(0);
  });
});

test.describe("tab switcher", () => {
  test("Mod+P lists tabs with status, filters by name, folder or status, and jumps", async ({ app, page }) => {
    await app.open({
      tabs: [
        roleTab("tab-1", "role_planner", "Planner"),
        roleTab("tab-2", "role_general", "Notes", { cwd: "/Users/e2e/Projects/website" }),
        roleTab("tab-3", "role_general", "Scratch"),
      ],
    });
    const turn = await app.start("tab-1");
    await turn.plan("## Plan\n1. Ship");
    await chord(page, "KeyP");
    const switcher = page.getByRole("dialog", { name: "Go to tab" });
    const input = switcher.getByRole("textbox", { name: "Go to tab" });
    await expect(input).toBeFocused();
    const options = switcher.getByRole("option");
    await expect(options).toHaveCount(3);
    await expect(options.nth(0)).toContainText("Planner · current · Needs you: plan to review");
    await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");

    await input.fill("website");
    await expect(options).toHaveText([/^Notes/]);
    await input.fill("needs you");
    await expect(options).toHaveText([/^Planner/]);
    await input.fill("nothing like this");
    await expect(switcher.getByText("No tabs match")).toBeVisible();

    await input.fill("");
    await input.press("ArrowDown");
    await input.press("ArrowDown");
    await expect(options.nth(2)).toHaveAttribute("aria-selected", "true");
    await input.press("Enter");
    await expect(switcher).toHaveCount(0);
    await expectActive(page, "Scratch");

    await chord(page, "KeyP");
    await switcher.getByRole("option", { name: /^Notes/ }).click();
    await expectActive(page, "Notes");
    await chord(page, "KeyP");
    await page.keyboard.press("Escape");
    await expect(switcher).toHaveCount(0);
  });
});

test.describe("shortcuts overlay and first-use tip", () => {
  test("Mod+/ lists every shortcut with this platform's keys", async ({ app, page }) => {
    await app.open();
    await chord(page, "Slash");
    const overlay = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(overlay).toBeVisible();
    const mod = (await modKey(page)) === "Meta" ? "⌘" : "Ctrl";
    const alt = mod === "⌘" ? "⌥" : "Alt";
    const row = (label: string) => overlay.locator("li").filter({ has: page.getByText(label, { exact: true }) });
    await expect(row("Command palette").locator("kbd")).toHaveText(`${mod}+K`);
    await expect(row("Grid view").locator("kbd")).toHaveText(`${mod}+${alt}+G`);
    await expect(row("Go to tab 1–9").locator("kbd")).toHaveText(`${mod}+1…9`);
    await expect(row("Reopen closed tab").locator("kbd")).toHaveText("F6");
    await expect(row("Cancel turn").locator("kbd")).toHaveText("Esc");
    await overlay.getByRole("button", { name: "Close" }).click();
    await expect(overlay).toHaveCount(0);

    // The palette entry opens it too; Escape closes it.
    await openPalette(page, "keyboard shortcuts");
    await page.keyboard.press("Enter");
    await expect(overlay).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(overlay).toHaveCount(0);
  });

  const freshUi = {
    get_ui_settings: { theme: "github-dark", shortcutBar: false, tipsSeen: [], padHeight: 0, padHidden: false },
  };

  test("first-use tip: Show shortcut bar turns the bar on and records the tip", async ({ app, page }) => {
    await app.open({ responses: freshUi });
    const tip = page.getByRole("status", { name: "Tip" });
    const mod = (await modKey(page)) === "Meta" ? "⌘" : "Ctrl";
    await expect(tip.locator("kbd")).toHaveText([`${mod}+K`, `${mod}+P`, `${mod}+/`]);
    // The tip steps aside while a dialog is open.
    await chord(page, "KeyK");
    await expect(tip).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(tip).toBeVisible();

    await tip.getByRole("button", { name: "Show shortcut bar" }).click();
    await expect(tip).toHaveCount(0);
    const saved = await app.waitForCall("set_ui_settings", (args) =>
      ((args.ui as { tipsSeen: string[] }).tipsSeen ?? []).includes("welcome"),
    );
    expect(saved.args.ui).toMatchObject({ shortcutBar: true, tipsSeen: ["welcome"] });

    const bar = page.getByRole("group", { name: "Shortcut bar" });
    await expect(bar.getByRole("button")).toHaveText([
      /Commands/,
      /Go to tab/,
      /New tab/,
      /Find/,
      /Files/,
      /Split/,
      /All shortcuts/,
      "×",
    ]);
    await bar.getByRole("button", { name: /Go to tab/ }).click();
    await expect(page.getByRole("dialog", { name: "Go to tab" })).toBeVisible();
    await page.keyboard.press("Escape");
    await bar.getByRole("button", { name: /All shortcuts/ }).click();
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
    await page.keyboard.press("Escape");

    await bar.getByRole("button", { name: "Hide shortcut bar" }).click();
    await expect(bar).toHaveCount(0);
    await app.waitForCall("set_ui_settings", (args) => (args.ui as { shortcutBar: boolean }).shortcutBar === false);
    // The palette can bring it back.
    await openPalette(page, "toggle shortcut bar");
    await page.keyboard.press("Enter");
    await expect(bar).toBeVisible();
  });

  test("first-use tip: Got it records the tip and leaves the bar off", async ({ app, page }) => {
    await app.open({ responses: freshUi });
    const tip = page.getByRole("status", { name: "Tip" });
    await tip.getByRole("button", { name: "Got it" }).click();
    await expect(tip).toHaveCount(0);
    const saved = await app.waitForCall("set_ui_settings");
    expect(saved.args.ui).toMatchObject({ shortcutBar: false, tipsSeen: ["welcome"] });
    await expect(page.getByRole("group", { name: "Shortcut bar" })).toHaveCount(0);
  });
});
