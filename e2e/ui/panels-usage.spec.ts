// Claude usage in the status bar, context fill in the chat header, and limit alerts
// (src/usage/limits.ts). The app polls get_claude_usage every 20 s; the tests drive
// that poll with Playwright's clock.
import type { Page } from "@playwright/test";
import type { UsageSnapshot } from "../../src/bridge";
import type { RateWindow } from "../../src/usage/limits";
import { expect, roleTab, test, type TauriApp } from "./fixtures/tauri";

const NOW = new Date("2026-10-10T10:00:00Z");
const POLL_MS = 20_000;
const at = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);
const FIVE_H_RESET = at("2026-10-10T12:30:00Z");
const SEVEN_D_RESET = at("2026-10-14T08:00:00Z");

function win(type: "five_hour" | "seven_day", extra: Partial<RateWindow> = {}): RateWindow {
  return {
    rateLimitType: type,
    label: type === "five_hour" ? "5h" : "7d",
    utilization: 10,
    resetsAt: type === "five_hour" ? FIVE_H_RESET : SEVEN_D_RESET,
    status: "allowed",
    seenAtMs: NOW.getTime() - 60_000,
    ...extra,
  };
}

function snapshot(windows: RateWindow[], contextByTab: UsageSnapshot["contextByTab"] = {}): UsageSnapshot {
  return { configDir: "/Users/e2e/.claude", windows, contextByTab };
}

/** The reset time as the app formats it, in the browser's locale. */
function resetText(page: Page, seconds: number): Promise<string> {
  return page.evaluate(
    (s) => new Date(s * 1000).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }),
    seconds,
  );
}

/** Runs the next 20 s usage poll and waits until the app has asked. */
async function poll(app: TauriApp, page: Page) {
  const before = (await app.calls("get_claude_usage")).length;
  await page.clock.fastForward(POLL_MS);
  await expect.poll(async () => (await app.calls("get_claude_usage")).length).toBeGreaterThan(before);
}

const usage = (page: Page) => page.getByTestId("status-usage");
const toast = (page: Page, title: string) => page.locator(".agent-toast", { hasText: title });

test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: NOW });
});

test("usage reads 'not reported yet' until the first reading, then shows 5h and 7d windows", async ({
  app,
  page,
}) => {
  await app.open();
  await app.waitForCall("get_claude_usage");
  await expect(usage(page)).toHaveText("Claude usage not reported yet");
  await expect(usage(page)).toHaveClass(/status-usage-muted/);
  await expect(usage(page)).toHaveAttribute("title", "Updated by Claude chat tabs; terminal tabs don't report usage.");

  const turn = await app.start("tab-1");
  await turn.reply("Hi.");
  await expect(page.locator(".session-terminal-subtitle")).not.toContainText("Context");

  await app.respond(
    "get_claude_usage",
    snapshot([win("five_hour", { utilization: 42.4 }), win("seven_day", { utilization: 10 })], {
      "tab-1": { used: 50_000, size: 200_000 },
      "tab-other": { used: 1, size: 2 },
    }),
  );
  await poll(app, page);
  const fiveReset = await resetText(page, FIVE_H_RESET);
  const sevenReset = await resetText(page, SEVEN_D_RESET);
  await expect(usage(page)).toHaveText(`Claude 5h 42% · resets ${fiveReset}`);
  await expect(usage(page)).toHaveClass(/status-usage-ok/);
  const title = await usage(page).getAttribute("title");
  expect(title).toContain(`Claude 5h 42% · resets ${fiveReset}`);
  expect(title).toContain(`Claude 7d 10% · resets ${sevenReset}`);
  expect(title).toMatch(/Last reported .+/);
  // Context fill of this tab only, as a percent.
  await expect(page.locator(".session-terminal-subtitle .chain-label")).toHaveText("Context 25%");
  await expect(page.getByText(/limit/)).toHaveCount(0);

  // A reading without a utilization shows the window without a percent.
  await app.respond(
    "get_claude_usage",
    snapshot([win("seven_day", { utilization: null })], { "tab-1": { used: 300_000, size: 200_000 } }),
  );
  await poll(app, page);
  await expect(usage(page)).toHaveText(`Claude 7d · resets ${sevenReset}`);
  // Never above 100%.
  await expect(page.locator(".session-terminal-subtitle .chain-label")).toHaveText("Context 100%");
});

test("a reading from before the window reset is shown as stale and does not alert", async ({ app, page }) => {
  await app.open({
    responses: {
      get_claude_usage: snapshot([
        win("five_hour", { utilization: 97, resetsAt: at("2026-10-10T09:00:00Z"), status: "allowed_warning" }),
        win("seven_day", { utilization: 30 }),
      ]),
    },
  });
  await expect(usage(page)).toHaveText("Claude 5h reset · no new reading");
  await expect(usage(page)).toHaveClass(/status-usage-muted/);
  await expect(usage(page)).toHaveAttribute("title", /Claude 5h has reset since the last reading/);
  await poll(app, page);
  await expect(page.locator(".agent-toast")).toHaveCount(0);
});

test("usage is hidden on a Cursor tab", async ({ app, page }) => {
  await app.open({
    tabs: [roleTab("tab-1", "role_general", "General", { provider: "cursor" })],
    responses: { get_claude_usage: snapshot([win("five_hour", { utilization: 50 })]) },
  });
  await app.waitForCall("get_claude_usage");
  await expect(page.locator(".status-bar-status")).toBeVisible();
  await expect(usage(page)).toHaveCount(0);
});

test("limit alerts fire once at 80% and again when the limit is reached", async ({ app, page }) => {
  await app.open({
    responses: { get_claude_usage: snapshot([win("five_hour", { utilization: 79 })]) },
  });
  await expect(usage(page)).toHaveText(/^Claude 5h 79%/);
  await expect(usage(page)).toHaveClass(/status-usage-ok/);
  await expect(page.locator(".agent-toast")).toHaveCount(0);

  await app.respond("get_claude_usage", snapshot([win("five_hour", { utilization: 80 })]));
  await poll(app, page);
  const reset = await resetText(page, FIVE_H_RESET);
  const near = toast(page, "Claude 5h limit at 80%");
  await expect(near).toBeVisible();
  await expect(near).toHaveAttribute("role", "alert");
  await expect(near).toContainText(`Resets at ${reset}. A long run may stop when the limit is reached.`);
  await expect(usage(page)).toHaveClass(/status-usage-warn/);
  await near.getByRole("button", { name: "Dismiss notification" }).click();
  await expect(near).toHaveCount(0);

  // Same window, still high: no second alert.
  await app.respond("get_claude_usage", snapshot([win("five_hour", { utilization: 91 })]));
  await poll(app, page);
  await expect(usage(page)).toHaveText(/^Claude 5h 91%/);
  await expect(page.locator(".agent-toast")).toHaveCount(0);

  // Reached: a separate alert.
  await app.respond("get_claude_usage", snapshot([win("five_hour", { utilization: 100, status: "rejected" })]));
  await poll(app, page);
  const reached = toast(page, "Claude 5h limit reached");
  await expect(reached).toBeVisible();
  await expect(reached).toContainText(`New requests wait until it resets at ${reset}.`);
  await expect(usage(page)).toHaveClass(/status-usage-hot/);
  await reached.getByRole("button", { name: "Dismiss notification" }).click();
  await poll(app, page);
  await expect(page.locator(".agent-toast")).toHaveCount(0);

  // After the window resets, a new window near its limit alerts again.
  const nextReset = at("2026-10-10T17:30:00Z");
  await app.respond(
    "get_claude_usage",
    snapshot([win("five_hour", { utilization: 85, resetsAt: nextReset, status: "allowed_warning" })]),
  );
  await poll(app, page);
  await expect(toast(page, "Claude 5h limit at 85%")).toBeVisible();
});
