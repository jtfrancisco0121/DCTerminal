// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CliDetectResult, LoginStatus, RoleSummary } from "../bridge";

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

describe("FirstRunSetup", () => {
  it("walks detect → login hint → folder → role → Start", async () => {
    const detect = vi.fn(async () => found);
    const loginStatus = vi
      .fn()
      .mockResolvedValueOnce(status("loggedOut"))
      .mockResolvedValueOnce(status("loggedIn", "jt@example.com"));
    const onFinish = vi.fn();
    render(
      <FirstRunSetup
        cli={missing}
        detect={detect}
        loginStatus={loginStatus}
        roles={roles}
        initialFolder=""
        onFinish={onFinish}
        onSkip={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Set up DCTerminal" });
    expect(dialog.textContent).toContain("Cursor CLI (agent) was not found.");
    expect(screen.getByRole("link", { name: /Install the Cursor CLI/ })).toBeTruthy();
    const next = () => screen.getByRole("button", { name: "Next" }) as HTMLButtonElement;
    expect(next().disabled).toBe(true);

    // 1. Detect: found after installing.
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(await screen.findByText(/2026\.10\.01/)).toBeTruthy();
    expect(screen.getByText("/Users/jt/.local/bin/agent")).toBeTruthy();
    fireEvent.click(next());

    // 2. Login: signed out shows the hint; checking again finds the account.
    expect(await screen.findByText(/Not signed in/)).toBeTruthy();
    expect(screen.getByText("agent login")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(await screen.findByText(/jt@example\.com/)).toBeTruthy();
    expect(loginStatus).toHaveBeenCalledTimes(2);
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
    expect(onFinish).toHaveBeenCalledWith({
      roleId: "role_developer",
      folder: "/Users/jt/Koneksi",
      surface: "terminal",
    });
  });

  it("lets the user go back, continue when sign-in is unclear, and skip", async () => {
    const onSkip = vi.fn();
    render(
      <FirstRunSetup
        cli={found}
        detect={vi.fn(async () => found)}
        loginStatus={vi.fn(async () => ({
          ...status("unknown"),
          detail: "agent status timed out",
        }))}
        roles={roles}
        initialFolder="/Users/jt/api"
        onFinish={vi.fn()}
        onSkip={onSkip}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText(/agent status timed out/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => screen.getByText(/agent status timed out/));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect((screen.getByLabelText("Folder path") as HTMLInputElement).value).toBe("/Users/jt/api");
    fireEvent.click(screen.getByRole("button", { name: "Skip setup" }));
    expect(onSkip).toHaveBeenCalled();
  });

  it("says when an API key is set instead of a browser login", async () => {
    render(
      <FirstRunSetup
        cli={found}
        detect={vi.fn(async () => found)}
        loginStatus={vi.fn(async () => ({ ...status("loggedOut"), apiKeyEnv: true }))}
        roles={roles}
        initialFolder=""
        onFinish={vi.fn()}
        onSkip={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText(/CURSOR_API_KEY is set/)).toBeTruthy();
  });
});
