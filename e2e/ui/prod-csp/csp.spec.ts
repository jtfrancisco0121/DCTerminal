// The built frontend (a production `vite build`) under the production CSP from tauri.conf.json,
// served by e2e/ui/prod-csp/server.mjs. Runs only in the prod-csp-* projects.
// Specs here use `responses`, not `handlers`: handlers are compiled with
// `new Function`, which `script-src 'self'` forbids.
import { createServer, type Server } from "node:http";
import type { Page } from "@playwright/test";
import { roleTab } from "../fixtures/tauri";
import { expect, productionCsp, test } from "./csp";

/** Font faces of `family` and their load status, once the page's fonts settle. */
async function fontStatus(page: Page, family: string): Promise<string[]> {
  return page.evaluate(async (name) => {
    await document.fonts.ready;
    return [...document.fonts]
      .filter((face) => face.family.replace(/["']/g, "") === name)
      .map((face) => face.status);
  }, family);
}

test("the app boots with no CSP violation, and the policy is enforced", async ({ app, page, csp }) => {
  const shell = await page.request.get("/");
  expect(shell.headers()["content-security-policy"]).toBe(productionCsp());

  await app.open();
  await expect(page.getByRole("tab", { name: /^General\b/ })).toBeVisible();
  await expect.poll(() => fontStatus(page, "Inter Variable")).toContain("loaded");
  expect(await fontStatus(page, "Inter Variable")).not.toContain("error");
  expect(await csp.take()).toEqual([]);

  // The header is live: an inline script is refused.
  await page.evaluate(() => {
    const script = document.createElement("script");
    script.textContent = "window.__inlineRan = true";
    document.head.append(script);
  });
  await expect.poll(async () => (await csp.take()).join("\n")).toMatch(/script-src/);
  expect(await page.evaluate(() => (window as any).__inlineRan ?? false)).toBe(false);
});

test("a Mermaid diagram in a rendered Markdown file is drawn", async ({ app, page }) => {
  const text = "# Flow\n\n```mermaid\nflowchart LR\n  Build --> Ship\n```\n";
  await app.open({
    responses: {
      get_layout: {
        splitMode: "single",
        secondaryTabId: null,
        primarySize: 50,
        filePanelOpen: true,
        filePanelWidth: 280,
      },
      files_list: {
        root: "/Users/e2e/Projects/demo",
        path: "",
        entries: [{ name: "flow.md", path: "flow.md", isDir: false, size: text.length }],
        truncated: false,
      },
      files_read: {
        path: "flow.md",
        absPath: "/Users/e2e/Projects/demo/flow.md",
        size: text.length,
        kind: "text",
        text,
        dataBase64: null,
        mime: null,
        mtimeMs: 1000,
      },
    },
  });
  const panel = page.getByRole("complementary", { name: "Files" });
  await panel.getByRole("button", { name: "flow.md" }).click();
  await expect(panel.getByRole("heading", { name: "Flow" })).toBeVisible();
  const diagram = panel.getByRole("img", { name: "Diagram" });
  await expect(diagram.locator("svg")).toBeVisible();
  await expect(diagram.locator("svg")).toContainText("Build");
  await expect(diagram.locator("svg")).toContainText("Ship");
  await expect(panel.locator(".mermaid-error")).toHaveCount(0);
});

test.describe("localhost preview", () => {
  let server: Server;
  let port = 0;

  test.beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<!doctype html><title>dev server</title><h1>Hello from the dev server</h1>");
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    port = typeof address === "object" && address ? address.port : 0;
  });

  test.afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
  });

  test("a preview tab frames a localhost page (frame-src)", async ({ app, page }) => {
    const url = `http://127.0.0.1:${port}/`;
    await app.open({
      tabs: [
        roleTab("tab-1", "role_general", "General"),
        roleTab("tab-2", "", `Preview · 127.0.0.1:${port}`, { kind: "preview", previewUrl: url, cwd: "" }),
      ],
      activeTabId: "tab-2",
    });
    const frame = page.getByTitle(`Preview of ${url}`);
    await expect(frame).toBeVisible();
    await expect(
      page.frameLocator(".preview-frame").getByRole("heading", { name: "Hello from the dev server" }),
    ).toBeVisible();
  });
});

test("a terminal draws PTY output in xterm with the bundled mono font", async ({ app, page }) => {
  await app.open();
  await page.getByRole("radiogroup", { name: "Terminals" }).getByRole("radio", { name: "Terminal", exact: true }).click();
  await page.getByRole("group", { name: "Start a session" }).getByRole("button", { name: "Start terminal" }).click();
  await app.waitForCall("shell_terminal_start");
  await app.ptyOutput("tab-1", "hello \x1b[32mgreen\x1b[0m world\r\n$ ");
  const screen = page.locator(".terminal-screen .xterm-rows");
  await expect(screen).toContainText("hello green world");
  await expect.poll(() => fontStatus(page, "JetBrains Mono Variable")).toContain("loaded");
  expect(await fontStatus(page, "JetBrains Mono Variable")).not.toContain("error");
});
