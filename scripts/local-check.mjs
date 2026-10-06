// Local stand-in for CI. Automatic GitHub Actions are disabled.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import process from "node:process";

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

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
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

function executable(command) {
  // npm is installed as npm.cmd on Windows. Spawning that file avoids cmd.exe.
  if (process.platform === "win32" && command === "npm") {
    return "npm.cmd";
  }
  return command;
}

function runStep(step) {
  console.log(`\n==> ${step.name}`);
  const result = spawnSync(executable(step.cmd), step.args, {
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`\n${step.name} failed to start: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`\n${step.name} failed (exit ${result.status ?? "signal"})`);
    process.exit(result.status || 1);
  }
}

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
