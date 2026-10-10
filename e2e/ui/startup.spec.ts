import type { Page } from "@playwright/test";
import { CWD } from "./fixtures/data";
import { expect, roleTab, test, type PageHandler } from "./fixtures/tauri";

// The "Start a session" card: provider, model and effort, role tiles, fields,
// Validate & preview, Start, and per-tab drafts (src/StartupForm.tsx).

const startRow = (page: Page) => page.getByRole("group", { name: "Start a session" });
const roleGroup = (page: Page) => page.getByRole("group", { name: "Role" });
const providerChip = (page: Page) => page.getByRole("radiogroup", { name: "Provider for this tab" });
const fieldControls = (page: Page) => page.locator(".composer-fields").locator("input, textarea, select");

const PLANNER_ANSWERS = {
  taskType: "Feature",
  title: "Effort controls",
  request: "Let users pick reasoning effort",
  expectedBehavior: "An effort picker in the chat header",
};

/** set_tab_provider / set_tab_model the way the Rust store applies them. */
const tabSettingHandlers: Record<string, PageHandler> = {
  set_tab_provider: (a, s) => {
    const tab = s.tabs.find((t: { id: string }) => t.id === a.tabId);
    if (!tab) throw new Error(`tab not found: ${a.tabId}`);
    tab.provider = a.provider;
    if (a.roleId) (s.e2eRoleProvider ??= {})[a.roleId] = a.provider;
    return null;
  },
  set_tab_model: (a, s) => {
    const tab = s.tabs.find((t: { id: string }) => t.id === a.tabId);
    if (!tab) throw new Error(`tab not found: ${a.tabId}`);
    tab.model = a.model;
    return a.model ?? "default";
  },
  get_provider_settings: (_a, s) => {
    const configDir = { path: "/Users/e2e/.claude", display: "~/.claude", source: "default", exists: true };
    return {
      settings: { default: "claude", roleProvider: { ...(s.e2eRoleProvider ?? {}) }, claude: {}, cursor: {} },
      claudeConfigDir: configDir,
      claudeConfigDirEnv: null,
      claudeAccounts: [{ id: "default", name: "Claude", config: configDir, envOverride: false }],
    };
  },
};

/** role_session_start whose Claude sessions report effort levels (Cursor ones do not). */
const startWithEffort: PageHandler = (a, s) => {
  const tab = s.tabs.find((t: { id: string }) => t.id === a.tabId);
  tab.phase = "running";
  tab.startupPromptSent = true;
  tab.acpSessionId = `sess-${tab.id}`;
  const claude = tab.provider === "claude";
  return {
    errors: [],
    session: {
      sessionId: `sess-${tab.id}`,
      modeId: "agent",
      cwd: tab.cwd,
      model: tab.model ?? (claude ? "default" : "auto"),
      effort: claude ? "medium" : null,
      effortOptions: claude ? ["default", "low", "medium", "high"] : [],
      supportsImages: true,
    },
    mergedChars: 24,
    injectionStrategy: "send_on_start",
    startupInjected: false,
    injectionInFlight: true,
    tabId: tab.id,
    resumedSession: false,
    skippedStartupInjection: false,
    folderWarning: null,
    loadedViaSessionLoad: false,
    replayMessageCount: 0,
    replayTruncated: false,
    replay: [],
    modelVia: "unchanged",
  };
};

/** template/validate.rs: required visible fields, select options, then the folder. */
const validateLikeRust: PageHandler = (a, s) => {
  const role = s.roles.find((r: { id: string }) => r.id === a.roleId);
  const values: Record<string, string> = a.values ?? {};
  const errors: { key: string; message: string }[] = [];
  for (const f of role.fields) {
    if (f.showWhen && !f.showWhen.equals.includes((values[f.showWhen.fieldKey] ?? "").trim())) continue;
    const raw = (values[f.key] ?? "").trim();
    if (f.required && !raw) {
      errors.push({ key: f.key, message: `${f.label} is required` });
      continue;
    }
    if (f.type === "select" && f.options && (f.required || raw) && !f.options.includes(raw)) {
      errors.push({ key: f.key, message: "Select a valid option" });
    }
  }
  if (!(values.cwd ?? "").trim()) errors.push({ key: "cwd", message: "Working folder is required" });
  if (errors.length > 0) return { errors, merged: null };
  const text = `# ${values.taskType}: ${values.title}\n\n${values.request}\n\nExpected: ${values.expectedBehavior}`;
  return { errors: [], merged: { text, chars: text.length, unresolved: [] } };
};

test.describe("provider", () => {
  test("switching to Cursor saves it for the tab and role, and swaps history and models", async ({
    app,
    page,
  }) => {
    await app.open({
      tabs: [roleTab("tab-1", "role_planner", "Planner", { model: "sonnet" })],
      handlers: tabSettingHandlers,
    });
    const chip = providerChip(page);
    await expect(chip.getByRole("radio", { name: "Claude" })).toBeChecked();
    await expect(page.getByRole("region", { name: "Claude Code history" })).toBeVisible();
    await expect(startRow(page).getByRole("button", { name: "Model for this tab" })).toContainText("Sonnet");

    await chip.getByRole("radio", { name: "Cursor" }).click();
    // A Claude model id means nothing to Cursor: it is cleared first.
    const cleared = await app.waitForCall("set_tab_model");
    expect(cleared.args).toEqual({ tabId: "tab-1", model: null });
    const set = await app.waitForCall("set_tab_provider");
    expect(set.args).toEqual({ tabId: "tab-1", provider: "cursor", roleId: "role_planner" });
    const order = (await app.calls()).map((c) => c.cmd);
    expect(order.lastIndexOf("set_tab_model")).toBeLessThan(order.lastIndexOf("set_tab_provider"));

    await expect(chip.getByRole("radio", { name: "Cursor" })).toBeChecked();
    await expect(chip.getByRole("radio", { name: "Claude" })).not.toBeChecked();
    await expect(page.getByRole("region", { name: "Cursor CLI history" })).toBeVisible();
    await expect(page.getByRole("group", { name: "History provider" }).getByRole("button", { name: "Cursor" }))
      .toHaveAttribute("aria-pressed", "true");
    expect((await app.waitForCall("list_cursor_cli_history")).args).toEqual({ cwd: CWD });
    await expect(startRow(page).getByRole("button", { name: "Model for this tab" })).toContainText("Auto");

    // Back to Claude: no model to clear this time.
    await chip.getByRole("radio", { name: "Claude" }).click();
    await expect(chip.getByRole("radio", { name: "Claude" })).toBeChecked();
    await expect(page.getByRole("region", { name: "Claude Code history" })).toBeVisible();
    expect(await app.calls("set_tab_model")).toHaveLength(1);
    expect((await app.calls("set_tab_provider")).at(-1)!.args).toEqual({
      tabId: "tab-1",
      provider: "claude",
      roleId: "role_planner",
    });
  });

  test("picking a role applies the provider remembered for that role", async ({ app, page }) => {
    await app.open({
      tabs: [roleTab("tab-1", "role_planner", "Planner")],
      handlers: tabSettingHandlers,
    });
    // Remember Cursor for the Planner, then move to another role (default: Claude).
    await providerChip(page).getByRole("radio", { name: "Cursor" }).click();
    await expect(providerChip(page).getByRole("radio", { name: "Cursor" })).toBeChecked();
    await roleGroup(page).getByRole("button", { name: "Developer" }).click();
    await expect(providerChip(page).getByRole("radio", { name: "Claude" })).toBeChecked();
    expect((await app.calls("set_tab_provider")).at(-1)!.args).toEqual({
      tabId: "tab-1",
      provider: "claude",
      roleId: null,
    });

    await roleGroup(page).getByRole("button", { name: "Planner" }).click();
    await expect(providerChip(page).getByRole("radio", { name: "Cursor" })).toBeChecked();
    expect((await app.calls("set_tab_provider")).at(-1)!.args).toEqual({
      tabId: "tab-1",
      provider: "cursor",
      roleId: null,
    });
  });

  test("Cursor CLI missing: the message and a disabled Start show only for Cursor", async ({
    app,
    page,
  }) => {
    await app.open({
      handlers: tabSettingHandlers,
      responses: {
        detect_cli: { found: false, path: null, version: null, error: "agent: command not found" },
      },
    });
    const missing = page.getByText("Cursor CLI was not found.");
    const start = startRow(page).getByRole("button", { name: "Start", exact: true });
    await expect(providerChip(page).getByRole("radio", { name: "Claude" })).toBeChecked();
    await expect(start).toBeEnabled();
    await expect(missing).toBeHidden();

    await providerChip(page).getByRole("radio", { name: "Cursor" }).click();
    await expect(missing).toBeVisible();
    await expect(start).toBeDisabled();

    await providerChip(page).getByRole("radio", { name: "Claude" }).click();
    await expect(missing).toBeHidden();
    await expect(start).toBeEnabled();
  });
});

test.describe("model and effort", () => {
  test("the model picker sets this tab's model only", async ({ app, page }) => {
    await app.open({
      tabs: [roleTab("tab-1", "role_general", "Alpha"), roleTab("tab-2", "role_general", "Beta")],
      handlers: tabSettingHandlers,
    });
    const picker = startRow(page).getByRole("button", { name: "Model for this tab" });
    await expect(picker).toContainText("Default (Opus)");
    await picker.click();
    const list = page.getByRole("listbox", { name: "Model for this tab" });
    await expect(list.getByRole("option")).toHaveCount(4); // Default: … plus the three models
    await list.getByRole("option", { name: /Sonnet/ }).click();
    const set = await app.waitForCall("set_tab_model");
    expect(set.args).toEqual({ tabId: "tab-1", model: "sonnet" });
    await expect(picker).toContainText("Sonnet");

    await page.getByRole("tab", { name: "Beta" }).click();
    await expect(page.getByRole("tab", { name: "Beta" })).toHaveAttribute("aria-selected", "true");
    await expect(picker).toContainText("Default (Opus)");

    await page.getByRole("tab", { name: "Alpha" }).click();
    await expect(picker).toContainText("Sonnet");

    // Back to the inherited model.
    await picker.click();
    await list.getByRole("option", { name: /^Default: / }).click();
    await expect.poll(async () => (await app.calls("set_tab_model")).at(-1)!.args).toEqual({
      tabId: "tab-1",
      model: null,
    });
    await expect(picker).toContainText("Default (Opus)");
    // The model is tab state; Start does not carry it.
    await app.start("tab-1");
    expect((await app.waitForCall("role_session_start")).args).not.toHaveProperty("model");
  });

  test("the effort picker changes a running Claude chat's effort, per tab", async ({ app, page }) => {
    await app.open({
      tabs: [
        roleTab("tab-1", "role_general", "Alpha"),
        roleTab("tab-2", "role_general", "Beta", { provider: "cursor" }),
      ],
      handlers: { ...tabSettingHandlers, role_session_start: startWithEffort, acp_set_effort: (a) => a.effort },
    });
    // No session yet: no effort picker.
    await expect(page.getByRole("combobox", { name: /^Effort for / })).toHaveCount(0);

    await (await app.start("tab-1")).reply("alpha ready");
    const effort = page.getByRole("combobox", { name: "Effort for Alpha" });
    await expect(effort).toHaveValue("medium");
    await expect(effort.getByRole("option")).toHaveText([
      "Effort: default",
      "Effort: low",
      "Effort: medium",
      "Effort: high",
    ]);
    await effort.selectOption("high");
    const set = await app.waitForCall("acp_set_effort");
    expect(set.args).toEqual({ tabId: "tab-1", effort: "high" });
    await expect(effort).toHaveValue("high");

    // A Cursor chat reports no effort levels: no picker on that tab.
    await page.getByRole("tab", { name: "Beta" }).click();
    await (await app.start("tab-2")).reply("beta ready");
    await expect(page.getByRole("button", { name: "Model for Beta" })).toBeVisible();
    await expect(page.getByRole("combobox", { name: /^Effort for / })).toHaveCount(0);

    await page.getByRole("tab", { name: "Alpha" }).click();
    await expect(page.getByRole("combobox", { name: "Effort for Alpha" })).toHaveValue("high");
    expect(await app.calls("acp_set_effort")).toHaveLength(1);
  });

  test("an effort change the agent refuses keeps the old level and says why", async ({ app, page }) => {
    await app.open({
      handlers: {
        role_session_start: startWithEffort,
        acp_set_effort: () => {
          throw new Error("The agent is busy. Try again when the turn finishes.");
        },
      },
    });
    await (await app.start("tab-1")).reply("ready");
    const effort = page.getByRole("combobox", { name: "Effort for General" });
    await effort.selectOption("low");
    expect((await app.waitForCall("acp_set_effort")).args).toEqual({ tabId: "tab-1", effort: "low" });
    await expect(page.getByText("Effort not changed")).toBeVisible();
    await expect(page.getByText("The agent is busy. Try again when the turn finishes.")).toBeVisible();
    await expect(effort).toHaveValue("medium");
  });
});

test.describe("role tiles", () => {
  test("tiles are grouped Pipeline (in hand-off order), Other roles, Terminals", async ({ app, page }) => {
    await app.open();
    const tiles = roleGroup(page);
    await expect(tiles.getByRole("group")).toHaveCount(3);
    await expect(tiles.getByRole("group", { name: "Pipeline" }).getByRole("button")).toHaveText([
      "Planner",
      "Plan Reviewer",
      "Implementer",
      "PR Reviewer",
    ]);
    await expect(tiles.getByRole("group", { name: "Pipeline" })).toContainText(
      "Planner→Plan Reviewer→Implementer→PR Reviewer",
    );
    await expect(tiles.getByRole("group", { name: "Other roles" }).getByRole("button")).toHaveText([
      "Developer",
      "General",
      "Recommendation",
      "Codebase Audit",
    ]);
    await expect(tiles.getByRole("group", { name: "Terminals" }).getByRole("button")).toHaveText([
      "Terminal",
      "Claude Code",
      "Cursor CLI",
    ]);
    await expect(tiles.getByRole("button", { name: "General" })).toHaveAttribute("aria-pressed", "true");
  });

  test("a custom role joins Other roles, after the built-ins", async ({ app, page }) => {
    await app.open({
      roles: (roles) => [
        ...roles,
        { ...roles.find((r) => r.id === "role_general")!, id: "role_custom_notes", name: "Release Notes", isBuiltIn: false },
      ],
    });
    await expect(roleGroup(page).getByRole("group", { name: "Other roles" }).getByRole("button")).toHaveText([
      "Developer",
      "General",
      "Recommendation",
      "Codebase Audit",
      "Release Notes",
    ]);
  });

  const lightweight = ["Title", "What to work on"];
  const roleFields: Record<string, string[]> = {
    Planner: ["Task Type *", "Title *", "Request / Problem *", "Expected Behavior *", "Additional Context"],
    "Plan Reviewer": ["Original Task *", "Proposed Implementation Plan *", "Additional Context"],
    Implementer: ["Task Type *", "Title *", "Description *", "Approved Implementation Plan *", "Additional Context"],
    "PR Reviewer": ["Original Task *", "Approved Implementation Plan *", "Additional Context"],
    Developer: lightweight,
    General: lightweight,
    Recommendation: lightweight,
    "Codebase Audit": lightweight,
  };
  const eagle: Record<string, string> = { Planner: "Eagle-Eye 1", Implementer: "Eagle-Eye 2" };
  for (const [name, labels] of Object.entries(roleFields)) {
    test(`selecting ${name} shows its fields`, async ({ app, page }) => {
      // Start from another role so the tile click really switches the form.
      const from = name === "Developer" ? "role_planner" : "role_developer";
      await app.open({ tabs: [roleTab("tab-1", from, "Draft")] });
      const tile = roleGroup(page).getByRole("button", { name, exact: true });
      await tile.click();
      await expect(tile).toHaveAttribute("aria-pressed", "true");
      await expect(roleGroup(page).locator('[aria-pressed="true"]')).toHaveCount(1);
      for (const label of labels) {
        const role = label.startsWith("Task Type") ? "combobox" : "textbox";
        await expect(page.getByRole(role, { name: label, exact: true })).toBeVisible();
      }
      await expect(fieldControls(page)).toHaveCount(labels.length);
      if (eagle[name]) await expect(page.getByRole("checkbox", { name: eagle[name] })).not.toBeChecked();
      else await expect(page.getByRole("checkbox", { name: /Eagle-Eye/ })).toHaveCount(0);
      await expect(page.getByRole("group", { name: "Open as" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Validate & preview" })).toBeVisible();
      await expect(startRow(page).getByRole("button", { name: "Start", exact: true })).toBeEnabled();
    });
  }

  test("Planner: Current Behavior shows only for a Bug", async ({ app, page }) => {
    await app.open({ tabs: [roleTab("tab-1", "role_planner", "Planner")] });
    const taskType = page.getByRole("combobox", { name: "Task Type *" });
    await expect(taskType.getByRole("option")).toHaveText(["Select…", "Feature", "Bug", "Refactor", "Chore"]);
    await expect(page.getByLabel("Current Behavior *")).toBeHidden();
    await taskType.selectOption("Bug");
    await expect(page.getByLabel("Current Behavior *")).toBeVisible();
    await taskType.selectOption("Refactor");
    await expect(page.getByLabel("Current Behavior *")).toBeHidden();
  });

  test("terminal tiles replace the role form with a launch button", async ({ app, page }) => {
    await app.open({
      handlers: {
        shell_terminal_start: () => {
          throw new Error("could not spawn /bin/zsh");
        },
      },
    });
    const tiles = roleGroup(page);
    const cases: [string, string, boolean][] = [
      ["Terminal", "Start terminal", false],
      ["Claude Code", "Start Claude Code", true],
      ["Cursor CLI", "Start Cursor CLI", true],
    ];
    for (const [tile, button, hasModel] of cases) {
      await tiles.getByRole("button", { name: tile, exact: true }).click();
      await expect(tiles.getByRole("button", { name: tile, exact: true })).toHaveAttribute("aria-pressed", "true");
      // No role is selected while a terminal tile is.
      await expect(tiles.getByRole("button", { name: "General" })).toHaveAttribute("aria-pressed", "false");
      await expect(startRow(page).getByRole("button", { name: button })).toBeEnabled();
      await expect(startRow(page).getByRole("button", { name: "Model for this tab" })).toHaveCount(hasModel ? 1 : 0);
      await expect(providerChip(page)).toBeHidden();
      await expect(page.getByRole("group", { name: "Open as" })).toBeHidden();
      await expect(fieldControls(page)).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Validate & preview" })).toBeHidden();
      await expect(page.locator(".start-history")).toBeHidden();
    }

    await tiles.getByRole("button", { name: "Terminal", exact: true }).click();
    await startRow(page).getByRole("button", { name: "Start terminal" }).click();
    const call = await app.waitForCall("shell_terminal_start");
    expect(call.args.input).toEqual({
      tabId: "tab-1",
      cwd: CWD,
      launch: "shell",
      resumeSessionId: null,
      cols: 80,
      rows: 24,
      windowId: "main",
    });
    await expect(page.getByText("could not spawn /bin/zsh")).toBeVisible();

    // Picking a role again brings the form back.
    await tiles.getByRole("button", { name: "Developer" }).click();
    await expect(fieldControls(page)).toHaveCount(2);
    await expect(startRow(page).getByRole("button", { name: "Start", exact: true })).toBeVisible();
  });
});

test.describe("validate and start", () => {
  test("required fields: Preview and Start list what is missing and nothing starts", async ({
    app,
    page,
  }) => {
    await app.open({
      tabs: [roleTab("tab-1", "role_planner", "Planner")],
      handlers: {
        validate_and_preview: validateLikeRust,
        role_session_start: (a, s) => {
          const role = s.roles.find((r: { id: string }) => r.id === a.roleId);
          const errors = role.fields
            .filter(
              (f: { required: boolean; key: string; showWhen?: { fieldKey: string; equals: string[] } }) =>
                f.required &&
                (!f.showWhen || f.showWhen.equals.includes((a.values[f.showWhen.fieldKey] ?? "").trim())) &&
                !(a.values[f.key] ?? "").trim(),
            )
            .map((f: { key: string; label: string }) => ({ key: f.key, message: `${f.label} is required` }));
          return {
            errors,
            session: null,
            mergedChars: null,
            injectionStrategy: null,
            startupInjected: false,
            injectionInFlight: false,
            tabId: a.tabId,
            resumedSession: false,
            skippedStartupInjection: false,
            folderWarning: null,
            loadedViaSessionLoad: false,
            replayMessageCount: 0,
            replayTruncated: false,
            replay: [],
          };
        },
      },
    });
    const errors = page.locator(".field-errors li");
    const missing = [
      "taskType: Task Type is required",
      "title: Title is required",
      "request: Request / Problem is required",
      "expectedBehavior: Expected Behavior is required",
    ];

    // Preview checks the form without starting anything.
    await page.getByRole("button", { name: "Validate & preview" }).click();
    expect((await app.waitForCall("validate_and_preview")).args).toEqual({
      roleId: "role_planner",
      values: { cwd: CWD },
    });
    await expect(errors).toHaveText(missing);
    await expect(page.locator(".preview-details")).toHaveCount(0);
    expect(await app.calls("role_session_start")).toHaveLength(0);

    // Start runs the same check in the backend; nothing starts.
    await startRow(page).getByRole("button", { name: "Start", exact: true }).click();
    const start = await app.waitForCall("role_session_start");
    expect(start.args).toMatchObject({ roleId: "role_planner", tabId: "tab-1", values: { cwd: CWD } });
    await expect(errors).toHaveText(missing);
    await expect(page.getByRole("button", { name: "Stop session" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Start a session" })).toBeVisible();

    // Fill some: only what is left is listed, and a Bug also needs Current Behavior.
    await page.getByRole("combobox", { name: "Task Type *" }).selectOption("Bug");
    await page.getByRole("textbox", { name: "Title *" }).fill("Crash on save");
    await startRow(page).getByRole("button", { name: "Start", exact: true }).click();
    await expect.poll(async () => (await app.calls("role_session_start")).length).toBe(2);
    await expect(errors).toHaveText([
      "request: Request / Problem is required",
      "expectedBehavior: Expected Behavior is required",
      "currentBehavior: Current Behavior is required",
    ]);
  });

  test("Validate & preview renders the merged prompt; Start sends the form", async ({ app, page }) => {
    await app.open({
      tabs: [roleTab("tab-1", "role_planner", "Planner")],
      answers: { "tab-1": PLANNER_ANSWERS },
      handlers: { validate_and_preview: validateLikeRust },
    });
    await expect(page.getByRole("textbox", { name: "Title *" })).toHaveValue("Effort controls");
    await page.getByRole("textbox", { name: "Additional Context" }).fill("See the ACP spec");
    await page.getByRole("button", { name: "Validate & preview" }).click();

    const values = { cwd: CWD, ...PLANNER_ANSWERS, additionalContext: "See the ACP spec" };
    const preview = await app.waitForCall("validate_and_preview");
    expect(preview.args).toEqual({ roleId: "role_planner", values });

    const text =
      "# Feature: Effort controls\n\nLet users pick reasoning effort\n\nExpected: An effort picker in the chat header";
    const details = page.locator(".preview-details");
    await expect(details.locator("summary")).toHaveText(`Merged prompt (${text.length} chars)`);
    await details.locator("summary").click();
    await expect(details.locator("pre")).toHaveText(text);
    await expect(page.locator(".field-errors")).toHaveCount(0);

    await app.start("tab-1");
    const start = await app.waitForCall("role_session_start");
    expect(start.args).toEqual({
      roleId: "role_planner",
      values,
      tabId: "tab-1",
      resendStartup: false,
      resumeSessionId: null,
      windowId: "main",
    });
    // The previewed startup prompt is what the chat shows as sent.
    await expect(page.getByRole("log")).toContainText("Let users pick reasoning effort");
    expect(await app.calls("role_terminal_start")).toHaveLength(0);
  });

  test("a preview the backend rejects shows its error", async ({ app, page }) => {
    await app.open({
      handlers: {
        validate_and_preview: () => {
          throw new Error("template has an unclosed {{");
        },
      },
    });
    await page.getByRole("button", { name: "Validate & preview" }).click();
    await expect(page.locator(".field-errors li")).toHaveText(["_form: template has an unclosed {{"]);
  });

  test("Open as Terminal is remembered per role and starts the role in a terminal", async ({
    app,
    page,
  }) => {
    await app.open({
      answers: { "tab-1": { title: "Audit deps", request: "List outdated packages" } },
      responses: {
        role_terminal_start: {
          errors: [{ key: "_session", message: "claude was not found on PATH" }],
          tabId: null,
          pid: null,
          usedPromptFile: false,
        },
      },
    });
    const openAs = page.getByRole("group", { name: "Open as" });
    await expect(openAs.getByRole("button", { name: "Chat" })).toHaveAttribute("aria-pressed", "true");
    await openAs.getByRole("button", { name: "Terminal" }).click();

    const saved = await app.waitForCall("set_terminal_settings");
    expect((saved.args.terminal as { roleSurface: Record<string, string> }).roleSurface).toEqual({
      role_general: "terminal",
    });
    await expect(openAs.getByRole("button", { name: "Terminal" })).toHaveAttribute("aria-pressed", "true");
    await expect(openAs.getByRole("button", { name: "Chat" })).toHaveAttribute("aria-pressed", "false");
    const startTerminal = startRow(page).getByRole("button", { name: "Start terminal" });
    await expect(startTerminal).toBeVisible();

    // Other roles keep Chat.
    await roleGroup(page).getByRole("button", { name: "Developer" }).click();
    await expect(openAs.getByRole("button", { name: "Chat" })).toHaveAttribute("aria-pressed", "true");
    await expect(startRow(page).getByRole("button", { name: "Start", exact: true })).toBeVisible();
    await roleGroup(page).getByRole("button", { name: "General" }).click();

    await startTerminal.click();
    const call = await app.waitForCall("role_terminal_start");
    expect(call.args.input).toEqual({
      roleId: "role_general",
      values: { cwd: CWD, title: "Audit deps", request: "List outdated packages" },
      tabId: "tab-1",
      handoffPlan: null,
      cols: 80,
      rows: 24,
      windowId: "main",
    });
    expect(await app.calls("role_session_start")).toHaveLength(0);
    await expect(page.locator(".field-errors li")).toHaveText(["_session: claude was not found on PATH"]);

    // Back to Chat: Start opens a chat again.
    await openAs.getByRole("button", { name: "Chat" }).click();
    await app.start("tab-1");
    expect((await app.waitForCall("role_session_start")).args).toMatchObject({ roleId: "role_general" });
  });
});

test.describe("drafts", () => {
  test("each tab keeps its own role and answers when switching tabs", async ({ app, page }) => {
    await app.open({
      tabs: [roleTab("tab-1", "role_planner", "Planner"), roleTab("tab-2", "role_general", "Notes")],
      // Nothing reaches the backend store, so only the in-memory drafts can restore the form.
      handlers: { sync_active_tab_form: () => null },
    });
    await page.getByRole("combobox", { name: "Task Type *" }).selectOption("Bug");
    await page.getByRole("textbox", { name: "Title *" }).fill("Crash on save");
    await page.getByRole("textbox", { name: "Current Behavior *" }).fill("It crashes");

    await page.getByRole("tab", { name: "Notes" }).click();
    await expect(roleGroup(page).getByRole("button", { name: "General" })).toHaveAttribute("aria-pressed", "true");
    const title = page.getByRole("textbox", { name: "Title", exact: true });
    await expect(title).toHaveValue("");
    await title.fill("Release checklist");
    await roleGroup(page).getByRole("button", { name: "Developer" }).click();
    await expect(roleGroup(page).getByRole("button", { name: "Developer" })).toHaveAttribute("aria-pressed", "true");

    await page.getByRole("tab", { name: "Planner" }).click();
    await expect(roleGroup(page).getByRole("button", { name: "Planner" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("combobox", { name: "Task Type *" })).toHaveValue("Bug");
    await expect(page.getByRole("textbox", { name: "Title *" })).toHaveValue("Crash on save");
    await expect(page.getByRole("textbox", { name: "Current Behavior *" })).toHaveValue("It crashes");

    await page.getByRole("tab", { name: "Notes" }).click();
    await expect(roleGroup(page).getByRole("button", { name: "Developer" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveValue("Release checklist");
  });

  test("the form comes back after a reload", async ({ app, page }) => {
    await app.open({ tabs: [roleTab("tab-1", "role_planner", "Planner")] });
    await page.getByRole("combobox", { name: "Task Type *" }).selectOption("Feature");
    await page.getByRole("textbox", { name: "Title *" }).fill("Effort controls");
    await page.getByRole("textbox", { name: "Request / Problem *" }).fill("Let users pick effort");

    // The debounced write to the tab store.
    const synced = await app.waitForCall(
      "sync_active_tab_form",
      (args) => (args.values as Record<string, string>).request === "Let users pick effort",
    );
    expect(synced.args).toEqual({
      tabId: "tab-1",
      roleId: "role_planner",
      cwd: CWD,
      values: {
        cwd: CWD,
        taskType: "Feature",
        title: "Effort controls",
        request: "Let users pick effort",
      },
    });

    // Carry the fake backend's store across the reload, like the Rust state file.
    await page.evaluate(() =>
      sessionStorage.setItem(
        "e2e-startup-state",
        JSON.stringify({ tabs: window.__E2E.state.tabs, answers: window.__E2E.state.answers }),
      ),
    );
    await page.addInitScript(() => {
      const saved = sessionStorage.getItem("e2e-startup-state");
      if (saved) Object.assign(window.__E2E.state, JSON.parse(saved));
    });
    await page.reload();
    await expect
      .poll(() => page.evaluate(() => window.__E2E.listenerCount("acp/session-update")))
      .toBeGreaterThan(0);

    await expect(roleGroup(page).getByRole("button", { name: "Planner" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("combobox", { name: "Task Type *" })).toHaveValue("Feature");
    await expect(page.getByRole("textbox", { name: "Title *" })).toHaveValue("Effort controls");
    await expect(page.getByRole("textbox", { name: "Request / Problem *" })).toHaveValue("Let users pick effort");
    await expect(startRow(page).getByRole("button", { name: /Choose folder…$/ })).toHaveText("demo");
  });
});
