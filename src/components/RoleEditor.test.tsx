// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Role, RoleSummary } from "../bridge";

const CUSTOM_ID = "role_custom_0123456789ab";

function role(id: string, overrides: Partial<Role> = {}): Role {
  return {
    id,
    name: id === CUSTOM_ID ? "Docs writer" : "Planner",
    templateText: "# {{title}}\n\n{{request}}",
    templateVersion: 1,
    templateHash: "x",
    schemaTemplateHash: "x",
    defaultMode: "plan",
    injection: "send_on_start",
    color: "#58A6FF",
    isBuiltIn: id !== CUSTOM_ID,
    fields: [],
    ...overrides,
  };
}

const bridge = vi.hoisted(() => ({
  getRole: vi.fn(),
  saveRole: vi.fn(),
  resetBuiltinRole: vi.fn(),
  previewRoleTemplate: vi.fn(),
  createRole: vi.fn(),
  duplicateRole: vi.fn(),
  deleteRole: vi.fn(),
  importRole: vi.fn(),
  exportRole: vi.fn(),
}));
vi.mock("../bridge", () => bridge);

const dialog = vi.hoisted(() => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => dialog);

import { RoleEditor } from "./RoleEditor";

const roles: RoleSummary[] = [
  { id: "role_planner", name: "Planner", defaultMode: "plan", color: "#58a6ff", fieldCount: 2, isBuiltIn: true },
  { id: "role_developer", name: "Developer", defaultMode: "agent", color: "#3fb950", fieldCount: 0, isBuiltIn: true },
  { id: "role_plan_reviewer", name: "Plan Reviewer", defaultMode: "agent", color: "#bc8cff", fieldCount: 3, isBuiltIn: true },
  { id: CUSTOM_ID, name: "Docs writer", defaultMode: "agent", color: "#8b949e", fieldCount: 2, isBuiltIn: false },
];

beforeEach(() => {
  vi.clearAllMocks();
  bridge.getRole.mockImplementation(async (id: string) => role(id));
  bridge.previewRoleTemplate.mockResolvedValue({
    fields: [
      { key: "title", label: "Title", type: "text", required: true },
      { key: "request", label: "Request", type: "multiline", required: false },
    ],
    error: null,
  });
  bridge.saveRole.mockImplementation(async (input: { roleId: string }) => role(input.roleId));
});

describe("RoleEditor", () => {
  it("Save sends name, color, mode and hand-off targets", async () => {
    const onRefreshRoles = vi.fn(async () => {});
    render(<RoleEditor roles={roles} onRefreshRoles={onRefreshRoles} />);
    const name = (await screen.findByLabelText("Name")) as HTMLInputElement;
    expect(name.value).toBe("Planner");
    // Built-in targets come from the transition table until edited.
    const developer = screen.getByRole("checkbox", { name: "Developer" }) as HTMLInputElement;
    expect(developer.checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "Plan Reviewer" }) as HTMLInputElement).checked).toBe(true);

    fireEvent.change(name, { target: { value: "Architect" } });
    fireEvent.click(screen.getByRole("button", { name: "Color #3fb950" }));
    fireEvent.change(screen.getByLabelText("Default mode"), { target: { value: "ask" } });
    fireEvent.click(developer);
    fireEvent.click(screen.getByRole("checkbox", { name: "Docs writer" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(bridge.saveRole).toHaveBeenCalledOnce());
    expect(bridge.saveRole).toHaveBeenCalledWith({
      roleId: "role_planner",
      templateText: "# {{title}}\n\n{{request}}",
      name: "Architect",
      color: "#3fb950",
      defaultMode: "ask",
      handoffTargets: ["role_plan_reviewer", "role_implementer", CUSTOM_ID],
    });
    expect(await screen.findByText("Saved.")).toBeTruthy();
    expect(onRefreshRoles).toHaveBeenCalled();
  });

  it("unchanged built-in targets stay on the table (not sent)", async () => {
    render(<RoleEditor roles={roles} />);
    await screen.findByLabelText("Name");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(bridge.saveRole).toHaveBeenCalledOnce());
    expect(bridge.saveRole.mock.calls[0][0]).not.toHaveProperty("handoffTargets");
  });

  it("shows the fields the template implies, and blocks Save on an error", async () => {
    render(<RoleEditor roles={roles} />);
    expect(await screen.findByText(/Form fields: Title \(required\) · Request/)).toBeTruthy();
    bridge.previewRoleTemplate.mockResolvedValue({
      fields: [],
      error: "Placeholder names use letters, digits and _ only: {{a b}}",
    });
    fireEvent.change(screen.getByLabelText("Role template"), { target: { value: "{{a b}}" } });
    expect(await screen.findByText(/Placeholder names use letters/)).toBeTruthy();
    expect(bridge.previewRoleTemplate).toHaveBeenLastCalledWith("role_planner", "{{a b}}");
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("built-ins have no Delete; a custom role asks in the page before deleting", async () => {
    const onRefreshRoles = vi.fn(async () => {});
    const confirmSpy = vi.spyOn(window, "confirm");
    render(<RoleEditor roles={roles} onRefreshRoles={onRefreshRoles} />);
    await screen.findByLabelText("Name");
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.getByRole("button", { name: "Reset built-in" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^Docs writer/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(screen.getByRole("alertdialog", { name: "Delete role" })).toBeTruthy();
    expect(bridge.deleteRole).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(bridge.deleteRole).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete role" }));
    await waitFor(() => expect(bridge.deleteRole).toHaveBeenCalledWith(CUSTOM_ID));
    expect(await screen.findByText("Deleted Docs writer.")).toBeTruthy();
    expect(onRefreshRoles).toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("shows why a delete was refused", async () => {
    bridge.deleteRole.mockRejectedValue(new Error("1 open tab uses Docs writer. Close them before deleting the role."));
    render(<RoleEditor roles={roles} />);
    fireEvent.click(screen.getByRole("button", { name: /^Docs writer/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete role" }));
    expect(await screen.findByText(/1 open tab uses Docs writer/)).toBeTruthy();
  });

  it("Duplicate passes the shown targets and selects the copy", async () => {
    const copy = role(CUSTOM_ID, { name: "Planner copy" });
    bridge.duplicateRole.mockResolvedValue(copy);
    render(<RoleEditor roles={roles} onRefreshRoles={async () => {}} />);
    await screen.findByLabelText("Name");
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    await waitFor(() =>
      expect(bridge.duplicateRole).toHaveBeenCalledWith("role_planner", [
        "role_plan_reviewer",
        "role_implementer",
        "role_developer",
      ]),
    );
    expect(await screen.findByText("Duplicated as Planner copy.")).toBeTruthy();
  });

  it("New role creates a custom role", async () => {
    bridge.createRole.mockResolvedValue(role(CUSTOM_ID, { name: "New role" }));
    render(<RoleEditor roles={roles} onRefreshRoles={async () => {}} />);
    await screen.findByLabelText("Name");
    fireEvent.click(screen.getByRole("button", { name: "New role" }));
    await waitFor(() => expect(bridge.createRole).toHaveBeenCalledWith("New role"));
    expect(await screen.findByText(/New role added/)).toBeTruthy();
  });

  it("Export saves one role through the save dialog; Import reads a picked file", async () => {
    dialog.save.mockResolvedValue("/tmp/Planner.role.json");
    dialog.open.mockResolvedValue("/tmp/docs.role.json");
    bridge.importRole.mockResolvedValue(role(CUSTOM_ID));
    render(<RoleEditor roles={roles} onRefreshRoles={async () => {}} />);
    await screen.findByLabelText("Name");
    fireEvent.click(screen.getByRole("button", { name: "Export…" }));
    await waitFor(() =>
      expect(bridge.exportRole).toHaveBeenCalledWith("role_planner", "/tmp/Planner.role.json"),
    );
    expect(dialog.save).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: "Planner.role.json" }),
    );
    expect(await screen.findByText("Exported to /tmp/Planner.role.json.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Import…" }));
    await waitFor(() => expect(bridge.importRole).toHaveBeenCalledWith("/tmp/docs.role.json"));
    expect(await screen.findByText("Imported Docs writer.")).toBeTruthy();
  });

  it("a cancelled import changes nothing", async () => {
    dialog.open.mockResolvedValue(null);
    render(<RoleEditor roles={roles} />);
    await screen.findByLabelText("Name");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Import…" }));
    });
    expect(await screen.findByText("Import cancelled.")).toBeTruthy();
    expect(bridge.importRole).not.toHaveBeenCalled();
  });
});
