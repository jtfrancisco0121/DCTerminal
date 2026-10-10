// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
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
  previewRoleTemplate: vi.fn(async () => ({ fields: [], error: null })),
  getClaudeUsage: vi.fn(async () => ({
    configDir: "/tmp/claude",
    windows: [],
    contextByTab: {},
  })),
  storageStatus: vi.fn(async () => ({ appDataDir: "/tmp/dct", bytes: 2048 })),
  storageCleanup: vi.fn(async () => ({ bytesFreed: 0, bytes: 2048 })),
}));

import { SettingsPage } from "./SettingsPage";
import type { RoleSummary } from "../bridge";

function openCategory(name: string) {
  const nav = screen.getByRole("navigation", { name: "Settings categories" });
  fireEvent.click(within(nav).getByRole("button", { name }));
}

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
    expect(await screen.findByText(/Full access/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Developer/ }));
    expect(screen.getAllByText("Full access").length).toBeGreaterThan(0);
    openCategory("Terminal");
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
    openCategory("Permissions");
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
    openCategory("Data");
    expect(screen.getAllByText(/not found/i).length).toBeGreaterThan(0);
  });
});

describe("SettingsPage categories (U6)", () => {
  const props = {
    roles,
    cli: null,
    cliError: null,
    platform: "mac" as const,
    diagnostics: null,
    captureOn: false,
    showDevTools: false,
    onToggleCapture: () => {},
    terminalSettings: { shell: "", fontSize: 14, roleSurface: {}, roleRunMode: {} },
    onTerminalSettings: () => {},
    approvalMode: null,
    onClose: () => {},
  };

  it("lists the settings categories in a left menu and opens on Roles", async () => {
    render(<SettingsPage {...props} />);
    const nav = screen.getByRole("navigation", { name: "Settings categories" });
    expect(within(nav).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Roles",
      "Providers",
      "Models",
      "Terminal",
      "Permissions",
      "Usage",
      "Notifications",
      "Shortcuts",
      "Data",
    ]);
    expect(within(nav).getByRole("button", { name: "Roles" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(await screen.findByText(/Full access/)).toBeTruthy();
    expect(screen.queryByLabelText("Shell program")).toBeNull();
  });

  it("shows one category at a time", () => {
    render(<SettingsPage {...props} />);
    openCategory("Terminal");
    expect(screen.getByRole("region", { name: "Terminal" })).toBeTruthy();
    expect(screen.getByLabelText("Developer run mode")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Roles" })).toBeNull();
    openCategory("Shortcuts");
    expect(screen.getByRole("region", { name: "Shortcuts" })).toBeTruthy();
    expect(screen.getByText("Command palette")).toBeTruthy();
    openCategory("Models");
    expect(screen.getByRole("region", { name: "Models" })).toBeTruthy();
    openCategory("Permissions");
    expect(screen.getByLabelText("Record permission payloads")).toBeTruthy();
  });

  it("sets a Claude reasoning effort per role, and default clears it", () => {
    const onModelSettings = vi.fn();
    render(
      <SettingsPage
        {...props}
        initialCategory="Models"
        modelSettings={{
          cursor: { defaultModel: "composer-2.5", roleModels: {} },
          claude: { defaultModel: "default", roleModels: {}, roleEffort: { role_developer: "low" } },
        }}
        onModelSettings={onModelSettings}
      />,
    );
    const planner = screen.getByLabelText("Claude effort for Planner") as HTMLSelectElement;
    expect(planner.value).toBe("");
    expect((screen.getByLabelText("Claude effort for Developer") as HTMLSelectElement).value).toBe("low");
    fireEvent.change(planner, { target: { value: "high" } });
    expect(onModelSettings).toHaveBeenLastCalledWith(
      "claude",
      expect.objectContaining({ roleEffort: { role_developer: "low", role_planner: "high" } }),
    );
    fireEvent.change(screen.getByLabelText("Claude effort for Developer"), { target: { value: "" } });
    expect(onModelSettings).toHaveBeenLastCalledWith(
      "claude",
      expect.objectContaining({ roleEffort: {} }),
    );
    // Cursor has no effort setting.
    expect(screen.queryByLabelText("Cursor effort for Planner")).toBeNull();
  });

  it("can open straight on a category", () => {
    render(<SettingsPage {...props} initialCategory="Notifications" />);
    expect(screen.getByRole("region", { name: "Notifications" })).toBeTruthy();
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
    openCategory("Terminal");
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
    initialCategory: "Notifications" as const,
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

describe("SettingsPage shortcuts (U7)", () => {
  it("toggles the shortcut bar and resets first-use tips", () => {
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
        uiSettings={{
          theme: "github-dark",
          shortcutBar: false,
          tipsSeen: ["welcome"],
          padHeight: 0,
          padHidden: false,
        }}
        onUiSettings={onUiSettings}
        initialCategory="Shortcuts"
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByLabelText("Show shortcut bar in the status strip"));
    expect(onUiSettings).toHaveBeenCalledWith({ shortcutBar: true });
    fireEvent.click(screen.getByRole("button", { name: "Show tips again" }));
    expect(onUiSettings).toHaveBeenCalledWith({ tipsSeen: [] });
  });
});
