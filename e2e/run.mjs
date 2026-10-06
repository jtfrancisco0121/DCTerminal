/**
 * Builds the app when needed, points it at the fake agent, and runs WebdriverIO.
 * App data and a fake ~/.cursor live under e2e/.tmp so the user's files are left alone.
 *
 * Windows known-folder APIs ignore APPDATA and panic if USERPROFILE is not a
 * real profile. The app is pointed at the temp dir with DCT_DATA_DIR and
 * DCT_CURSOR_HOME instead. Cargo is never run with that environment, or it
 * would download the registry into the temp home.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { usesCmdShim, windowsInvocation } from "../scripts/local-check.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = path.join(root, "e2e", ".tmp");
const home = path.join(tmp, "home");
const data = path.join(tmp, "data");
const webview = path.join(tmp, "webview2");
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

function commandLaunch(command, args) {
  if (process.platform === "win32" && usesCmdShim(command)) {
    const invocation = windowsInvocation(command, args);
    return {
      file: invocation.file,
      args: invocation.args,
      windowsVerbatimArguments: true,
    };
  }
  return { file: command, args, windowsVerbatimArguments: false };
}

function start(command, args, env, cwd) {
  const launch = commandLaunch(command, args);
  const options = { cwd, env, stdio: "inherit" };
  if (launch.windowsVerbatimArguments) {
    options.windowsVerbatimArguments = true;
  }
  return spawn(launch.file, launch.args, options);
}

function run(command, args, env = process.env, cwd = root) {
  return new Promise((resolve, reject) => {
    const child = start(command, args, env, cwd);
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}`));
    });
  });
}

function stopProcess(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    child.kill("SIGTERM");
  } catch {
    // The process already exited.
  }
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

function isolatedEnv() {
  const env = { ...process.env };
  if (process.env.DCT_E2E_LIVE !== "1") env.DCT_AGENT_PATH = agent;
  env.DCT_DATA_DIR = data;
  env.DCT_CURSOR_HOME = home;
  env.WEBVIEW2_USER_DATA_FOLDER = webview;
  // Do not override USERPROFILE. Tauri's Windows path resolver treats a fake
  // profile as "unknown path" and the setup hook then panics.
  env.XDG_DATA_HOME = data;
  env.XDG_CONFIG_HOME = path.join(tmp, "config");
  env.XDG_CACHE_HOME = path.join(tmp, "cache");
  env.APPDATA = path.join(tmp, "AppData", "Roaming");
  env.LOCALAPPDATA = path.join(tmp, "AppData", "Local");
  env.DCT_E2E_APP = binary;
  return env;
}

fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(folder, { recursive: true });
fs.mkdirSync(data, { recursive: true });
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(webview, { recursive: true });
fs.writeFileSync(path.join(tmp, "folder.txt"), folder);
fs.writeFileSync(path.join(tmp, "data-dir.txt"), data);
seedCursor(home);

if (!path.resolve(data).startsWith(path.resolve(tmp) + path.sep)) {
  console.error("Refusing to start: DCT_DATA_DIR is outside e2e/.tmp");
  process.exit(1);
}

if (!fs.existsSync(path.join(root, "e2e", "node_modules", ".bin", "wdio"))) {
  await run("npm", ["install"], process.env, path.join(root, "e2e"));
}
if (!fs.existsSync(path.join(root, "dist", "index.html"))) {
  await run("npm", ["run", "build"], process.env);
}
if (!fs.existsSync(binary)) {
  await run("cargo", ["build", "--manifest-path", "src-tauri/Cargo.toml"], process.env);
}

const env = isolatedEnv();
for (const dir of [env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME, env.APPDATA, env.LOCALAPPDATA]) {
  fs.mkdirSync(dir, { recursive: true });
}
if (!env.DCT_DATA_DIR || !env.DCT_CURSOR_HOME || !env.WEBVIEW2_USER_DATA_FOLDER) {
  console.error("Refusing to start: isolation variables are missing.");
  process.exit(1);
}

let exitCode = 1;
let preview;
let tauriDriver;
try {
  // A debug build loads devUrl. Serve the built frontend there so the webview
  // is the real app, not an empty window.
  preview = start(
    "npx",
    ["vite", "preview", "--port", "1420", "--host", "127.0.0.1", "--strictPort"],
    env,
    root,
  );
  preview.on("error", () => {
    console.error("Could not start vite preview on 127.0.0.1:1420.");
  });
  const previewReady = await waitForPreview();
  if (!previewReady) {
    console.error("The built frontend did not answer on http://127.0.0.1:1420.");
    process.exitCode = 1;
  } else {
    const driver = nativeDriver();
    const driverArgs = driver ? ["--native-driver", driver] : [];
    tauriDriver = start("tauri-driver", driverArgs, env, root);
    const driverGone = new Promise((_, reject) => {
      tauriDriver.on("error", () => {
        reject(new Error("tauri-driver failed to start"));
      });
      tauriDriver.on("exit", (code) => {
        reject(new Error(`tauri-driver exited ${code ?? "unknown"}`));
      });
    });
    driverGone.catch(() => {});
    const driverReady = new Promise((resolve) => setTimeout(resolve, 750));
    try {
      await Promise.race([driverReady, driverGone]);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      console.error("Install tauri-driver with: cargo install tauri-driver --locked");
      console.error(
        "Windows also needs msedgedriver matching the installed WebView2. Linux needs webkit2gtk-driver (WebKitWebDriver).",
      );
      process.exitCode = 1;
    }
    if (process.exitCode !== 1) {
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
      }
      exitCode = failed ? 1 : 0;
    }
  }
} finally {
  stopProcess(tauriDriver);
  stopProcess(preview);
  process.exit(exitCode);
}
