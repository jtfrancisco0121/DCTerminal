#Requires -Version 5.1
<#
.SYNOPSIS
  Build DCTerminal on this Windows PC and install it for the current user.

.DESCRIPTION
  macOS and Linux use ./install.sh. npm run install-app selects the script.
  The NSIS installer is per-user (see src-tauri/tauri.conf.json) and is run
  silently. Nothing is code-signed. User data under %APPDATA% is left in
  place on uninstall.

  Flags match install.sh: --yes --skip-checks --universal --uninstall --help
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:ProductName = 'DCTerminal'
# Cargo package name (src-tauri/Cargo.toml default-run). The exe is not DCTerminal.exe.
$script:BinaryName = 'dcterminal'
$script:BundleId = 'com.jtfrancisco.dcterminal'
$script:MinNodeMajor = 20
$script:MinRust = [version]'1.90.0'
$script:WebView2Guid = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
$script:Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$script:AssumeYes = $false

function Write-User {
  # The installer talks to the person running it. Write-Output would mix with pipeline data.
  [Diagnostics.CodeAnalysis.SuppressMessageAttribute(
    'PSAvoidUsingWriteHost', '', Justification = 'Installer text is for the operator.')]
  param([string]$Message)
  Write-Host $Message
}

function Write-Info {
  param([string]$Message)
  Write-User "==> $Message"
}

function Write-InstallError {
  param([string]$Message)
  Write-User "error: $Message"
}

function Show-InstallUsage {
  param()
  Write-User @"
Usage: powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 [--yes] [--skip-checks] [--uninstall]

Build DCTerminal for this Windows PC and install it for the current user.
On macOS or Linux, run ./install.sh. From either OS: npm run install-app.

  --yes           Install missing prerequisites without prompting
  --skip-checks   Skip npm run check (cargo test, clippy, npm test, frontend build)
  --universal     macOS only. On Windows this script builds the NSIS installer for this PC.
  --uninstall     Remove the app. User data is left in place and the path is printed
  -h, --help      Show this help

The build is unsigned. SmartScreen may warn the first time you launch it.
"@
}

function Test-NodeVersionSupported {
  param([string]$VersionText)
  if ($VersionText -match 'v?(\d+)') {
    return ([int]$Matches[1] -ge $script:MinNodeMajor)
  }
  return $false
}

function Test-RustVersionSupported {
  param([string]$VersionText)
  if ($VersionText -match 'rustc (\d+\.\d+\.\d+)') {
    return ([version]$Matches[1] -ge $script:MinRust)
  }
  return $false
}

function Test-CheckStep {
  param([bool]$SkipChecks)
  return -not $SkipChecks
}

function Get-NodeFixMessage {
  @"
Node.js $($script:MinNodeMajor)+ is required, with npm.
  https://nodejs.org/
Install the LTS package with winget:
  winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
"@
}

function Get-RustupInstallCommand {
  'winget install --id Rustlang.Rustup -e --accept-source-agreements --accept-package-agreements'
}

function Get-RustToolchainFixMessage {
  @"
rustc is missing or older than $($script:MinRust), or it is not the MSVC toolchain.
  rustup update stable
  rustup toolchain install stable-msvc
If rustc is still old, the active toolchain is a pin. Use stable-msvc in this repo only:
  rustup override set stable-msvc
"@
}

function Get-MsvcFixMessage {
  @"
MSVC Build Tools are required (the "Desktop development with C++" workload).
  winget install --id Microsoft.VisualStudio.2022.BuildTools -e --accept-source-agreements --accept-package-agreements --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
Or download the installer: https://visualstudio.microsoft.com/visual-cpp-build-tools/
The winget install needs an Administrator approval window and takes a while.
"@
}

function Get-WebView2FixMessage {
  @"
The WebView2 runtime is required. Windows 10 (1803+) and Windows 11 usually have it.
  winget install --id Microsoft.EdgeWebView2Runtime -e --accept-source-agreements --accept-package-agreements
Or download the Evergreen Bootstrapper:
  https://developer.microsoft.com/microsoft-edge/webview2/#download-section
"@
}

function Get-AgentWarning {
  @"
warning: Cursor CLI 'agent' is not on PATH.
DCTerminal starts ``agent acp`` for each session. Install the CLI, then run: agent login
  irm 'https://cursor.com/install?win32=true' | iex
"@
}

function Get-NsisArchName {
  param([string]$Processor)
  switch ($Processor) {
    'AMD64' { 'x64' }
    'ARM64' { 'arm64' }
    'x86' { 'x86' }
    default { throw "unsupported architecture: $Processor" }
  }
}

function Get-NsisArtifactPath {
  param([string]$Version, [string]$Arch)
  "src-tauri\target\release\bundle\nsis\$($script:ProductName)_${Version}_${Arch}-setup.exe"
}

function Get-AppDataDirectory {
  param([string]$AppData)
  # Always a Windows path. Join-Path would look up drive C: when this file is
  # dot-sourced on a non-Windows host (the unit test). On Windows the result
  # matches %APPDATA%\com.jtfrancisco.dcterminal.
  $base = $AppData.TrimEnd('\', '/')
  return "$base\$($script:BundleId)"
}

function Get-DataFilesKept {
  'settings.json roles.json forms.json state.json scratch.json handoffs.json logs/'
}

function Get-InstallDirectory {
  Join-Path $env:LOCALAPPDATA $script:ProductName
}

function Request-InstallConsent {
  param([string]$Prompt)
  if ($script:AssumeYes) {
    Write-User "Proceeding (--yes): $Prompt"
    return $true
  }
  if ([Console]::IsInputRedirected) {
    Write-User 'Not a terminal, so nothing was installed. Re-run with --yes, or run the command above.'
    return $false
  }
  $reply = Read-Host "$Prompt [y/N]"
  return @('y', 'Y', 'yes', 'YES') -contains $reply
}

function Update-ProcessPath {
  # This only edits the current process environment, after the operator agreed to an install.
  [Diagnostics.CodeAnalysis.SuppressMessageAttribute(
    'PSUseShouldProcessForStateChangingFunctions', '',
    Justification = 'Updates this process PATH only, after the operator agreed.')]
  [CmdletBinding()]
  param()
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $cargo = Join-Path $env:USERPROFILE '.cargo\bin'
  $env:Path = "$user;$machine;$cargo"
}

function Invoke-Native {
  param(
    [Parameter(Mandatory = $true)][string]$File,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )
  & $File @Arguments
  # winget returns -1978335189 when the package is already installed.
  $alreadyInstalled = -1978335189
  if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne $alreadyInstalled) {
    throw "$File exited with code $LASTEXITCODE"
  }
}

function Test-WebView2Installed {
  $keys = @(
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$($script:WebView2Guid)",
    "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$($script:WebView2Guid)",
    "HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$($script:WebView2Guid)"
  )
  foreach ($key in $keys) {
    $props = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue
    if ($null -ne $props -and $props.PSObject.Properties.Name -contains 'pv') {
      $pv = [string]$props.pv
      if (-not [string]::IsNullOrWhiteSpace($pv) -and $pv -ne '0.0.0.0') {
        return $true
      }
    }
  }
  return $false
}

function Test-MsvcCompiler {
  $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
  if (Test-Path -LiteralPath $vswhere) {
    $found = & $vswhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace("$found")) {
      return $true
    }
  }
  $cl = Get-Command cl.exe -ErrorAction SilentlyContinue
  return $null -ne $cl
}

function Install-NodeWithWinget {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw 'winget is not installed. Install Node.js 20+ from https://nodejs.org/ and re-run.'
  }
  Invoke-Native -File 'winget' -Arguments @(
    'install', '--id', 'OpenJS.NodeJS.LTS', '-e',
    '--accept-source-agreements', '--accept-package-agreements'
  )
  Update-ProcessPath
}

function Install-RustupWithWinget {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw 'winget is not installed. Install rustup from https://rustup.rs/ and re-run.'
  }
  Invoke-Native -File 'winget' -Arguments @(
    'install', '--id', 'Rustlang.Rustup', '-e',
    '--accept-source-agreements', '--accept-package-agreements'
  )
  Update-ProcessPath
}

function Initialize-NodePrerequisite {
  Update-ProcessPath
  $node = Get-Command node -ErrorAction SilentlyContinue
  $npm = Get-Command npm -ErrorAction SilentlyContinue
  $version = ''
  if ($null -ne $node) {
    $version = (& node -v).Trim()
  }
  if ((Test-NodeVersionSupported $version) -and $null -ne $npm) {
    Write-Info "Node $version, npm $((& npm -v).Trim())"
    return
  }
  Write-User (Get-NodeFixMessage)
  if (Request-InstallConsent "Install Node.js $($script:MinNodeMajor)+ now?") {
    Install-NodeWithWinget
  }
  else {
    throw "Node.js $($script:MinNodeMajor)+ is required."
  }
  $version = (& node -v).Trim()
  if (-not (Test-NodeVersionSupported $version)) {
    throw "Node is still older than $($script:MinNodeMajor). Open a new terminal so PATH updates, then re-run."
  }
  Write-Info "Node $version"
}

function Initialize-MsvcRustToolchain {
  $active = (& rustup show active-toolchain | Out-String).Trim()
  $rustVersion = (& rustc --version | Out-String).Trim()
  $versionOk = Test-RustVersionSupported $rustVersion
  if ($versionOk -and $active -match 'msvc') {
    return
  }
  # Directory override, not `rustup default`, so a pin used by other projects stays.
  Write-User (Get-RustToolchainFixMessage)
  if (Request-InstallConsent 'Use stable-msvc for this repo?') {
    Invoke-Native -File 'rustup' -Arguments @('toolchain', 'install', 'stable-msvc')
    Invoke-Native -File 'rustup' -Arguments @('override', 'set', 'stable-msvc')
  }
  else {
    throw 'The MSVC Rust toolchain is required. npm run release:win uses it.'
  }
}

function Initialize-RustPrerequisite {
  Update-ProcessPath
  if (-not (Get-Command rustup -ErrorAction SilentlyContinue)) {
    Write-User "Rust must come from rustup. Tauri 2.12 needs rustc $($script:MinRust) or newer."
    Write-User "  $(Get-RustupInstallCommand)"
    Write-User 'Choose the MSVC host triple (x86_64-pc-windows-msvc on a 64-bit PC) if the installer asks.'
    if (Request-InstallConsent 'Install Rust with rustup now?') {
      Install-RustupWithWinget
    }
    else {
      throw 'Rust via rustup is required.'
    }
  }
  $rustc = Get-Command rustc -ErrorAction SilentlyContinue
  $rustVersion = ''
  if ($null -ne $rustc) {
    $rustVersion = (& rustc --version | Out-String).Trim()
  }
  if (-not (Test-RustVersionSupported $rustVersion)) {
    Write-User (Get-RustToolchainFixMessage)
    if (Request-InstallConsent 'Update the stable Rust toolchain now?') {
      Invoke-Native -File 'rustup' -Arguments @('update', 'stable')
      Update-ProcessPath
      $rustVersion = (& rustc --version | Out-String).Trim()
      if (-not (Test-RustVersionSupported $rustVersion)) {
        Write-Info "Active rustc is still older than $($script:MinRust); pinning stable-msvc in this repo"
        Invoke-Native -File 'rustup' -Arguments @('toolchain', 'install', 'stable-msvc')
        Invoke-Native -File 'rustup' -Arguments @('override', 'set', 'stable-msvc')
      }
    }
    else {
      throw "Rust $($script:MinRust)+ is required."
    }
    $rustVersion = (& rustc --version | Out-String).Trim()
    if (-not (Test-RustVersionSupported $rustVersion)) {
      throw "rustc is still older than $($script:MinRust). Run: rustup update stable; rustup override set stable-msvc"
    }
  }
  Initialize-MsvcRustToolchain
  $components = & rustup component list --installed
  if ("$components" -notmatch '(?m)^clippy') {
    Write-Info 'Installing the clippy component (npm run check uses it)'
    Invoke-Native -File 'rustup' -Arguments @('component', 'add', 'clippy')
  }
  Write-Info "Rust $((& rustc --version | Out-String).Trim())"
}

function Initialize-MsvcPrerequisite {
  if (Test-MsvcCompiler) {
    Write-Info 'MSVC C++ Build Tools are installed'
    return
  }
  Write-User (Get-MsvcFixMessage)
  if (Request-InstallConsent 'Install the MSVC Build Tools now?') {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
      throw 'winget is not installed. Install Build Tools from https://visualstudio.microsoft.com/visual-cpp-build-tools/'
    }
    Invoke-Native -File 'winget' -Arguments @(
      'install', '--id', 'Microsoft.VisualStudio.2022.BuildTools', '-e',
      '--accept-source-agreements', '--accept-package-agreements',
      '--override', '--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended'
    )
  }
  else {
    throw 'MSVC Build Tools are required.'
  }
  if (-not (Test-MsvcCompiler)) {
    throw 'MSVC Build Tools are still missing. Finish the Visual Studio installer, then re-run.'
  }
}

function Initialize-WebView2Prerequisite {
  if (Test-WebView2Installed) {
    Write-Info 'WebView2 runtime is installed'
    return
  }
  Write-User (Get-WebView2FixMessage)
  if (Request-InstallConsent 'Install the WebView2 runtime now?') {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
      throw 'winget is not installed. Download the Evergreen Bootstrapper from the link above.'
    }
    Invoke-Native -File 'winget' -Arguments @(
      'install', '--id', 'Microsoft.EdgeWebView2Runtime', '-e',
      '--accept-source-agreements', '--accept-package-agreements'
    )
  }
  else {
    throw 'WebView2 is required.'
  }
}

function Write-AgentWarningIfMissing {
  param()
  $agent = Get-Command agent -ErrorAction SilentlyContinue
  if ($null -ne $agent) {
    Write-Info "Cursor CLI: $($agent.Source)"
    return
  }
  # Warning only. --yes does not run the Cursor installer.
  Write-User (Get-AgentWarning)
  Write-User 'The app will still be installed. Run agent login before starting a session.'
}

function Get-AppVersion {
  $config = Get-Content -LiteralPath (Join-Path $script:Root 'src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json
  if ([string]::IsNullOrWhiteSpace($config.version)) {
    throw 'src-tauri/tauri.conf.json has no version'
  }
  return [string]$config.version
}

function Stop-DcTerminalIfRunning {
  # Silent NSIS has no "the app is running" dialog, and Windows locks the exe.
  [Diagnostics.CodeAnalysis.SuppressMessageAttribute(
    'PSUseShouldProcessForStateChangingFunctions', '',
    Justification = 'Stops only the DCTerminal process so the installer can replace the exe.')]
  [CmdletBinding()]
  param()
  Get-Process -Name $script:BinaryName -ErrorAction SilentlyContinue |
    Stop-Process -Force -ErrorAction SilentlyContinue
}

function Install-NsisBundle {
  $version = Get-AppVersion
  $arch = Get-NsisArchName $env:PROCESSOR_ARCHITECTURE
  $relative = Get-NsisArtifactPath -Version $version -Arch $arch
  $setup = Join-Path $script:Root $relative
  if (-not (Test-Path -LiteralPath $setup)) {
    throw "NSIS installer was not produced at $setup"
  }
  # A file we just built should not be blocked as a download. Unblock-File
  # removes Zone.Identifier if some tool stamped it. This is not a signature.
  Unblock-File -LiteralPath $setup
  Stop-DcTerminalIfRunning
  Write-Info "Running the per-user NSIS installer silently: $setup"
  Write-User 'The installer is unsigned. If SmartScreen appears outside silent mode: More info, then Run anyway. See docs/RELEASE.md.'
  # /S is the NSIS silent switch. currentUser in tauri.conf.json means no UAC prompt.
  # Running it again upgrades the copy in %LOCALAPPDATA%\DCTerminal.
  $proc = Start-Process -FilePath $setup -ArgumentList '/S' -Wait -PassThru
  if ($proc.ExitCode -ne 0) {
    throw "NSIS installer exited with code $($proc.ExitCode)"
  }
}

function Show-InstalledSummary {
  param()
  $dir = Get-InstallDirectory
  $exe = Join-Path $dir "$($script:BinaryName).exe"
  $data = Get-AppDataDirectory $env:APPDATA
  Write-User ''
  Write-User 'DCTerminal is installed.'
  Write-User ''
  Write-User "  App:    $exe"
  Write-User "  Launch: start `"`"$exe`"`""
  Write-User '          or the DCTerminal shortcut on the Start menu / desktop'
  Write-User ''
  Write-User "  Data:   $data"
  Write-User '          Created on first launch. Uninstall leaves it in place.'
  Write-User "          Files: $(Get-DataFilesKept)"
  Write-User ''
}

function Show-DataKept {
  param()
  $data = Get-AppDataDirectory $env:APPDATA
  Write-User ''
  Write-User 'User data was kept. Uninstall does not remove roles, tabs, transcripts, or settings.'
  Write-User "  $data"
  Write-User "  Files: $(Get-DataFilesKept)"
}

function Uninstall-DcTerminalApp {
  $uninstaller = Join-Path (Get-InstallDirectory) 'uninstall.exe'
  if (Test-Path -LiteralPath $uninstaller) {
    Stop-DcTerminalIfRunning
    Write-Info "Running $uninstaller /S"
    # Silent mode skips the "delete app data" page, so the checkbox stays off
    # and %APPDATA%\com.jtfrancisco.dcterminal is not removed.
    $proc = Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait -PassThru
    if ($proc.ExitCode -ne 0) {
      throw "Uninstaller exited with code $($proc.ExitCode)"
    }
    Write-Info 'Removed the per-user install'
  }
  else {
    Write-Info "DCTerminal is not installed ($uninstaller is absent)"
  }
  Show-DataKept
}

function Invoke-HostBuild {
  Write-Info 'npm run tauri -- build --bundles nsis'
  # `--` is npm's separator so `tauri` receives `build --bundles nsis`.
  Invoke-Native -File 'npm' -Arguments @('run', 'tauri', '--', 'build', '--bundles', 'nsis')
}

function Invoke-DcTerminalInstall {
  param([string[]]$ArgumentList)
  $skipChecks = $false
  $universal = $false
  $doUninstall = $false
  $showHelp = $false
  $script:AssumeYes = $false
  foreach ($arg in $ArgumentList) {
    switch ($arg) {
      '--yes' { $script:AssumeYes = $true }
      '-y' { $script:AssumeYes = $true }
      '--skip-checks' { $skipChecks = $true }
      '--universal' { $universal = $true }
      '--uninstall' { $doUninstall = $true }
      '--help' { $showHelp = $true }
      '-h' { $showHelp = $true }
      default { throw "unknown argument: $arg" }
    }
  }
  if ($showHelp) {
    Show-InstallUsage
    return
  }
  if ($universal) {
    throw '--universal builds a universal macOS app (Apple Silicon and Intel). It only works on macOS.'
  }
  # $IsWindows is read-only in PowerShell 6+. Windows PowerShell 5.1 does not define it.
  $runningOnWindows = $true
  if ($PSVersionTable.PSVersion.Major -ge 6) {
    $runningOnWindows = $IsWindows
  }
  if (-not $runningOnWindows) {
    throw 'install.ps1 is for Windows. On macOS or Linux run ./install.sh'
  }
  Set-Location -LiteralPath $script:Root
  if ($doUninstall) {
    Uninstall-DcTerminalApp
    return
  }
  Initialize-NodePrerequisite
  Initialize-RustPrerequisite
  Initialize-MsvcPrerequisite
  Initialize-WebView2Prerequisite
  Write-AgentWarningIfMissing
  Write-Info 'npm ci'
  Invoke-Native -File 'npm' -Arguments @('ci')
  if (Test-CheckStep $skipChecks) {
    Write-Info 'npm run check'
    Invoke-Native -File 'npm' -Arguments @('run', 'check')
  }
  else {
    Write-Info 'Skipping npm run check (--skip-checks)'
  }
  Invoke-HostBuild
  Install-NsisBundle
  Show-InstalledSummary
}

# Dot-sourcing (tests) must not start a build. -File and .\install.ps1 do.
if ($MyInvocation.InvocationName -ne '.') {
  try {
    Invoke-DcTerminalInstall -ArgumentList @($args)
  }
  catch {
    Write-InstallError $_.Exception.Message
    exit 1
  }
}
