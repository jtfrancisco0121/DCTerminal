// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoEntry } from "../bridge";

vi.mock("../bridge", () => ({
  getReposSettings: vi.fn(async () => [
    { name: "backend", folder: "/src/backend", check: "cd server && go test ./...", verify: "Run qa128-ml on Windows." },
    { name: "engine", folder: "/src/engine" },
  ]),
  setReposSettings: vi.fn(async (repos: RepoEntry[]) => repos),
}));

vi.mock("./FolderPicker", () => ({
  FolderPicker: ({ value, onChange }: { value: string; onChange: (path: string) => void }) => (
    <input aria-label="Folder path" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

import { setReposSettings } from "../bridge";
import { ReposSettings } from "./ReposSettings";

describe("Settings › Repos checks and verify steps (L2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists each repo's check and verify steps", async () => {
    render(<ReposSettings />);
    const list = await screen.findByRole("list", { name: "Your repos" });
    expect(list.textContent).toContain("Check: cd server && go test ./...");
    expect(list.textContent).toContain("Verify: Run qa128-ml on Windows.");
    const engine = within(list).getByText("engine").closest("li")!;
    expect(engine.textContent).not.toContain("Check:");
  });

  it("edits a repo's check, refusing one that is too long, and clears its verify steps", async () => {
    render(<ReposSettings />);
    await screen.findByRole("list", { name: "Your repos" });
    fireEvent.click(screen.getByRole("button", { name: "Edit backend" }));
    const form = screen.getByLabelText("Editing backend");
    const check = within(form).getByLabelText("Check (optional)") as HTMLInputElement;
    const verify = within(form).getByLabelText("Verify steps (optional)") as HTMLTextAreaElement;
    expect(check.value).toBe("cd server && go test ./...");
    expect(verify.value).toBe("Run qa128-ml on Windows.");

    // A one-line input drops line breaks itself; the length is checked here.
    fireEvent.change(check, { target: { value: "x".repeat(2001) } });
    expect(within(form).getByText("The check is longer than 2000 characters.")).toBeTruthy();
    fireEvent.click(within(form).getByRole("button", { name: "Save repo" }));
    expect(setReposSettings).not.toHaveBeenCalled();

    fireEvent.change(check, { target: { value: "  go test ./server/...  " } });
    fireEvent.change(verify, { target: { value: "   " } });
    fireEvent.click(within(form).getByRole("button", { name: "Save repo" }));
    await waitFor(() =>
      expect(setReposSettings).toHaveBeenCalledWith([
        { name: "backend", folder: "/src/backend", check: "go test ./server/..." },
        { name: "engine", folder: "/src/engine" },
      ]),
    );
    const saved = vi.mocked(setReposSettings).mock.calls[0][0];
    expect("verify" in saved[0]).toBe(false);
  });

  it("adds a repo with verify steps over several lines", async () => {
    render(<ReposSettings />);
    await screen.findByRole("list", { name: "Your repos" });
    fireEvent.click(screen.getByRole("button", { name: "Add repo" }));
    const form = screen.getByLabelText("New repo");
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "web" } });
    fireEvent.change(within(form).getByLabelText("Folder path"), { target: { value: "/src/web" } });
    fireEvent.change(within(form).getByLabelText("Verify steps (optional)"), {
      target: { value: "Open staging.\nSign in as qa128." },
    });
    fireEvent.click(within(form).getByRole("button", { name: "Save repo" }));
    await waitFor(() => expect(setReposSettings).toHaveBeenCalled());
    const saved = vi.mocked(setReposSettings).mock.calls[0][0];
    expect(saved[2]).toEqual({ name: "web", folder: "/src/web", verify: "Open staging.\nSign in as qa128." });
  });
});
