import { defineConfig, devices } from "@playwright/test";

// UI tests against the Vite dev server with a faked Tauri IPC layer (e2e/ui).
// The prod-csp-* projects run e2e/ui/prod-csp against the built frontend
// served with the production CSP (docs/TESTING.md). The WebdriverIO suite
// that drives the built app lives in e2e/specs.
// E2E_PORT lets several checkouts run the suite at once.
const PORT = Number(process.env.E2E_PORT ?? 1430);
const PROD_CSP_PORT = Number(process.env.E2E_PROD_CSP_PORT ?? PORT + 10);
// The production build is only made when a prod-csp project can run: no
// --project given, or one naming prod-csp.
const projectArgs = process.argv.filter((arg) => arg.startsWith("--project"));
const wantsProdCsp = projectArgs.length === 0 || process.argv.some((arg) => arg.includes("prod-csp"));
const safari = { ...devices["Desktop Safari"], viewport: { width: 1400, height: 900 } };
const chrome = { ...devices["Desktop Chrome"], viewport: { width: 1400, height: 900 } };
const prodCsp = { testMatch: "prod-csp/**/*.spec.ts" };
const prodCspURL = `http://127.0.0.1:${PROD_CSP_PORT}`;
// E2E_SLOWMO=<ms> with --headed slows every action down so a person can follow along.
const SLOWMO = Number(process.env.E2E_SLOWMO ?? 0);
export default defineConfig({
  testDir: "e2e/ui",
  outputDir: "e2e/artifacts/playwright",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: SLOWMO ? 120_000 : 15_000,
  expect: { timeout: SLOWMO ? 30_000 : 5_000 },
  reporter: process.env.CI ? "line" : [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1400, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: { slowMo: SLOWMO },
  },
  projects: [
    { name: "webkit", testIgnore: "prod-csp/**", use: safari },
    { name: "chromium", testIgnore: "prod-csp/**", use: chrome },
    { name: "prod-csp-webkit", ...prodCsp, use: { ...safari, baseURL: prodCspURL } },
    { name: "prod-csp-chromium", ...prodCsp, use: { ...chrome, baseURL: prodCspURL } },
  ],
  webServer: [
    {
      command: "npx vite --config e2e/ui/vite.config.ts",
      url: `http://127.0.0.1:${PORT}`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    ...(wantsProdCsp
      ? [
          {
            // `vite build` (about a second) writes dist/; the server adds the CSP header.
            command: "npx vite build --logLevel error && node e2e/ui/prod-csp/server.mjs",
            url: prodCspURL,
            env: { E2E_PROD_CSP_PORT: String(PROD_CSP_PORT) },
            reuseExistingServer: false,
            timeout: 120_000,
          },
        ]
      : []),
  ],
});
