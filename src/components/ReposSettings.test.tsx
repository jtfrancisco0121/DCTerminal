// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoEntry } from "../bridge";

vi.mock("../bridge", () => ({
  getReposSettings: vi.fn(async () => [{ name: "backend", folder: "/src/backend" }]),
  setReposSettings: vi.fn(async (repos: RepoEntry[]) => repos),
}));

vi.mock("./FolderPicker", () => ({
  FolderPicker: ({ value, onChange }: { value: string; onChange: (path: string) => void }) => (
    <input aria-label="Folder path" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

import { getReposSettings, setReposSettings } from "../bridge";
import { ReposSettings } from "./ReposSettings";

describe("Settings › Repos (L1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists your repos and adds one, checking the name before it saves", async () => {
    render(<ReposSettings />);
    const list = await screen.findByRole("list", { name: "Your repos" });
    expect(list.textContent).toContain("backend");
    expect(list.textContent).toContain("/src/backend");

    fireEvent.click(screen.getByRole("button", { name: "Add repo" }));
    const form = screen.getByLabelText("New repo");
    fireEvent.click(within(form).getByRole("button", { name: "Save repo" }));
    expect(within(form).getByText("Give the repo a name, such as backend.")).toBeTruthy();
    expect(within(form).getByText("Choose the repo's folder.")).toBeTruthy();

    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Backend" } });
    expect(within(form).getByText("There is already a repo named Backend.")).toBeTruthy();
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "my engine" } });
    expect(within(form).getByText("The name may use only letters, digits, - and _.")).toBeTruthy();
    expect(setReposSettings).not.toHaveBeenCalled();

    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: " engine " } });
    fireEvent.change(within(form).getByLabelText("Folder path"), { target: { value: "/src/engine" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save repo" }));
    await waitFor(() =>
      expect(setReposSettings).toHaveBeenCalledWith([
        { name: "backend", folder: "/src/backend" },
        { name: "engine", folder: "/src/engine" },
      ]),
    );
    await waitFor(() => expect(screen.queryByLabelText("New repo")).toBeNull());
    expect(screen.getByRole("list", { name: "Your repos" }).textContent).toContain("/src/engine");
  });

  it("shows the app's answer under the form when a folder is not a git repo, and keeps the form", async () => {
    vi.mocked(setReposSettings).mockRejectedValueOnce(
      new Error("web: /tmp/plain is not a git repository, so fan-out could not make worktrees there."),
    );
    render(<ReposSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Add repo" }));
    const form = screen.getByLabelText("New repo");
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "web" } });
    fireEvent.change(within(form).getByLabelText("Folder path"), { target: { value: "/tmp/plain" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save repo" }));
    expect((await within(form).findByRole("alert")).textContent).toContain("is not a git repository");
    expect(screen.getByLabelText("New repo")).toBeTruthy();
    expect(screen.getByRole("list", { name: "Your repos" }).textContent).not.toContain("web");
  });

  it("edits a repo's folder and removes one after you confirm", async () => {
    vi.mocked(getReposSettings).mockResolvedValueOnce([
      { name: "backend", folder: "/src/backend" },
      { name: "engine", folder: "/src/engine" },
    ]);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<ReposSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit engine" }));
    const form = screen.getByLabelText("Editing engine");
    expect((within(form).getByLabelText("Name") as HTMLInputElement).value).toBe("engine");
    fireEvent.change(within(form).getByLabelText("Folder path"), { target: { value: "/src/engine-v2" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save repo" }));
    await waitFor(() =>
      expect(setReposSettings).toHaveBeenLastCalledWith([
        { name: "backend", folder: "/src/backend" },
        { name: "engine", folder: "/src/engine-v2" },
      ]),
    );

    fireEvent.click(await screen.findByRole("button", { name: "Remove backend" }));
    await waitFor(() => expect(setReposSettings).toHaveBeenLastCalledWith([{ name: "engine", folder: "/src/engine-v2" }]));
    expect(confirm.mock.calls[0][0]).toContain("Remove “backend” from DCTerminal?");
    confirm.mockRestore();
  });
});
