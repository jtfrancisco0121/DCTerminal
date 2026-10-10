import type { Page } from "@playwright/test";
import type { ModelSettings, UiSettings } from "../../src/bridge";
import { CLAUDE_EFFORT_LEVELS } from "../../src/models";
import { expect, test } from "./fixtures/tauri";

const CATEGORIES = [
  "Roles",
  "Providers",
  "Models",
  "Terminal",
  "Permissions",
  "Usage",
  "Notifications",
  "Shortcuts",
  "Data",
] as const;
type Category = (typeof CATEGORIES)[number];

/** Opens Settings from the tab bar gear and shows one category. */
async function openSettings(page: Page, category: Category = "Roles") {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Settings", level: 2 })).toBeVisible();
  if (category !== "Roles") await nav(page).getByRole("button", { name: category }).click();
  const section = page.getByRole("region", { name: category, exact: true });
  await expect(section).toBeVisible();
  return section;
}

const nav = (page: Page) => page.getByRole("navigation", { name: "Settings categories" });

/** A CSS custom property as the page resolves it on <html>. */
const token = (page: Page, name: string) =>
  page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

test.describe("settings page", () => {
  test("every category opens its own section and Close returns to the tab", async ({ app, page }) => {
    await app.open();
    await openSettings(page);
    await expect(nav(page).getByRole("button")).toHaveText([...CATEGORIES]);
    await expect(nav(page).getByRole("button", { name: "Roles" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    for (const name of CATEGORIES) {
      await nav(page).getByRole("button", { name }).click();
      await expect(nav(page).getByRole("button", { name })).toHaveAttribute("aria-current", "page");
      await expect(page.getByRole("region", { name, exact: true })).toBeVisible();
      await expect(page.getByRole("region", { name, exact: true }).getByRole("heading", { level: 3 })).toHaveText(name);
      // Only one category is shown at a time.
      await expect(nav(page).locator("[aria-current=page]")).toHaveCount(1);
    }

    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Settings", level: 2 })).toBeHidden();
    await expect(page.getByRole("heading", { name: "Start a session" })).toBeVisible();
  });
});

test.describe("Models", () => {
  test("Claude roles get an effort select with every level; Cursor and CLI rows do not", async ({
    app,
    page,
  }) => {
    await app.open();
    const models = await openSettings(page, "Models");
    // One per built-in role (8 in the seed).
    await expect(models.getByRole("combobox", { name: /^Claude effort for / })).toHaveCount(8);
    await expect(models.getByRole("combobox", { name: /^Cursor effort for / })).toHaveCount(0);
    await expect(models.getByRole("combobox", { name: "Claude effort for Claude Code tabs" })).toHaveCount(0);
    // The Claude Code tabs row still has its own model picker.
    await expect(models.getByRole("button", { name: "Claude model for Claude Code tabs" })).toBeVisible();
    await expect(models.getByRole("button", { name: "Cursor model for Cursor CLI tabs" })).toBeVisible();

    const effort = models.getByRole("combobox", { name: "Claude effort for Planner" });
    await expect(effort).toHaveValue("");
    await expect(effort.locator("option")).toHaveText([
      "Effort: default",
      ...CLAUDE_EFFORT_LEVELS.map((level) => `Effort: ${level}`),
    ]);
    await expect(models.getByText(/^3 models from the last Claude chat$/)).toBeVisible();
    await expect(models.getByText(/^1 models \(cached list\)$/)).toBeVisible();
  });

  test("choosing an effort saves role_effort for Claude, and Effort: default removes it", async ({
    app,
    page,
  }) => {
    await app.open();
    const models = await openSettings(page, "Models");

    await models.getByRole("combobox", { name: "Claude effort for Planner" }).selectOption("high");
    let saved = await app.waitForCall("set_model_settings", (a) => a.provider === "claude");
    expect(saved.args).toEqual({
      provider: "claude",
      models: { defaultModel: "default", roleModels: {}, roleEffort: { role_planner: "high" } },
    });

    await models.getByRole("combobox", { name: "Claude effort for Developer" }).selectOption("max");
    saved = await app.waitForCall(
      "set_model_settings",
      (a) => (a.models as ModelSettings).roleEffort?.role_developer === "max",
    );
    expect((saved.args.models as ModelSettings).roleEffort).toEqual({
      role_planner: "high",
      role_developer: "max",
    });

    await models.getByRole("combobox", { name: "Claude effort for Planner" }).selectOption("");
    saved = await app.waitForCall(
      "set_model_settings",
      (a) => !("role_planner" in ((a.models as ModelSettings).roleEffort ?? {})),
    );
    expect((saved.args.models as ModelSettings).roleEffort).toEqual({ role_developer: "max" });
    await expect(models.getByRole("combobox", { name: "Claude effort for Planner" })).toHaveValue("");
    await expect(models.getByRole("combobox", { name: "Claude effort for Developer" })).toHaveValue("max");
    // Cursor settings are never written by a Claude effort change.
    expect(await app.calls("set_model_settings").then((c) => c.filter((x) => x.args.provider === "cursor"))).toEqual([]);
  });

  test("per-role and default model pickers save to their own provider", async ({ app, page }) => {
    await app.open();
    const models = await openSettings(page, "Models");

    const planner = models.getByRole("button", { name: "Claude model for Planner" });
    await expect(planner).toContainText("Default (Opus)");
    await expect(planner).toContainText("default");
    await planner.click();
    const list = page.getByRole("dialog", { name: "Claude model for Planner list" });
    await expect(list.getByRole("option")).toHaveText([
      /Default model: Default \(Opus\)/,
      /Default \(Opus\)/,
      /Sonnet/,
      /Haiku.*Fast/,
    ]);
    await list.getByRole("option", { name: /^Sonnet/ }).click();
    await expect(list).toBeHidden();
    let saved = await app.waitForCall("set_model_settings", (a) => a.provider === "claude");
    expect(saved.args.models).toEqual({ defaultModel: "default", roleModels: { role_planner: "sonnet" } });
    await expect(planner).toContainText("Sonnet");

    // Back to the inherited default removes the role entry.
    await planner.click();
    await list.getByRole("option", { name: /^Default model:/ }).click();
    saved = await app.waitForCall(
      "set_model_settings",
      (a) => a.provider === "claude" && Object.keys((a.models as ModelSettings).roleModels).length === 0,
    );
    expect(saved.args.models).toEqual({ defaultModel: "default", roleModels: {} });

    // The search box filters, and Enter picks the first match.
    await models.getByRole("button", { name: "Claude default model" }).click();
    const defaults = page.getByRole("dialog", { name: "Claude default model list" });
    await defaults.getByRole("textbox", { name: "Search models" }).fill("hai");
    await expect(defaults.getByRole("option")).toHaveCount(1);
    await defaults.getByRole("textbox", { name: "Search models" }).press("Enter");
    saved = await app.waitForCall(
      "set_model_settings",
      (a) => a.provider === "claude" && (a.models as ModelSettings).defaultModel === "haiku",
    );
    expect(saved.args.models).toEqual({ defaultModel: "haiku", roleModels: {} });

    // Cursor has its own block and saves with provider "cursor".
    await models.getByRole("button", { name: "Cursor model for General" }).click();
    await page.getByRole("dialog", { name: "Cursor model for General list" }).getByRole("option", { name: /^Auto/ }).click();
    saved = await app.waitForCall("set_model_settings", (a) => a.provider === "cursor");
    expect(saved.args.models).toEqual({ defaultModel: "auto", roleModels: { role_general: "auto" } });
  });

  test("Refresh Cursor model list asks the CLI again and shows the new count", async ({ app, page }) => {
    await app.open();
    const models = await openSettings(page, "Models");
    await app.respond("list_models", {
      models: [
        { id: "auto", label: "Auto", fast: false },
        { id: "composer-2.5", label: "Composer 2.5", fast: false },
      ],
      source: "cli",
      fetchedAtMs: 1,
      error: null,
    });
    await models.getByRole("button", { name: "Refresh Cursor model list" }).click();
    const call = await app.waitForCall("list_models", (a) => a.refresh === true);
    expect(call.args).toEqual({ provider: "cursor", refresh: true });
    await expect(models.getByText("2 models from agent --list-models")).toBeVisible();
  });
});

test.describe("Terminal and theme", () => {
  test("theme switches data-theme and the light palette tokens, and is saved", async ({ app, page }) => {
    await app.open();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "github-dark");
    expect(await token(page, "--attention")).toBe("#f0c14b");

    const terminal = await openSettings(page, "Terminal");
    const theme = terminal.getByRole("combobox", { name: "Theme" });
    await expect(theme.locator("option")).toHaveText(["GitHub Dark", "GitHub Light"]);
    await expect(theme).toHaveValue("github-dark");

    await theme.selectOption({ label: "GitHub Light" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "github-light");
    expect(await token(page, "--attention")).toBe("#9a6700");
    expect(await token(page, "--fg-on-emphasis")).toBe("#ffffff");
    expect(await page.evaluate(() => document.documentElement.style.colorScheme)).toBe("light");
    // The page itself repaints on the light canvas.
    await expect(page.locator("html")).toHaveCSS("background-color", "rgb(255, 255, 255)");
    const saved = await app.waitForCall("set_ui_settings");
    expect((saved.args.ui as UiSettings).theme).toBe("github-light");
    expect(await page.evaluate(() => localStorage.getItem("dcterminal.theme"))).toBe("github-light");

    await theme.selectOption("github-dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "github-dark");
    expect(await token(page, "--attention")).toBe("#f0c14b");
    expect(await page.evaluate(() => document.documentElement.style.colorScheme)).toBe("dark");
    await expect(page.locator("html")).toHaveCSS("background-color", "rgb(13, 17, 23)");
    await app.waitForCall("set_ui_settings", (a) => (a.ui as UiSettings).theme === "github-dark");
  });

  test("an unknown saved theme falls back to GitHub Dark", async ({ app, page }) => {
    await app.open({
      responses: {
        get_ui_settings: { theme: "solarized", shortcutBar: false, tipsSeen: ["welcome", "first-use"], padHeight: 0, padHidden: false },
      },
    });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "github-dark");
    const terminal = await openSettings(page, "Terminal");
    await expect(terminal.getByRole("combobox", { name: "Theme" })).toHaveValue("github-dark");
  });

  test("shell, font size and per-role run mode are saved", async ({ app, page }) => {
    await app.open();
    const terminal = await openSettings(page, "Terminal");
    await expect(terminal.getByRole("textbox", { name: "Shell program" })).toHaveValue("/bin/zsh");
    await expect(terminal.getByRole("spinbutton", { name: "Font size" })).toHaveValue("13");

    await terminal.getByRole("textbox", { name: "Shell program" }).fill("/bin/bash");
    await app.waitForCall("set_terminal_settings", (a) => (a.terminal as { shell: string }).shell === "/bin/bash");

    await terminal.getByRole("spinbutton", { name: "Font size" }).fill("16");
    const font = await app.waitForCall(
      "set_terminal_settings",
      (a) => (a.terminal as { fontSize: number }).fontSize === 16,
    );
    expect(font.args.terminal).toMatchObject({ shell: "/bin/bash", fontSize: 16 });

    const runMode = terminal.getByRole("combobox", { name: "Planner run mode" });
    await expect(runMode).toHaveValue("default");
    await expect(runMode.locator("option")).toHaveText(["Default", "Run Everything", "Auto-review", "Plan", "Ask"]);
    await runMode.selectOption({ label: "Run Everything" });
    const mode = await app.waitForCall(
      "set_terminal_settings",
      (a) => (a.terminal as { roleRunMode: Record<string, string> }).roleRunMode.role_planner === "yolo",
    );
    expect(mode.args.terminal).toEqual({
      shell: "/bin/bash",
      fontSize: 16,
      roleSurface: {},
      roleRunMode: { role_planner: "yolo" },
    });
    await expect(runMode).toHaveValue("yolo");
  });
});

test.describe("Permissions and Usage", () => {
  test("Permissions shows the Cursor approval mode and toggles payload capture", async ({ app, page }) => {
    await app.open({
      responses: {
        cursor_approval_mode: {
          kind: "allowlist",
          approvalMode: "allowlist",
          configPath: "/Users/e2e/.cursor/cli-config.json",
          roleRulesOff: false,
          note: null,
        },
      },
      handlers: {
        diagnostics_set_capture: (args) => ({
          capturePermissionPayloads: args.enabled,
          appDataDir: "/tmp/dct-e2e",
          transcriptsDir: "/tmp/dct-e2e/transcripts",
          logPath: "/tmp/dct-e2e/app.log",
          lastError: null,
        }),
      },
    });
    const perms = await openSettings(page, "Permissions");
    await expect(perms.getByText("Cursor CLI allowlist still applies inside Cursor terminals.", { exact: false })).toBeVisible();
    await expect(perms.getByText(/Current approvalMode: allowlist \(\/Users\/e2e\/\.cursor\/cli-config\.json\)/)).toBeVisible();

    const capture = perms.getByRole("checkbox", { name: "Record permission payloads" });
    await expect(capture).not.toBeChecked();
    await capture.check();
    expect((await app.waitForCall("diagnostics_set_capture")).args).toEqual({ enabled: true });
    await expect(capture).toBeChecked();
    await capture.uncheck();
    await app.waitForCall("diagnostics_set_capture", (a) => a.enabled === false);
    await expect(capture).not.toBeChecked();
  });

  test("Permissions says when the approval mode is unknown", async ({ app, page }) => {
    await app.open();
    const perms = await openSettings(page, "Permissions");
    await expect(perms.getByText(/Cursor CLI approval mode could not be determined/)).toBeVisible();
  });

  test("Usage lists each rate window with its percentage, and stale ones as reset", async ({ app, page }) => {
    const now = Date.now();
    await app.open({
      responses: {
        get_claude_usage: {
          configDir: "/Users/e2e/.claude",
          contextByTab: {},
          windows: [
            { rateLimitType: "five_hour", label: "5-hour", utilization: 42.4, resetsAt: Math.floor(now / 1000) + 3600, status: "allowed", seenAtMs: now },
            { rateLimitType: "seven_day", label: "Weekly", utilization: 90, resetsAt: Math.floor(now / 1000) - 60, status: "allowed", seenAtMs: now - 86_400_000 },
          ],
        },
      },
    });
    const usage = await openSettings(page, "Usage");
    await app.waitForCall("get_claude_usage");
    const windows = usage.locator(".usage-window");
    await expect(windows).toHaveCount(2);
    await expect(windows.nth(0)).toContainText("5-hour 42%");
    await expect(windows.nth(0)).toContainText(/resets \d/);
    // A reading from before the reset shows no percentage.
    await expect(windows.nth(1)).toContainText("Weekly");
    await expect(windows.nth(1)).not.toContainText("90%");
    await expect(windows.nth(1)).toContainText("reset since this reading");
  });

  test("Usage shows the empty and error states", async ({ app, page }) => {
    await app.open();
    let usage = await openSettings(page, "Usage");
    await expect(usage.getByText("Claude usage not reported yet.")).toBeVisible();

    await app.handle("get_claude_usage", () => {
      throw new Error("usage file unreadable");
    });
    await nav(page).getByRole("button", { name: "Data" }).click();
    await nav(page).getByRole("button", { name: "Usage" }).click();
    usage = page.getByRole("region", { name: "Usage", exact: true });
    await expect(usage.getByText("usage file unreadable")).toBeVisible();
  });
});

test.describe("Notifications", () => {
  test("toggles save the whole settings object; sub-options follow the master switch", async ({ app, page }) => {
    await app.open();
    const section = await openSettings(page, "Notifications");
    const master = section.getByRole("checkbox", { name: /^Notify when an agent finishes/ });
    const system = section.getByRole("checkbox", { name: /^System notifications while/ });
    const toasts = section.getByRole("checkbox", { name: /^In-app toasts for other tabs/ });
    const testButton = section.getByRole("button", { name: "Send test notification" });

    await expect(master).toBeChecked();
    await expect(system).not.toBeChecked();
    await expect(system).toBeEnabled();
    await expect(testButton).toBeEnabled();

    await toasts.check();
    let saved = await app.waitForCall("set_notification_settings");
    expect(saved.args).toEqual({ notifications: { enabled: true, system: false, toastWhenFocused: true } });
    await expect(toasts).toBeChecked();

    await master.uncheck();
    saved = await app.waitForCall("set_notification_settings", (a) => !(a.notifications as { enabled: boolean }).enabled);
    expect(saved.args).toEqual({ notifications: { enabled: false, system: false, toastWhenFocused: true } });
    await expect(system).toBeDisabled();
    await expect(toasts).toBeDisabled();
    await expect(testButton).toBeDisabled();

    await master.check();
    await expect(system).toBeEnabled();
    await system.check();
    saved = await app.waitForCall("set_notification_settings", (a) => (a.notifications as { system: boolean }).system);
    expect(saved.args).toEqual({ notifications: { enabled: true, system: true, toastWhenFocused: true } });
  });

  test("Send test notification shows an in-app toast that can be dismissed", async ({ app, page }) => {
    await app.open();
    const section = await openSettings(page, "Notifications");
    await section.getByRole("button", { name: "Send test notification" }).click();
    const toast = page.getByRole("status").filter({ hasText: "DCTerminal notifications are on" });
    await expect(toast).toBeVisible();
    await expect(toast).toContainText("You will see this when a background tab finishes or needs you.");
    await toast.getByRole("button", { name: "Dismiss notification" }).click();
    await expect(toast).toBeHidden();
  });

  test("controls are disabled while the settings have not loaded", async ({ app, page }) => {
    await app.open({
      handlers: {
        get_notification_settings: () => {
          throw new Error("settings.json unreadable");
        },
      },
    });
    const section = await openSettings(page, "Notifications");
    await expect(section.getByRole("checkbox", { name: /^Notify when an agent finishes/ })).toBeDisabled();
    await expect(section.getByRole("button", { name: "Send test notification" })).toBeDisabled();
  });
});

test.describe("Shortcuts", () => {
  // The key labels depend on navigator.platform; pin it to macOS so the list is the same everywhere.
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, "platform", { get: () => "MacIntel", configurable: true });
    });
  });

  test("lists the key bindings and toggles the shortcut bar", async ({ app, page }) => {
    await app.open();
    const section = await openSettings(page, "Shortcuts");
    const rows = section.locator(".settings-shortcuts li");
    expect(await rows.count()).toBeGreaterThan(10);
    const row = (label: string) => rows.filter({ has: page.locator("span", { hasText: new RegExp(`^${label}$`) }) });
    await expect(row("Find in tab").locator("kbd")).toHaveText("⌘+F");
    // Tab switching has two bindings, each its own row.
    await expect(row("Next tab").locator("kbd")).toHaveText(["⌘+PageDown", "⌘+Tab"]);
    await expect(row("Previous tab").locator("kbd")).toHaveText(["⌘+PageUp", "⌘+Shift+Tab"]);
    await expect(rows.filter({ hasText: "⌘+1…9" })).toHaveCount(1);

    await expect(page.getByRole("group", { name: "Shortcut bar" })).toBeHidden();
    const bar = section.getByRole("checkbox", { name: "Show shortcut bar in the status strip" });
    await bar.check();
    const saved = await app.waitForCall("set_ui_settings", (a) => (a.ui as UiSettings).shortcutBar);
    expect(saved.args.ui).toMatchObject({ shortcutBar: true, theme: "github-dark" });
    await page.getByRole("button", { name: "Close", exact: true }).click();
    const shortcutBar = page.getByRole("group", { name: "Shortcut bar" });
    await expect(shortcutBar).toBeVisible();
    await shortcutBar.getByRole("button", { name: "Hide shortcut bar" }).click();
    await expect(shortcutBar).toBeHidden();
    await app.waitForCall("set_ui_settings", (a) => !(a.ui as UiSettings).shortcutBar);
  });

  test("the Settings shortcut is shown as ⌘+, (the key it is bound to)", async ({ app, page }) => {
    await app.open();
    const section = await openSettings(page, "Shortcuts");
    const row = section.locator(".settings-shortcuts li").filter({ has: page.locator("span", { hasText: /^Settings$/ }) });
    await expect(row.locator("kbd")).toHaveText("⌘+,", { timeout: 1000 });
  });

  test("the shortcut list renders without React key collisions", async ({ app, page }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    await app.open();
    const section = await openSettings(page, "Shortcuts");
    await expect(section.locator(".settings-shortcuts li").filter({ hasText: "Search terminal" })).toHaveCount(1);
    expect(errors.filter((text) => text.includes("same key"))).toEqual([]);
  });

  test("Show tips again clears the seen tips and then disables itself", async ({ app, page }) => {
    await app.open();
    const section = await openSettings(page, "Shortcuts");
    const again = section.getByRole("button", { name: "Show tips again" });
    await expect(again).toBeEnabled();
    await again.click();
    const saved = await app.waitForCall("set_ui_settings");
    expect((saved.args.ui as UiSettings).tipsSeen).toEqual([]);
    await expect(again).toBeDisabled();
  });
});

test.describe("Data", () => {
  test("shows the app data paths, folder size and the About line", async ({ app, page }) => {
    await app.open({ responses: { storage_status: { appDataDir: "/tmp/dct-e2e", bytes: 5 * 1024 * 1024 } } });
    const data = await openSettings(page, "Data");
    const paths = data.locator("dl.settings-paths");
    await expect(paths.locator("dt")).toHaveText(["App data", "Transcripts", "Permission log"]);
    await expect(paths.locator("dd")).toHaveText(["/tmp/dct-e2e", "/tmp/dct-e2e/transcripts", "/tmp/dct-e2e/app.log"]);
    await expect(data.getByText("App data folder: 5.0 MB")).toBeVisible();
    await expect(data.getByText(/^DCTerminal \d+\.\d+\.\d+ · Cursor CLI 2026\.10\.01$/)).toBeVisible();
    await expect(data.getByText("Cursor CLI was not found.", { exact: false })).toHaveCount(0);
  });

  test("Clean up now runs the sweep, shows Cleaning… and then what it freed", async ({ app, page }) => {
    await app.open({
      responses: { storage_status: { appDataDir: "/tmp/dct-e2e", bytes: 4096 } },
      handlers: {
        storage_cleanup: () =>
          new Promise((resolve) => {
            (window as any).__finishCleanup = () => resolve({ bytesFreed: 1536, bytes: 2560 });
          }),
      },
    });
    const data = await openSettings(page, "Data");
    await expect(data.getByText("App data folder: 4.0 KB")).toBeVisible();

    await data.getByRole("button", { name: "Clean up now" }).click();
    const busy = data.getByRole("button", { name: "Cleaning…" });
    await expect(busy).toBeDisabled();
    await page.waitForFunction(() => typeof (window as any).__finishCleanup === "function");
    await page.evaluate(() => (window as any).__finishCleanup());
    await expect(data.getByRole("status")).toHaveText("Freed 1.5 KB.");
    await expect(data.getByText("App data folder: 2.5 KB")).toBeVisible();
    await expect(data.getByRole("button", { name: "Clean up now" })).toBeEnabled();
    expect(await app.calls("storage_cleanup")).toHaveLength(1);

    // A second sweep with nothing left says so.
    await app.respond("storage_cleanup", { bytesFreed: 0, bytes: 2560 });
    await data.getByRole("button", { name: "Clean up now" }).click();
    await expect(data.getByRole("status")).toHaveText("Nothing to clean up.");
  });

  test("storage errors are shown, and the About line reports a missing Cursor CLI", async ({ app, page }) => {
    await app.open({
      responses: { detect_cli: { found: false, path: null, version: null, error: "agent not on PATH" } },
      handlers: {
        storage_status: () => {
          throw new Error("app data folder missing");
        },
        storage_cleanup: () => {
          throw new Error("permission denied");
        },
      },
    });
    const data = await openSettings(page, "Data");
    await expect(data.getByText("app data folder missing")).toBeVisible();
    await expect(data.getByText("App data folder: …")).toBeVisible();
    await data.getByRole("button", { name: "Clean up now" }).click();
    await expect(data.getByText("permission denied")).toBeVisible();
    await expect(data.getByRole("status")).toHaveCount(0);
    await expect(data.getByText(/^DCTerminal \d+\.\d+\.\d+$/)).toBeVisible();
    await expect(data.getByText("Cursor CLI was not found. Install it and run agent login.")).toBeVisible();
  });
});

test.describe("persistence", () => {
  test("theme, effort, model, notification and terminal settings survive a reload", async ({ app, page }) => {
    test.slow(); // Two full page loads.
    // Store settings the way settings.json would: across page loads.
    await app.open({
      handlers: {
        get_ui_settings: () =>
          JSON.parse(sessionStorage.getItem("e2e.ui") ?? "null") ?? {
            theme: "github-dark",
            shortcutBar: false,
            tipsSeen: ["welcome", "first-use"],
            padHeight: 0,
            padHidden: false,
          },
        set_ui_settings: (args) => {
          sessionStorage.setItem("e2e.ui", JSON.stringify(args.ui));
          return args.ui;
        },
        get_model_settings: () =>
          JSON.parse(sessionStorage.getItem("e2e.models") ?? "null") ?? {
            cursor: { defaultModel: "auto", roleModels: {} },
            claude: { defaultModel: "default", roleModels: {} },
          },
        set_model_settings: (args) => {
          const all = JSON.parse(sessionStorage.getItem("e2e.models") ?? "null") ?? {
            cursor: { defaultModel: "auto", roleModels: {} },
            claude: { defaultModel: "default", roleModels: {} },
          };
          all[args.provider] = args.models;
          sessionStorage.setItem("e2e.models", JSON.stringify(all));
          return args.models;
        },
        get_notification_settings: () =>
          JSON.parse(sessionStorage.getItem("e2e.notify") ?? "null") ?? {
            enabled: true,
            system: false,
            toastWhenFocused: false,
          },
        set_notification_settings: (args) => {
          sessionStorage.setItem("e2e.notify", JSON.stringify(args.notifications));
          return args.notifications;
        },
        get_terminal_settings: () =>
          JSON.parse(sessionStorage.getItem("e2e.terminal") ?? "null") ?? {
            shell: "/bin/zsh",
            fontSize: 13,
            roleSurface: {},
            roleRunMode: {},
          },
        set_terminal_settings: (args) => {
          sessionStorage.setItem("e2e.terminal", JSON.stringify(args.terminal));
          return args.terminal;
        },
      },
    });

    const terminal = await openSettings(page, "Terminal");
    await terminal.getByRole("combobox", { name: "Theme" }).selectOption("github-light");
    await terminal.getByRole("spinbutton", { name: "Font size" }).fill("18");
    await nav(page).getByRole("button", { name: "Models" }).click();
    const models = page.getByRole("region", { name: "Models", exact: true });
    await models.getByRole("combobox", { name: "Claude effort for Implementer" }).selectOption("xhigh");
    await models.getByRole("button", { name: "Claude model for Implementer" }).click();
    await page.getByRole("dialog", { name: "Claude model for Implementer list" }).getByRole("option", { name: /^Haiku/ }).click();
    await nav(page).getByRole("button", { name: "Notifications" }).click();
    await page.getByRole("checkbox", { name: /^Notify when an agent finishes/ }).uncheck();
    await app.waitForCall("set_notification_settings");
    await app.waitForCall(
      "set_model_settings",
      (a) => (a.models as ModelSettings).roleModels.role_implementer === "haiku",
    );

    // Drop the theme cache so the light theme can only come from the backend.
    await page.evaluate(() => localStorage.removeItem("dcterminal.theme"));
    await page.reload();
    await expect
      .poll(() => page.evaluate(() => window.__E2E.listenerCount("acp/session-update")))
      .toBeGreaterThan(0);

    await expect(page.locator("html")).toHaveAttribute("data-theme", "github-light");
    const after = await openSettings(page, "Terminal");
    await expect(after.getByRole("combobox", { name: "Theme" })).toHaveValue("github-light");
    await expect(after.getByRole("spinbutton", { name: "Font size" })).toHaveValue("18");
    await nav(page).getByRole("button", { name: "Models" }).click();
    const modelsAfter = page.getByRole("region", { name: "Models", exact: true });
    await expect(modelsAfter.getByRole("combobox", { name: "Claude effort for Implementer" })).toHaveValue("xhigh");
    await expect(modelsAfter.getByRole("combobox", { name: "Claude effort for Planner" })).toHaveValue("");
    await expect(modelsAfter.getByRole("button", { name: "Claude model for Implementer" })).toContainText("Haiku");
    await nav(page).getByRole("button", { name: "Notifications" }).click();
    await expect(page.getByRole("checkbox", { name: /^Notify when an agent finishes/ })).not.toBeChecked();
  });
});

test.describe("keyboard", () => {
  test("Tab walks Close then the categories in order; Enter opens one", async ({ app, page, browserName }) => {
    // WebKit on macOS follows Safari's default: Tab reaches form fields only, never buttons.
    test.skip(browserName === "webkit", "WebKit's Tab key skips buttons (macOS default)");
    await app.open();
    await openSettings(page);
    await page.getByRole("button", { name: "Close", exact: true }).focus();
    for (const name of CATEGORIES) {
      await page.keyboard.press("Tab");
      await expect(nav(page).getByRole("button", { name })).toBeFocused();
    }
    // Shift+Tab goes back the same way.
    await page.keyboard.press("Shift+Tab");
    await expect(nav(page).getByRole("button", { name: "Shortcuts" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("region", { name: "Shortcuts", exact: true })).toBeVisible();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    // After the menu, focus enters the section's first control.
    await expect(page.getByRole("checkbox", { name: "Show shortcut bar in the status strip" })).toBeFocused();
    await page.keyboard.press("Space");
    await app.waitForCall("set_ui_settings", (a) => (a.ui as UiSettings).shortcutBar);
  });

  test("Escape closes Settings, and Mod+, opens and closes it", async ({ app, page }) => {
    await app.open();
    await openSettings(page, "Data");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("heading", { name: "Settings", level: 2 })).toBeHidden();
    await expect(page.getByRole("heading", { name: "Start a session" })).toBeVisible();

    await page.keyboard.press("ControlOrMeta+Comma");
    await expect(page.getByRole("heading", { name: "Settings", level: 2 })).toBeVisible();
    // Escape works from inside a text field too.
    await nav(page).getByRole("button", { name: "Terminal" }).click();
    await page.getByRole("textbox", { name: "Shell program" }).focus();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("heading", { name: "Settings", level: 2 })).toBeHidden();

    await page.keyboard.press("ControlOrMeta+Comma");
    await expect(page.getByRole("heading", { name: "Settings", level: 2 })).toBeVisible();
    await page.keyboard.press("ControlOrMeta+Comma");
    await expect(page.getByRole("heading", { name: "Settings", level: 2 })).toBeHidden();
  });

  test("Escape in an open model list closes only the list", async ({ app, page }) => {
    await app.open();
    const models = await openSettings(page, "Models");
    await models.getByRole("button", { name: "Claude model for General" }).click();
    const list = page.getByRole("dialog", { name: "Claude model for General list" });
    await expect(list.getByRole("textbox", { name: "Search models" })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Escape");
    await expect(list).toBeHidden();
    await expect(page.getByRole("heading", { name: "Settings", level: 2 })).toBeVisible();
    expect(await app.calls("set_model_settings")).toHaveLength(0);
  });
});
