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

  Windows PowerShell 5.1 and PowerShell 7 both run this file. StrictMode stays
  on. External tools are invoked by the full path of the .cmd/.exe shim, never
  by a bare name that PowerShell binds to npm.ps1.
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# PowerShell 7.4+ turns native stderr into a terminating error when
# ErrorActionPreference is Stop. npm.cmd and winget write warnings there.
# Windows PowerShell 5.1 does not define this preference, so Test-Path is false.
if (Test-Path -Path 'Variable:PSNativeCommandUseErrorActionPreference') {
  $PSNativeCommandUseErrorActionPreference = $false
}

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

function Get-ShimStem {
  param([Parameter(Mandatory = $true)][string]$Name)
  $leaf = [System.IO.Path]::GetFileName($Name)
  if ([string]::IsNullOrWhiteSpace($leaf)) {
    return $Name
  }
  # -replace is case-insensitive, so NPM.CMD and npm.cmd share a stem.
  return ($leaf -replace '\.(cmd|exe|bat|com|ps1)$', '')
}

function Get-Ps1ShimRefusal {
  param([Parameter(Mandatory = $true)][string]$Stem)
  # Single quotes keep $MyInvocation as text. That property is missing on 5.1.
  $template = 'On Windows PowerShell 5.1, {0}.ps1 reads $MyInvocation.Statement, which does not exist.'
  $cause = $template -f $Stem
  $fix = "Invoke $Stem.cmd, or the full path from (Get-Command $Stem.cmd).Source."
  return "Refusing to run $Stem.ps1. Set-StrictMode leaks into PowerShell shims. $cause $fix"
}

function Get-ShimSearchName {
  param([Parameter(Mandatory = $true)][string]$Name)
  $leaf = [System.IO.Path]::GetFileName($Name)
  # An explicit native shim is used as-is. Never add the .ps1 name to this list.
  if ($leaf -match '\.(cmd|exe|bat|com)$') {
    return @($leaf)
  }
  $stem = Get-ShimStem -Name $leaf
  return @("$stem.cmd", "$stem.exe", "$stem.bat", "$stem.com", $stem)
}

function Test-SameShimName {
  param([string]$Left, [string]$Right)
  if ([string]::IsNullOrWhiteSpace($Left) -or [string]::IsNullOrWhiteSpace($Right)) {
    return $false
  }
  return $Left.Equals($Right, [System.StringComparison]::OrdinalIgnoreCase)
}

function Select-ShimFileName {
  <#
    Pick the file PowerShell must call. .cmd before .exe/.bat/.com, then a
    name with no extension. A lone .ps1 is refused: Set-StrictMode is inherited
    by scripts in this session, and npm.ps1 touches $MyInvocation.Statement.
  #>
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)]
    [AllowEmptyCollection()]
    [string[]]$Available
  )
  foreach ($candidate in @(Get-ShimSearchName -Name $Name)) {
    foreach ($item in @($Available)) {
      if (Test-SameShimName $item $candidate) {
        return $item
      }
    }
  }
  $stem = Get-ShimStem -Name $Name
  foreach ($item in @($Available)) {
    if (Test-SameShimName $item "$stem.ps1") {
      throw (Get-Ps1ShimRefusal -Stem $stem)
    }
  }
  throw "$Name was not found on PATH. Install it and re-run."
}

function Get-CommandSourceText {
  param($CommandInfo)
  if ($null -eq $CommandInfo) {
    return ''
  }
  $sourceProp = $CommandInfo.PSObject.Properties['Source']
  if ($null -eq $sourceProp) {
    return ''
  }
  return [string]$sourceProp.Value
}

function Get-AvailableShimName {
  param([Parameter(Mandatory = $true)][string]$Name)
  $stem = Get-ShimStem -Name $Name
  # Look up each suffix ourselves. Get-Command npm returns npm.ps1 first and
  # hides npm.cmd, which is the Windows PowerShell 5.1 failure.
  $lookups = @(
    @{ Name = "$stem.cmd"; Type = 'Application' },
    @{ Name = "$stem.exe"; Type = 'Application' },
    @{ Name = "$stem.bat"; Type = 'Application' },
    @{ Name = "$stem.com"; Type = 'Application' },
    @{ Name = $stem; Type = 'Application' },
    @{ Name = "$stem.ps1"; Type = 'ExternalScript' }
  )
  $available = @()
  foreach ($lookup in $lookups) {
    $lookupName = [string]$lookup['Name']
    $lookupType = [string]$lookup['Type']
    $cmds = @(Get-Command -Name $lookupName -CommandType $lookupType `
        -ErrorAction SilentlyContinue)
    foreach ($cmd in $cmds) {
      $fileName = [System.IO.Path]::GetFileName((Get-CommandSourceText $cmd))
      if ([string]::IsNullOrWhiteSpace($fileName)) {
        continue
      }
      $already = $false
      foreach ($existing in $available) {
        if (Test-SameShimName $existing $fileName) {
          $already = $true
          break
        }
      }
      if (-not $already) {
        $available += $fileName
      }
    }
  }
  # Pipeline output keeps a one-item result an array for the caller.
  foreach ($fileName in $available) {
    Write-Output $fileName
  }
}

function Resolve-LiteralExecutable {
  param([Parameter(Mandatory = $true)][string]$Name)
  $hasSeparator = $Name.Contains('\') -or $Name.Contains('/')
  if (-not $hasSeparator -and -not [System.IO.Path]::IsPathRooted($Name)) {
    return $null
  }
  if (-not (Test-Path -LiteralPath $Name)) {
    return $null
  }
  $item = Get-Item -LiteralPath $Name
  $ext = [string]$item.Extension
  if ($ext.Equals('.ps1', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw (Get-Ps1ShimRefusal -Stem (Get-ShimStem -Name $item.Name))
  }
  return [string]$item.FullName
}

function Get-SelectedShimSource {
  param([Parameter(Mandatory = $true)][string]$SelectedName)
  $cmds = @(Get-Command -Name $SelectedName -CommandType Application -ErrorAction SilentlyContinue)
  foreach ($cmd in $cmds) {
    $source = Get-CommandSourceText $cmd
    if ([string]::IsNullOrWhiteSpace($source)) {
      continue
    }
    if ($source.EndsWith('.ps1', [System.StringComparison]::OrdinalIgnoreCase)) {
      throw (Get-Ps1ShimRefusal -Stem (Get-ShimStem -Name $SelectedName))
    }
    return $source
  }
  throw "$SelectedName was not found on PATH. Install it and re-run."
}

function Get-ExternalExecutable {
  param([Parameter(Mandatory = $true)][string]$Name)
  $literal = Resolve-LiteralExecutable -Name $Name
  if (-not [string]::IsNullOrWhiteSpace($literal)) {
    return $literal
  }
  $available = @(Get-AvailableShimName -Name $Name)
  $selected = Select-ShimFileName -Name $Name -Available $available
  return (Get-SelectedShimSource -SelectedName $selected)
}

function Find-ExternalExecutable {
  # Missing tools and .ps1-only shims are $null so a warning can continue.
  param([Parameter(Mandatory = $true)][string]$Name)
  $literal = Resolve-LiteralExecutable -Name $Name
  if (-not [string]::IsNullOrWhiteSpace($literal)) {
    return $literal
  }
  $available = @(Get-AvailableShimName -Name $Name)
  if ($available.Count -eq 0) {
    return $null
  }
  try {
    $selected = Select-ShimFileName -Name $Name -Available $available
  }
  catch {
    return $null
  }
  return (Get-SelectedShimSource -SelectedName $selected)
}

function Invoke-Resolved {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [AllowEmptyCollection()][string[]]$Arguments = @()
  )
  $exe = Get-ExternalExecutable -Name $Name
  if ($null -eq $Arguments) {
    $Arguments = @()
  }
  # Full path of npm.cmd / tool.exe. A bare name would re-bind to the .ps1 shim.
  & $exe @Arguments
}

function Invoke-ExternalText {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [AllowEmptyCollection()][string[]]$Arguments = @()
  )
  $output = @(Invoke-Resolved -Name $Name -Arguments $Arguments)
  if ($LASTEXITCODE -ne 0) {
    throw "$Name exited with code $LASTEXITCODE"
  }
  return (($output | Out-String).Trim())
}

function Invoke-Native {
  param(
    [Parameter(Mandatory = $true)][string]$File,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )
  Invoke-Resolved -Name $File -Arguments $Arguments
  # winget returns -1978335189 when the package is already installed.
  $alreadyInstalled = -1978335189
  if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne $alreadyInstalled) {
    throw "$File exited with code $LASTEXITCODE"
  }
}

function Write-InstallFailure {
  param($ErrorRecord)
  $message = ''
  if ($null -ne $ErrorRecord) {
    $exProp = $ErrorRecord.PSObject.Properties['Exception']
    if ($null -ne $exProp -and $null -ne $exProp.Value) {
      $messageProp = $exProp.Value.PSObject.Properties['Message']
      if ($null -ne $messageProp) {
        $message = [string]$messageProp.Value
      }
    }
  }
  if ([string]::IsNullOrWhiteSpace($message)) {
    $message = "$ErrorRecord"
  }
  Write-InstallError $message
  # DCT_DEBUG=1 prints the script stack. The default stays a one-line error.
  if ($env:DCT_DEBUG -eq '1' -and $null -ne $ErrorRecord) {
    $stackProp = $ErrorRecord.PSObject.Properties['ScriptStackTrace']
    if ($null -ne $stackProp -and -not [string]::IsNullOrWhiteSpace([string]$stackProp.Value)) {
      Write-User ([string]$stackProp.Value)
    }
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
    # Already the full path of vswhere.exe, so this cannot bind to a .ps1 shim.
    $found = & $vswhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace("$found")) {
      return $true
    }
  }
  # cl.exe, not a bare name. A cl.ps1 shim is not the MSVC compiler.
  $cl = Find-ExternalExecutable -Name 'cl.exe'
  return $null -ne $cl
}

function Install-NodeWithWinget {
  if ($null -eq (Find-ExternalExecutable -Name 'winget')) {
    throw 'winget is not installed. Install Node.js 20+ from https://nodejs.org/ and re-run.'
  }
  Invoke-Native -File 'winget' -Arguments @(
    'install', '--id', 'OpenJS.NodeJS.LTS', '-e',
    '--accept-source-agreements', '--accept-package-agreements'
  )
  Update-ProcessPath
}

function Install-RustupWithWinget {
  if ($null -eq (Find-ExternalExecutable -Name 'winget')) {
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
  $node = Find-ExternalExecutable -Name 'node'
  $npm = Find-ExternalExecutable -Name 'npm'
  $version = ''
  if ($null -ne $node) {
    $version = Invoke-ExternalText -Name 'node' -Arguments @('-v')
  }
  if ((Test-NodeVersionSupported $version) -and $null -ne $npm) {
    $npmVersion = Invoke-ExternalText -Name 'npm' -Arguments @('-v')
    Write-Info "Node $version, npm $npmVersion"
    return
  }
  Write-User (Get-NodeFixMessage)
  if (Request-InstallConsent "Install Node.js $($script:MinNodeMajor)+ now?") {
    Install-NodeWithWinget
  }
  else {
    throw "Node.js $($script:MinNodeMajor)+ is required."
  }
  $version = Invoke-ExternalText -Name 'node' -Arguments @('-v')
  if (-not (Test-NodeVersionSupported $version)) {
    throw "Node is still older than $($script:MinNodeMajor). Open a new terminal so PATH updates, then re-run."
  }
  Write-Info "Node $version"
}

function Initialize-MsvcRustToolchain {
  $active = Invoke-ExternalText -Name 'rustup' -Arguments @('show', 'active-toolchain')
  $rustVersion = Invoke-ExternalText -Name 'rustc' -Arguments @('--version')
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
  if ($null -eq (Find-ExternalExecutable -Name 'rustup')) {
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
  $rustc = Find-ExternalExecutable -Name 'rustc'
  $rustVersion = ''
  if ($null -ne $rustc) {
    $rustVersion = Invoke-ExternalText -Name 'rustc' -Arguments @('--version')
  }
  if (-not (Test-RustVersionSupported $rustVersion)) {
    Write-User (Get-RustToolchainFixMessage)
    if (Request-InstallConsent 'Update the stable Rust toolchain now?') {
      Invoke-Native -File 'rustup' -Arguments @('update', 'stable')
      Update-ProcessPath
      $rustVersion = Invoke-ExternalText -Name 'rustc' -Arguments @('--version')
      if (-not (Test-RustVersionSupported $rustVersion)) {
        Write-Info "Active rustc is still older than $($script:MinRust); pinning stable-msvc in this repo"
        Invoke-Native -File 'rustup' -Arguments @('toolchain', 'install', 'stable-msvc')
        Invoke-Native -File 'rustup' -Arguments @('override', 'set', 'stable-msvc')
      }
    }
    else {
      throw "Rust $($script:MinRust)+ is required."
    }
    $rustVersion = Invoke-ExternalText -Name 'rustc' -Arguments @('--version')
    if (-not (Test-RustVersionSupported $rustVersion)) {
      throw "rustc is still older than $($script:MinRust). Run: rustup update stable; rustup override set stable-msvc"
    }
  }
  Initialize-MsvcRustToolchain
  $components = Invoke-ExternalText -Name 'rustup' -Arguments @('component', 'list', '--installed')
  if ("$components" -notmatch '(?m)^clippy') {
    Write-Info 'Installing the clippy component (npm run check uses it)'
    Invoke-Native -File 'rustup' -Arguments @('component', 'add', 'clippy')
  }
  Write-Info "Rust $(Invoke-ExternalText -Name 'rustc' -Arguments @('--version'))"
}

function Initialize-MsvcPrerequisite {
  if (Test-MsvcCompiler) {
    Write-Info 'MSVC C++ Build Tools are installed'
    return
  }
  Write-User (Get-MsvcFixMessage)
  if (Request-InstallConsent 'Install the MSVC Build Tools now?') {
    if ($null -eq (Find-ExternalExecutable -Name 'winget')) {
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
    if ($null -eq (Find-ExternalExecutable -Name 'winget')) {
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
  # agent.cmd / agent.exe only. A .ps1 shim is not something the app can spawn.
  $agent = Find-ExternalExecutable -Name 'agent'
  if ($null -ne $agent) {
    Write-Info "Cursor CLI: $agent"
    return
  }
  # Warning only. --yes does not run the Cursor installer.
  Write-User (Get-AgentWarning)
  Write-User 'The app will still be installed. Run agent login before starting a session.'
}

function Get-AppVersion {
  $configPath = Join-Path $script:Root 'src-tauri\tauri.conf.json'
  $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
  # StrictMode throws on a missing property. Read the note if it is absent.
  $versionProp = $null
  if ($null -ne $config) {
    $versionProp = $config.PSObject.Properties['version']
  }
  if ($null -eq $versionProp -or [string]::IsNullOrWhiteSpace([string]$versionProp.Value)) {
    throw 'src-tauri/tauri.conf.json has no version'
  }
  return [string]$versionProp.Value
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

function Get-WindowsLaunchCommand {
  param([Parameter(Mandatory = $true)][string]$Executable)
  # cmd start uses the first quoted string as the window title. An empty
  # title, then the quoted exe: start "" "C:\path\dcterminal.exe"
  return 'start "" "' + $Executable + '"'
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
  Write-User ("  Launch: " + (Get-WindowsLaunchCommand -Executable $exe))
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
  # A missing list is "no flags". foreach over $null is a StrictMode hazard.
  if ($null -eq $ArgumentList) {
    $ArgumentList = @()
  }
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
    Write-InstallFailure $_
    exit 1
  }
}
