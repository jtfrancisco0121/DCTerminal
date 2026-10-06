//! Native folder picker. The path is returned to the form and nothing else
//! is started. Windows uses a hidden PowerShell dialog so the cross-compile
//! target does not need an extra GUI crate.

use std::process::Command;

pub fn pick_folder_blocking() -> Result<Option<String>, String> {
    #[cfg(target_os = "windows")]
    {
        pick_folder_windows()
    }
    #[cfg(target_os = "macos")]
    {
        pick_folder_macos()
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        pick_folder_linux()
    }
}

#[cfg(target_os = "windows")]
fn pick_folder_windows() -> Result<Option<String>, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let script = r#"
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Select a working folder'
$dialog.ShowNewFolderButton = $true
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $dialog.SelectedPath
}
"#;
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-STA", "-Command", script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| format!("folder dialog failed: {e}"))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("folder dialog failed: {err}"));
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        Ok(None)
    } else {
        Ok(Some(path))
    }
}

#[cfg(target_os = "macos")]
fn pick_folder_macos() -> Result<Option<String>, String> {
    let output = Command::new("osascript")
        .args([
            "-e",
            "POSIX path of (choose folder with prompt \"Select a working folder\")",
        ])
        .output()
        .map_err(|e| format!("folder dialog failed: {e}"))?;
    if !output.status.success() {
        return Ok(None);
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        Ok(None)
    } else {
        Ok(Some(path))
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn pick_folder_linux() -> Result<Option<String>, String> {
    if Command::new("zenity").arg("--version").output().is_err() {
        return Err(
            "Folder dialog is unavailable in this environment. Type the path, or install zenity."
                .to_string(),
        );
    }
    let output = Command::new("zenity")
        .args([
            "--file-selection",
            "--directory",
            "--title=Select a working folder",
        ])
        .output()
        .map_err(|e| format!("folder dialog failed: {e}"))?;
    // zenity exits 1 when the user cancels.
    if output.status.code() == Some(1) {
        return Ok(None);
    }
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!("folder dialog failed: {err}"));
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        Ok(None)
    } else {
        Ok(Some(path))
    }
}
