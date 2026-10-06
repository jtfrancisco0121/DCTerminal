// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CursorHistoryList } from "./CursorHistoryList";
import type { CursorHistoryEntry } from "../cursorHistory";

const entry: CursorHistoryEntry = {
  id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  source: "acp",
  cwd: "C:\\Users\\user\\Documents\\Projects\\Encryptor",
  title: "Senior Software Engineer",
  updatedAt: "2026-10-06T05:29:04.681517200+00:00",
  roleName: "Developer",
  userText: "Encrypt the login",
};

describe("Cursor CLI history list", () => {
  it("uses a plain sentence, the user's title, and a relative time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-06T06:29:04.000Z"));
    render(
      <CursorHistoryList
        entries={[entry]}
        error={null}
        busy={false}
        onResume={() => {}}
        onOpenCli={() => {}}
      />,
    );
    expect(screen.getByText("Saved sessions for this folder.")).toBeTruthy();
    expect(screen.queryByText(/session\/load/)).toBeNull();
    expect(screen.queryByText(/agent ls/)).toBeNull();
    expect(screen.getByText("Developer · Encrypt the login")).toBeTruthy();
    expect(screen.queryByText("Senior Software Engineer")).toBeNull();
    expect(screen.getByText("1 hour ago")).toBeTruthy();
    expect(screen.queryByText(/2026-10-06T05:29/)).toBeNull();
    expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open in Cursor CLI" })).toBeNull();
    vi.useRealTimers();
  });

  it("offers Open in Cursor CLI only for a chat", () => {
    render(
      <CursorHistoryList
        entries={[{ ...entry, source: "cli", title: "Vault notes", roleName: null, userText: null }]}
        error={null}
        busy={false}
        onResume={() => {}}
        onOpenCli={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Open in Cursor CLI" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
  });
});
