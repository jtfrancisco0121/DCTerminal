import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const application =
  process.env.DCT_E2E_APP ||
  path.join(root, "src-tauri", "target", "debug", process.platform === "win32" ? "dcterminal.exe" : "dcterminal");

export const config = {
  runner: "local",
  specs: [path.join(root, "e2e", "specs", "**", "*.spec.mjs")],
  maxInstances: 1,
  capabilities: [
    {
      maxInstances: 1,
      // browserName is left unset. tauri-driver turns tauri:options into
      // webkitgtk:browserOptions. A browserName of "wry" is rejected by WebKitWebDriver.
      "tauri:options": {
        application,
      },
    },
  ],
  logLevel: "warn",
  waitforTimeout: 20000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 1,
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: {
    timeout: 120000,
    // Stop if the app is not using the isolated data dir. Later specs write state.
    bail: true,
  },
  hostname: "127.0.0.1",
  port: 4444,
  afterTest: async function afterTest(test, _context, result) {
    if (!result?.error) return;
    const dir = path.join(root, "e2e", "artifacts");
    fs.mkdirSync(dir, { recursive: true });
    const name = String(test.title || "failure")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    try {
      await browser.saveScreenshot(path.join(dir, `${name || "failure"}.png`));
    } catch {
      // The webview may already be gone. The spec failure is still the result.
    }
  },
};
