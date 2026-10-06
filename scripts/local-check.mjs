// Local stand-in for CI. Automatic GitHub Actions is disabled.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const steps = [
  {
    name: "cargo test",
    cmd: "cargo",
    args: ["test", "--manifest-path", "src-tauri/Cargo.toml"],
  },
  {
    name: "cargo clippy",
    cmd: "cargo",
    args: [
      "clippy",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "--all-targets",
      "--",
      "-D",
      "warnings",
    ],
  },
  { name: "npm test", cmd: "npm", args: ["test"] },
  { name: "npm run build", cmd: "npm", args: ["run", "build"] },
];

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function cargoPackageVersion() {
  const text = readFileSync("src-tauri/Cargo.toml", "utf8");
  const match = text.match(/\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m);
  if (!match) {
    throw new Error("could not read version from src-tauri/Cargo.toml");
  }
  return match[1];
}

function assertReleaseVersionsMatch() {
  const npmVersion = readJson("package.json").version;
  const tauriVersion = readJson("src-tauri/tauri.conf.json").version;
  const cargoVersion = cargoPackageVersion();
  const versions = { npm: npmVersion, tauri: tauriVersion, cargo: cargoVersion };
  const unique = new Set(Object.values(versions));
  if (unique.size !== 1) {
    throw new Error(
      `release versions differ (${JSON.stringify(versions)}). ` +
        "Bump package.json, src-tauri/tauri.conf.json, and src-tauri/Cargo.toml together.",
    );
  }
  console.log(`release version ${npmVersion} matches across npm, Tauri, and Cargo`);
}

/**
 * Quote one argv element for cmd.exe. The result is always wrapped in
 * double quotes. `%` is doubled so cmd does not expand variables, and
 * embedded quotes are doubled (cmd's quote escape, not backslash).
 */
export function quoteCmdArg(value) {
  const text = String(value).replaceAll("%", "%%").replaceAll('"', '""');
  return `"${text}"`;
}

/**
 * Argument to `cmd.exe /d /s /c`. `/s` strips one leading quote and the
 * final quote on the line, so the payload keeps an extra outer pair.
 * Each original argument stays quoted inside that pair.
 */
export function windowsCmdPayload(command, args) {
  const joined = [command, ...args].map(quoteCmdArg).join(" ");
  return `"${joined}"`;
}

/**
 * Run a command. On Windows, npm and npx are `.cmd` shims, and some Cargo
 * installs are `.cmd` too. Node refuses to spawn those without a shell
 * (CVE-2024-27980, EINVAL). Always go through `cmd.exe /d /s /c` there so
 * cargo, npm, and npx share one quoted path. Clippy's `-- -D warnings`
 * stays separate arguments.
 */
export function spawnCommand(command, args, options = {}) {
  const stdio = options.stdio ?? "inherit";
  if (process.platform === "win32") {
    const comspec = process.env.ComSpec;
    const shell = comspec && /\\cmd(?:\.exe)?$/i.test(comspec) ? comspec : "cmd.exe";
    return spawnSync(shell, ["/d", "/s", "/c", windowsCmdPayload(command, args)], {
      stdio,
      windowsVerbatimArguments: true,
      encoding: options.encoding,
    });
  }
  return spawnSync(command, args, {
    stdio,
    encoding: options.encoding,
  });
}

function runStep(step) {
  console.log(`\n==> ${step.name}`);
  const result = spawnCommand(step.cmd, step.args);
  if (result.error) {
    console.error(`\n${step.name} failed to start: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    const detail = result.signal ? `signal ${result.signal}` : `exit ${result.status}`;
    console.error(`\n${step.name} failed (${detail})`);
    process.exit(result.status === null || result.status === undefined ? 1 : result.status);
  }
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

export { steps };

if (isDirectRun()) {
  try {
    assertReleaseVersionsMatch();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }

  for (const step of steps) {
    runStep(step);
  }

  console.log("\nAll local checks passed.");
}
