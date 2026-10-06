// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

vi.mock("../bridge", () => ({
  projectsList: vi.fn(),
  projectsRemove: vi.fn(),
  projectsToggleFavorite: vi.fn(),
  checkWorkingFolder: vi.fn(),
}));

import { open } from "@tauri-apps/plugin-dialog";
import { checkWorkingFolder, projectsList, projectsToggleFavorite } from "../bridge";
import { FolderPicker } from "./FolderPicker";

describe("FolderPicker", () => {
  beforeEach(() => {
    vi.mocked(projectsList).mockResolvedValue({ favorites: [], recent: [] });
    vi.mocked(open).mockReset();
  });

  it("asks for a folder and does not start a session when one is chosen", async () => {
    const onChange = vi.fn();
    vi.mocked(open).mockResolvedValue("C:\\Projects\\Encryptor");
    render(<FolderPicker value="" onChange={onChange} />);
    expect(screen.getByRole("button", { name: "Choose folder…" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Choose folder…" }));
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith("C:\\Projects\\Encryptor");
    });
  });

  it("shows a missing folder and still lists recent folders", async () => {
    vi.mocked(projectsList).mockResolvedValue({
      favorites: [],
      recent: [{ path: "C:\\Missing\\Repo", available: false, favorite: false }],
    });
    render(
      <FolderPicker
        value={"C:\\Missing\\Repo"}
        unavailable
        onChange={() => {}}
      />,
    );
    expect(screen.getByText("unavailable")).toBeTruthy();
    expect(screen.getByText("C:\\Missing\\Repo")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Recent" }));
    expect(await screen.findByText(/Missing\\Repo/)).toBeTruthy();
  });

  it("stars the current folder", async () => {
    vi.mocked(projectsToggleFavorite).mockResolvedValue(true);
    render(<FolderPicker value={"C:\\Projects\\Encryptor"} onChange={() => {}} />);
    fireEvent.click(screen.getByTitle("Star as favorite"));
    await waitFor(() => {
      expect(projectsToggleFavorite).toHaveBeenCalledWith("C:\\Projects\\Encryptor");
    });
  });

  it("reports a pasted path that does not exist", async () => {
    vi.mocked(checkWorkingFolder).mockRejectedValue(new Error("Folder was not found."));
    render(<FolderPicker value="" onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Recent" }));
    const input = await screen.findByRole("textbox");
    fireEvent.change(input, { target: { value: "C:\\Gone" } });
    fireEvent.click(screen.getByRole("button", { name: "Use path" }));
    expect(await screen.findByText("Folder was not found.")).toBeTruthy();
  });
});
