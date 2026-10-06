// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatHistoryDialog } from "./ChatHistoryDialog";
import type { CursorHistoryEntry } from "../cursorHistory";

const entry: CursorHistoryEntry = {
  id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  source: "acp",
  cwd: "/Users/jt/Koneksi",
  title: "Login",
  updatedAt: null,
  roleName: "Developer",
  userText: "Fix the login",
};

describe("Chat history dialog (F9)", () => {
  it("loads the folder's history and resumes a chat", async () => {
    const load = vi.fn(async () => [entry]);
    const onResume = vi.fn();
    render(
      <ChatHistoryDialog
        folder="/Users/jt/Koneksi"
        load={load}
        busy={false}
        onResume={onResume}
        onOpenCli={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole("dialog", { name: "Chat history" })).toBeTruthy();
    expect(screen.getByText("/Users/jt/Koneksi")).toBeTruthy();
    expect(screen.getByText("Loading…")).toBeTruthy();
    expect(load).toHaveBeenCalledWith("/Users/jt/Koneksi");
    fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
    expect(onResume).toHaveBeenCalledWith(entry);
  });

  it("shows a load error, and asks for a folder when there is none", async () => {
    const load = vi.fn(async () => {
      throw new Error("agent ls failed");
    });
    const { unmount } = render(
      <ChatHistoryDialog
        folder="/x"
        load={load}
        busy={false}
        onResume={() => {}}
        onOpenCli={() => {}}
        onClose={() => {}}
      />,
    );
    expect(await screen.findByText("agent ls failed")).toBeTruthy();
    unmount();

    const none = vi.fn(async () => [entry]);
    const onClose = vi.fn();
    render(
      <ChatHistoryDialog
        folder=""
        load={none}
        busy={false}
        onResume={() => {}}
        onOpenCli={() => {}}
        onClose={onClose}
      />,
    );
    expect(screen.getByText(/Pick a folder for this tab first/)).toBeTruthy();
    expect(none).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Chat history" }), { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
