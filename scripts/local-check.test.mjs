import { describe, expect, it } from "vitest";
import process from "node:process";
import {
  quoteCmdArg,
  spawnCommand,
  steps,
  windowsCmdPayload,
} from "./local-check.mjs";

/** Undo cmd.exe `/d /s /c` outer-quote stripping, then split argv. */
function argvFromCmdPayload(payload) {
  expect(payload.startsWith('"')).toBe(true);
  const lastQuote = payload.lastIndexOf('"');
  expect(lastQuote).toBe(payload.length - 1);
  const inner = payload.slice(1, lastQuote);
  const tokens = [];
  let index = 0;
  while (index < inner.length) {
    while (inner[index] === " ") {
      index += 1;
    }
    if (index >= inner.length) {
      break;
    }
    expect(inner[index]).toBe('"');
    index += 1;
    let token = "";
    while (index < inner.length) {
      if (inner[index] === '"') {
        if (inner[index + 1] === '"') {
          token += '"';
          index += 2;
          continue;
        }
        index += 1;
        break;
      }
      if (inner[index] === "%" && inner[index + 1] === "%") {
        token += "%";
        index += 2;
        continue;
      }
      token += inner[index];
      index += 1;
    }
    tokens.push(token);
  }
  return tokens;
}

describe("windows command quoting", () => {
  it("keeps clippy -D warnings as its own arguments", () => {
    const clippy = steps.find((step) => step.name === "cargo clippy");
    expect(clippy).toBeDefined();
    expect(clippy.args).toContain("-D");
    expect(clippy.args).toContain("warnings");
    expect(clippy.args.at(-3)).toBe("--");

    const payload = windowsCmdPayload(clippy.cmd, clippy.args);
    expect(argvFromCmdPayload(payload)).toEqual([clippy.cmd, ...clippy.args]);
  });

  it("quotes spaces, quotes, percent signs, and empty args", () => {
    const args = [
      "C:\\Program Files\\nodejs\\node.exe",
      "hello world",
      'say "hi"',
      "100%",
      "",
    ];
    expect(argvFromCmdPayload(windowsCmdPayload("npm", args))).toEqual(["npm", ...args]);
  });

  it("doubles quotes and percent signs inside the cmd token", () => {
    expect(quoteCmdArg('a"b%')).toBe('"a""b%%"');
  });
});

describe("spawnCommand", () => {
  it("returns the child exit code", () => {
    const result = spawnCommand(process.execPath, ["-e", "process.exit(3)"], {
      stdio: "pipe",
      encoding: "utf8",
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(3);
  });

  it("passes clippy-style arguments through to the child", () => {
    const args = ["--", "-D", "warnings", "hello world", 'say "hi"', "100%"];
    // The first `--` ends Node's own options so the child sees the rest.
    const result = spawnCommand(
      process.execPath,
      ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "--", ...args],
      { stdio: "pipe", encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(args);
  });
});
