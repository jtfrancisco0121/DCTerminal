# Releasing DCTerminal

Installers are built on a local machine. **Automatic GitHub Actions is disabled** (no Actions subscription). Do not add `push`, `pull_request`, or tag triggers under `.github/workflows/`. The existing workflow is `workflow_dispatch` only and is not part of the release path.

`.github/workflows/ci.yml` will not run on pull requests or pushes. Use `npm run check` before merging.

## Install on this machine

From a fresh clone, one command checks prerequisites, builds for the OS you are on, and installs DCTerminal. It does not cross-compile, sign, or notarize.

```bash
./install.sh                         # macOS or Linux
npm run install-app                  # either OS, including Windows
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

`install.ps1` runs in Windows PowerShell 5.1 and in PowerShell 7. It calls `npm.cmd` and `npx.cmd` by the full path from `Get-Command`, not the `npm.ps1` shim. StrictMode makes that shim fail on 5.1 because `$MyInvocation.Statement` does not exist there. Set `DCT_DEBUG=1` to print the script stack when the installer stops.

| Flag | Effect |
|------|--------|
| `--yes` | Install missing prerequisites without prompting |
| `--skip-checks` | Skip `npm run check` |
| `--universal` | macOS only. Build one `.app` for Apple Silicon and Intel. The default is the Mac you are on |
| `--uninstall` | Remove the app. User data stays, and the script prints where |

Prerequisite checks print the exact command, then ask before running it. Node.js 20+, Rust via rustup (1.90+), Xcode Command Line Tools on macOS, the Tauri Linux packages for apt/dnf/pacman (webkit2gtk 4.1, the appindicator library, patchelf, and the rest of that list), and on Windows the MSVC Build Tools plus the WebView2 runtime. A missing Cursor CLI `agent` is a warning, with `curl https://cursor.com/install -fsS | bash` or the Windows `irm` installer. The app still installs. `--yes` does not install the Cursor CLI.

What gets installed:

| OS | Build | Where it lands | Launch |
|----|--------|----------------|--------|
| macOS | `.app` for this Mac, or a universal `.app` with `--universal` | `/Applications/DCTerminal.app`, or `~/Applications/DCTerminal.app` when `/Applications` is not writable | `open -a DCTerminal` |
| Linux with apt | `.deb` | package `dc-terminal`, binary `/usr/bin/dcterminal` | `dcterminal` |
| Other Linux | `.AppImage` | `~/.local/bin/DCTerminal.AppImage` plus a `.desktop` entry | that path, or the app menu |
| Windows | NSIS, current user, silent (`/S`) | `%LOCALAPPDATA%\DCTerminal\dcterminal.exe` | Start menu, or that exe |

Running it again replaces that copy. `dpkg -i`, the NSIS installer, and the `.app` / AppImage copy all upgrade in place.

The macOS app is unsigned. The script clears `com.apple.quarantine` on the bundle it just copied and says why: Gatekeeper blocks an unsigned app when that attribute is set. This is not a signature and not notarization. The Windows installer is unsigned too; SmartScreen can still warn (see below).

`--uninstall` removes the app only. It leaves:

| OS | Data directory |
|----|----------------|
| macOS | `~/Library/Application Support/com.jtfrancisco.dcterminal/` |
| Linux | `$XDG_DATA_HOME/com.jtfrancisco.dcterminal/` or `~/.local/share/com.jtfrancisco.dcterminal/` |
| Windows | `%APPDATA%\com.jtfrancisco.dcterminal\` |

That folder holds `settings.json`, `roles.json`, `forms.json`, `state.json`, `scratch.json`, `handoffs.json`, and `logs/`. The silent Windows uninstaller does not check "delete app data".

`npm run release:win`, `release:mac`, and `release:linux` still only build artifacts. They do not install them.

## Version

Keep these three on the same semver before you build:

| File | Field |
|------|--------|
| `package.json` | `version` |
| `src-tauri/tauri.conf.json` | `version` |
| `src-tauri/Cargo.toml` | `[package] version` |

`npm run check` fails if they differ. The installer version comes from `tauri.conf.json`. The bundle id is `com.jtfrancisco.dcterminal` and the product name is `DCTerminal`.

## Prerequisites

- Node.js 20+ and Rust 1.90+ (Tauri 2.12 in `Cargo.lock` refuses older compilers), plus the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for the OS you are packaging
- Windows: WebView2. The NSIS and MSI installers use the WebView2 **download bootstrapper** (needs network on first install) and do not embed the runtime
- Linux packaging: webkit2gtk 4.1, GTK 3, patchelf, and the other packages from the Tauri Linux guide
- macOS packaging: Xcode command line tools. Minimum system version is **10.15**

Icons are already in `src-tauri/icons/` (including `icon.ico` and `icon.icns`). To replace them, put a square 1024×1024 PNG somewhere outside `src-tauri/icons/` and run:

```bash
npm run tauri icon path/to/source.png
```

## Local checks

From the repo root, on the OS you are about to ship from:

```bash
npm install
npm run check
```

`npm run check` runs, in order:

1. `cargo test --manifest-path src-tauri/Cargo.toml`
2. `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
3. `npm test`
4. `npm run build`

That compiles the Rust crate for the **host** OS, so `cfg(windows)` code is compiled when you run it on Windows. From Linux or macOS you can typecheck the Windows modules without a Windows machine:

```bash
rustup target add x86_64-pc-windows-gnu
# Linux also needs the MinGW linker, e.g. gcc-mingw-w64-x86-64
cargo check --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-gnu
```

The MinGW target is a compile check. Ship Windows builds with the MSVC toolchain (`x86_64-pc-windows-msvc`), which is what `npm run release:win` uses on a normal Windows Rust install.

## Build installers

`tauri build` runs `npm run build` first, then compiles the release binary and packages only the bundles for that command. Run each script on the matching OS (Tauri does not cross-compile installers):

```bash
npm run release:win      # Windows: NSIS (.exe) and MSI
npm run release:mac      # macOS: .app and .dmg
npm run release:linux    # Linux: .deb and .AppImage
```

NSIS installs for the **current user** (no Administrator prompt by default).

Artifacts land under `src-tauri/target/release/bundle/`:

| OS | Directory | Example (version 0.1.0, 64-bit) |
|----|-----------|----------------------------------|
| Windows | `nsis/`, `msi/` | `nsis/DCTerminal_0.1.0_x64-setup.exe`, `msi/DCTerminal_0.1.0_x64_en-US.msi` |
| macOS | `macos/`, `dmg/` | `dmg/DCTerminal_0.1.0_aarch64.dmg` (or `x64` on Intel) |
| Linux | `deb/`, `appimage/` | `deb/DCTerminal_0.1.0_amd64.deb`, `appimage/DCTerminal_0.1.0_amd64.AppImage` |

The exact file name follows the product name, version, and architecture. Copy those files out of `target/` (it is gitignored) and attach them to a GitHub Release by hand if you want a download page. Nothing in this repo publishes a release automatically.

## Unsigned Windows installers and SmartScreen

These installers are **not code-signed**. Windows SmartScreen will warn ("Windows protected your PC" / unknown publisher) because the file has no Authenticode signature and no reputation yet. That is expected.

To install anyway: **More info** → **Run anyway**. The same warning can appear for the NSIS `.exe` and, less often, when launching an unsigned app installed from the MSI.

## Add code signing later

No signing secrets are required to build. When you have certificates, wire them in locally. Do not commit certificates or passwords.

### Windows Authenticode

1. Obtain a code-signing certificate (`.pfx`). An EV certificate reduces SmartScreen warnings sooner than a standard OV certificate.
2. Import it into the Windows certificate store (or point `signtool` at the `.pfx`).
3. In `src-tauri/tauri.conf.json` under `bundle.windows`, set:
   - `certificateThumbprint` — SHA1 of the cert
   - `digestAlgorithm` — `"sha256"`
   - `timestampUrl` — your provider’s timestamp server, for example `http://timestamp.digicert.com`
4. Install the Windows SDK so `signtool.exe` is on `PATH`, then rebuild with `npm run release:win`.

Tauri’s updater key (`TAURI_SIGNING_PRIVATE_KEY`) is a separate minisign key. It does **not** Authenticode-sign the installer. This app does not enable the updater.

### macOS Developer ID and notarization

1. Enroll in the Apple Developer Program and create a **Developer ID Application** certificate in Keychain Access.
2. Export it as a `.p12` if you want to sign on a clean machine.
3. Before `npm run release:mac`, export:
   - `APPLE_SIGNING_IDENTITY` — for example `Developer ID Application: Your Name (TEAMID)`
   - `APPLE_CERTIFICATE` and `APPLE_CERTIFICATE_PASSWORD` if the certificate is not already in the login keychain
   - For notarization: `APPLE_ID`, `APPLE_PASSWORD` (an app-specific password), and `APPLE_TEAM_ID`
4. Tauri signs the `.app` and staples the notarization ticket onto the `.dmg` when those variables are set. `bundle.macOS.hardenedRuntime` stays at the default `true`.

### Linux

`.deb` and `.AppImage` builds do not need a certificate. If you later host an apt repository, sign the repo metadata with a GPG key. That is separate from the Tauri bundle step.

## Dependency audits

Before a release:

```bash
npm audit
cargo install cargo-audit --locked   # once
cargo audit
```

`npm audit` must be clean, or every remaining advisory must be explained in the release notes. Vitest is a dev dependency only; it is not inside the desktop installer.

`cargo audit` (0.22 or newer; older builds reject CVSS 4.0 advisories in the database) currently reports two warnings and no vulnerabilities. Both come from the Tauri 2 / GTK 0.18 stack, which this app does not depend on directly:

- `glib` 0.18.5, [RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429) — unsound `VariantStrIter` on Linux only. The patched release is `glib` 0.20+, and GTK 0.18 cannot take that major. There is no `0.18.x` patch on crates.io.
- `proc-macro-error` 1.0.4, [RUSTSEC-2024-0370](https://rustsec.org/advisories/RUSTSEC-2024-0370) — unmaintained proc-macro used by `glib-macros` 0.18. Not a known vulnerability. Replacing it means the gtk-rs crates Tauri links have to move.
