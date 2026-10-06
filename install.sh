#!/usr/bin/env bash
# Build DCTerminal on this Mac or Linux machine and install it for the current user.
#
# Windows uses install.ps1. npm run install-app picks the right one.
#
# macOS still ships Bash 3.2, so this file avoids Bash 4 features (mapfile,
# associative arrays, ${var,,}). The macOS install path cannot be executed on
# the Linux dev machine; those branches stay small and are covered by the
# pure functions in scripts/install.test.mjs.
#
# There is no code signing and no notarization. This is a local install only.

# The shell options apply when the file is executed. Sourcing (the unit tests)
# is fine: nothing below runs a command that fails at load time.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Tauri productName. The .app, deb filename, and NSIS name use this string.
PRODUCT_NAME="DCTerminal"
# Cargo package name / default-run. The installed executable is this name,
# not the product name. See src-tauri/Cargo.toml.
LINUX_BIN="dcterminal"
# heck::AsKebabCase("DCTerminal") in Tauri's deb control file. "DC" is one
# word and "Terminal" is the next, so the package is dc-terminal, not dcterminal.
DEB_PACKAGE="dc-terminal"
BUNDLE_ID="com.jtfrancisco.dcterminal"
# docs/RELEASE.md: Node 20+ and Rust 1.90+ (Tauri 2.12 refuses older rustc).
MIN_NODE_MAJOR=20
MIN_RUST_VERSION="1.90.0"

SHOW_HELP=0
SKIP_CHECKS=0
UNIVERSAL=0
ASSUME_YES=0
DO_UNINSTALL=0
INSTALLED_APP=""

log() {
  printf '==> %s\n' "$*"
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: ./install.sh [--yes] [--skip-checks] [--universal] [--uninstall]

Build DCTerminal for this Mac or Linux machine and install it locally.
On Windows, run:  powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
Or from either OS:  npm run install-app -- [the same flags]

  --yes           Install missing prerequisites without prompting
  --skip-checks   Skip npm run check (cargo test, clippy, npm test, frontend build)
  --universal     macOS only: universal .app (Apple Silicon and Intel)
  --uninstall     Remove the app. User data is left in place and the path is printed
  -h, --help      Show this help

The build is unsigned. Nothing is notarized or sent to Apple, Microsoft, or a CI runner.
EOF
}

# --- version and flag decisions (unit-tested) --------------------------------

# $1 >= $2 for up to three numeric components. "1.100" beats "1.90".
version_ge() {
  local left="$1"
  local right="$2"
  local IFS=.
  # shellcheck disable=SC2206
  local lparts=( $left )
  # shellcheck disable=SC2206
  local rparts=( $right )
  local i=0
  local ln rn
  while [[ "$i" -lt 3 ]]; do
    ln=0
    rn=0
    if [[ "${#lparts[@]}" -gt "$i" ]]; then
      ln="${lparts[$i]}"
    fi
    if [[ "${#rparts[@]}" -gt "$i" ]]; then
      rn="${rparts[$i]}"
    fi
    ln="${ln%%[!0-9]*}"
    rn="${rn%%[!0-9]*}"
    ln="${ln:-0}"
    rn="${rn:-0}"
    if [[ "$ln" -gt "$rn" ]]; then
      return 0
    fi
    if [[ "$ln" -lt "$rn" ]]; then
      return 1
    fi
    i=$((i + 1))
  done
  return 0
}

node_major() {
  printf '%s\n' "$1" | sed -n 's/^v\{0,1\}\([0-9][0-9]*\).*/\1/p'
}

node_is_supported() {
  local major
  major="$(node_major "$1")"
  [[ -n "$major" ]] && [[ "$major" -ge "$MIN_NODE_MAJOR" ]]
}

rustc_semver() {
  printf '%s\n' "$1" | sed -n 's/^rustc \([0-9][0-9.]*\).*/\1/p'
}

rust_is_supported() {
  local ver
  ver="$(rustc_semver "$1")"
  [[ -n "$ver" ]] && version_ge "$ver" "$MIN_RUST_VERSION"
}

should_run_checks() {
  [[ "$1" == "0" ]]
}

# universal=1 is a macOS fat binary. Other systems cannot build it.
flags_are_supported() {
  local os="$1"
  local universal="$2"
  if [[ "$universal" == "1" && "$os" != "Darwin" ]]; then
    return 1
  fi
  return 0
}

# Second argument is the package manager when os is Linux: apt, dnf, or pacman.
node_fix_message() {
  local os="$1"
  local manager="${2:-}"
  cat <<EOF
Node.js ${MIN_NODE_MAJOR}+ is required, with npm.
  https://nodejs.org/
EOF
  if [[ "$os" == "Darwin" ]]; then
    cat <<'EOF'
Install or upgrade it with Homebrew:
  brew install node
Without Homebrew, use the LTS installer on https://nodejs.org/en/download
EOF
    return 0
  fi
  case "$manager" in
    apt)
      cat <<'EOF'
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
EOF
      ;;
    dnf)
      cat <<'EOF'
  sudo dnf install -y nodejs npm
If that package is older than Node 20, install a current build from https://nodejs.org/en/download
EOF
      ;;
    pacman)
      cat <<'EOF'
  sudo pacman -S --needed nodejs npm
EOF
      ;;
    *)
      printf 'Install Node.js %s+ from https://nodejs.org/en/download\n' "$MIN_NODE_MAJOR"
      ;;
  esac
}

rustup_install_command() {
  printf '%s\n' "curl --proto '=https' --tlsv1.2 https://sh.rustup.rs -sSf | sh -s -- -y --default-toolchain stable"
}

# Printed when rustc is too old. `rustup update stable` refreshes the stable
# channel and does not move a pinned default (this VM's default is 1.83.0).
# The override applies only in this repo, so other projects keep their pin.
rust_toolchain_fix_message() {
  cat <<EOF
rustc is missing or older than ${MIN_RUST_VERSION}.
  rustup update stable
If rustc is still old, the active toolchain is a pin. Use stable in this repo only:
  rustup override set stable
EOF
}

xcode_fix_message() {
  cat <<'EOF'
Xcode Command Line Tools are required to compile DCTerminal on macOS.
Install them with:
  xcode-select --install
A system dialog opens. Finish it, then re-run ./install.sh.
Desktop builds do not need the full Xcode app.
EOF
}

# A missing agent does not fail the install. Sessions need it later.
agent_warning() {
  local os="$1"
  cat <<'EOF'
warning: Cursor CLI 'agent' is not on PATH.
DCTerminal starts `agent acp` for each session. Install the CLI, then run: agent login
EOF
  if [[ "$os" == "Windows" ]]; then
    printf '%s\n' "  irm 'https://cursor.com/install?win32=true' | iex"
  else
    printf '%s\n' "  curl https://cursor.com/install -fsS | bash"
  fi
}

# Tauri's Linux prerequisite list (https://v2.tauri.app/start/prerequisites/),
# plus patchelf, which the AppImage bundler and docs/RELEASE.md require.
# Debian ships the Ayatana indicator library. Fedora and Arch still ship
# libappindicator under the names Tauri documents.
apt_packages() {
  cat <<'EOF'
libwebkit2gtk-4.1-dev
build-essential
curl
wget
file
libxdo-dev
libssl-dev
libayatana-appindicator3-dev
librsvg2-dev
patchelf
pkg-config
EOF
}

dnf_packages() {
  cat <<'EOF'
webkit2gtk4.1-devel
openssl-devel
curl
wget
file
libappindicator-gtk3-devel
librsvg2-devel
libxdo-devel
patchelf
gcc
gcc-c++
make
pkgconf-pkg-config
EOF
}

pacman_packages() {
  cat <<'EOF'
webkit2gtk-4.1
base-devel
curl
wget
file
openssl
appmenu-gtk-module
libappindicator-gtk3
librsvg
xdotool
patchelf
EOF
}

# Args passed to `npm run tauri --`. Host OS only; no cross-compiled installers.
# On a Mac the default is the machine's own arch. --universal opts into the fat binary.
tauri_build_args() {
  local os="$1"
  local universal="$2"
  local manager="$3"
  case "$os" in
    Darwin)
      if [[ "$universal" == "1" ]]; then
        printf '%s\n' "build --bundles app --target universal-apple-darwin"
      else
        printf '%s\n' "build --bundles app"
      fi
      ;;
    Linux)
      # apt can install the .deb. Everyone else gets an AppImage in ~/.local/bin.
      if [[ "$manager" == "apt" ]]; then
        printf '%s\n' "build --bundles deb"
      else
        printf '%s\n' "build --bundles appimage"
      fi
      ;;
    Windows)
      # NSIS currentUser is set in src-tauri/tauri.conf.json. MSI needs WiX, so
      # the local install does not build it.
      printf '%s\n' "build --bundles nsis"
      ;;
    *)
      return 1
      ;;
  esac
}

# applications_writable: yes|no
# existing: absent|writable|readonly  (the copy already in /Applications)
# A readonly bundle (root-owned) cannot be replaced, so we use ~/Applications.
choose_mac_install_dir() {
  local applications_writable="$1"
  local existing="$2"
  local home="$3"
  if [[ "$existing" == "writable" ]]; then
    printf '%s\n' "/Applications/${PRODUCT_NAME}.app"
    return 0
  fi
  if [[ "$existing" == "absent" && "$applications_writable" == "yes" ]]; then
    printf '%s\n' "/Applications/${PRODUCT_NAME}.app"
    return 0
  fi
  printf '%s\n' "${home}/Applications/${PRODUCT_NAME}.app"
}

quarantine_attribute() {
  printf '%s\n' "com.apple.quarantine"
}

mac_quarantine_explanation() {
  cat <<'EOF'
DCTerminal.app is unsigned. This installer does not code-sign or notarize it.
macOS adds the com.apple.quarantine attribute to apps that were downloaded, and
Gatekeeper then refuses to open an unsigned app. Clearing that attribute on this
locally built copy lets you launch it. Sessions and settings are not modified.
EOF
}

mac_app_bundle() {
  if [[ "$1" == "1" ]]; then
    printf '%s\n' "src-tauri/target/universal-apple-darwin/release/bundle/macos/${PRODUCT_NAME}.app"
  else
    printf '%s\n' "src-tauri/target/release/bundle/macos/${PRODUCT_NAME}.app"
  fi
}

deb_package_name() {
  printf '%s\n' "$DEB_PACKAGE"
}

linux_binary_path() {
  printf '%s\n' "/usr/bin/${LINUX_BIN}"
}

deb_artifact_path() {
  printf '%s\n' "src-tauri/target/release/bundle/deb/${PRODUCT_NAME}_${1}_${2}.deb"
}

appimage_artifact_path() {
  printf '%s\n' "src-tauri/target/release/bundle/appimage/${PRODUCT_NAME}_${1}_${2}.AppImage"
}

nsis_artifact_path() {
  printf '%s\n' "src-tauri/target/release/bundle/nsis/${PRODUCT_NAME}_${1}_${2}-setup.exe"
}

debian_arch() {
  case "$1" in
    x86_64|amd64) printf 'amd64\n' ;;
    aarch64|arm64) printf 'arm64\n' ;;
    i686|i386|x86) printf 'i386\n' ;;
    armv7l|armhf) printf 'armhf\n' ;;
    *)
      printf 'unsupported architecture: %s\n' "$1" >&2
      return 1
      ;;
  esac
}

nsis_arch() {
  case "$1" in
    x86_64|amd64|AMD64) printf 'x64\n' ;;
    aarch64|arm64|ARM64) printf 'arm64\n' ;;
    i686|i386|x86) printf 'x86\n' ;;
    *)
      printf 'unsupported architecture: %s\n' "$1" >&2
      return 1
      ;;
  esac
}

# $1 home, or on Windows the APPDATA directory (see the unit test).
# $2 XDG_DATA_HOME on Linux. Empty means ~/.local/share.
app_data_dir() {
  local os="$1"
  local home="$2"
  local xdg="${3:-}"
  case "$os" in
    Darwin)
      printf '%s\n' "${home}/Library/Application Support/${BUNDLE_ID}"
      ;;
    Linux)
      if [[ -n "$xdg" ]]; then
        printf '%s\n' "${xdg}/${BUNDLE_ID}"
      else
        printf '%s\n' "${home}/.local/share/${BUNDLE_ID}"
      fi
      ;;
    Windows)
      printf '%s\\%s\n' "$home" "$BUNDLE_ID"
      ;;
    *)
      return 1
      ;;
  esac
}

data_files_kept() {
  printf '%s\n' "settings.json roles.json forms.json state.json scratch.json handoffs.json logs/"
}

appimage_install_path() {
  printf '%s\n' "$1/.local/bin/${PRODUCT_NAME}.AppImage"
}

desktop_entry_path() {
  printf '%s\n' "$1/.local/share/applications/${PRODUCT_NAME}.desktop"
}

# --yes skips the prompt. A pipe or CI log is not consent: print the command and stop.
confirm() {
  local prompt="$1"
  if [[ "${ASSUME_YES:-0}" == "1" ]]; then
    printf 'Proceeding (--yes): %s\n' "$prompt"
    return 0
  fi
  if [[ ! -t 0 ]]; then
    printf 'Not a terminal, so nothing was installed. Re-run with --yes, or run the command above.\n' >&2
    return 1
  fi
  local reply
  read -r -p "${prompt} [y/N] " reply || true
  [[ "$reply" == "y" || "$reply" == "Y" || "$reply" == "yes" || "$reply" == "YES" ]]
}

pkg_manager() {
  if [[ -n "${DCT_PKG_MANAGER:-}" ]]; then
    printf '%s\n' "$DCT_PKG_MANAGER"
    return 0
  fi
  if command -v apt-get >/dev/null 2>&1; then
    printf 'apt\n'
  elif command -v dnf >/dev/null 2>&1; then
    printf 'dnf\n'
  elif command -v pacman >/dev/null 2>&1; then
    printf 'pacman\n'
  else
    printf 'none\n'
  fi
}

# --- prerequisite installs ---------------------------------------------------

prepend_tool_paths() {
  # Apple Silicon Homebrew lives in /opt/homebrew; Intel Homebrew in /usr/local.
  if [[ "$(uname -s)" == "Darwin" ]]; then
    if [[ -d /opt/homebrew/bin ]]; then
      export PATH="/opt/homebrew/bin:${PATH}"
    fi
    if [[ -d /usr/local/bin ]]; then
      export PATH="/usr/local/bin:${PATH}"
    fi
  fi
  if [[ -f "${HOME}/.cargo/env" ]]; then
    # shellcheck disable=SC1091
    . "${HOME}/.cargo/env"
  fi
  export PATH="${HOME}/.cargo/bin:${PATH}"
}

install_node() {
  local os manager
  os="$(uname -s)"
  manager="$(pkg_manager)"
  case "$os" in
    Darwin)
      if ! command -v brew >/dev/null 2>&1; then
        die "Homebrew is not installed. Install Node.js ${MIN_NODE_MAJOR}+ from https://nodejs.org/en/download and re-run."
      fi
      brew install node
      ;;
    Linux)
      case "$manager" in
        apt)
          curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
          sudo DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
          ;;
        dnf)
          sudo dnf install -y nodejs npm
          ;;
        pacman)
          # Consent was already collected. --noconfirm stops pacman asking again.
          sudo pacman -S --needed --noconfirm nodejs npm
          ;;
        *)
          die "No apt, dnf, or pacman. Install Node.js ${MIN_NODE_MAJOR}+ from https://nodejs.org/en/download"
          ;;
      esac
      ;;
    *)
      die "install.sh supports macOS and Linux. On Windows run install.ps1"
      ;;
  esac
}

ensure_node() {
  local version=""
  if command -v node >/dev/null 2>&1; then
    version="$(node -v 2>/dev/null || true)"
  fi
  if node_is_supported "$version" && command -v npm >/dev/null 2>&1; then
    log "Node ${version}, npm $(npm -v)"
    return 0
  fi
  node_fix_message "$(uname -s)" "$(pkg_manager)"
  if confirm "Install Node.js ${MIN_NODE_MAJOR}+ now?"; then
    install_node
    hash -r
    prepend_tool_paths
  else
    die "Node.js ${MIN_NODE_MAJOR}+ is required."
  fi
  version="$(node -v 2>/dev/null || true)"
  if ! node_is_supported "$version" || ! command -v npm >/dev/null 2>&1; then
    die "Node.js is still missing or older than ${MIN_NODE_MAJOR} after install. Open a new terminal so PATH updates, then re-run."
  fi
  log "Node ${version}, npm $(npm -v)"
}

ensure_rust() {
  prepend_tool_paths
  if ! command -v rustup >/dev/null 2>&1; then
    printf 'Rust must come from rustup. Tauri 2.12 needs rustc %s or newer.\n' "$MIN_RUST_VERSION"
    printf '  %s\n' "$(rustup_install_command)"
    printf 'Then open a new terminal, or source %s/.cargo/env\n' "$HOME"
    if confirm "Install Rust with rustup now?"; then
      curl --proto '=https' --tlsv1.2 https://sh.rustup.rs -sSf | sh -s -- -y --default-toolchain stable
      prepend_tool_paths
    else
      die "Rust via rustup is required."
    fi
  fi
  if ! command -v rustc >/dev/null 2>&1 || ! rust_is_supported "$(rustc --version 2>/dev/null || true)"; then
    rust_toolchain_fix_message
    if confirm "Update the stable Rust toolchain now?"; then
      rustup update stable
      hash -r
      prepend_tool_paths
      if ! rust_is_supported "$(rustc --version 2>/dev/null || true)"; then
        log "Active rustc is still older than ${MIN_RUST_VERSION}; pinning stable in this repo"
        rustup override set stable
        hash -r
      fi
    else
      die "Rust ${MIN_RUST_VERSION}+ is required."
    fi
  fi
  if ! rust_is_supported "$(rustc --version 2>/dev/null || true)"; then
    die "rustc is still older than ${MIN_RUST_VERSION}. Run: rustup update stable && rustup override set stable"
  fi
  # npm run check runs clippy -D warnings. The default rustup profile includes
  # it; a minimal profile does not.
  if ! rustup component list --installed 2>/dev/null | grep -q '^clippy'; then
    log "Installing the clippy component (npm run check uses it)"
    rustup component add clippy
  fi
  log "Rust $(rustc --version)"
}

ensure_xcode_clt() {
  # xcode-select -p prints the developer directory when the tools are installed.
  # The full Xcode app is not required for a desktop build.
  if xcode-select -p >/dev/null 2>&1; then
    log "Xcode Command Line Tools: $(xcode-select -p)"
    return 0
  fi
  xcode_fix_message
  if confirm "Open the Xcode Command Line Tools installer now?"; then
    xcode-select --install || true
    die "Finish the installer dialog, then re-run ./install.sh."
  fi
  die "Xcode Command Line Tools are required."
}

package_installed() {
  local manager="$1"
  local pkg="$2"
  case "$manager" in
    apt)
      dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -q 'install ok installed'
      ;;
    dnf)
      rpm -q "$pkg" >/dev/null 2>&1
      ;;
    pacman)
      # base-devel is a group. -Qg succeeds when its members are installed.
      if [[ "$pkg" == "base-devel" ]]; then
        pacman -Qg base-devel >/dev/null 2>&1
      else
        pacman -Qi "$pkg" >/dev/null 2>&1
      fi
      ;;
    *)
      return 1
      ;;
  esac
}

missing_packages() {
  local manager="$1"
  local lister="$2"
  local pkg
  while IFS= read -r pkg; do
    [[ -z "$pkg" ]] && continue
    if ! package_installed "$manager" "$pkg"; then
      printf '%s\n' "$pkg"
    fi
  done < <("$lister")
}

linux_install_instructions() {
  local manager="$1"
  case "$manager" in
    apt)
      printf 'sudo apt-get update\n'
      printf 'sudo apt-get install -y'
      local pkg
      while IFS= read -r pkg; do
        printf ' %s' "$pkg"
      done < <(apt_packages)
      printf '\n'
      ;;
    dnf)
      printf 'sudo dnf install -y'
      local pkg_dnf
      while IFS= read -r pkg_dnf; do
        printf ' %s' "$pkg_dnf"
      done < <(dnf_packages)
      printf '\n'
      ;;
    pacman)
      # A full system upgrade is not part of installing this app.
      printf 'sudo pacman -S --needed'
      local pkg_pac
      while IFS= read -r pkg_pac; do
        printf ' %s' "$pkg_pac"
      done < <(pacman_packages)
      printf '\n'
      ;;
    *)
      printf 'https://v2.tauri.app/start/prerequisites/\n'
      ;;
  esac
}

run_package_install() {
  local manager="$1"
  local -a packages=()
  local pkg
  case "$manager" in
    apt)
      while IFS= read -r pkg; do
        [[ -z "$pkg" ]] && continue
        packages+=("$pkg")
      done < <(apt_packages)
      # noninteractive so a package question cannot hang a one-command install.
      sudo DEBIAN_FRONTEND=noninteractive apt-get update
      sudo DEBIAN_FRONTEND=noninteractive apt-get install -y "${packages[@]}"
      ;;
    dnf)
      while IFS= read -r pkg; do
        [[ -z "$pkg" ]] && continue
        packages+=("$pkg")
      done < <(dnf_packages)
      sudo dnf install -y "${packages[@]}"
      ;;
    pacman)
      while IFS= read -r pkg; do
        [[ -z "$pkg" ]] && continue
        packages+=("$pkg")
      done < <(pacman_packages)
      sudo pacman -S --needed --noconfirm "${packages[@]}"
      ;;
    *)
      die "No supported package manager."
      ;;
  esac
}

ensure_linux_packages() {
  local manager
  manager="$(pkg_manager)"
  if [[ "$manager" == "none" ]]; then
    if command -v pkg-config >/dev/null 2>&1 && pkg-config --exists webkit2gtk-4.1; then
      log "webkit2gtk-4.1 is visible to pkg-config; no apt/dnf/pacman install"
      return 0
    fi
    printf 'No apt, dnf, or pacman was found.\n'
    printf 'Install the Tauri Linux dependencies from:\n  https://v2.tauri.app/start/prerequisites/\n'
    die "Linux build dependencies are missing."
  fi
  local lister="apt_packages"
  case "$manager" in
    dnf) lister="dnf_packages" ;;
    pacman) lister="pacman_packages" ;;
  esac
  local missing
  missing="$(missing_packages "$manager" "$lister")"
  if [[ -z "$missing" ]]; then
    log "Linux build dependencies are already installed (${manager})"
    return 0
  fi
  printf 'Missing %s packages:\n%s\n\n' "$manager" "$missing"
  linux_install_instructions "$manager"
  if confirm "Install the missing Linux packages now?"; then
    run_package_install "$manager"
  else
    die "Linux build dependencies are required."
  fi
}

warn_if_agent_missing() {
  if command -v agent >/dev/null 2>&1; then
    log "Cursor CLI: $(command -v agent)"
    return 0
  fi
  # Warning only. --yes does not pipe the Cursor installer.
  agent_warning "$(uname -s)"
  # Backticks are instructions for the user, not a command substitution.
  # shellcheck disable=SC2016
  printf 'The app will still be installed. Run `agent login` before starting a session.\n'
}

ensure_prereqs() {
  prepend_tool_paths
  ensure_node
  ensure_rust
  case "$(uname -s)" in
    Darwin) ensure_xcode_clt ;;
    Linux) ensure_linux_packages ;;
  esac
  warn_if_agent_missing
}

# --- build and install -------------------------------------------------------

app_version() {
  node -e 'const fs=require("node:fs"); const j=JSON.parse(fs.readFileSync("src-tauri/tauri.conf.json","utf8")); if(!j.version) process.exit(1); process.stdout.write(String(j.version));'
}

app_data_dir_host() {
  local os
  os="$(uname -s)"
  if [[ "$os" == "Linux" ]]; then
    app_data_dir Linux "$HOME" "${XDG_DATA_HOME:-}"
  else
    app_data_dir "$os" "$HOME" ""
  fi
}

run_host_build() {
  local os manager
  os="$(uname -s)"
  manager="$(pkg_manager)"
  local -a args=()
  case "$os" in
    Darwin)
      if [[ "$UNIVERSAL" == "1" ]]; then
        # Both targets have to be present before Tauri can lipo them together.
        log "Adding Rust targets aarch64-apple-darwin and x86_64-apple-darwin"
        rustup target add aarch64-apple-darwin x86_64-apple-darwin
        args=(build --bundles app --target universal-apple-darwin)
      else
        # Host arch only. Apple Silicon stays arm64; an Intel Mac stays x86_64.
        args=(build --bundles app)
      fi
      ;;
    Linux)
      if [[ "$manager" == "apt" ]]; then
        args=(build --bundles deb)
      else
        args=(build --bundles appimage)
      fi
      ;;
    *)
      die "install.sh supports macOS and Linux. On Windows run install.ps1"
      ;;
  esac
  log "npm run tauri -- ${args[*]}"
  npm run tauri -- "${args[@]}"
}

resolve_mac_destination() {
  local writable="no"
  local existing="absent"
  local app="/Applications/${PRODUCT_NAME}.app"
  if [[ -w /Applications ]]; then
    writable="yes"
  fi
  if [[ -e "$app" ]]; then
    if [[ -w "$app" ]]; then
      existing="writable"
    else
      existing="readonly"
    fi
  fi
  choose_mac_install_dir "$writable" "$existing" "$HOME"
}

clear_macos_quarantine() {
  local app="$1"
  mac_quarantine_explanation
  # Do not codesign. xattr returns non-zero when the attribute is already
  # absent, which is normal for a bundle that cargo just wrote.
  xattr -dr "$(quarantine_attribute)" "$app" || true
}

install_built_macos_app() {
  local src dest
  src="${ROOT}/$(mac_app_bundle "$UNIVERSAL")"
  if [[ ! -d "$src" ]]; then
    die "App bundle was not produced at ${src}"
  fi
  dest="$(resolve_mac_destination)"
  mkdir -p "$(dirname "$dest")"
  if command -v osascript >/dev/null 2>&1; then
    # The running app locks files inside the bundle. Quit by product name so
    # the replacement below can succeed. User data is not inside the .app.
    osascript -e "quit app \"${PRODUCT_NAME}\"" >/dev/null 2>&1 || true
  fi
  if [[ -d "$dest" ]]; then
    log "Replacing ${dest}"
    rm -rf "$dest"
  fi
  # ditto keeps the symlinks inside Contents/MacOS. cp -R on macOS can break them.
  log "Copying ${src} to ${dest}"
  ditto "$src" "$dest"
  clear_macos_quarantine "$dest"
  INSTALLED_APP="$dest"
}

install_built_deb() {
  local version arch deb
  version="$(app_version)"
  arch="$(debian_arch "$(uname -m)")"
  deb="${ROOT}/$(deb_artifact_path "$version" "$arch")"
  if [[ ! -f "$deb" ]]; then
    die "deb was not produced at ${deb}"
  fi
  # The filename uses the product name. The control Package field is kebab-case.
  local actual_package
  actual_package="$(dpkg-deb -f "$deb" Package)"
  if [[ "$actual_package" != "$(deb_package_name)" ]]; then
    die "deb Package field is '${actual_package}', expected '$(deb_package_name)'."
  fi
  # dpkg -i upgrades a package that is already installed (same or newer version).
  log "Installing ${deb} (package $(deb_package_name))"
  if ! sudo dpkg -i "$deb"; then
    log "dpkg reported a dependency problem; running apt-get install -f"
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -f -y
  fi
  if ! dpkg -s "$(deb_package_name)" >/dev/null 2>&1; then
    die "Package $(deb_package_name) is not installed."
  fi
}

install_built_appimage() {
  local version arch src dest desktop icon
  version="$(app_version)"
  arch="$(debian_arch "$(uname -m)")"
  src="${ROOT}/$(appimage_artifact_path "$version" "$arch")"
  if [[ ! -f "$src" ]]; then
    die "AppImage was not produced at ${src}"
  fi
  dest="$(appimage_install_path "$HOME")"
  desktop="$(desktop_entry_path "$HOME")"
  icon="${HOME}/.local/share/icons/hicolor/128x128/apps/${LINUX_BIN}.png"
  mkdir -p "$(dirname "$dest")" "$(dirname "$desktop")" "$(dirname "$icon")"
  chmod +x "$src"
  cp -f "$src" "$dest"
  chmod +x "$dest"
  cp -f "${ROOT}/src-tauri/icons/128x128.png" "$icon"
  cat >"$desktop" <<EOF
[Desktop Entry]
Type=Application
Name=${PRODUCT_NAME}
Comment=Role-aware multi-tab UI for the Cursor CLI
Exec=${dest}
Icon=${LINUX_BIN}
Terminal=false
Categories=Development;
StartupWMClass=${PRODUCT_NAME}
EOF
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "${HOME}/.local/share/applications" >/dev/null 2>&1 || true
  fi
  INSTALLED_APP="$dest"
}

print_installed() {
  local data
  data="$(app_data_dir_host)"
  printf '\nDCTerminal is installed.\n\n'
  case "$(uname -s)" in
    Darwin)
      printf '  App:    %s\n' "$INSTALLED_APP"
      printf '  Launch: open "%s"\n' "$INSTALLED_APP"
      printf '          open -a %s\n' "$PRODUCT_NAME"
      ;;
    Linux)
      if [[ "$(pkg_manager)" == "apt" ]]; then
        printf '  App:    %s\n' "$(linux_binary_path)"
        printf '  Menu:   %s\n' "$PRODUCT_NAME"
        printf '  Launch: %s\n' "$LINUX_BIN"
      else
        printf '  App:    %s\n' "$(appimage_install_path "$HOME")"
        printf '  Menu:   %s\n' "$(desktop_entry_path "$HOME")"
        printf '  Launch: %s\n' "$(appimage_install_path "$HOME")"
        case ":${PATH}:" in
          *":${HOME}/.local/bin:"*) ;;
          *)
            printf '\n  ~/.local/bin is not on PATH. Add this to your shell profile:\n'
            # shellcheck disable=SC2016
            printf '    export PATH="$HOME/.local/bin:$PATH"\n'
            ;;
        esac
        printf '\n  If the AppImage says it needs FUSE, install libfuse2 (Debian/Ubuntu: libfuse2t64).\n'
      fi
      ;;
  esac
  printf '\n  Data:   %s\n' "$data"
  printf '          Created on first launch. Uninstall leaves it in place.\n'
  printf '          Files: %s\n\n' "$(data_files_kept)"
}

print_data_kept() {
  local dir
  dir="$(app_data_dir_host)"
  cat <<EOF

User data was kept. Uninstall does not remove roles, tabs, transcripts, or settings.
  ${dir}
  Files: $(data_files_kept)
EOF
}

uninstall_macos() {
  local path removed=0
  for path in "/Applications/${PRODUCT_NAME}.app" "${HOME}/Applications/${PRODUCT_NAME}.app"; do
    if [[ -d "$path" ]]; then
      rm -rf "$path"
      log "Removed ${path}"
      removed=1
    fi
  done
  if [[ "$removed" == "0" ]]; then
    log "${PRODUCT_NAME}.app is not in /Applications or ${HOME}/Applications"
  fi
}

uninstall_linux() {
  local pkg img desktop icon
  pkg="$(deb_package_name)"
  if command -v dpkg >/dev/null 2>&1 && dpkg -s "$pkg" >/dev/null 2>&1; then
    # -r removes the package. It does not purge, and the home data dir is not
    # owned by the package, so roles and transcripts stay.
    log "Removing ${pkg}"
    sudo dpkg -r "$pkg"
  else
    log "Debian package ${pkg} is not installed"
  fi
  img="$(appimage_install_path "$HOME")"
  desktop="$(desktop_entry_path "$HOME")"
  icon="${HOME}/.local/share/icons/hicolor/128x128/apps/${LINUX_BIN}.png"
  if [[ -f "$img" ]]; then
    rm -f "$img"
    log "Removed ${img}"
  fi
  if [[ -f "$desktop" ]]; then
    rm -f "$desktop"
    log "Removed ${desktop}"
  fi
  if [[ -f "$icon" ]]; then
    rm -f "$icon"
  fi
}

cmd_uninstall() {
  case "$(uname -s)" in
    Darwin) uninstall_macos ;;
    Linux) uninstall_linux ;;
    *) die "On Windows run: powershell -NoProfile -ExecutionPolicy Bypass -File .\\install.ps1 --uninstall" ;;
  esac
  print_data_kept
}

parse_args() {
  SHOW_HELP=0
  SKIP_CHECKS=0
  UNIVERSAL=0
  ASSUME_YES=0
  DO_UNINSTALL=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      -h|--help) SHOW_HELP=1 ;;
      --skip-checks) SKIP_CHECKS=1 ;;
      --universal) UNIVERSAL=1 ;;
      --yes|-y) ASSUME_YES=1 ;;
      --uninstall) DO_UNINSTALL=1 ;;
      *)
        printf 'error: unknown argument: %s\n' "$1" >&2
        usage >&2
        exit 1
        ;;
    esac
    shift
  done
}

main() {
  parse_args "$@"
  if [[ "$SHOW_HELP" == "1" ]]; then
    usage
    return 0
  fi
  local os
  os="$(uname -s)"
  if ! flags_are_supported "$os" "$UNIVERSAL"; then
    die "--universal builds a universal macOS app (Apple Silicon and Intel). It only works on macOS."
  fi
  if [[ "$os" != "Darwin" && "$os" != "Linux" ]]; then
    die "install.sh supports macOS and Linux. On Windows run install.ps1"
  fi
  cd "$ROOT" || die "Cannot cd to ${ROOT}"
  if [[ "$DO_UNINSTALL" == "1" ]]; then
    cmd_uninstall
    return 0
  fi
  ensure_prereqs
  log "npm ci"
  npm ci
  if should_run_checks "$SKIP_CHECKS"; then
    log "npm run check"
    npm run check
  else
    log "Skipping npm run check (--skip-checks)"
  fi
  run_host_build
  case "$os" in
    Darwin) install_built_macos_app ;;
    Linux)
      if [[ "$(pkg_manager)" == "apt" ]]; then
        install_built_deb
      else
        install_built_appimage
      fi
      ;;
  esac
  print_installed
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
