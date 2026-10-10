import type { Page } from "@playwright/test";
import type { ProvidersSettings } from "../../src/bridge";
import { CWD } from "./fixtures/data";
import { expect, test, type PageHandler } from "./fixtures/tauri";

/** First-run setup ("Set up DCTerminal"): src/components/FirstRunSetup.tsx. */

const FIRST_RUN = { first_run_status: { needed: true, completed: false } };

/** provider_status where Claude Code is missing. */
const claudeMissing: PageHandler = (args) => ({
  status: {
    id: args.provider,
    found: false,
    path: null,
    version: null,
    adapterFound: false,
    adapterPath: null,
    error: null,
  },
  login: { state: "noCli", account: null, detail: null, apiKeyEnv: false },
  configDir: { path: "/Users/e2e/.claude", display: "~/.claude", source: "default", exists: true },
  adapterInstall: null,
});

const cliMissing = { found: false, path: null, version: null, error: "agent not found" };

function wizard(page: Page) {
  return page.getByRole("dialog", { name: "Set up DCTerminal" });
}

async function expectStep(page: Page, label: string) {
  await expect(wizard(page).getByRole("list", { name: "Setup steps" }).locator("[aria-current=step]")).toHaveText(label);
}

test("does not open on a profile that finished setup", async ({ app, page }) => {
  await app.open();
  await app.waitForCall("first_run_status");
  await expect(page.getByRole("heading", { name: "Start a session" })).toBeVisible();
  await expect(wizard(page)).toHaveCount(0);
});

test("Claude step: found and signed in, Next moves to the Cursor step", async ({ app, page }) => {
  await app.open({ responses: FIRST_RUN });
  const dialog = wizard(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("list", { name: "Setup steps" }).getByRole("listitem")).toHaveText([
    "Claude Code",
    "Cursor CLI",
    "Folder",
    "Role",
  ]);
  await expectStep(page, "Claude Code");
  const claude = dialog.getByRole("region", { name: "Claude Code" });
  await expect(claude.getByText("Claude Code found.")).toBeVisible();
  await expect(claude.getByText("Version 2.1.0")).toBeVisible();
  await expect(claude.getByText("/usr/local/bin/claude", { exact: true })).toBeVisible();
  await expect(claude.getByText("Config folder: ~/.claude")).toBeVisible();
  await expect(claude.getByText("Signed in as e2e@example.com (claude.ai · team).")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Back" })).toHaveCount(0);

  await dialog.getByRole("button", { name: "Next" }).click();
  await expectStep(page, "Cursor CLI");
  const cursor = dialog.getByRole("region", { name: "Cursor CLI" });
  await expect(cursor.getByText("Cursor CLI found.")).toBeVisible();
  await expect(cursor.getByText("Version 2026.10.01")).toBeVisible();
  await expect(cursor.getByText("Signed in as e2e@example.com.")).toBeVisible();
  await app.waitForCall("cli_login_status");
});

test("Back returns to the Claude step without re-checking", async ({ app, page }) => {
  await app.open({ responses: { ...FIRST_RUN, detect_cli: cliMissing } });
  const dialog = wizard(page);
  const claude = dialog.getByRole("region", { name: "Claude Code" });
  await expect(claude.getByText("Claude Code found.")).toBeVisible();
  await dialog.getByRole("button", { name: "Next" }).click();
  await expectStep(page, "Cursor CLI");
  const checks = (await app.calls("provider_status")).length;
  await dialog.getByRole("button", { name: "Back" }).click();
  await expectStep(page, "Claude Code");
  await expect(claude.getByText("Claude Code found.")).toBeVisible();
  expect((await app.calls("provider_status")).length).toBe(checks);
});

test("Cursor step: once the sign-in check finishes, Back, Next and Skip work again", async ({ app, page }) => {
  await app.open({ responses: FIRST_RUN });
  const dialog = wizard(page);
  await expect(dialog.getByText("Claude Code found.")).toBeVisible();
  await dialog.getByRole("button", { name: "Next" }).click();
  await expect(dialog.getByText("Signed in as e2e@example.com.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Next" })).toBeEnabled({ timeout: 2000 });
  await expect(dialog.getByRole("button", { name: "Back" })).toBeEnabled({ timeout: 500 });
  await expect(dialog.getByRole("button", { name: "Skip setup" })).toBeEnabled({ timeout: 500 });
});

test("Claude step: nothing found blocks Next until Check again finds Claude", async ({ app, page }) => {
  await app.open({
    responses: { ...FIRST_RUN, detect_cli: cliMissing },
    handlers: { provider_status: claudeMissing },
  });
  const dialog = wizard(page);
  const claude = dialog.getByRole("region", { name: "Claude Code" });
  await expect(claude.getByText("Claude Code (claude) was not found.")).toBeVisible();
  await expect(claude.getByRole("link", { name: "Install Claude Code" })).toHaveAttribute(
    "href",
    "https://docs.anthropic.com/en/docs/claude-code/setup",
  );
  await expect(dialog.getByRole("button", { name: "Next" })).toBeDisabled();

  const before = (await app.calls("provider_status")).length;
  await app.handle("provider_status", (args) => ({
    status: {
      id: args.provider,
      found: true,
      path: "/opt/homebrew/bin/claude",
      version: "2.2.0",
      adapterFound: true,
      adapterPath: "/opt/homebrew/bin/claude-agent-acp",
      error: null,
    },
    login: { state: "loggedOut", account: null, detail: null, apiKeyEnv: false },
    configDir: { path: "/Users/e2e/.claude", display: "~/.claude", source: "default", exists: true },
    adapterInstall: null,
  }));
  await claude.getByRole("button", { name: "Check again" }).click();
  await expect(claude.getByText("Claude Code found.")).toBeVisible();
  await expect(claude.getByText("Version 2.2.0")).toBeVisible();
  await expect(claude.getByText(/^Not signed in for this folder\. Run CLAUDE_CONFIG_DIR=~\/\.claude claude/)).toBeVisible();
  expect((await app.calls("provider_status")).length).toBe(before + 1);
  await expect(dialog.getByRole("button", { name: "Next" })).toBeEnabled();
});

test("Claude step: the Cursor CLI alone is enough to continue", async ({ app, page }) => {
  await app.open({ responses: FIRST_RUN, handlers: { provider_status: claudeMissing } });
  const dialog = wizard(page);
  await expect(dialog.getByText("You can also continue with the Cursor CLI only.", { exact: false })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Next" })).toBeEnabled();
});

test("Claude step: Change folder saves the config folder and re-checks", async ({ app, page }) => {
  await app.open({
    responses: FIRST_RUN,
    handlers: {
      set_provider_settings: (args) => ({
        settings: args.providers,
        claudeConfigDir: { path: "/Users/e2e/.claude-work", display: "~/.claude-work", source: "setting", exists: true },
        claudeConfigDirEnv: null,
        claudeAccounts: [],
      }),
    },
  });
  const claude = wizard(page).getByRole("region", { name: "Claude Code" });
  await expect(claude.getByText("Claude Code found.")).toBeVisible();
  await claude.getByRole("button", { name: "Change folder" }).click();
  await claude.getByRole("textbox", { name: "Claude config folder" }).fill("~/.claude-work");
  const before = (await app.calls("provider_status")).length;
  await claude.getByRole("button", { name: "Use folder" }).click();
  const saved = await app.waitForCall("set_provider_settings");
  expect((saved.args.providers as ProvidersSettings).claude.configDir).toBe("~/.claude-work");
  await expect(claude.getByRole("textbox", { name: "Claude config folder" })).toHaveCount(0);
  await expect.poll(async () => (await app.calls("provider_status")).length).toBeGreaterThan(before);
});

test("Cursor step: not found offers the install link; Check again detects it", async ({ app, page }) => {
  await app.open({
    responses: {
      ...FIRST_RUN,
      detect_cli: cliMissing,
      cli_login_status: { state: "loggedOut", account: null, detail: null, apiKeyEnv: true },
    },
  });
  const dialog = wizard(page);
  await expect(dialog.getByText("Claude Code found.")).toBeVisible();
  await dialog.getByRole("button", { name: "Next" }).click();
  await expectStep(page, "Cursor CLI");
  const cursor = dialog.getByRole("region", { name: "Cursor CLI" });
  await expect(cursor.getByText("Optional: tabs can also run on the Cursor CLI.")).toBeVisible();
  await expect(cursor.getByRole("link", { name: "install the Cursor CLI" })).toHaveAttribute(
    "href",
    "https://cursor.com/docs/cli/installation",
  );
  // Cursor is optional: Next works without it.
  await expect(dialog.getByRole("button", { name: "Next" })).toBeEnabled();
  expect(await app.calls("cli_login_status")).toHaveLength(0);

  const detects = (await app.calls("detect_cli")).length;
  await app.respond("detect_cli", { found: true, path: "/usr/local/bin/agent", version: "2026.11.02", error: null });
  await cursor.getByRole("button", { name: "Check again" }).click();
  await expect(cursor.getByText("Cursor CLI found.")).toBeVisible();
  await expect(cursor.getByText("Version 2026.11.02")).toBeVisible();
  await expect(cursor.getByText("Not signed in. Run agent login in a terminal to use Cursor tabs.")).toBeVisible();
  await expect(cursor.getByText("CURSOR_API_KEY is set in this environment.")).toBeVisible();
  expect((await app.calls("detect_cli")).length).toBe(detects + 1);
  await app.waitForCall("cli_login_status");
});

test("Cursor step: a failing check shows its error and keeps the wizard usable", async ({ app, page }) => {
  await app.open({ responses: { ...FIRST_RUN, detect_cli: cliMissing } });
  const dialog = wizard(page);
  await expect(dialog.getByText("Claude Code found.")).toBeVisible();
  await dialog.getByRole("button", { name: "Next" }).click();
  await app.handle("detect_cli", () => {
    throw new Error("spawn agent: permission denied");
  });
  await dialog.getByRole("region", { name: "Cursor CLI" }).getByRole("button", { name: "Check again" }).click();
  await expect(dialog.getByText("spawn agent: permission denied")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Next" })).toBeEnabled();
});

test("Skip setup closes the wizard and marks setup done", async ({ app, page }) => {
  await app.open({ responses: FIRST_RUN });
  const dialog = wizard(page);
  await expect(dialog.getByText("Claude Code found.")).toBeVisible();
  await dialog.getByRole("button", { name: "Skip setup" }).click();
  await expect(dialog).toBeHidden();
  await app.waitForCall("first_run_complete");
  expect(await app.calls("role_session_start")).toHaveLength(0);
  await expect(page.getByRole("heading", { name: "Start a session" })).toBeVisible();
});

test("full walk: folder and role steps, then Start opens the chosen role", async ({ app, page }) => {
  // No Cursor CLI: with one, the wizard locks after its sign-in check (see the known bug above).
  await app.open({ responses: { ...FIRST_RUN, detect_cli: cliMissing } });
  const dialog = wizard(page);
  await expect(dialog.getByText("Claude Code found.")).toBeVisible();
  await dialog.getByRole("button", { name: "Next" }).click();
  await expectStep(page, "Cursor CLI");
  await dialog.getByRole("button", { name: "Next" }).click();

  await expectStep(page, "Folder");
  const folder = dialog.getByRole("region", { name: "Working folder" });
  // It starts on the tab's folder.
  await expect(folder).toContainText(CWD);
  await expect(dialog.getByRole("button", { name: "Next" })).toBeEnabled();
  await dialog.getByRole("button", { name: "Next" }).click();

  await expectStep(page, "Role");
  const roles = dialog.getByRole("radiogroup", { name: "Role" });
  await expect(roles.getByRole("radio")).toHaveCount(8);
  const start = dialog.getByRole("button", { name: "Start" });
  await expect(start).toBeDisabled();
  await expect(dialog.getByRole("radiogroup", { name: "Open as" })).toHaveCount(0);
  await roles.getByRole("radio", { name: "General" }).click();
  await expect(roles.getByRole("radio", { name: "General" })).toHaveAttribute("aria-checked", "true");
  const surface = dialog.getByRole("radiogroup", { name: "Open as" });
  await expect(surface.getByRole("radio", { name: "Chat" })).toHaveAttribute("aria-checked", "true");
  await expect(start).toBeEnabled();
  // Earlier steps are marked done.
  await expect(dialog.locator(".first-run-steps li.done")).toHaveText(["Claude Code", "Cursor CLI", "Folder"]);

  await start.click();
  await expect(dialog).toBeHidden();
  await app.waitForCall("first_run_complete");
  const started = await app.waitForCall("role_session_start");
  expect(started.args).toMatchObject({ roleId: "role_general" });
  expect((started.args.values as Record<string, string>).cwd).toBe(CWD);
});
