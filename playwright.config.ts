import { defineConfig, devices } from "@playwright/test";

// UI tests against the Vite dev server with a faked Tauri IPC layer (e2e/ui).
// The WebdriverIO suite that drives the built app lives in e2e/specs.
const PORT = 1430;
export default defineConfig({
  testDir: "e2e/ui",
  outputDir: "e2e/artifacts/playwright",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 15_000,
  expect: { timeout: 5_000 },
  reporter: process.env.CI ? "line" : [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1400, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "webkit", use: { ...devices["Desktop Safari"], viewport: { width: 1400, height: 900 } } },
    { name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1400, height: 900 } } },
  ],
  webServer: {
    command: "npx vite --config e2e/ui/vite.config.ts",
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
