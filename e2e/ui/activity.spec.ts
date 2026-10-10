import { expect, test } from "./fixtures/tauri";

test("Activity panel lists the turn's tool calls", async ({ app, page }) => {
  await app.open();
  const turn = await app.start("tab-1");
  await turn.toolCall({ id: "toolu_1", title: "List files", kind: "execute", input: { command: "ls -la" } });
  await turn.toolCall({ id: "toolu_1", title: "List files", kind: "execute", status: "completed" });
  await turn.toolCall({
    id: "toolu_2",
    title: "Edit src/App.tsx",
    kind: "edit",
    status: "completed",
    input: { file_path: "src/App.tsx" },
  });
  await turn.toolCall({
    id: "toolu_3",
    title: "Fetch docs",
    kind: "fetch",
    status: "failed",
    input: { url: "https://example.com/docs" },
  });
  await expect(page.getByRole("log")).toContainText("List files");
  await turn.reply("Done.");
  await expect(page.locator(".status-bar-status")).toHaveText("Ready");

  await page.getByRole("button", { name: /^Activity/ }).click();
  const panel = page.getByRole("dialog", { name: "Activity in General" });
  await expect(panel.getByTestId("activity-counts")).toHaveText(
    "shell 1 · write 0 · edit 1 · fetch 1 · mcp 0 · rejected 0",
  );
  const rows = panel.getByRole("table", { name: "Agent activity" }).locator("tbody tr");
  // Newest first.
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("https://example.com/docs");
  await expect(rows.nth(1)).toContainText("src/App.tsx");
  await expect(rows.nth(2)).toContainText("ls -la");
  await expect(rows.nth(2)).toContainText(/completed|done/i);
  await expect(rows.nth(0).getByLabel("network")).toBeVisible();

  await panel.getByRole("button", { name: "shell 1" }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("ls -la");

  await panel.getByRole("button", { name: "Close activity" }).click();
  await expect(panel).toBeHidden();
});
