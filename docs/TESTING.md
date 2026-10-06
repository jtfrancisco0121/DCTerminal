# Testing DCTerminal

Unit tests and component tests run without a Cursor login. End-to-end tests drive the built desktop app. There is no GitHub Actions workflow: run these locally.

## Unit and component tests

```bash
npm test
cd src-tauri && cargo test
cargo clippy --all-targets -- -D warnings
```

Component tests use Vitest, React Testing Library, and jsdom. They cover the startup form, the blank-tab card, the tab bar, the folder chooser, Cursor CLI history, the hand-off dialog, and Settings. The Tauri bridge is mocked, so those tests do not start a webview.

## Linux checks that also cover the Windows build

```bash
cargo check --target x86_64-pc-windows-gnu
npm run build
```

The Windows target check needs the `x86_64-pc-windows-gnu` rustup target. It does not replace a run on Windows.

## End-to-end tests

```bash
npm run e2e
```

`npm run e2e` installs the WebdriverIO packages into `e2e/node_modules` (they are not dependencies of the app), builds the frontend and the debug binary when they are missing, serves that frontend on `127.0.0.1:1420`, then starts `tauri-driver`. A debug build loads that address, so the webview is the built UI. Screenshots of failed tests are written to `e2e/artifacts/`.

The app's `npm audit` stays at 0. WebdriverIO currently pulls `extract-zip` and `braces` versions that have no patched release, so those packages live only in the e2e folder.

The runner gives the app its own data directory under `e2e/.tmp` through `DCT_DATA_DIR`
and `DCT_CURSOR_HOME`. It does not override `USERPROFILE` (a fake profile makes
Tauri panic with `unknown path` on Windows) and it does not point Cargo at that
directory. WebView2's user data folder is `e2e/.tmp/webview2`. The first spec
reads Settings → App data and stops the run if that path is not the isolated
directory. A temporary cursor home holds two fixture `meta.json` files so the
history list has one session and one chat. The runner does not write the user's
`~/.cursor`, app data, or repositories.

On Windows, from the repository root in PowerShell, with `tauri-driver` and a
matching `msedgedriver` on `PATH`:

```powershell
npm run check
npm run e2e
```

### Fake agent

By default the app uses `tools/fake-acp-agent` through `DCT_AGENT_PATH`. The fake speaks a small ACP subset and an interactive stub. It does not log in and it does not spend Cursor requests.

```bash
DCT_E2E_LIVE=1 npm run e2e
```

Live mode leaves `DCT_AGENT_PATH` unset, so the app uses the real `agent` on `PATH`. Log in with `agent login` first. Live mode can spend Cursor requests.

`DCT_FAKE_AUTH=deny` makes the fake reject login. `DCT_FAKE_LOAD=fail` makes continue fail. Those are for a manual run of the fake binary; the default end-to-end suite uses a working login and a working continue.

### Install tauri-driver

```bash
cargo install tauri-driver --locked
```

### Windows

Windows is the primary target. Install a Microsoft Edge WebDriver (`msedgedriver`) that matches the installed WebView2 runtime, and put it on `PATH`. WebView2's version is under Settings → Apps → Installed apps, or:

```powershell
(Get-ItemProperty "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}").pv
```

Download the matching driver from https://developer.microsoft.com/microsoft-edge/tools/webdriver/ and run `npm run e2e` from the repository root in PowerShell.

### Linux

Install the WebKitGTK driver that matches the system's webkit2gtk (often the `webkit2gtk-driver` package). `tauri-driver` looks for `WebKitWebDriver` on `PATH`. If it lives somewhere else:

```bash
DCT_E2E_NATIVE_DRIVER=/usr/bin/WebKitWebDriver npm run e2e
```

A display is required. On a machine without one, run the command inside `xvfb-run`.
