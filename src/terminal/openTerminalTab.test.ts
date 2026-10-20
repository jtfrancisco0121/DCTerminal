import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../bridge", () => ({
  createPtyChannel: () => ({ id: 1 }),
  ptyOpen: vi.fn(async () => 42),
  shellTerminalStart: vi.fn(),
}));
vi.mock("./park", () => ({
  measuredTerminalSize: () => ({ cols: 100, rows: 30 }),
}));

import { ptyOpen } from "../bridge";
import { dropLivePty, livePty } from "./live";
import { attachStageTerminal } from "./openTerminalTab";

describe("attachStageTerminal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dropLivePty("stage");
  });

  it("attaches to the run actor's terminal through pty_open, never starting a prompt", async () => {
    await attachStageTerminal({ id: "stage", cwd: "/repo", roleId: "role_pr_reviewer" });
    expect(ptyOpen).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ptyOpen).mock.calls[0][0]).toMatchObject({
      id: "stage",
      cwd: "/repo",
      launch: "role",
      roleId: "role_pr_reviewer",
      prompt: null,
      resumeSessionId: null,
      cols: 100,
      rows: 30,
      attach: true,
    });
    expect(livePty("stage")).toBeDefined();
    // Held already (its tab was opened first): nothing to attach.
    await attachStageTerminal({ id: "stage", cwd: "/repo", roleId: "role_pr_reviewer" });
    expect(ptyOpen).toHaveBeenCalledTimes(1);
  });

  it("lets go of the terminal when it cannot attach, so opening its tab tries again", async () => {
    vi.mocked(ptyOpen).mockRejectedValueOnce(new Error("no terminal"));
    await expect(attachStageTerminal({ id: "stage", cwd: "/repo", roleId: "role_pr_reviewer" })).rejects.toThrow(
      "no terminal",
    );
    expect(livePty("stage")).toBeUndefined();
    await attachStageTerminal({ id: "stage", cwd: "/repo", roleId: "role_pr_reviewer" });
    expect(ptyOpen).toHaveBeenCalledTimes(2);
  });
});
