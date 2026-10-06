import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { installerCommand } from "./install-app.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("npm run install-app", () => {
  it("runs install.sh on macOS and Linux", () => {
    for (const platform of ["darwin", "linux"]) {
      const command = installerCommand(platform);
      expect(command.file).toBe(path.join(root, "install.sh"));
      expect(command.args).toEqual([]);
    }
  });

  it("runs install.ps1 under PowerShell with execution policy bypass", () => {
    const command = installerCommand("win32");
    expect(command.file).toBe("powershell.exe");
    expect(command.args).toEqual([
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(root, "install.ps1"),
    ]);
  });
});
