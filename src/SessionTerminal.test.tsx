// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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

describe("SessionTerminal find (F5)", () => {
  const segments = [
    { id: "u1", kind: "user" as const, text: "Fix the login bug" },
    { id: "a1", kind: "agent" as const, text: "I looked at the login form." },
    { id: "t1", kind: "thought" as const, text: "Maybe the LOGIN api is slow" },
    { id: "a2", kind: "agent" as const, text: "Done." },
  ];

  it("opens on request, jumps to the message, and steps through hits", () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const { rerender } = render(
      <SessionTerminal {...base} segments={segments} findRequest={{ query: "login", nonce: 1 }} />,
    );
    const input = screen.getByRole("searchbox", { name: "Find in chat" });
    expect((input as HTMLInputElement).value).toBe("login");
    expect(screen.getByText("1 of 3")).toBeTruthy();
    const current = () => document.querySelector(".session-find-current")?.getAttribute("data-segment-id");
    expect(current()).toBe("u1");
    expect(scroll).toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(current()).toBe("a1");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(current()).toBe("t1");
    // A hit inside collapsed reasoning opens it.
    expect((document.querySelector('[data-segment-id="t1"] details') as HTMLDetailsElement).open).toBe(true);
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(current()).toBe("a1");

    // A jump from Search all chats lands on that message.
    rerender(
      <SessionTerminal
        {...base}
        segments={segments}
        findRequest={{ query: "login", segmentId: "t1", occurrence: 0, nonce: 2 }}
      />,
    );
    expect(current()).toBe("t1");
    expect(screen.getByText("3 of 3")).toBeTruthy();

    fireEvent.keyDown(screen.getByRole("searchbox", { name: "Find in chat" }), { key: "Escape" });
    expect(screen.queryByRole("searchbox", { name: "Find in chat" })).toBeNull();
    expect(current()).toBeUndefined();
  });

  it("hands the query to Search all chats", () => {
    const onSearchAll = vi.fn();
    Element.prototype.scrollIntoView = vi.fn();
    render(
      <SessionTerminal
        {...base}
        segments={segments}
        findRequest={{ query: "nothing here", nonce: 1 }}
        onSearchAllChats={onSearchAll}
      />,
    );
    expect(screen.getByText("No results")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Search all chats" }));
    expect(onSearchAll).toHaveBeenCalledWith("nothing here");
  });
});
