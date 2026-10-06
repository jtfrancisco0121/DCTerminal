// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("../bridge", () => ({
  projectsList: vi.fn(async () => ({ favorites: [], recent: [] })),
  projectsRemember: vi.fn(),
  projectsRemove: vi.fn(),
  projectsToggleFavorite: vi.fn(),
  checkWorkingFolder: vi.fn(async () => "ok"),
}));

import { WorktreeDialog } from "./WorktreeDialog";
import type { RepoInfo } from "../bridge";

const info: RepoInfo = {
  mainRoot: "/Users/jt/Koneksi",
  currentBranch: "main",
  branches: ["main", "feat/old", "feat/busy"],
  checkedOut: ["main", "feat/busy"],
  worktreesDir: "/Users/jt/Koneksi-worktrees",
};

const roles = [
  { id: "role_developer", name: "Developer", defaultMode: "agent", color: "#3fb950", fieldCount: 0 },
  { id: "role_planner", name: "Planner", defaultMode: "plan", color: "#58a6ff", fieldCount: 0 },
];

describe("WorktreeDialog", () => {
  it("creates a new branch worktree and shows where it will go", async () => {
    const loadRepo = vi.fn(async () => info);
    const onCreate = vi.fn(async () => {});
    render(
      <WorktreeDialog
        initialRepo="/Users/jt/Koneksi"
        roles={roles}
        defaultRoleId="role_planner"
        loadRepo={loadRepo}
        onCreate={onCreate}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(loadRepo).toHaveBeenCalledWith("/Users/jt/Koneksi"));
    const create = screen.getByRole("button", { name: "Create worktree and open tab" });
    expect((create as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("New branch name"), {
      target: { value: "feat/login" },
    });
    expect(screen.getByText("/Users/jt/Koneksi-worktrees/feat-login")).toBeTruthy();
    expect((screen.getByLabelText("Start from") as HTMLSelectElement).value).toBe("main");
    fireEvent.click(create);
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith({
        repoPath: "/Users/jt/Koneksi",
        branch: "feat/login",
        createBranch: true,
        base: "main",
        roleId: "role_planner",
      }),
    );
  });

  it("checks out an existing branch that is free", async () => {
    const onCreate = vi.fn(async () => {});
    render(
      <WorktreeDialog
        initialRepo="/Users/jt/Koneksi"
        roles={roles}
        defaultRoleId="role_developer"
        loadRepo={async () => info}
        onCreate={onCreate}
        onClose={() => {}}
      />,
    );
    await screen.findByLabelText("New branch name");
    fireEvent.click(screen.getByLabelText("Existing branch"));
    const select = screen.getByLabelText("Branch") as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toEqual(["", "feat/old"]);
    fireEvent.change(select, { target: { value: "feat/old" } });
    fireEvent.click(screen.getByRole("button", { name: "Create worktree and open tab" }));
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({ branch: "feat/old", createBranch: false, base: null }),
      ),
    );
  });

  it("shows a repository error for a plain folder", async () => {
    render(
      <WorktreeDialog
        initialRepo="/tmp/plain"
        roles={roles}
        defaultRoleId="role_developer"
        loadRepo={async () => {
          throw new Error("this folder is not inside a git repository");
        }}
        onCreate={async () => {}}
        onClose={() => {}}
      />,
    );
    expect(await screen.findByText(/not inside a git repository/)).toBeTruthy();
    expect(screen.queryByLabelText("New branch name")).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Create worktree and open tab" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("blocks a name that already exists and shows git's error on failure", async () => {
    const onCreate = vi.fn(async () => {
      throw new Error("fatal: could not create work tree dir");
    });
    render(
      <WorktreeDialog
        initialRepo="/Users/jt/Koneksi"
        roles={roles}
        defaultRoleId="role_developer"
        loadRepo={async () => info}
        onCreate={onCreate}
        onClose={() => {}}
      />,
    );
    const input = await screen.findByLabelText("New branch name");
    fireEvent.change(input, { target: { value: "feat/old" } });
    expect(screen.getByText(/already exists/)).toBeTruthy();
    const create = screen.getByRole("button", { name: "Create worktree and open tab" });
    expect((create as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: "feat/z" } });
    fireEvent.click(create);
    expect(await screen.findByText(/could not create work tree dir/)).toBeTruthy();
  });

  it("does nothing until the user clicks Create, and closes on Cancel", async () => {
    const onCreate = vi.fn(async () => {});
    const onClose = vi.fn();
    render(
      <WorktreeDialog
        initialRepo="/Users/jt/Koneksi"
        roles={roles}
        defaultRoleId="role_developer"
        loadRepo={async () => info}
        onCreate={onCreate}
        onClose={onClose}
      />,
    );
    await screen.findByLabelText("New branch name");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onCreate).not.toHaveBeenCalled();
  });
});
