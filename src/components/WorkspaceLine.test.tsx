// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../bridge", () => ({
  workspaceReposFor: vi.fn(async (folder: string) =>
    folder === "/ws"
      ? {
          workspace: true,
          repos: [
            { name: "koneksi-backend", folder: "/ws/koneksi-backend", check: "cd server && go test ./..." },
            { name: "koneksi-engine", folder: "/ws/koneksi-engine", check: "go test ./..." },
            { name: "koneksi-web", folder: "/ws/koneksi-web", check: "npm run check" },
            { name: "koneksi-desktop", folder: "/ws/koneksi-desktop" },
          ],
        }
      : { workspace: false, repos: [] },
  ),
}));

import { workspaceReposFor } from "../bridge";
import { WorkspaceLine } from "./WorkspaceLine";

describe("WorkspaceLine (W1)", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it("shows one line for a folder of repos", async () => {
    render(<WorkspaceLine folder="/ws" />);
    const line = await screen.findByRole("status");
    expect(line.textContent).toBe("Workspace: 4 repos found (koneksi-backend, koneksi-engine, koneksi-web, …)");
    expect(line.getAttribute("title")).toBe("koneksi-backend, koneksi-engine, koneksi-web, koneksi-desktop");
    expect(workspaceReposFor).toHaveBeenCalledWith("/ws");
  });

  it("shows nothing for a repo or plain folder, a blank folder, or when the list cannot be read", async () => {
    const { rerender, container } = render(<WorkspaceLine folder="/src/app" />);
    await waitFor(() => expect(workspaceReposFor).toHaveBeenCalledWith("/src/app"));
    expect(container.textContent).toBe("");
    rerender(<WorkspaceLine folder="  " />);
    expect(container.textContent).toBe("");
    vi.mocked(workspaceReposFor).mockRejectedValueOnce(new Error("git is missing"));
    rerender(<WorkspaceLine folder="/broken" />);
    await waitFor(() => expect(workspaceReposFor).toHaveBeenCalledWith("/broken"));
    expect(container.textContent).toBe("");
  });

  it("drops the line when the folder changes to one that is not a workspace", async () => {
    const { rerender, container } = render(<WorkspaceLine folder="/ws" />);
    await screen.findByRole("status");
    rerender(<WorkspaceLine folder="/src/app" />);
    expect(container.textContent).toBe("");
  });
});
