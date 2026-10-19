import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../bridge", () => ({
  createPtyChannel: () => ({ id: 1 }),
  ptyOpen: vi.fn(async () => 42),
  ptyDetach: vi.fn(async () => true),
  shellTerminalStart: vi.fn(),
}));
vi.mock("./park", () => ({
  measuredTerminalSize: () => ({ cols: 100, rows: 30 }),
  parkedTerminal: vi.fn(() => ({ term: { reset: resetTerm } })),
  releaseParkedTerminal: vi.fn(),
}));
const resetTerm = vi.hoisted(() => vi.fn());

import { ptyDetach, ptyOpen } from "../bridge";
import { dropLivePty, livePty } from "./live";
import { attachStageTerminal, detachStageTerminal } from "./openTerminalTab";
import { releaseParkedTerminal } from "./park";

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

  it("attaches again when the run actor resumed a stage whose view saw it exit (V4)", async () => {
    await attachStageTerminal({ id: "stage", cwd: "/repo", roleId: "role_implementer" });
    const ended = livePty("stage")!;
    ended.exited = true;
    ended.exitCode = 143;
    await attachStageTerminal({ id: "stage", cwd: "/repo", roleId: "role_implementer" });
    expect(ptyOpen).toHaveBeenCalledTimes(2);
    expect(vi.mocked(ptyOpen).mock.calls[1][0]).toMatchObject({ id: "stage", attach: true, prompt: null });
    const now = livePty("stage")!;
    expect(now).not.toBe(ended);
    expect(now.exited).toBe(false);
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

describe("detachStageTerminal (V5)", () => {
  const stage = { id: "stage", cwd: "/repo", roleId: "role_pr_reviewer" };
  beforeEach(() => {
    vi.clearAllMocks();
    dropLivePty("stage");
  });

  it("lets go of a hidden stage's view so the next Watch replays it, never stopping it", async () => {
    await attachStageTerminal(stage);
    expect(await detachStageTerminal(stage, () => false)).toBe(true);
    expect(ptyDetach).toHaveBeenCalledWith("stage");
    expect(livePty("stage")).toBeUndefined();
    expect(releaseParkedTerminal).toHaveBeenCalledWith("stage");
    await attachStageTerminal(stage);
    expect(ptyOpen).toHaveBeenCalledTimes(2);
  });

  it("keeps the stream of a terminal a view started (not a hidden stage)", async () => {
    await attachStageTerminal({ ...stage, roleId: "role_planner" });
    vi.mocked(ptyDetach).mockResolvedValueOnce(false);
    expect(await detachStageTerminal(stage, () => false)).toBe(false);
    expect(livePty("stage")).toBeDefined();
    expect(releaseParkedTerminal).not.toHaveBeenCalled();
  });

  it("watches afresh when a view came back while the old one let go", async () => {
    await attachStageTerminal(stage);
    const before = livePty("stage");
    expect(await detachStageTerminal(stage, () => true)).toBe(true);
    expect(resetTerm).toHaveBeenCalled();
    expect(releaseParkedTerminal).not.toHaveBeenCalled();
    expect(livePty("stage")).toBeDefined();
    expect(livePty("stage")).not.toBe(before);
    expect(vi.mocked(ptyOpen).mock.calls[1][0]).toMatchObject({ id: "stage", attach: true });
  });
});
