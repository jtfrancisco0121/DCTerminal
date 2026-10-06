/**
 * Builds the app when needed, points it at the fake agent, and runs WebdriverIO.
 * App data and a fake ~/.cursor live under e2e/.tmp so the user's files are left alone.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = path.join(root, "e2e", ".tmp");
const home = path.join(tmp, "home");
const data = path.join(tmp, "data");
const folder = path.join(tmp, "project");
const binary = path.join(
  root,
  "src-tauri",
  "target",
  "debug",
  process.platform === "win32" ? "dcterminal.exe" : "dcterminal",
);
const agent =
  process.platform === "win32"
    ? path.join(root, "tools", "fake-acp-agent", "agent.cmd")
    : path.join(root, "tools", "fake-acp-agent", "agent");

function run(command, args, env = process.env, cwd = root) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}`));
    });
  });
}

async function waitForPreview() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch("http://127.0.0.1:1420/");
      if (response.ok) return true;
    } catch {
      // The preview server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function nativeDriver() {
  if (process.env.DCT_E2E_NATIVE_DRIVER) return process.env.DCT_E2E_NATIVE_DRIVER;
  if (process.platform === "win32") return "";
  const candidates = [
    "/usr/bin/WebKitWebDriver",
    "/usr/libexec/webkit2gtk-4.1/WebKitWebDriver",
    "/usr/lib/webkit2gtk-4.1/WebKitWebDriver",
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? "";
}

function seedCursor(dir) {
  const acp = path.join(dir, ".cursor", "acp-sessions", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  const chat = path.join(dir, ".cursor", "chats", "project", "11111111-2222-3333-4444-555555555555");
  fs.mkdirSync(acp, { recursive: true });
  fs.mkdirSync(chat, { recursive: true });
  const updated = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  fs.writeFileSync(
    path.join(acp, "meta.json"),
    JSON.stringify({ cwd: folder, title: "Senior Software Engineer", updatedAt: updated }),
  );
  fs.writeFileSync(
    path.join(chat, "meta.json"),
    JSON.stringify({ cwd: folder, name: "Vault notes", updatedAt: updated }),
  );
}

fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(folder, { recursive: true });
fs.mkdirSync(data, { recursive: true });
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(path.join(tmp, "folder.txt"), folder);
seedCursor(home);

const env = { ...process.env };
if (process.env.DCT_E2E_LIVE !== "1") env.DCT_AGENT_PATH = agent;
env.HOME = home;
env.USERPROFILE = home;
env.XDG_DATA_HOME = data;
env.XDG_CONFIG_HOME = path.join(tmp, "config");
env.XDG_CACHE_HOME = path.join(tmp, "cache");
env.APPDATA = path.join(tmp, "AppData", "Roaming");
env.LOCALAPPDATA = path.join(tmp, "AppData", "Local");
fs.mkdirSync(env.XDG_CONFIG_HOME, { recursive: true });
fs.mkdirSync(env.XDG_CACHE_HOME, { recursive: true });
fs.mkdirSync(env.APPDATA, { recursive: true });
fs.mkdirSync(env.LOCALAPPDATA, { recursive: true });
env.DCT_E2E_APP = binary;

if (!fs.existsSync(path.join(root, "e2e", "node_modules", ".bin", "wdio"))) {
  await run("npm", ["install"], env, path.join(root, "e2e"));
}
if (!fs.existsSync(path.join(root, "dist", "index.html"))) {
  await run("npm", ["run", "build"], env);
}
if (!fs.existsSync(binary)) {
  await run("cargo", ["build", "--manifest-path", "src-tauri/Cargo.toml"], env);
}

// A debug build loads devUrl. Serve the built frontend there so the webview
// is the real app, not an empty window.
const preview = spawn(
  "npx",
  ["vite", "preview", "--port", "1420", "--host", "127.0.0.1", "--strictPort"],
  { cwd: root, env, stdio: "inherit" },
);
preview.on("error", () => {
  console.error("Could not start vite preview on 127.0.0.1:1420.");
});
const previewReady = await waitForPreview();
if (!previewReady) {
  preview.kill("SIGTERM");
  console.error("The built frontend did not answer on http://127.0.0.1:1420.");
  process.exit(1);
}

const driver = nativeDriver();
const driverArgs = driver ? ["--native-driver", driver] : [];
const tauriDriver = spawn("tauri-driver", driverArgs, { cwd: root, env, stdio: "inherit" });
const driverGone = new Promise((_, reject) => {
  tauriDriver.on("error", () => {
    reject(new Error("tauri-driver failed to start"));
  });
  tauriDriver.on("exit", (code) => {
    reject(new Error(`tauri-driver exited ${code ?? "unknown"}`));
  });
});
const driverReady = new Promise((resolve) => setTimeout(resolve, 750));
try {
  await Promise.race([driverReady, driverGone]);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  console.error("Install tauri-driver with: cargo install tauri-driver --locked");
  console.error(
    "Windows also needs msedgedriver matching the installed WebView2. Linux needs webkit2gtk-driver (WebKitWebDriver).",
  );
  process.exit(1);
}

let failed = false;
try {
  await run(
    "node",
    [
      path.join(root, "e2e", "node_modules", "@wdio", "cli", "bin", "wdio.js"),
      "run",
      path.join(root, "e2e", "wdio.conf.mjs"),
    ],
    env,
    path.join(root, "e2e"),
  );
} catch (err) {
  failed = true;
  console.error(err instanceof Error ? err.message : String(err));
} finally {
  tauriDriver.kill("SIGTERM");
  preview.kill("SIGTERM");
}
process.exit(failed ? 1 : 0);
