// The GitHub tab (src/components/GitHubTab.tsx) on the mock's sample feed
// (fixtures/data.ts `sampleGithub`).
import { expect, test } from "./fixtures/tauri";
import { chord, expectActive } from "./tabs-helpers";

test("the new-tab picker opens the GitHub tab with its feed, filters and push commits", async ({ app, page }) => {
  await app.open({ newTabOpens: "ask" });
  await chord(page, "KeyT");
  await page.getByRole("dialog", { name: "New tab", exact: true }).getByRole("option", { name: /GitHub/ }).click();

  const opened = await app.waitForCall("open_github_tab");
  expect(opened.args).toEqual({ windowId: "main" });
  await expectActive(page, "GitHub");
  const tab = page.getByRole("region", { name: "GitHub" });
  await expect(tab.getByRole("heading", { name: "GitHub", exact: true })).toBeVisible();
  await expect(tab.getByText("e2e-dev · read through your gh login")).toBeVisible();
  await app.waitForCall("github_status");
  await app.waitForCall("github_feed");

  const needs = tab.getByRole("region", { name: "Needs you" });
  await expect(needs.getByText("Review requested from you")).toBeVisible();
  await expect(needs).toContainText("koneksi-web #41 Add upload retry");
  // The first claim only sets the baseline.
  const claim = await app.waitForCall("github_claim_notifications");
  expect(claim.args).toEqual({ ids: expect.any(Array) });

  const activity = tab.getByRole("region", { name: "Activity" });
  await expect(activity.locator(".gh-item")).toHaveCount(2);
  await expect(activity.locator(".gh-item").first()).toContainText("PR opened");
  await expect(activity).toContainText("1 bot event hidden");

  await activity.getByRole("button", { name: "Show commits" }).click();
  const commits = await app.waitForCall("github_push_commits");
  expect(commits.args).toEqual({ repo: "e2e-dev/dotfiles", before: "aaa1111", head: "bbb2222" });
  await expect(activity.getByRole("button", { name: /Use zsh completions/ })).toBeVisible();
  await expect(activity.getByRole("button", { name: /Add git aliases/ })).toBeVisible();

  await tab.getByRole("group", { name: "Source" }).getByRole("button", { name: /^Mine/ }).click();
  const saved = await app.waitForCall("github_save_filters");
  expect(saved.args).toEqual({
    filters: { chip: "mine", repo: "", hiddenTypes: [], involvesMe: false, showBots: false },
  });
  await expect(activity.locator(".gh-item")).toHaveCount(1);
  await expect(activity.locator(".gh-item")).toContainText("Pushed");

  // A second open focuses the same tab.
  await chord(page, "KeyT");
  await page.getByRole("dialog", { name: "New tab", exact: true }).getByRole("option", { name: /GitHub/ }).click();
  await expect.poll(async () => (await app.calls("open_github_tab")).length).toBe(2);
  await expect(page.getByRole("tab", { name: /^GitHub\b/ })).toHaveCount(1);
  await expectActive(page, "GitHub");
});
