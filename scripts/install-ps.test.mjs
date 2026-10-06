import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

describe("install.ps1 source", () => {
  const bytes = readFileSync(path.join(root, "install.ps1"));
  const text = bytes.toString("utf8");

  it("stays ASCII without a BOM so Windows PowerShell 5.1 parses it", () => {
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes[0]).not.toBe(0xef);
    expect(bytes[1]).not.toBe(0xbb);
    expect(bytes[2]).not.toBe(0xbf);
    for (const byte of bytes) {
      expect(byte).toBeLessThanOrEqual(127);
    }
  });

  it("avoids syntax Windows PowerShell 5.1 does not have", () => {
    expect(text).not.toMatch(/\?\?/);
    expect(text).not.toMatch(/&&/);
    expect(text).not.toMatch(/\|\|/);
    expect(text).toMatch(/PSVersionTable\.PSVersion\.Major -ge 6/);
    expect(text).not.toMatch(/-AdditionalChildPath/);
  });
});

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

  it("prefers cmd and exe shims and refuses a ps1-only shim", () => {
    const output = pwsh(`
      . ./install.ps1
      $npm = Select-ShimFileName -Name 'npm' -Available @('npm.ps1', 'npm', 'npm.cmd')
      if ($npm -ne 'npm.cmd') { throw "npm:$npm" }
      $npx = Select-ShimFileName -Name 'npx' -Available @('npx.ps1', 'npx.cmd')
      if ($npx -ne 'npx.cmd') { throw "npx:$npx" }
      $explicit = Select-ShimFileName -Name 'npm.cmd' -Available @('npm.ps1', 'npm.cmd')
      if ($explicit -ne 'npm.cmd') { throw "explicit:$explicit" }
      $rustc = Select-ShimFileName -Name 'rustc' -Available @('rustc.ps1', 'rustc.exe')
      if ($rustc -ne 'rustc.exe') { throw "rustc:$rustc" }
      $winget = Select-ShimFileName -Name 'winget' -Available @('winget.exe', 'winget.ps1')
      if ($winget -ne 'winget.exe') { throw "winget:$winget" }
      $node = Select-ShimFileName -Name 'node' -Available @('node.exe')
      if ($node -ne 'node.exe') { throw "node:$node" }
      $bare = Select-ShimFileName -Name 'rustup' -Available @('rustup')
      if ($bare -ne 'rustup') { throw "bare:$bare" }
      $com = Select-ShimFileName -Name 'agent' -Available @('agent.com', 'agent')
      if ($com -ne 'agent.com') { throw "com:$com" }
      $failed = $false
      try {
        Select-ShimFileName -Name 'npm' -Available @('npm.ps1')
      }
      catch {
        $failed = $true
        $message = $_.Exception.Message
        if ($message -notmatch 'Statement') { throw $message }
        if ($message -notmatch 'npm.cmd') { throw $message }
        if ($message -notmatch 'StrictMode') { throw $message }
      }
      if (-not $failed) { throw 'ps1 was accepted' }
      'shim-ok'
    `);
    expect(output).toContain("shim-ok");
  });

  it("resolves npm to npm.cmd when a ps1 shim is also on PATH", () => {
    const output = pwsh(`
      . ./install.ps1
      $td = Join-Path ([System.IO.Path]::GetTempPath()) ('shim-' + [guid]::NewGuid().ToString('n'))
      New-Item -ItemType Directory -Path $td | Out-Null
      try {
        $cmdPath = Join-Path $td 'npm.cmd'
        $ps1Path = Join-Path $td 'npm.ps1'
        $unix = $false
        if ($PSVersionTable.PSVersion.Major -ge 6) {
          $unix = $IsLinux -or $IsMacOS
        }
        if ($unix) {
          Set-Content -LiteralPath $cmdPath -Value "#!/bin/sh\`necho cmd-ok\`n" -Encoding utf8NoBOM
          Set-Content -LiteralPath $ps1Path -Value "Write-Output ps1-ran\`n" -Encoding utf8NoBOM
          chmod +x $cmdPath $ps1Path
        }
        else {
          Set-Content -LiteralPath $cmdPath -Value "@echo off\`r\`necho cmd-ok\`r\`n" -Encoding ascii
          Set-Content -LiteralPath $ps1Path -Value "Write-Output ps1-ran\`r\`n" -Encoding ascii
        }
        $env:PATH = $td + [IO.Path]::PathSeparator + $env:PATH
        $resolved = Get-ExternalExecutable -Name 'npm'
        if ($resolved -ne $cmdPath) { throw "resolved:$resolved" }
        $text = Invoke-ExternalText -Name 'npm' -Arguments @('-v')
        if ($text -ne 'cmd-ok') { throw "text:$text" }
        $only = Join-Path $td 'dcterminal-shim-only.ps1'
        if ($unix) {
          Set-Content -LiteralPath $only -Value "Write-Output no\`n" -Encoding utf8NoBOM
          chmod +x $only
        }
        else {
          Set-Content -LiteralPath $only -Value "Write-Output no\`r\`n" -Encoding ascii
        }
        $refused = $false
        try {
          Get-ExternalExecutable -Name 'dcterminal-shim-only'
        }
        catch {
          $refused = $true
          if ($_.Exception.Message -notmatch 'Statement') { throw $_.Exception.Message }
        }
        if (-not $refused) { throw 'ps1-only was accepted' }
        if ($null -ne (Find-ExternalExecutable -Name 'dcterminal-shim-only')) {
          throw 'find should ignore a ps1-only shim'
        }
        'resolve-ok'
      }
      finally {
        Remove-Item -LiteralPath $td -Recurse -Force -ErrorAction SilentlyContinue
      }
    `);
    expect(output).toContain("resolve-ok");
  });

  it("prints start with an empty title and a separate quoted exe path", () => {
    const output = pwsh(`
      . ./install.ps1
      $exe = 'C:\\Users\\jt\\AppData\\Local\\DCTerminal\\dcterminal.exe'
      $cmd = Get-WindowsLaunchCommand -Executable $exe
      $expected = 'start "" "C:\\Users\\jt\\AppData\\Local\\DCTerminal\\dcterminal.exe"'
      if ($cmd -ne $expected) { throw $cmd }
      if ($cmd -match '""C:') { throw "quotes glued to the path: $cmd" }
      'launch-ok'
    `);
    expect(output).toContain("launch-ok");
  });

  it("prints the script stack trace only when DCT_DEBUG=1", () => {
    const debug = pwsh(`
      . ./install.ps1
      $env:DCT_DEBUG = '1'
      try { throw 'debug-stack-marker' } catch { Write-InstallFailure $_ }
    `);
    expect(debug).toContain("error: debug-stack-marker");
    expect(debug).toMatch(/\bat\b/);

    const quiet = pwsh(`
      . ./install.ps1
      Remove-Item Env:DCT_DEBUG -ErrorAction SilentlyContinue
      try { throw 'quiet-marker' } catch { Write-InstallFailure $_ }
    `);
    expect(quiet).toContain("error: quiet-marker");
    expect(quiet).not.toMatch(/\bat\b/);
  });
});
