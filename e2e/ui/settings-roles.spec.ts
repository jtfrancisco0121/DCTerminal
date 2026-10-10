import type { Page } from "@playwright/test";
import type { Role } from "../../src/bridge";
import { expect, roleTab, test, type PageHandler } from "./fixtures/tauri";

/**
 * Settings > Roles beyond roles.spec.ts (New role → hand-off targets → picker):
 * duplicate, delete, import/export, field and template editing, save errors.
 */

async function openRoles(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const section = page.getByRole("region", { name: "Roles", exact: true });
  await expect(section).toBeVisible();
  return section;
}

/** The list entry whose name is exactly `name`. */
function roleEntry(page: Page, name: string) {
  return page
    .getByRole("region", { name: "Roles", exact: true })
    .locator(".settings-role-list")
    .getByRole("button")
    .filter({ has: page.locator("span", { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }) });
}

const detail = (page: Page) => page.locator(".settings-role-detail");

/** Like the Rust preview: every {{key}} that is not a built-in token becomes a required field. */
const previewTemplate: PageHandler = (args) => {
  const text = String(args.templateText).trim();
  if (!text) return { fields: [], error: "Template text cannot be empty." };
  if (/\{\{[^}]*$/.test(text)) return { fields: [], error: "Unclosed {{ in the template." };
  const builtIn = ["cwd", "folderName", "date", "roleName"];
  const keys = [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).filter((k) => !builtIn.includes(k));
  return {
    error: null,
    fields: [...new Set(keys)].map((key) => ({
      key,
      label: key[0].toUpperCase() + key.slice(1),
      type: "text",
      required: true,
    })),
  };
};

function customRole(id: string, name: string): Role {
  return {
    id,
    name,
    templateText: `You are ${name}.`,
    templateVersion: 1,
    templateHash: "h",
    schemaTemplateHash: "h",
    defaultMode: "agent",
    injection: "send_on_start",
    color: "#8b949e",
    isBuiltIn: false,
    fields: [],
    updatedAt: "2026-10-01T00:00:00Z",
  } as Role;
}

test("a built-in role shows Reset but no Delete; Duplicate makes an editable custom copy", async ({ app, page }) => {
  await app.open();
  const roles = await openRoles(page);
  await expect(roleEntry(page, "Planner")).toHaveClass(/settings-role-active/);
  await expect(detail(page).locator("p").first()).toHaveText("Planner · built-in · plan · 6 fields");
  await expect(roles.getByRole("button", { name: "Reset built-in" })).toBeVisible();
  await expect(roles.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);

  await roles.getByRole("button", { name: "Duplicate" }).click();
  const call = await app.waitForCall("duplicate_role");
  // The copy keeps the hand-off targets the editor shows for the source.
  expect(call.args).toEqual({
    roleId: "role_planner",
    handoffTargets: ["role_plan_reviewer", "role_implementer", "role_developer"],
  });
  await expect(roles.getByText("Duplicated as Planner copy.")).toBeVisible();
  await expect(roleEntry(page, "Planner copy")).toHaveClass(/settings-role-active/);
  await expect(roleEntry(page, "Planner copy")).toContainText("custom · plan · 6 fields");
  await expect(detail(page).locator("p").first()).toHaveText("Planner copy · custom · plan · 6 fields");
  await expect(roles.getByLabel("Name", { exact: true })).toHaveValue("Planner copy");
  await expect(roles.getByRole("button", { name: "Delete", exact: true })).toBeVisible();
  await expect(roles.getByRole("button", { name: "Reset built-in" })).toHaveCount(0);
  // The start screen picker lists it too.
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("group", { name: "Role" }).getByRole("button", { name: "Planner copy" })).toBeVisible();
});

test("Delete asks first: Keep it cancels, Delete role removes the role", async ({ app, page }) => {
  await app.open({ roles: (list) => [...list, customRole("role_custom_triage", "Triage")] });
  const roles = await openRoles(page);
  await roleEntry(page, "Triage").click();
  await expect(roles.getByLabel("Name", { exact: true })).toHaveValue("Triage");

  await roles.getByRole("button", { name: "Delete", exact: true }).click();
  const confirm = roles.getByRole("alertdialog", { name: "Delete role" });
  await expect(confirm).toContainText("Delete Triage? This cannot be undone. Export it first to keep a copy.");
  await expect(roles.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
  await confirm.getByRole("button", { name: "Keep it" }).click();
  await expect(confirm).toBeHidden();
  expect(await app.calls("delete_role")).toHaveLength(0);

  await roles.getByRole("button", { name: "Delete", exact: true }).click();
  await confirm.getByRole("button", { name: "Delete role" }).click();
  expect((await app.waitForCall("delete_role")).args).toEqual({ roleId: "role_custom_triage" });
  await expect(roles.getByText("Deleted Triage.")).toBeVisible();
  await expect(roleEntry(page, "Triage")).toHaveCount(0);
  // Selection moves to the first remaining role.
  await expect(roles.getByLabel("Name", { exact: true })).toHaveValue("Planner");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("group", { name: "Role" }).getByRole("button", { name: "Triage" })).toHaveCount(0);
});

test("deleting a role an open tab uses is refused and the role stays", async ({ app, page }) => {
  await app.open({
    roles: (list) => [...list, customRole("role_custom_triage", "Triage")],
    tabs: [roleTab("tab-1", "role_general", "General"), roleTab("tab-2", "role_custom_triage", "Triage")],
    handlers: {
      delete_role: (args, state) => {
        const inUse = state.tabs.filter((t: { roleId: string }) => t.roleId === args.roleId).length;
        const role = state.roles.find((r: { id: string }) => r.id === args.roleId);
        if (inUse > 0) {
          throw new Error(`${inUse} open ${inUse === 1 ? "tab uses" : "tabs use"} ${role.name}. Close them before deleting the role.`);
        }
        state.roles = state.roles.filter((r: { id: string }) => r.id !== args.roleId);
        return null;
      },
    },
  });
  const roles = await openRoles(page);
  await roleEntry(page, "Triage").click();
  await expect(roles.getByLabel("Name", { exact: true })).toHaveValue("Triage");
  await roles.getByRole("button", { name: "Delete", exact: true }).click();
  await roles.getByRole("alertdialog", { name: "Delete role" }).getByRole("button", { name: "Delete role" }).click();
  await expect(roles.getByText("1 open tab uses Triage. Close them before deleting the role.")).toBeVisible();
  await expect(roleEntry(page, "Triage")).toBeVisible();
  await expect(roles.getByLabel("Name", { exact: true })).toHaveValue("Triage");
});

test("name, color and default mode edits are saved and shown in the list", async ({ app, page }) => {
  await app.open();
  const roles = await openRoles(page);
  await roleEntry(page, "Developer").click();
  await expect(roles.getByLabel("Name", { exact: true })).toHaveValue("Developer");
  await expect(roles.getByRole("button", { name: "Color #3fb950" })).toHaveAttribute("aria-pressed", "true");

  await roles.getByLabel("Name", { exact: true }).fill("Dev Lead");
  await roles.getByRole("button", { name: "Color #f85149" }).click();
  await expect(roles.getByRole("button", { name: "Color #f85149" })).toHaveAttribute("aria-pressed", "true");
  await expect(roles.getByRole("button", { name: "Color #3fb950" })).toHaveAttribute("aria-pressed", "false");
  const mode = roles.getByLabel("Default mode");
  await expect(mode.locator("option")).toHaveText(["Agent", "Plan", "Ask"]);
  await mode.selectOption("plan");
  await roles.getByRole("button", { name: "Save", exact: true }).click();

  const saved = await app.waitForCall("save_role");
  expect(saved.args.input).toEqual({
    roleId: "role_developer",
    templateText: expect.stringContaining("SENIOR SOFTWARE ENGINEER"),
    name: "Dev Lead",
    color: "#f85149",
    defaultMode: "plan",
  });
  // Unchanged hand-off targets stay on the built-in table.
  expect(saved.args.input).not.toHaveProperty("handoffTargets");
  await expect(roles.getByText("Saved.")).toBeVisible();
  await expect(roleEntry(page, "Dev Lead")).toContainText("plan · 0 fields");
  await expect(detail(page).locator("p").first()).toHaveText("Dev Lead · built-in · plan · 0 fields");
});

test("unticking a hand-off target saves the new list", async ({ app, page }) => {
  await app.open();
  const roles = await openRoles(page);
  const targets = roles.getByRole("group", { name: "Hand-off targets" });
  await expect(targets.getByRole("checkbox", { name: "Plan Reviewer" })).toBeChecked();
  await expect(targets.getByRole("checkbox", { name: "Planner" })).toHaveCount(0);
  await targets.getByRole("checkbox", { name: "Plan Reviewer" }).uncheck();
  await roles.getByRole("button", { name: "Save", exact: true }).click();
  const saved = await app.waitForCall("save_role");
  expect(saved.args.input).toMatchObject({
    roleId: "role_planner",
    handoffTargets: ["role_implementer", "role_developer"],
  });
});

test("template edits preview their form fields; an invalid template blocks Save", async ({ app, page }) => {
  await app.open({ handlers: { preview_role_template: previewTemplate } });
  const roles = await openRoles(page);
  await roleEntry(page, "General").click();
  const template = roles.getByLabel("Role template");
  await expect(template).toHaveValue(/General-Purpose Project Lead/);
  const preview = roles.getByRole("status", { name: "Template fields" });
  await expect(preview).toContainText("Form fields: none.");

  await template.fill("Fix {{ticket}} in {{cwd}} for {{customer}}.");
  await expect(preview).toContainText("Form fields: Ticket (required) · Customer (required).");
  const call = await app.waitForCall("preview_role_template", (a) => String(a.templateText).includes("ticket"));
  expect(call.args).toEqual({ roleId: "role_general", templateText: "Fix {{ticket}} in {{cwd}} for {{customer}}." });

  await template.fill("Fix {{ticket");
  await expect(preview.locator(".error")).toHaveText("Unclosed {{ in the template.");
  await expect(roles.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  await template.fill("");
  await expect(preview.locator(".error")).toHaveText("Template text cannot be empty.");
  await expect(roles.getByRole("button", { name: "Save", exact: true })).toBeDisabled();

  await template.fill("Triage {{ticket}}.");
  await expect(preview).toContainText("Form fields: Ticket (required).");
  await expect(roles.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  await roles.getByRole("button", { name: "Save", exact: true }).click();
  const saved = await app.waitForCall("save_role");
  expect(saved.args.input).toMatchObject({ roleId: "role_general", templateText: "Triage {{ticket}}." });
  await expect(roles.getByText("Saved.")).toBeVisible();
});

test("a save the backend refuses shows its error and keeps the draft", async ({ app, page }) => {
  await app.open({
    handlers: {
      save_role: (args) => {
        if (!String(args.input.name ?? "").trim()) throw new Error("Role name cannot be empty.");
        throw new Error("unexpected save");
      },
    },
  });
  const roles = await openRoles(page);
  await roles.getByLabel("Name", { exact: true }).fill("   ");
  await roles.getByRole("button", { name: "Save", exact: true }).click();
  await expect(roles.getByText("Role name cannot be empty.")).toBeVisible();
  await expect(roles.getByLabel("Name", { exact: true })).toHaveValue("   ");
  await expect(roleEntry(page, "Planner")).toBeVisible();
  await expect(roles.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
});

test("Reset built-in restores the shipped role", async ({ app, page }) => {
  await app.open({
    handlers: {
      reset_builtin_role: (args, state) => {
        const role = state.roles.find((r: { id: string }) => r.id === args.roleId);
        role.name = "Planner";
        return role;
      },
    },
  });
  const roles = await openRoles(page);
  await roles.getByLabel("Name", { exact: true }).fill("My Planner");
  await roles.getByRole("button", { name: "Save", exact: true }).click();
  await expect(roleEntry(page, "My Planner")).toBeVisible();

  await roles.getByRole("button", { name: "Reset built-in" }).click();
  expect((await app.waitForCall("reset_builtin_role")).args).toEqual({ roleId: "role_planner" });
  await expect(roles.getByText("Reset to built-in template.")).toBeVisible();
  await expect(roles.getByLabel("Name", { exact: true })).toHaveValue("Planner");
  await expect(roleEntry(page, "Planner")).toBeVisible();
  await expect(roleEntry(page, "My Planner")).toHaveCount(0);
});

test("Export… writes the role to the path picked in the save dialog", async ({ app, page }) => {
  await app.open({
    responses: { "plugin:dialog|save": "/Users/e2e/Desktop/Plan-Reviewer.role.json", export_role: null },
  });
  const roles = await openRoles(page);
  await roleEntry(page, "Plan Reviewer").click();
  await expect(roles.getByLabel("Name", { exact: true })).toHaveValue("Plan Reviewer");
  await roles.getByRole("button", { name: "Export…" }).click();
  const dialog = await app.waitForCall("plugin:dialog|save");
  expect(dialog.args.options).toMatchObject({ defaultPath: "Plan-Reviewer.role.json", title: "Export role" });
  expect((await app.waitForCall("export_role")).args).toEqual({
    roleId: "role_plan_reviewer",
    path: "/Users/e2e/Desktop/Plan-Reviewer.role.json",
  });
  await expect(roles.getByText("Exported to /Users/e2e/Desktop/Plan-Reviewer.role.json.")).toBeVisible();
});

test("Export… cancelled or failing writes nothing and says why", async ({ app, page }) => {
  await app.open();
  const roles = await openRoles(page);
  // The mock answers the save dialog with null: cancelled.
  await roles.getByRole("button", { name: "Export…" }).click();
  await expect(roles.getByText("Export cancelled.")).toBeVisible();
  expect(await app.calls("export_role")).toHaveLength(0);

  await app.respond("plugin:dialog|save", "relative.json");
  await app.handle("export_role", () => {
    throw new Error("Choose a full path for the export.");
  });
  await roles.getByRole("button", { name: "Export…" }).click();
  await expect(roles.getByText("Choose a full path for the export.")).toBeVisible();
});

test("Import… adds the picked role file as a new custom role and selects it", async ({ app, page }) => {
  await app.open({
    responses: { "plugin:dialog|open": "/Users/e2e/Downloads/Triage.role.json" },
    handlers: {
      import_role: (_args, state) => {
        const role = {
          id: "role_custom_triage",
          name: "Triage",
          templateText: "Triage {{ticket}}.",
          templateVersion: 1,
          templateHash: "h",
          schemaTemplateHash: "h",
          defaultMode: "ask",
          injection: "send_on_start",
          color: "#d29922",
          isBuiltIn: false,
          fields: [{ key: "ticket", label: "Ticket", type: "text", required: true }],
          updatedAt: "2026-10-01T00:00:00Z",
        };
        state.roles.push(role);
        return role;
      },
    },
  });
  const roles = await openRoles(page);
  await roles.getByRole("button", { name: "Import…" }).click();
  const dialog = await app.waitForCall("plugin:dialog|open");
  expect(dialog.args.options).toMatchObject({ multiple: false, directory: false, title: "Import role" });
  expect((await app.waitForCall("import_role")).args).toEqual({ path: "/Users/e2e/Downloads/Triage.role.json" });
  await expect(roles.getByText("Imported Triage.")).toBeVisible();
  await expect(roleEntry(page, "Triage")).toHaveClass(/settings-role-active/);
  await expect(roleEntry(page, "Triage")).toContainText("custom · ask · 1 fields");
  await expect(roles.getByLabel("Role template")).toHaveValue("Triage {{ticket}}.");
});

test("Import… cancelled or rejected adds nothing", async ({ app, page }) => {
  await app.open();
  const roles = await openRoles(page);
  await roles.getByRole("button", { name: "Import…" }).click();
  await expect(roles.getByText("Import cancelled.")).toBeVisible();
  expect(await app.calls("import_role")).toHaveLength(0);

  await app.respond("plugin:dialog|open", "/Users/e2e/Downloads/notes.json");
  await app.handle("import_role", () => {
    throw new Error("This file is not a DCTerminal role (kind is missing).");
  });
  await roles.getByRole("button", { name: "Import…" }).click();
  await expect(roles.getByText("This file is not a DCTerminal role (kind is missing).")).toBeVisible();
  await expect(roles.locator(".settings-role-list li")).toHaveCount(8);
});
