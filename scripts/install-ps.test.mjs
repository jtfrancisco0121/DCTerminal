import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function pwshAvailable() {
  try {
    execFileSync("pwsh", ["-NoProfile", "-Command", "exit 0"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function pwsh(command) {
  return execFileSync("pwsh", ["-NoProfile", "-Command", command], {
    cwd: root,
    encoding: "utf8",
  });
}

function pwshResult(command) {
  try {
    const stdout = execFileSync("pwsh", ["-NoProfile", "-Command", command], {
      cwd: root,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    return {
      status: error.status ?? 1,
      stdout: error.stdout?.toString() ?? "",
      stderr: error.stderr?.toString() ?? "",
    };
  }
}

describe.skipIf(!pwshAvailable())("install.ps1", () => {
  it("keeps the same version gates, NSIS path, and install commands as install.sh", () => {
    const output = pwsh(`
      . ./install.ps1
      if (-not (Test-NodeVersionSupported 'v20.0.0')) { throw 'node 20' }
      if (-not (Test-NodeVersionSupported 'v22.14.0')) { throw 'node 22' }
      if (Test-NodeVersionSupported 'v19.9.0') { throw 'node 19' }
      if (-not (Test-RustVersionSupported 'rustc 1.90.0 (abc 2025-01-01)')) { throw 'rust 1.90' }
      if (-not (Test-RustVersionSupported 'rustc 1.100.0 (abc 2025-01-01)')) { throw 'rust 1.100' }
      if (Test-RustVersionSupported 'rustc 1.83.0 (abc 2024-11-26)') { throw 'rust 1.83' }
      if ((Get-NsisArchName 'AMD64') -ne 'x64') { throw 'arch' }
      if ((Get-NsisArchName 'ARM64') -ne 'arm64') { throw 'arm' }
      $nsis = Get-NsisArtifactPath -Version '0.1.0' -Arch 'x64'
      if ($nsis -ne 'src-tauri\\target\\release\\bundle\\nsis\\DCTerminal_0.1.0_x64-setup.exe') { throw $nsis }
      $data = Get-AppDataDirectory 'C:\\Users\\jt\\AppData\\Roaming'
      if ($data -notmatch 'com\\.jtfrancisco\\.dcterminal') { throw $data }
      $kept = Get-DataFilesKept
      foreach ($name in @('settings.json','roles.json','forms.json','state.json','scratch.json','handoffs.json')) {
        if ($kept -notmatch [regex]::Escape($name)) { throw $name }
      }
      if ((Get-NodeFixMessage) -notmatch 'OpenJS.NodeJS.LTS') { throw 'node cmd' }
      if ((Get-RustupInstallCommand) -notmatch 'Rustlang.Rustup') { throw 'rustup cmd' }
      $refresh = Get-RustToolchainFixMessage
      if ($refresh -notmatch 'rustup update stable') { throw 'rust update' }
      if ($refresh -notmatch 'rustup override set stable-msvc') { throw 'rust override' }
      if ((Get-MsvcFixMessage) -notmatch 'VCTools') { throw 'msvc cmd' }
      if ((Get-WebView2FixMessage) -notmatch 'EdgeWebView2Runtime') { throw 'webview cmd' }
      $agent = Get-AgentWarning
      if ($agent -notmatch 'warning') { throw 'agent warning' }
      if ($agent -notmatch 'irm') { throw 'agent install' }
      if (-not (Test-CheckStep $false)) { throw 'checks' }
      if (Test-CheckStep $true) { throw 'skip' }
      'ps-ok'
    `);
    expect(output).toContain("ps-ok");
  });

  it("prints help and refuses --universal and non-Windows runs", () => {
    const help = pwshResult("pwsh -NoProfile -File ./install.ps1 --help");
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("--uninstall");
    expect(help.stdout).toContain("--skip-checks");

    const universal = pwshResult("pwsh -NoProfile -File ./install.ps1 --universal");
    expect(universal.status).not.toBe(0);
    expect(`${universal.stdout}\n${universal.stderr}`.toLowerCase()).toContain("macos");

    const host = pwshResult("pwsh -NoProfile -File ./install.ps1");
    expect(host.status).not.toBe(0);
    expect(`${host.stdout}\n${host.stderr}`.toLowerCase()).toContain("windows");
  });
});
