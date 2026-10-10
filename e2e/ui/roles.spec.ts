import { expect, test } from "./fixtures/tauri";

test("role editor: a new role is saved with its hand-off targets and shows in the picker", async ({
  app,
  page,
}) => {
  await app.open();
  await page.getByRole("button", { name: "Settings" }).click();
  const roles = page.getByRole("region", { name: "Roles" });
  await roles.getByRole("button", { name: "New role" }).click();

  const created = await app.waitForCall("create_role");
  expect(created.args).toEqual({ name: "New role" });
  await expect(roles.getByText("New role added. Edit it, then Save.")).toBeVisible();

  await roles.getByLabel("Name", { exact: true }).fill("Release Notes");
  const targets = roles.getByRole("group", { name: "Hand-off targets" });
  await targets.getByRole("checkbox", { name: "Planner" }).check();
  await targets.getByRole("checkbox", { name: "Developer" }).check();
  await roles.getByRole("button", { name: "Save", exact: true }).click();

  const saved = await app.waitForCall("save_role");
  expect(saved.args.input).toMatchObject({
    roleId: "role_custom_new_role",
    name: "Release Notes",
    handoffTargets: ["role_planner", "role_developer"],
  });
  await expect(roles.getByText("Saved.")).toBeVisible();
  await expect(roles.getByRole("button", { name: /Release Notes/ })).toBeVisible();

  // The start screen's role picker lists the custom role.
  await page.getByRole("button", { name: "Close", exact: true }).click();
  const picker = page.getByRole("group", { name: "Role" });
  await expect(picker.getByRole("button", { name: "Release Notes" })).toBeVisible();
  await picker.getByRole("button", { name: "Release Notes" }).click();
  await expect(picker.getByRole("button", { name: "Release Notes" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  // Its "Send to …" buttons follow the saved targets, in the order ticked.
  const turn = await app.start("tab-1");
  expect((await app.waitForCall("role_session_start")).args.roleId).toBe("role_custom_new_role");
  await turn.reply("Release notes drafted.");
  const log = page.getByRole("log");
  await expect(log.getByRole("button", { name: /^Send to / })).toHaveText([
    "Send to Planner",
    "Send to Developer",
  ]);
});
