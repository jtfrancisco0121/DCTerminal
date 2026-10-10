import type { Page } from "@playwright/test";
import type { ProviderReport, ProviderSettingsView, ProvidersSettings } from "../../src/bridge";
import { expect, test, type PageHandler } from "./fixtures/tauri";

const CONFIG_DIR = { path: "/Users/e2e/.claude", display: "~/.claude", source: "default", exists: true } as const;

/** `set_provider_settings`: echo the saved settings back as a view, like the Rust command. */
const saveProviders: PageHandler = (args) => {
  const settings = args.providers;
  const custom = settings.claude.configDir;
  const dir = custom
    ? { path: custom.replace(/^~/, "/Users/e2e"), display: custom, source: "setting", exists: true }
    : { path: "/Users/e2e/.claude", display: "~/.claude", source: "default", exists: true };
  return { settings, claudeConfigDir: dir, claudeConfigDirEnv: null, claudeAccounts: [] };
};

async function openProviders(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("navigation", { name: "Settings categories" }).getByRole("button", { name: "Providers" }).click();
  const section = page.getByRole("region", { name: "Providers", exact: true });
  await expect(section).toBeVisible();
  return section;
}

function claudeReport(patch: { status?: Partial<ProviderReport["status"]>; login?: Partial<ProviderReport["login"]> } = {}): ProviderReport {
  return {
    status: {
      id: "claude",
      found: true,
      path: "/usr/local/bin/claude",
      version: "2.1.0",
      adapterFound: true,
      adapterPath: "/usr/local/bin/claude-agent-acp",
      error: null,
      ...patch.status,
    },
    login: {
      state: "loggedIn",
      account: "e2e@example.com",
      detail: null,
      apiKeyEnv: false,
      method: "claude.ai · team",
      organization: "Example Org",
      ...patch.login,
    },
    configDir: { ...CONFIG_DIR },
    adapterInstall: null,
  };
}

test("signed-in Claude shows version, adapter, config folder and account", async ({ app, page }) => {
  await app.open();
  const section = await openProviders(page);
  const claude = section.locator(`[aria-label="Claude Code"]`);
  await expect(claude.getByText("2.1.0 · /usr/local/bin/claude")).toBeVisible();
  await expect(claude.getByText("/usr/local/bin/claude-agent-acp")).toBeVisible();
  await expect(claude.getByRole("textbox", { name: "Account name" })).toHaveValue("Claude");
  await expect(claude.getByRole("textbox", { name: "Claude config folder" })).toHaveValue("");
  await expect(claude.getByRole("textbox", { name: "Claude config folder" })).toHaveAttribute("placeholder", "~/.claude");
  await expect(claude.getByTestId("claude-config-source")).toHaveText(
    "Using ~/.claude (default (~/.claude)). DCT_CLAUDE_CONFIG_DIR overrides this account only. DCTerminal only reads the folder.",
  );
  await expect(claude.getByText("Signed in as e2e@example.com (claude.ai · team)")).toBeVisible();
  await expect(claude.getByText(/Run CLAUDE_CONFIG_DIR=/)).toHaveCount(0);

  const cursor = section.locator(`[aria-label="Cursor CLI"]`);
  await expect(cursor.getByText("2.1.0 · /usr/local/bin/claude")).toBeVisible();
  await expect(section.getByRole("radiogroup", { name: "Default provider" }).getByRole("radio", { name: "Claude", exact: true })).toHaveAttribute("aria-checked", "true");
  for (const provider of ["claude", "cursor"]) {
    await app.waitForCall("provider_status", (a) => a.provider === provider);
  }
});

test("signed-out Claude says so with the /login hint, and Check again re-reads it", async ({ app, page }) => {
  const signedOut = claudeReport({ login: { state: "loggedOut", account: null, method: null, organization: null } });
  await app.open({ responses: { provider_status: signedOut } });
  const section = await openProviders(page);
  const claude = section.locator(`[aria-label="Claude Code"]`);
  await expect(claude.getByText("Not signed in.")).toBeVisible();
  await expect(claude.getByText("Run CLAUDE_CONFIG_DIR=~/.claude claude (your claude2) in a terminal and use /login. Then Check again.")).toBeVisible();

  const before = (await app.calls("provider_status")).length;
  await app.respond("provider_status", claudeReport());
  await section.getByRole("button", { name: "Check again" }).click();
  await expect(claude.getByText("Signed in as e2e@example.com (claude.ai · team)")).toBeVisible();
  await expect(claude.getByText("Not signed in.")).toHaveCount(0);
  // Check again re-runs detection for both providers.
  expect((await app.calls("provider_status")).length).toBeGreaterThanOrEqual(before + 2);
  expect((await app.calls("get_provider_settings")).length).toBeGreaterThanOrEqual(2);
});

test("Check again shows Checking… while detection runs", async ({ app, page }) => {
  await app.open();
  const section = await openProviders(page);
  await app.handle("provider_status", () => new Promise(() => {}));
  await section.getByRole("button", { name: "Check again" }).click();
  await expect(section.getByRole("button", { name: "Checking…" })).toBeDisabled();
});

test("missing Claude Code and a missing chat adapter are reported", async ({ app, page }) => {
  await app.open({
    handlers: {
      provider_status: (args) => ({
        status: {
          id: args.provider,
          found: args.provider === "cursor",
          path: args.provider === "cursor" ? "/usr/local/bin/agent" : null,
          version: args.provider === "cursor" ? "2026.10.01" : null,
          adapterFound: false,
          adapterPath: null,
          error: args.provider === "claude" ? "claude was not found on PATH" : null,
        },
        login: { state: "noCli", account: null, detail: null, apiKeyEnv: false },
        configDir: null,
        adapterInstall: null,
      }),
    },
  });
  const section = await openProviders(page);
  const claude = section.locator(`[aria-label="Claude Code"]`);
  await expect(claude.getByText("claude was not found on PATH")).toBeVisible();
  await expect(claude.getByText("Chat adapter")).toHaveCount(0);
  await expect(section.locator(`[aria-label="Cursor CLI"]`).getByText("2026.10.01 · /usr/local/bin/agent")).toBeVisible();

  // Claude found, adapter not: the install command is shown.
  await app.respond(
    "provider_status",
    { ...claudeReport({ status: { adapterFound: false, adapterPath: null } }), adapterInstall: "npm install -g claude-agent-acp" },
  );
  await section.getByRole("button", { name: "Check again" }).click();
  await expect(claude.getByText("Not found. Install it with npm install -g claude-agent-acp")).toBeVisible();
});

test("a config folder set by DCT_CLAUDE_CONFIG_DIR is read-only", async ({ app, page }) => {
  const envDir = { path: "/Users/e2e/.claude-work", display: "~/.claude-work", source: "env", exists: true };
  const view: ProviderSettingsView = {
    settings: { default: "claude", roleProvider: {}, claude: {}, cursor: {} },
    claudeConfigDir: envDir as ProviderSettingsView["claudeConfigDir"],
    claudeConfigDirEnv: "/Users/e2e/.claude-work",
  };
  await app.open({ responses: { get_provider_settings: view } });
  const section = await openProviders(page);
  const claude = section.locator(`[aria-label="Claude Code"]`);
  const folder = claude.getByRole("textbox", { name: "Claude config folder" });
  await expect(folder).toHaveValue("/Users/e2e/.claude-work");
  await expect(folder).toHaveAttribute("readonly", "");
  await expect(claude.getByRole("button", { name: "Browse…" })).toBeDisabled();
  await expect(claude.getByTestId("claude-config-source")).toContainText(
    "Using ~/.claude-work (set by DCT_CLAUDE_CONFIG_DIR (/Users/e2e/.claude-work)).",
  );
});

test("a missing config folder is flagged", async ({ app, page }) => {
  await app.open({
    responses: {
      get_provider_settings: {
        settings: { default: "claude", roleProvider: {}, claude: { configDir: "~/.claude-gone" }, cursor: {} },
        claudeConfigDir: { path: "/Users/e2e/.claude-gone", display: "~/.claude-gone", source: "setting", exists: false },
        claudeConfigDirEnv: null,
      },
    },
  });
  const section = await openProviders(page);
  const claude = section.locator(`[aria-label="Claude Code"]`);
  await expect(claude.getByText("Folder not found: /Users/e2e/.claude-gone")).toBeVisible();
  await expect(claude.getByRole("textbox", { name: "Account name" })).toHaveValue("Personal");
  await expect(claude.getByTestId("claude-config-source")).toContainText("(from Settings)");
});

test("default provider, account name and config folder are saved", async ({ app, page }) => {
  await app.open({ handlers: { set_provider_settings: saveProviders } });
  const section = await openProviders(page);
  const providers = section.getByRole("radiogroup", { name: "Default provider" });

  await providers.getByRole("radio", { name: "Cursor", exact: true }).click();
  let saved = await app.waitForCall("set_provider_settings");
  expect((saved.args.providers as ProvidersSettings).default).toBe("cursor");
  await expect(providers.getByRole("radio", { name: "Cursor", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(providers.getByRole("radio", { name: "Claude", exact: true })).toHaveAttribute("aria-checked", "false");

  const claude = section.locator(`[aria-label="Claude Code"]`);
  await claude.getByRole("textbox", { name: "Account name" }).fill("  Work ");
  await claude.getByRole("textbox", { name: "Account name" }).press("Enter");
  saved = await app.waitForCall("set_provider_settings", (a) => !!(a.providers as ProvidersSettings).claude.accounts);
  expect((saved.args.providers as ProvidersSettings).claude).toEqual({
    accounts: [{ id: "default", name: "Work", configDir: null }],
    configDir: null,
  });

  const folder = claude.getByRole("textbox", { name: "Claude config folder" });
  await folder.fill("~/.claude-work");
  await folder.blur();
  saved = await app.waitForCall(
    "set_provider_settings",
    (a) => (a.providers as ProvidersSettings).claude.configDir === "~/.claude-work",
  );
  expect((saved.args.providers as ProvidersSettings).claude.accounts).toEqual([
    { id: "default", name: "Work", configDir: "~/.claude-work" },
  ]);
  await expect(claude.getByTestId("claude-config-source")).toContainText("Using ~/.claude-work (from Settings).");
  // A save re-checks sign-in for the new folder.
  await expect.poll(async () => (await app.calls("provider_status")).filter((c) => c.args.provider === "claude").length).toBeGreaterThanOrEqual(2);
});

test("Add account and Remove manage a second Claude account", async ({ app, page }) => {
  await app.open({ handlers: { set_provider_settings: saveProviders } });
  const section = await openProviders(page);
  await section.getByRole("button", { name: "Add account" }).click();
  const added = await app.waitForCall("set_provider_settings");
  const accounts = (added.args.providers as ProvidersSettings).claude.accounts!;
  expect(accounts).toHaveLength(2);
  expect(accounts[1]).toMatchObject({ name: "Company", configDir: "~/.claude" });
  await expect(section.getByRole("textbox", { name: "Account name for Company" })).toHaveValue("Company");
  await expect(section.getByRole("textbox", { name: "Config folder for Company" })).toHaveValue("~/.claude");

  await section.getByRole("button", { name: "Remove Company" }).click();
  await app.waitForCall("set_provider_settings", (a) => (a.providers as ProvidersSettings).claude.accounts?.length === 1);
  await expect(section.getByRole("textbox", { name: "Account name for Company" })).toHaveCount(0);
});
