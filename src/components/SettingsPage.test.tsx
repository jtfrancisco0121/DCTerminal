// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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
  pipelineDefsList: vi.fn(async () => []),
  pipelineDefsSave: vi.fn(async (defs: unknown[]) => defs),
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
        terminalSettings={{ shell: "", fontSize: 14, optionAsMeta: true, copyOnSelect: false, roleSurface: {}, roleRunMode: {}, newTabOpens: "ask" as const }}
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
    terminalSettings: { shell: "", fontSize: 14, optionAsMeta: true, copyOnSelect: false, roleSurface: {}, roleRunMode: {}, newTabOpens: "ask" as const },
    onTerminalSettings: () => {},
    approvalMode: null,
    onClose: () => {},
  };

  it("lists the settings categories in a left menu and opens on Roles", async () => {
    render(<SettingsPage {...props} />);
    const nav = screen.getByRole("navigation", { name: "Settings categories" });
    expect(within(nav).getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Roles",
      "Pipelines",
      "Providers",
      "Models",
      "Appearance",
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

  it("toggles Use Option as Meta on macOS only", () => {
    const onTerminalSettings = vi.fn();
    const { unmount } = render(<SettingsPage {...props} onTerminalSettings={onTerminalSettings} />);
    openCategory("Terminal");
    const box = screen.getByLabelText(/Use Option as Meta/) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(onTerminalSettings).toHaveBeenCalledWith(
      expect.objectContaining({ optionAsMeta: false }),
    );
    unmount();
    render(<SettingsPage {...props} platform="windows" />);
    openCategory("Terminal");
    expect(screen.queryByLabelText(/Use Option as Meta/)).toBeNull();
  });

  it("chooses what a new tab opens", () => {
    const onTerminalSettings = vi.fn();
    render(<SettingsPage {...props} onTerminalSettings={onTerminalSettings} />);
    openCategory("Terminal");
    const group = screen.getByRole("radiogroup", { name: "New tab opens" });
    expect(within(group).getAllByRole("radio").map((radio) => radio.parentElement?.textContent)).toEqual([
      "Ask",
      "Claude",
      "Shell",
      "Start screen",
    ]);
    expect((within(group).getByRole("radio", { name: "Ask" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/What ⌘\+T opens/)).toBeTruthy();
    fireEvent.click(within(group).getByRole("radio", { name: "Shell" }));
    expect(onTerminalSettings).toHaveBeenCalledWith(expect.objectContaining({ newTabOpens: "shell" }));
  });

  it("toggles Copy on select, off by default", () => {
    const onTerminalSettings = vi.fn();
    render(<SettingsPage {...props} onTerminalSettings={onTerminalSettings} />);
    openCategory("Terminal");
    const box = screen.getByLabelText(/Copy on select/) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    expect(onTerminalSettings).toHaveBeenCalledWith(
      expect.objectContaining({ copyOnSelect: true }),
    );
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
    openCategory("Appearance");
    const group = screen.getByRole("radiogroup", { name: "Theme" });
    const cards = Array.from(group.querySelectorAll('[role="radio"]'));
    expect(cards.map((card) => card.textContent)).toEqual([
      "Match system",
      "GitHub Dark",
      "GitHub Light",
      "Dracula",
      "Nord",
      "Tokyo Night",
      "Catppuccin Mocha",
    ]);
    const checked = cards.filter((card) => card.getAttribute("aria-checked") === "true");
    expect(checked.map((card) => card.textContent)).toEqual(["GitHub Dark"]);
    expect(checked[0].querySelectorAll(".theme-card-dot")).toHaveLength(5);
    fireEvent.click(screen.getByRole("radio", { name: "GitHub Light" }));
    expect(onUiSettings).toHaveBeenCalledWith({ theme: "github-light" });
    fireEvent.click(screen.getByRole("radio", { name: "Match system" }));
    expect(onUiSettings).toHaveBeenLastCalledWith({ theme: "system" });
    const preview = screen.getByRole("group", { name: "Status colours" });
    expect(preview.textContent).toBe("WorkingNeeds youDoneExited");
  });

  it("saves a custom colour and resets them all", () => {
    const onUiSettings = vi.fn();
    const props = {
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
      onUiSettings,
      onClose: () => {},
    };
    const ui = { theme: "nord", shortcutBar: false, tipsSeen: [], padHeight: 0, padHidden: false };
    const { rerender } = render(<SettingsPage {...props} uiSettings={ui} />);
    openCategory("Appearance");
    const reset = screen.getByRole("button", { name: "Reset" }) as HTMLButtonElement;
    expect(reset.disabled).toBe(true);
    const background = screen.getByLabelText("Background") as HTMLInputElement;
    expect(background.value).toBe("#2e3440");
    fireEvent.change(screen.getByLabelText("Needs you"), { target: { value: "#ff00ff" } });
    fireEvent.blur(screen.getByLabelText("Needs you"));
    expect(onUiSettings).toHaveBeenLastCalledWith({ customColors: { needsYou: "#ff00ff" } });
    rerender(
      <SettingsPage {...props} uiSettings={{ ...ui, customColors: { needsYou: "#ff00ff" } }} />,
    );
    expect((screen.getByLabelText("Needs you") as HTMLInputElement).value).toBe("#ff00ff");
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(onUiSettings).toHaveBeenLastCalledWith({ customColors: {} });
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

describe("SettingsPage save model", () => {
  const baseProps = {
    roles,
    cli: null,
    cliError: null,
    platform: "mac" as const,
    diagnostics: null,
    captureOn: false,
    showDevTools: false,
    onToggleCapture: () => {},
    terminalSettings: { shell: "", fontSize: 14, optionAsMeta: true, copyOnSelect: false, roleSurface: {}, roleRunMode: {}, newTabOpens: "ask" as const },
    approvalMode: null,
    initialCategory: "Terminal" as const,
    onClose: () => {},
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows Saving then Saved for a setting that saves", async () => {
    let done: () => void = () => {};
    const onTerminalSettings = vi.fn(() => new Promise<void>((resolve) => (done = resolve)));
    render(<SettingsPage {...baseProps} onTerminalSettings={onTerminalSettings} />);
    fireEvent.change(screen.getByLabelText("Developer run mode"), { target: { value: "plan" } });
    expect(screen.getByRole("status").textContent).toBe("Saving…");
    await act(async () => done());
    expect(screen.getByRole("status").textContent).toBe("Saved");
  });

  it("shows the error when a save fails", async () => {
    const onTerminalSettings = vi.fn(() => Promise.reject(new Error("disk full")));
    render(<SettingsPage {...baseProps} onTerminalSettings={onTerminalSettings} />);
    fireEvent.change(screen.getByLabelText("Developer run mode"), { target: { value: "plan" } });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Not saved: disk full");
  });

  it("saves the font size once typing pauses, not on every keystroke", () => {
    vi.useFakeTimers();
    const onTerminalSettings = vi.fn();
    render(<SettingsPage {...baseProps} onTerminalSettings={onTerminalSettings} />);
    const size = screen.getByLabelText("Font size");
    fireEvent.change(size, { target: { value: "1" } });
    fireEvent.change(size, { target: { value: "18" } });
    expect(onTerminalSettings).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(onTerminalSettings).toHaveBeenCalledTimes(1);
    expect(onTerminalSettings).toHaveBeenCalledWith(expect.objectContaining({ fontSize: 18 }));
  });

  it("saves a pending edit when the field loses focus", async () => {
    const onTerminalSettings = vi.fn();
    render(<SettingsPage {...baseProps} onTerminalSettings={onTerminalSettings} />);
    const shell = screen.getByLabelText("Shell program");
    fireEvent.change(shell, { target: { value: "/bin/fish" } });
    expect(onTerminalSettings).not.toHaveBeenCalled();
    fireEvent.blur(shell);
    await waitFor(() =>
      expect(onTerminalSettings).toHaveBeenCalledWith(expect.objectContaining({ shell: "/bin/fish" })),
    );
  });
});

describe("SettingsPage unsaved pipeline edits", () => {
  const props = {
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
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function editPipelines() {
    const editor = (await screen.findByLabelText("Your pipelines (JSON)")) as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toBe("[]"));
    fireEvent.change(editor, { target: { value: "[{}]" } });
    return editor;
  }

  it("marks the page unsaved, confirms before switching category, and Discard clears it", async () => {
    const onUnsavedChange = vi.fn();
    const ask = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(
      <SettingsPage
        {...props}
        initialCategory="Pipelines"
        onUnsavedChange={onUnsavedChange}
        onClose={() => {}}
      />,
    );
    await editPipelines();
    await waitFor(() => expect(onUnsavedChange).toHaveBeenLastCalledWith(true));

    openCategory("Terminal");
    await waitFor(() => expect(ask).toHaveBeenCalledOnce());
    expect(ask.mock.calls[0][0]).toContain("Leave the pipeline editor?");
    expect(ask.mock.calls[0][0]).toContain("Your pipeline edits are not saved.");
    // Cancelled: still on Pipelines with the draft kept.
    expect(screen.getByRole("region", { name: "Pipelines" })).toBeTruthy();
    expect((screen.getByLabelText("Your pipelines (JSON)") as HTMLTextAreaElement).value).toBe("[{}]");

    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(onUnsavedChange).toHaveBeenLastCalledWith(false));
    openCategory("Terminal");
    expect(ask).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("Shell program")).toBeTruthy();
  });

  it("confirms Close with pipeline wording and leaves when confirmed", async () => {
    const onClose = vi.fn();
    const ask = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<SettingsPage {...props} initialCategory="Pipelines" onClose={onClose} />);
    await editPipelines();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    expect(ask.mock.calls[0][0]).toContain("Leave Settings?");
    expect(ask.mock.calls[0][0]).toContain("Your pipeline edits are not saved.");
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it("switching to Pipelines and back without edits asks nothing", async () => {
    const ask = vi.spyOn(window, "confirm");
    render(<SettingsPage {...props} initialCategory="Pipelines" onClose={() => {}} />);
    const editor = (await screen.findByLabelText("Your pipelines (JSON)")) as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toBe("[]"));
    openCategory("Terminal");
    expect(ask).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Shell program")).toBeTruthy();
  });
});
