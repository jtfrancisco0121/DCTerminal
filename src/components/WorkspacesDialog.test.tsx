// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceList, WorkspaceTab } from "../bridge";
import { WorkspacesDialog } from "./WorkspacesDialog";

const tab = (label: string, cwd: string, role: string, kind = "role"): WorkspaceTab => ({
  label,
  customLabel: false,
  roleId: `role_${role.toLowerCase()}`,
  roleSnapshot: { name: role, templateVersion: 1, mode: "agent", injection: "send_on_start" },
  cwd,
  kind,
  terminalLaunch: kind === "terminal" ? "shell" : "",
  color: null,
  model: null,
  answers: {},
});

const list: WorkspaceList = {
  path: "/Users/jt/Library/Application Support/com.jtfrancisco.dcterminal/workspaces.json",
  workspaces: [
    {
      id: "ws_daily",
      name: "Koneksi daily",
      savedAt: "2026-10-06T09:00:00Z",
      tabs: [
        tab("Planner · Koneksi", "/Users/jt/Koneksi", "Planner"),
        tab("Shell · api", "/Users/jt/api", "Developer", "terminal"),
      ],
      activeIndex: 0,
    },
    {
      id: "ws_review",
      name: "Review",
      savedAt: "2026-10-05T09:00:00Z",
      tabs: [tab("Reviewer · PR 12", "/Users/jt/DCTerminal", "Reviewer")],
      activeIndex: null,
    },
  ],
};

const noop = async () => {};

describe("WorkspacesDialog", () => {
  it("lists workspaces with their tabs, folders, and roles, and opens one", async () => {
    const onOpen = vi.fn(async () => {});
    render(
      <WorkspacesDialog
        list={list}
        openTabCount={3}
        onSave={noop}
        onOpen={onOpen}
        onDelete={noop}
        onClose={() => {}}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Workspaces" });
    expect(dialog.textContent).toContain("workspaces.json");
    const items = within(screen.getByRole("listbox", { name: "Saved workspaces" })).getAllByRole(
      "option",
    );
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringContaining("Koneksi daily"),
      expect.stringContaining("Review"),
    ]);
    const detail = screen.getByRole("list", { name: "Tabs in Koneksi daily" });
    expect(detail.textContent).toContain("Planner · Koneksi");
    expect(detail.textContent).toContain("/Users/jt/Koneksi");
    expect(detail.textContent).toContain("Planner");
    expect(detail.textContent).toContain("Terminal");

    fireEvent.click(items[1]);
    expect(screen.getByRole("list", { name: "Tabs in Review" }).textContent).toContain(
      "Reviewer · PR 12",
    );
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith("ws_review", false));
    fireEvent.click(screen.getByRole("button", { name: "Replace open tabs" }));
    await waitFor(() => expect(onOpen).toHaveBeenLastCalledWith("ws_review", true));
  });

  it("saves the open tabs under a new name, and asks before replacing a name in use", async () => {
    const onSave = vi.fn(async () => {});
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(
      <WorkspacesDialog
        list={list}
        openTabCount={2}
        focusSave
        onSave={onSave}
        onOpen={noop}
        onDelete={noop}
        onClose={() => {}}
      />,
    );
    const name = screen.getByRole("textbox", { name: "Workspace name" });
    expect(document.activeElement).toBe(name);
    const save = screen.getByRole("button", { name: /Save 2 tabs/ }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(name, { target: { value: "Morning" } });
    fireEvent.keyDown(name, { key: "Enter" });
    await waitFor(() => expect(onSave).toHaveBeenCalledWith("Morning", false));

    fireEvent.change(name, { target: { value: "review" } });
    expect(screen.getByRole("button", { name: /Replace “Review”/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Replace “Review”/ }));
    expect(onSave).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /Replace “Review”/ }));
    await waitFor(() => expect(onSave).toHaveBeenLastCalledWith("review", true));
    confirm.mockRestore();
  });

  it("shows save errors, deletes after confirming, and closes on Escape", async () => {
    const onSave = vi.fn(async () => {
      throw new Error("There are no tabs to save.");
    });
    const onDelete = vi.fn(async () => {});
    const onClose = vi.fn();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(
      <WorkspacesDialog
        list={list}
        openTabCount={1}
        onSave={onSave}
        onOpen={noop}
        onDelete={onDelete}
        onClose={onClose}
      />,
    );
    const name = screen.getByRole("textbox", { name: "Workspace name" });
    fireEvent.change(name, { target: { value: "X" } });
    fireEvent.click(screen.getByRole("button", { name: /Save 1 tab/ }));
    expect(await screen.findByText("There are no tabs to save.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith("ws_daily"));
    fireEvent.keyDown(name, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
    confirm.mockRestore();
  });

  it("explains an empty list", () => {
    render(
      <WorkspacesDialog
        list={{ workspaces: [], path: "/tmp/workspaces.json" }}
        openTabCount={0}
        onSave={noop}
        onOpen={noop}
        onDelete={noop}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/No saved workspaces yet/)).toBeTruthy();
    expect((screen.getByRole("button", { name: /Save 0 tabs/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
