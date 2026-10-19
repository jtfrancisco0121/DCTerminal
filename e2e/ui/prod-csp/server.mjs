// Serves the prod-csp build of the frontend with the production Content-Security-Policy
// from src-tauri/tauri.conf.json (`app.security.csp`) as a response header, for
// the Playwright prod-csp projects. Node built-ins only.
//
// E2E_PROD_CSP_PORT  port (default 1440)
// E2E_PROD_CSP_DIST  the build folder, repo-relative (default
//                    e2e/.tmp/prod-csp-dist-<port>; playwright.config.ts builds
//                    there, not dist/, so it never races `npm run check`)
// DCT_CSP_CONF       a tauri.conf.json to read the policy from instead (to see
//                    the specs fail on a broken policy; never commit a break);
//                    a relative path is taken from the repo root, as csp.ts does
import { readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const PORT = Number(process.env.E2E_PROD_CSP_PORT ?? 1440);
const DIST = path.resolve(ROOT, process.env.E2E_PROD_CSP_DIST || `e2e/.tmp/prod-csp-dist-${PORT}`);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
};

/** The policy the app ships, read from a tauri.conf.json. */
function productionCsp(confPath = path.resolve(ROOT, process.env.DCT_CSP_CONF || "src-tauri/tauri.conf.json")) {
  const csp = JSON.parse(readFileSync(confPath, "utf8"))?.app?.security?.csp;
  if (typeof csp !== "string" || !csp.trim()) throw new Error(`no app.security.csp in ${confPath}`);
  return csp;
}

/** A file under DIST for a request path; unknown paths get index.html. */
function fileFor(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  const file = path.normalize(path.join(DIST, decoded));
  if (file.startsWith(DIST + path.sep)) {
    try {
      if (statSync(file).isFile()) return file;
    } catch {
      // Not built: fall through to the app shell.
    }
  }
  return path.join(DIST, "index.html");
}

function isDirectRun() {
  return !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  const csp = productionCsp();
  createServer((req, res) => {
    let body;
    let file;
    try {
      file = fileFor(req.url ?? "/");
      body = readFileSync(file);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(`prod-csp server: ${err instanceof Error ? err.message : err} (run \`npx vite build --outDir ${path.relative(ROOT, DIST)}\`)`);
      return;
    }
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream",
      "Content-Security-Policy": csp,
      "Cache-Control": "no-store",
    });
    res.end(body);
  }).listen(PORT, "127.0.0.1", () => {
    console.log(`prod-csp: serving ${DIST} on http://127.0.0.1:${PORT}`);
  });
}
