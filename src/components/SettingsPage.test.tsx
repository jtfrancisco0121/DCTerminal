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
        onClose={onClose}
      />,
    );
    expect(await screen.findByText(/Deny write and shell/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Developer/ }));
    expect(await screen.findByText(/Auto-allow write, shell, and MCP/)).toBeTruthy();
    expect(screen.getByLabelText("Shell program")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
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
        onClose={() => {}}
      />,
    );
    expect(screen.getAllByText(/not found/i).length).toBeGreaterThan(0);
  });
});
