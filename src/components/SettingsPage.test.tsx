// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../bridge", () => ({
  getRole: vi.fn(async (id: string) => ({
    id,
    name: id === "role_developer" ? "Developer" : "Planner",
    templateText: "You are a planner.",
    templateVersion: 1,
    templateHash: "x",
    schemaTemplateHash: "x",
    defaultMode: "agent",
    injection: "send_on_start",
    color: "#3fb950",
    isBuiltIn: true,
    fields: [],
  })),
}));

import { SettingsPage } from "./SettingsPage";
import type { RoleSummary } from "../bridge";

const roles: RoleSummary[] = [
  { id: "role_planner", name: "Planner", defaultMode: "plan", color: "#58a6ff", fieldCount: 6 },
  { id: "role_developer", name: "Developer", defaultMode: "agent", color: "#3fb950", fieldCount: 0 },
];

describe("SettingsPage", () => {
  it("shows the role's permission line and closes", async () => {
    const onClose = vi.fn();
    render(
      <SettingsPage
        roles={roles}
        cli={{ found: true, path: "C:\\agent.cmd", version: "2026.10.01", error: null }}
        cliError={null}
        platform="windows"
        diagnostics={null}
        captureOn={false}
        showDevTools={false}
        onToggleCapture={() => {}}
        terminalSettings={{ shell: "", fontSize: 14, roleSurface: {}, roleRunMode: {} }}
        onTerminalSettings={() => {}}
        approvalMode={null}
        onClose={onClose}
      />,
    );
    expect(await screen.findByText(/Deny write and shell/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Developer/ }));
    expect(await screen.findByText(/Auto-allow write, shell, and MCP/)).toBeTruthy();
    expect(screen.getByLabelText("Shell program")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("notes allowlist creates/edits are not routed through DCTerminal", () => {
    render(
      <SettingsPage
        roles={roles}
        cli={{ found: true, path: "/agent", version: "2026.10.01", error: null }}
        cliError={null}
        platform="mac"
        diagnostics={null}
        captureOn={false}
        showDevTools={false}
        onToggleCapture={() => {}}
        terminalSettings={null}
        onTerminalSettings={() => {}}
        approvalMode={{
          kind: "allowlist",
          approvalMode: "allowlist",
          configPath: "/tmp/cfg/cli-config.json",
          roleRulesOff: false,
          note: "note",
        }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/file creates and edits are not routed/i)).toBeTruthy();
    expect(screen.getByText(/Current/i)).toBeTruthy();
    expect(screen.getByText("allowlist")).toBeTruthy();
  });

  it("shows guidance when the Cursor CLI is missing", () => {
    render(
      <SettingsPage
        roles={roles}
        cli={{ found: false, path: null, version: null, error: "Cursor CLI was not found." }}
        cliError="Cursor CLI was not found."
        platform="windows"
        diagnostics={null}
        captureOn={false}
        showDevTools={false}
        onToggleCapture={() => {}}
        terminalSettings={null}
        onTerminalSettings={() => {}}
        approvalMode={null}
        onClose={() => {}}
      />,
    );
    expect(screen.getAllByText(/not found/i).length).toBeGreaterThan(0);
  });
});

describe("SettingsPage theme (U8)", () => {
  it("defaults to GitHub Dark and switches to the alternative", () => {
    const onUiSettings = vi.fn();
    render(
      <SettingsPage
        roles={roles}
        cli={null}
        cliError={null}
        platform="mac"
        diagnostics={null}
        captureOn={false}
        showDevTools={false}
        onToggleCapture={() => {}}
        terminalSettings={null}
        onTerminalSettings={() => {}}
        approvalMode={null}
        uiSettings={{ theme: "github-dark", shortcutBar: false, tipsSeen: [], padHeight: 0, padHidden: false }}
        onUiSettings={onUiSettings}
        onClose={() => {}}
      />,
    );
    const select = screen.getByLabelText("Theme") as HTMLSelectElement;
    expect(select.value).toBe("github-dark");
    expect(select.selectedOptions[0].textContent).toBe("GitHub Dark");
    fireEvent.change(select, { target: { value: "github-light" } });
    expect(onUiSettings).toHaveBeenCalledWith({ theme: "github-light" });
  });
});

describe("SettingsPage notifications", () => {
  const baseProps = {
    roles,
    cli: null,
    cliError: null,
    platform: "mac" as const,
    diagnostics: null,
    captureOn: false,
    showDevTools: false,
    onToggleCapture: () => {},
    terminalSettings: null,
    onTerminalSettings: () => {},
    approvalMode: null,
    onClose: () => {},
  };

  it("toggles agent notifications off and leaves the sub-options disabled", () => {
    const onNotificationSettings = vi.fn();
    const { rerender } = render(
      <SettingsPage
        {...baseProps}
        notificationSettings={{ enabled: true, system: true, toastWhenFocused: true }}
        onNotificationSettings={onNotificationSettings}
      />,
    );
    const section = screen.getByRole("region", { name: "Notifications" });
    expect(section).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Notify when an agent finishes/));
    expect(onNotificationSettings).toHaveBeenCalledWith({
      enabled: false,
      system: true,
      toastWhenFocused: true,
    });
    rerender(
      <SettingsPage
        {...baseProps}
        notificationSettings={{ enabled: false, system: true, toastWhenFocused: true }}
        onNotificationSettings={onNotificationSettings}
      />,
    );
    expect((screen.getByLabelText(/System notifications/) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText(/In-app toasts/) as HTMLInputElement).disabled).toBe(true);
  });

  it("changes the system and toast options and sends a test", () => {
    const onNotificationSettings = vi.fn();
    const onTestNotification = vi.fn();
    render(
      <SettingsPage
        {...baseProps}
        notificationSettings={{ enabled: true, system: true, toastWhenFocused: true }}
        onNotificationSettings={onNotificationSettings}
        onTestNotification={onTestNotification}
      />,
    );
    fireEvent.click(screen.getByLabelText(/System notifications/));
    expect(onNotificationSettings).toHaveBeenLastCalledWith({
      enabled: true,
      system: false,
      toastWhenFocused: true,
    });
    fireEvent.click(screen.getByLabelText(/In-app toasts/));
    expect(onNotificationSettings).toHaveBeenLastCalledWith({
      enabled: true,
      system: true,
      toastWhenFocused: false,
    });
    fireEvent.click(screen.getByRole("button", { name: "Send test notification" }));
    expect(onTestNotification).toHaveBeenCalledOnce();
  });
});
