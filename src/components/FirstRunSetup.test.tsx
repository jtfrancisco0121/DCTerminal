// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CliDetectResult, LoginStatus, ProviderReport, RoleSummary } from "../bridge";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));

vi.mock("./FolderPicker", () => ({
  FolderPicker: ({ value, onChange }: { value: string; onChange: (path: string) => void }) => (
    <input aria-label="Folder path" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

import { FirstRunSetup } from "./FirstRunSetup";

const roles: RoleSummary[] = [
  { id: "role_planner", name: "Planner", defaultMode: "plan", color: "#a371f7", fieldCount: 3 },
  { id: "role_developer", name: "Developer", defaultMode: "agent", color: "#3fb950", fieldCount: 0 },
];
const found: CliDetectResult = {
  found: true,
  path: "/Users/jt/.local/bin/agent",
  version: "2026.10.01",
  error: null,
};
const missing: CliDetectResult = {
  found: false,
  path: null,
  version: null,
  error: "Cursor CLI (agent) was not found.",
};
const status = (state: string, account: string | null = null): LoginStatus => ({
  state,
  account,
  detail: null,
  apiKeyEnv: false,
});

const claudeDir = {
  path: "/Users/jt/.claude-account2",
  display: "~/.claude-account2",
  source: "setting" as const,
  exists: true,
};
const claudeReport = (
  found: boolean,
  login: LoginStatus,
  configDir = claudeDir,
): ProviderReport => ({
  status: {
    id: "claude",
    found,
    path: found ? "/opt/homebrew/bin/claude" : null,
    version: found ? "2.1.236 (Claude Code)" : null,
    adapterFound: false,
    adapterPath: null,
    error: found ? null : "Claude Code (claude) was not found.",
  },
  login,
  configDir,
  adapterInstall: "npm install -g --omit=optional @agentclientprotocol/claude-agent-acp@0.88.0",
});

function renderSetup(overrides: Partial<Parameters<typeof FirstRunSetup>[0]> = {}) {
  const props = {
    cli: found,
    detect: vi.fn(async () => found),
    loginStatus: vi.fn(async () => status("loggedIn", "cursor@example.com")),
    claudeStatus: vi.fn(async () => claudeReport(true, status("loggedIn", "jt@example.com"))),
    roles,
    initialFolder: "",
    onFinish: vi.fn(),
    onSkip: vi.fn(),
    ...overrides,
  };
  render(<FirstRunSetup {...props} />);
  return props;
}

const next = () => screen.getByRole("button", { name: "Next" }) as HTMLButtonElement;

describe("FirstRunSetup", () => {
  it("passes with Claude only: Cursor missing is optional", async () => {
    const props = renderSetup({
      cli: missing,
      detect: vi.fn(async () => missing),
      loginStatus: vi.fn(async () => status("noCli")),
    });
    const dialog = screen.getByRole("dialog", { name: "Set up DCTerminal" });
    expect(within(dialog).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Claude Code",
      "Cursor CLI",
      "Folder",
      "Role",
    ]);
    // 1. Claude: found, config folder and account shown.
    expect(await screen.findByText("Claude Code found.")).toBeTruthy();
    expect(screen.getByText("~/.claude-account2")).toBeTruthy();
    expect(screen.getByText(/Signed in as jt@example\.com/)).toBeTruthy();
    fireEvent.click(next());

    // 2. Cursor: not found, still optional.
    expect(screen.getByText(/install the Cursor CLI/)).toBeTruthy();
    expect(next().disabled).toBe(false);
    expect(props.loginStatus).not.toHaveBeenCalled();
    fireEvent.click(next());

    // 3. Folder.
    expect(next().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Folder path"), {
      target: { value: "/Users/jt/Koneksi" },
    });
    fireEvent.click(next());

    // 4. Role, then Start.
    const start = screen.getByRole("button", { name: "Start" }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: /Developer/ }));
    fireEvent.click(screen.getByRole("radio", { name: "Terminal" }));
    fireEvent.click(start);
    expect(props.onFinish).toHaveBeenCalledWith({
      roleId: "role_developer",
      folder: "/Users/jt/Koneksi",
      surface: "terminal",
    });
  });

  it("blocks Next when neither Claude nor Cursor is installed, then rechecks", async () => {
    const claudeStatus = vi
      .fn()
      .mockResolvedValueOnce(claudeReport(false, status("noCli")))
      .mockResolvedValueOnce(claudeReport(true, status("loggedIn", "jt@example.com")));
    renderSetup({ cli: missing, claudeStatus });
    expect(await screen.findByText("Claude Code (claude) was not found.")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Install Claude Code/ })).toBeTruthy();
    expect(next().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(await screen.findByText("Claude Code found.")).toBeTruthy();
    expect(next().disabled).toBe(false);
    expect(claudeStatus).toHaveBeenCalledTimes(2);
  });

  it("shows the claude2 login hint when the folder is not signed in", async () => {
    renderSetup({
      claudeStatus: vi.fn(async () => claudeReport(true, status("loggedOut"))),
    });
    expect(
      await screen.findByText(
        /Run CLAUDE_CONFIG_DIR=~\/\.claude-account2 claude \(your claude2\) in a terminal and use \/login/,
      ),
    ).toBeTruthy();
  });

  it("changes the Claude config folder from the Claude step", async () => {
    const saveClaudeFolder = vi.fn(async () => {});
    const claudeStatus = vi
      .fn()
      .mockResolvedValueOnce(
        claudeReport(true, status("loggedIn", "other@example.com"), {
          path: "/Users/jt/.claude",
          display: "~/.claude",
          source: "default" as never,
          exists: true,
        }),
      )
      .mockResolvedValueOnce(claudeReport(true, status("loggedIn", "jt@example.com")));
    renderSetup({ claudeStatus, saveClaudeFolder });
    expect(await screen.findByText(/other@example\.com/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Change folder" }));
    fireEvent.change(screen.getByLabelText("Claude config folder"), {
      target: { value: " ~/.claude-account2 " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Use folder" }));
    expect(await screen.findByText(/jt@example\.com/)).toBeTruthy();
    expect(saveClaudeFolder).toHaveBeenCalledWith("~/.claude-account2");
    expect(screen.getByText("~/.claude-account2")).toBeTruthy();
  });

  it("checks Cursor sign-in on its step, goes back, and skips", async () => {
    const loginStatus = vi
      .fn()
      .mockResolvedValueOnce({ ...status("unknown"), detail: "agent status timed out" })
      .mockResolvedValueOnce({ ...status("loggedOut"), apiKeyEnv: true });
    const props = renderSetup({ loginStatus, initialFolder: "/Users/jt/api" });
    await screen.findByText("Claude Code found.");
    fireEvent.click(next());
    expect(await screen.findByText(/agent status timed out/)).toBeTruthy();
    expect(screen.getByText("/Users/jt/.local/bin/agent")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(await screen.findByText(/CURSOR_API_KEY is set/)).toBeTruthy();
    expect(screen.getByText("agent login")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("Claude Code found.")).toBeTruthy();
    fireEvent.click(next());
    await waitFor(() => screen.getByText(/CURSOR_API_KEY is set/));
    fireEvent.click(next());
    expect((screen.getByLabelText("Folder path") as HTMLInputElement).value).toBe("/Users/jt/api");
    fireEvent.click(screen.getByRole("button", { name: "Skip setup" }));
    expect(props.onSkip).toHaveBeenCalled();
  });
});
