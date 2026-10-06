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

// cmd metacharacters. `%` still expands inside quotes, so it is doubled there.
const CMD_SPECIAL = /[\s"&|<>^%!()]/;

/**
 * Quote one argv element for cmd.exe only when it needs it.
 * `%` is doubled so cmd does not expand variables. Embedded quotes are
 * doubled (cmd's quote escape). Do not backslash-escape: cmd does not
 * treat `\"` as a quote, and Node must not add a second escape pass.
 */
export function quoteCmdArg(value) {
  const text = String(value);
  if (text.length > 0 && !CMD_SPECIAL.test(text)) {
    return text;
  }
  const escaped = text.replaceAll("%", "%%").replaceAll('"', '""');
  return `"${escaped}"`;
}

/**
 * Bare command token. A quoted name with no path (`"npm"`) makes cmd set
 * `%~dp0` to the current directory, so npm.cmd looks for npm-cli.js under
 * the project instead of `C:\Program Files\nodejs`. Leave bare names
 * unquoted. A path may be quoted; `%~dp0` is correct when the name contains
 * a separator.
 */
export function quoteCmdCommand(command) {
  const text = String(command);
  const token = quoteCmdArg(text);
  const hasPath = /[\\/]/.test(text);
  if (!hasPath && token.startsWith('"')) {
    throw new Error(
      `refusing to quote bare command ${JSON.stringify(text)}; ` +
        "cmd %~dp0 breaks for a quoted name with no path",
    );
  }
  return token;
}

/**
 * Argument to `cmd.exe /d /s /c`. `/s` strips one leading quote and the
 * final quote on the line, so the payload keeps an extra outer pair.
 */
export function windowsCmdPayload(command, args) {
  const joined = [quoteCmdCommand(command), ...args.map(quoteCmdArg)].join(" ");
  return `"${joined}"`;
}

/**
 * Spawn args for Windows. `windowsVerbatimArguments` must stay true: Node
 * otherwise re-quotes the `/c` string with backslashes, which cmd ignores.
 */
export function windowsInvocation(command, args, comspec = process.env.ComSpec) {
  const shell = comspec && /\\cmd(?:\.exe)?$/i.test(comspec) ? comspec : "cmd.exe";
  return {
    file: shell,
    args: ["/d", "/s", "/c", windowsCmdPayload(command, args)],
    windowsVerbatimArguments: true,
  };
}

/**
 * Run a command. On Windows, npm and npx are `.cmd` shims, and some Cargo
 * installs are `.cmd` too. Node refuses to spawn those without a shell
 * (CVE-2024-27980, EINVAL). Always go through `cmd.exe /d /s /c` there.
 * Clippy's `-- -D warnings` stays separate arguments.
 */
export function spawnCommand(command, args, options = {}) {
  const stdio = options.stdio ?? "inherit";
  if (process.platform === "win32") {
    const invocation = windowsInvocation(command, args);
    return spawnSync(invocation.file, invocation.args, {
      stdio,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
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
