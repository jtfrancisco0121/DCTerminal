// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoginStatus, ProviderReport, ProviderSettingsView, ProvidersSettings } from "../bridge";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("../bridge", () => ({
  getProviderSettings: vi.fn(),
  setProviderSettings: vi.fn(),
  providerStatus: vi.fn(),
}));

import { open } from "@tauri-apps/plugin-dialog";
import { getProviderSettings, providerStatus, setProviderSettings } from "../bridge";
import { useProviders } from "../provider/useProviders";
import { ProvidersSettingsSection } from "./ProvidersSettings";

const dirInfo = (path: string, source: "env" | "setting" | "default", exists = true) => ({
  path,
  display: path.replace("/Users/jt", "~"),
  source,
  exists,
});

let saved: ProvidersSettings;
let envValue: string | null;
let claudeLogin: LoginStatus;

const viewFor = (settings: ProvidersSettings): ProviderSettingsView => {
  const dir = envValue
    ? dirInfo(envValue, "env")
    : settings.claude.configDir
      ? dirInfo(settings.claude.configDir.replace("~", "/Users/jt"), "setting")
      : dirInfo("/Users/jt/.claude", "default");
  return { settings, claudeConfigDir: dir, claudeConfigDirEnv: envValue };
};

const report = (id: "claude" | "cursor"): ProviderReport => ({
  status: {
    id,
    found: true,
    path: id === "claude" ? "/opt/homebrew/bin/claude" : "/Users/jt/.local/bin/agent",
    version: id === "claude" ? "2.1.236 (Claude Code)" : "2026.10.01",
    adapterFound: false,
    adapterPath: null,
    error: null,
  },
  login: id === "claude" ? claudeLogin : { state: "loggedIn", account: null, detail: null, apiKeyEnv: false },
  configDir: id === "claude" ? viewFor(saved).claudeConfigDir : null,
  adapterInstall:
    id === "claude"
      ? "npm install -g --omit=optional @agentclientprotocol/claude-agent-acp@0.88.0"
      : null,
});

function Harness() {
  const providers = useProviders();
  return <ProvidersSettingsSection providers={providers} />;
}

beforeEach(() => {
  saved = { default: "claude", roleProvider: {}, claude: {}, cursor: {} };
  envValue = null;
  claudeLogin = {
    state: "loggedIn",
    account: "jt@example.com",
    detail: null,
    apiKeyEnv: false,
    method: "claude.ai · team",
  };
  vi.mocked(getProviderSettings).mockImplementation(async () => viewFor(saved));
  vi.mocked(setProviderSettings).mockImplementation(async (next) => {
    saved = next;
    return viewFor(saved);
  });
  vi.mocked(providerStatus).mockImplementation(async (id) => report(id));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Settings > Providers", () => {
  it("shows detection, the adapter hint, the folder source, and the account", async () => {
    render(<Harness />);
    const section = await screen.findByRole("region", { name: "Providers" });
    expect(await within(section).findByText(/2\.1\.236/)).toBeTruthy();
    expect(within(section).getByText("/opt/homebrew/bin/claude")).toBeTruthy();
    expect(
      within(section).getByText(
        "npm install -g --omit=optional @agentclientprotocol/claude-agent-acp@0.88.0",
      ),
    ).toBeTruthy();
    expect(within(section).getByTestId("claude-config-source").textContent).toContain(
      "default (~/.claude)",
    );
    expect(
      (within(section).getByLabelText("Claude config folder") as HTMLInputElement).placeholder,
    ).toBe("~/.claude");
    expect(within(section).getByText(/Signed in as jt@example\.com \(claude\.ai · team\)/)).toBeTruthy();
    expect(within(section).getByText("All tabs run with full permissions.")).toBeTruthy();
  });

  it("persists the default provider", async () => {
    render(<Harness />);
    const group = await screen.findByRole("radiogroup", { name: "Default provider" });
    expect(within(group).getByRole("radio", { name: "Claude" }).getAttribute("aria-checked")).toBe(
      "true",
    );
    fireEvent.click(within(group).getByRole("radio", { name: "Cursor" }));
    await waitFor(() =>
      expect(setProviderSettings).toHaveBeenCalledWith(
        expect.objectContaining({ default: "cursor" }),
      ),
    );
    await waitFor(() =>
      expect(within(group).getByRole("radio", { name: "Cursor" }).getAttribute("aria-checked")).toBe(
        "true",
      ),
    );
  });

  it("saves configDir and rechecks the account for that folder", async () => {
    render(<Harness />);
    const input = (await screen.findByLabelText("Claude config folder")) as HTMLInputElement;
    await screen.findByText(/Signed in as jt@/);
    fireEvent.change(input, { target: { value: "~/.claude-account2" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(setProviderSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          claude: expect.objectContaining({ configDir: "~/.claude-account2" }),
        }),
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId("claude-config-source").textContent).toContain(
        "~/.claude-account2 (from Settings)",
      ),
    );
    // Claude status was asked again for the new folder.
    expect(vi.mocked(providerStatus).mock.calls.filter(([id]) => id === "claude").length).toBe(2);
  });

  it("browses for the folder", async () => {
    vi.mocked(open).mockResolvedValue("/Users/jt/.claude-account2");
    render(<Harness />);
    await screen.findByText(/Signed in as jt@/);
    fireEvent.click(screen.getByRole("button", { name: "Browse…" }));
    await waitFor(() =>
      expect(setProviderSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          claude: expect.objectContaining({ configDir: "/Users/jt/.claude-account2" }),
        }),
      ),
    );
  });

  it("shows the env override read-only", async () => {
    envValue = "/Users/jt/.claude-account2";
    render(<Harness />);
    const input = (await screen.findByLabelText("Claude config folder")) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("/Users/jt/.claude-account2"));
    expect(input.readOnly).toBe(true);
    expect((screen.getByRole("button", { name: "Browse…" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByTestId("claude-config-source").textContent).toContain(
      "set by DCT_CLAUDE_CONFIG_DIR",
    );
  });

  it("says folder not found and does not claim a sign-in", async () => {
    saved = { ...saved, claude: { configDir: "~/.claude-missing" } };
    vi.mocked(getProviderSettings).mockImplementation(async () => ({
      ...viewFor(saved),
      claudeConfigDir: dirInfo("/Users/jt/.claude-missing", "setting", false),
    }));
    claudeLogin = { state: "noConfigDir", account: null, detail: null, apiKeyEnv: false };
    render(<Harness />);
    expect(await screen.findByText("Folder not found: /Users/jt/.claude-missing")).toBeTruthy();
    expect(await screen.findByText(/config folder does not exist/)).toBeTruthy();
  });

  it("shows the claude2 login hint when the folder is not signed in", async () => {
    saved = { ...saved, claude: { configDir: "~/.claude-account2" } };
    claudeLogin = { state: "loggedOut", account: null, detail: null, apiKeyEnv: false };
    render(<Harness />);
    expect(await screen.findByText(/Not signed in/)).toBeTruthy();
    expect(
      screen.getByText(
        /Run CLAUDE_CONFIG_DIR=~\/\.claude-account2 claude \(your claude2\) in a terminal and use \/login/,
      ),
    ).toBeTruthy();
  });
});
