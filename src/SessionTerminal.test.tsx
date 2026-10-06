// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SessionTerminal } from "./SessionTerminal";

const base = {
  title: "Developer · feat-login",
  cwd: "/Users/jt/Koneksi-worktrees/feat-login",
  sessionId: "s1",
  segments: [],
  promptInFlight: false,
  followUp: "",
  busy: false,
  canSendFollowUp: true,
  promptError: null,
  permissionRequest: null,
  onPermissionSelect: () => {},
  onPermissionCancel: () => {},
  onCancelTurn: () => {},
  onFollowUpChange: () => {},
  onSendFollowUp: () => {},
  onStop: () => {},
};

describe("SessionTerminal header", () => {
  it("shows the worktree branch next to the folder", () => {
    render(<SessionTerminal {...base} branch="feat/login" />);
    expect(screen.getByLabelText("Git branch").textContent).toContain("feat/login");
  });

  it("shows no branch for a plain tab", () => {
    render(<SessionTerminal {...base} />);
    expect(screen.queryByLabelText("Git branch")).toBeNull();
  });
});
