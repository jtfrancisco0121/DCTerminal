import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function installShSkipReason(probe) {
  if (probe?.ok) {
    return "";
  }
  const detail = probe?.detail || "bash -c 'echo ok' failed";
  return (
    "skipped: bash is not a working POSIX shell " +
    `(${detail}). install.sh tests need POSIX bash. ` +
    "On Windows, bash.exe is the WSL stub and fails when no distro is installed."
  );
}

function bashProbeDetail(error) {
  if (error?.code === "ENOENT") {
    return "bash was not found on PATH";
  }
  const stderr = error?.stderr?.toString?.() ?? "";
  const stdout = error?.stdout?.toString?.() ?? "";
  const line = `${stderr}\n${stdout}`
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find(Boolean);
  if (!line) {
    return "bash -c 'echo ok' failed";
  }
  return line.length > 180 ? `${line.slice(0, 177)}...` : line;
}

function probePosixBash() {
  try {
    const stdout = execFileSync("bash", ["-c", "echo ok"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
      windowsHide: true,
    });
    if (stdout.trim() === "ok") {
      return { ok: true, detail: "" };
    }
    return {
      ok: false,
      detail: `bash -c 'echo ok' printed ${JSON.stringify(stdout.trim())}`,
    };
  } catch (error) {
    return { ok: false, detail: bashProbeDetail(error) };
  }
}

const bashProbe = probePosixBash();
const bashSkipReason = installShSkipReason(bashProbe);

function bash(body) {
  return execFileSync("bash", ["-c", body], {
    cwd: root,
    encoding: "utf8",
  });
}

function bashResult(body) {
  try {
    const stdout = execFileSync("bash", ["-c", body], {
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

const source = "source ./install.sh";

describe("install.sh bash probe", () => {
  it("skips with a WSL-stub reason when bash cannot run", () => {
    const reason = installShSkipReason({
      ok: false,
      detail: "execvpe(/bin/bash) failed: No such file or directory",
    });
    expect(reason).toContain("not a working POSIX shell");
    expect(reason).toContain("WSL stub");
    expect(reason).toContain("execvpe(/bin/bash)");
    expect(installShSkipReason({ ok: true })).toBe("");
    expect(installShSkipReason({})).toContain("bash -c 'echo ok' failed");
  });
});

describe.skipIf(!bashProbe.ok)(
  bashSkipReason ? `install.sh decisions — ${bashSkipReason}` : "install.sh decisions",
  () => {
  it("does not start an install when the file is sourced", () => {
    const output = bash(`set -euo pipefail
${source}
printf 'sourced\\n'`);
    expect(output).toBe("sourced\n");
  });

  it("accepts Node 20 and newer and rejects older or empty versions", () => {
    const output = bash(`${source}
node_is_supported "v20.0.0" && printf '20\\n'
node_is_supported "v22.14.0" && printf '22\\n'
if node_is_supported "v19.9.9"; then printf '19\\n'; fi
if node_is_supported ""; then printf 'empty\\n'; fi
if node_is_supported "not-a-version"; then printf 'bad\\n'; fi`);
    expect(output).toBe("20\n22\n");
  });

  it("accepts Rust 1.90 and newer and rejects 1.89", () => {
    const output = bash(`${source}
rust_is_supported "rustc 1.90.0 (abc 2025-01-01)" && printf '190\\n'
rust_is_supported "rustc 1.91.0 (abc 2025-01-01)" && printf '191\\n'
rust_is_supported "rustc 1.100.0 (abc 2025-01-01)" && printf '1100\\n'
if rust_is_supported "rustc 1.89.0 (abc 2024-01-01)"; then printf '189\\n'; fi
if rust_is_supported "rustc 1.83.0 (abc 2024-11-26)"; then printf '183\\n'; fi
if rust_is_supported ""; then printf 'empty\\n'; fi`);
    expect(output).toBe("190\n191\n1100\n");
  });

  it("prints the Node install command for each platform", () => {
    const output = bash(`${source}
node_fix_message Darwin
printf '\\n---\\n'
node_fix_message Linux apt
printf '\\n---\\n'
node_fix_message Linux dnf
printf '\\n---\\n'
node_fix_message Linux pacman`);
    expect(output).toContain("https://nodejs.org/");
    expect(output).toContain("brew install node");
    expect(output).toContain("https://deb.nodesource.com/setup_22.x");
    expect(output).toContain("sudo apt-get install -y nodejs");
    expect(output).toContain("sudo dnf install -y nodejs");
    expect(output).toContain("sudo pacman -S --needed nodejs npm");
  });

  it("prints the rustup install command", () => {
    const output = bash(`${source}
rustup_install_command`);
    expect(output.trim()).toBe(
      "curl --proto '=https' --tlsv1.2 https://sh.rustup.rs -sSf | sh -s -- -y --default-toolchain stable",
    );
  });

  it("uses a repo-local stable override when the default toolchain is pinned old", () => {
    const output = bash(`${source}
rust_toolchain_fix_message`);
    expect(output).toContain("rustup update stable");
    expect(output).toContain("rustup override set stable");
  });

  it("lists the Tauri Linux packages for apt, dnf, and pacman", () => {
    const output = bash(`${source}
printf 'APT\\n'
apt_packages
printf 'DNF\\n'
dnf_packages
printf 'PACMAN\\n'
pacman_packages`);
    expect(output).toContain("libwebkit2gtk-4.1-dev");
    expect(output).toContain("libayatana-appindicator3-dev");
    expect(output).toContain("patchelf");
    expect(output).toContain("webkit2gtk4.1-devel");
    expect(output).toContain("libappindicator-gtk3-devel");
    expect(output).toContain("webkit2gtk-4.1");
    expect(output).toContain("libappindicator-gtk3");
    expect(output).not.toContain("xcode-select --install");
  });

  it("tells macOS to install the Xcode Command Line Tools", () => {
    const output = bash(`${source}
xcode_fix_message`);
    expect(output).toContain("xcode-select --install");
  });

  it("warns about a missing Cursor CLI without treating it as a failed install", () => {
    const output = bash(`${source}
agent_warning Darwin
printf '\\n---\\n'
agent_warning Windows`);
    expect(output).toContain("curl https://cursor.com/install -fsS | bash");
    expect(output).toContain("agent login");
    expect(output).toContain("irm 'https://cursor.com/install?win32=true' | iex");
    expect(output.toLowerCase()).toContain("warning");
  });

  it("builds a host .app on macOS and a universal binary only with the flag", () => {
    const output = bash(`${source}
tauri_build_args Darwin 0 apt
tauri_build_args Darwin 1 apt
mac_app_bundle 0
mac_app_bundle 1`);
    const lines = output.trim().split("\n");
    expect(lines[0]).toBe("build --bundles app");
    expect(lines[1]).toBe("build --bundles app --target universal-apple-darwin");
    expect(lines[2]).toBe("src-tauri/target/release/bundle/macos/DCTerminal.app");
    expect(lines[3]).toBe(
      "src-tauri/target/universal-apple-darwin/release/bundle/macos/DCTerminal.app",
    );
  });

  it("builds a deb when apt is present and an AppImage otherwise", () => {
    const output = bash(`${source}
tauri_build_args Linux 0 apt
tauri_build_args Linux 0 dnf
tauri_build_args Linux 0 pacman
tauri_build_args Linux 0 none`);
    const lines = output.trim().split("\n");
    expect(lines[0]).toBe("build --bundles deb");
    expect(lines[1]).toBe("build --bundles appimage");
    expect(lines[2]).toBe("build --bundles appimage");
    expect(lines[3]).toBe("build --bundles appimage");
  });

  it("builds only the per-user NSIS installer on Windows", () => {
    const output = bash(`${source}
tauri_build_args Windows 0 none`);
    expect(output.trim()).toBe("build --bundles nsis");
  });

  it("rejects a universal build off macOS", () => {
    const result = bashResult(`${source}
if flags_are_supported Linux 1; then exit 0; fi
exit 3`);
    expect(result.status).toBe(3);
    const ok = bash(`${source}
flags_are_supported Darwin 1 && printf 'mac\\n'
flags_are_supported Linux 0 && printf 'linux\\n'`);
    expect(ok).toBe("mac\nlinux\n");
  });

  it("installs the Mac app in /Applications when that directory is writable", () => {
    const output = bash(`${source}
choose_mac_install_dir yes absent /Users/jt
choose_mac_install_dir yes writable /Users/jt
choose_mac_install_dir no absent /Users/jt
choose_mac_install_dir yes readonly /Users/jt`);
    const lines = output.trim().split("\n");
    expect(lines[0]).toBe("/Applications/DCTerminal.app");
    expect(lines[1]).toBe("/Applications/DCTerminal.app");
    expect(lines[2]).toBe("/Users/jt/Applications/DCTerminal.app");
    expect(lines[3]).toBe("/Users/jt/Applications/DCTerminal.app");
  });

  it("names the quarantine attribute and explains why it is cleared", () => {
    const output = bash(`${source}
printf '%s\\n' "$(quarantine_attribute)"
mac_quarantine_explanation`);
    expect(output).toContain("com.apple.quarantine");
    expect(output.toLowerCase()).toContain("unsigned");
    expect(output.toLowerCase()).toContain("notar");
  });

  it("names the deb package, binary, and artifact path", () => {
    const output = bash(`${source}
printf '%s\\n' "$(deb_package_name)"
printf '%s\\n' "$(linux_binary_path)"
printf '%s\\n' "$(deb_artifact_path 0.1.0 amd64)"
printf '%s\\n' "$(appimage_artifact_path 0.1.0 amd64)"
printf '%s\\n' "$(nsis_artifact_path 0.1.0 x64)"
debian_arch x86_64
debian_arch aarch64
nsis_arch x86_64
nsis_arch aarch64`);
    const lines = output.trim().split("\n");
    expect(lines[0]).toBe("dc-terminal");
    expect(lines[1]).toBe("/usr/bin/dcterminal");
    expect(lines[2]).toBe("src-tauri/target/release/bundle/deb/DCTerminal_0.1.0_amd64.deb");
    expect(lines[3]).toBe(
      "src-tauri/target/release/bundle/appimage/DCTerminal_0.1.0_amd64.AppImage",
    );
    expect(lines[4]).toBe("src-tauri/target/release/bundle/nsis/DCTerminal_0.1.0_x64-setup.exe");
    expect(lines[5]).toBe("amd64");
    expect(lines[6]).toBe("arm64");
    expect(lines[7]).toBe("x64");
    expect(lines[8]).toBe("arm64");
  });

  it("names the app data directory and the files uninstall keeps", () => {
    const output = bash(`${source}
app_data_dir Darwin /Users/jt ""
printf '\\n'
app_data_dir Linux /home/jt ""
printf '\\n'
app_data_dir Linux /home/jt /home/jt/custom-data
printf '\\n'
app_data_dir Windows 'C:\\Users\\jt\\AppData\\Roaming' ""
printf '\\n'
data_files_kept`);
    expect(output).toContain("/Users/jt/Library/Application Support/com.jtfrancisco.dcterminal");
    expect(output).toContain("/home/jt/.local/share/com.jtfrancisco.dcterminal");
    expect(output).toContain("/home/jt/custom-data/com.jtfrancisco.dcterminal");
    expect(output).toContain("C:\\Users\\jt\\AppData\\Roaming\\com.jtfrancisco.dcterminal");
    for (const file of [
      "settings.json",
      "roles.json",
      "forms.json",
      "state.json",
      "scratch.json",
      "handoffs.json",
    ]) {
      expect(output).toContain(file);
    }
  });

  it("places the AppImage and desktop entry under the home directory", () => {
    const output = bash(`${source}
appimage_install_path /home/jt
desktop_entry_path /home/jt`);
    expect(output.trim()).toBe(
      "/home/jt/.local/bin/DCTerminal.AppImage\n/home/jt/.local/share/applications/DCTerminal.desktop",
    );
  });

  it("runs checks unless --skip-checks is set", () => {
    const output = bash(`${source}
if should_run_checks 0; then printf 'run\\n'; fi
if should_run_checks 1; then printf 'skip\\n'; fi`);
    expect(output).toBe("run\n");
  });

  it("treats --yes as consent and refuses to install packages when stdin is not a terminal", () => {
    const yes = bash(`${source}
ASSUME_YES=1
if confirm "Install packages"; then printf 'yes\\n'; fi`);
    expect(yes).toContain("yes");
    const blocked = bashResult(`${source}
ASSUME_YES=0
if confirm "Install packages"; then printf 'allowed\\n'; exit 0; fi
printf 'blocked\\n'`);
    expect(blocked.status).toBe(0);
    expect(blocked.stdout).toContain("blocked");
    expect(blocked.stdout).not.toContain("allowed");
  });

  it("prints help and rejects an unknown flag before doing any work", () => {
    const help = bash("./install.sh --help");
    expect(help).toContain("--skip-checks");
    expect(help).toContain("--universal");
    expect(help).toContain("--uninstall");
    expect(help).toContain("--yes");
    const unknown = bashResult("./install.sh --not-a-flag");
    expect(unknown.status).not.toBe(0);
    const universal = bashResult("./install.sh --universal");
    expect(universal.status).not.toBe(0);
    expect(`${universal.stdout}\n${universal.stderr}`.toLowerCase()).toContain("macos");
  });
});
