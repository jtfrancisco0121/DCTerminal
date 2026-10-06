import { describe, expect, it } from "vitest";
import process from "node:process";
import {
  quoteCmdArg,
  spawnCommand,
  steps,
  windowsCmdPayload,
  windowsInvocation,
} from "./local-check.mjs";

/** Undo cmd.exe `/d /s /c` outer-quote stripping, then split argv. */
function argvFromCmdPayload(payload) {
  expect(payload.startsWith('"')).toBe(true);
  expect(payload.endsWith('"')).toBe(true);
  const inner = payload.slice(1, -1);
  const tokens = [];
  let index = 0;
  while (index < inner.length) {
    while (inner[index] === " ") {
      index += 1;
    }
    if (index >= inner.length) {
      break;
    }
    let token = "";
    if (inner[index] === '"') {
      index += 1;
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
    } else {
      const start = index;
      while (index < inner.length && inner[index] !== " ") {
        index += 1;
      }
      token = inner.slice(start, index);
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
    expect(quoteCmdArg("test")).toBe("test");
  });

  it("leaves the npm command unquoted so %~dp0 is the nodejs directory", () => {
    const npmTest = steps.find((step) => step.name === "npm test");
    expect(npmTest).toBeDefined();
    const payload = windowsCmdPayload(npmTest.cmd, npmTest.args);
    const invocation = windowsInvocation(npmTest.cmd, npmTest.args);
    // Outer quotes are only for cmd /s. The command itself is bare.
    expect(payload).toBe('"npm test"');
    expect(payload.includes('"npm"')).toBe(false);
    expect(payload.includes("\\")).toBe(false);
    expect(invocation.windowsVerbatimArguments).toBe(true);
    expect(invocation.args).toEqual(["/d", "/s", "/c", '"npm test"']);
    expect(argvFromCmdPayload(payload)).toEqual(["npm", "test"]);
  });

  it("quotes an absolute npm.cmd path that contains spaces", () => {
    const command = "C:\\Program Files\\nodejs\\npm.cmd";
    const payload = windowsCmdPayload(command, ["test"]);
    expect(payload).toBe(`""${command}" test"`);
    expect(argvFromCmdPayload(payload)).toEqual([command, "test"]);
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
