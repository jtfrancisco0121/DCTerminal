// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryHit } from "../bridge";
import { ChatSearchDialog } from "./ChatSearchDialog";

const hit = (partial: Partial<HistoryHit>): HistoryHit => ({
  source: "open",
  tabId: "t_saved",
  label: "Planner · Koneksi",
  cwd: "/w/Koneksi",
  updatedAt: "2026-10-06T08:00:00Z",
  occurrence: 0,
  totalInSource: 1,
  before: "fix the ",
  matched: "login",
  after: " flow",
  ...partial,
});

describe("ChatSearchDialog", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("searches live chats and saved history, and jumps to a message", async () => {
    const search = vi.fn(async () => [
      hit({ source: "open", tabId: "t_live", label: "Dev (stale saved copy)" }),
      hit({}),
      hit({ source: "closed", tabId: "t_closed", label: "Reviewer · PR 12", occurrence: 2 }),
    ]);
    const onJump = vi.fn();
    render(
      <ChatSearchDialog
        initialQuery=""
        liveSources={[
          {
            tabId: "t_live",
            label: "Developer · Koneksi",
            segments: [
              { id: "s1", kind: "user", text: "Check the login page" },
              { id: "s2", kind: "agent", text: "The login page is fine." },
            ],
          },
        ]}
        search={search}
        loadTranscript={vi.fn()}
        onJump={onJump}
        onClose={() => {}}
      />,
    );
    const input = screen.getByRole("searchbox", { name: "Search chats" });
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "login" } });
    await waitFor(() => expect(search).toHaveBeenCalledWith("login"));
    const list = await screen.findByRole("listbox", { name: "Search results" });
    await waitFor(() => expect(within(list).getAllByRole("option")).toHaveLength(4));
    const rows = within(list).getAllByRole("option").map((o) => o.textContent ?? "");
    expect(rows[0]).toContain("Developer · Koneksi");
    expect(rows[0]).toContain("Check the login page");
    expect(rows.some((r) => r.includes("stale saved copy"))).toBe(false);
    expect(rows[3]).toContain("Closed tab");

    fireEvent.click(within(list).getAllByRole("option")[1]);
    expect(onJump).toHaveBeenLastCalledWith(
      expect.objectContaining({ source: "live", tabId: "t_live", segmentId: "s2", occurrence: 0 }),
      "login",
    );
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onJump).toHaveBeenLastCalledWith(
      expect.objectContaining({ source: "closed", tabId: "t_closed", occurrence: 2 }),
      "login",
    );
  });

  it("previews an archived transcript at the hit instead of opening a tab", async () => {
    const search = vi.fn(async () => [
      hit({ source: "archived", tabId: "t_old", label: "Saved chat · Koneksi", occurrence: 1 }),
    ]);
    const loadTranscript = vi.fn(async () => "login one\nother\nlogin two\n");
    const onJump = vi.fn();
    render(
      <ChatSearchDialog
        initialQuery="login"
        liveSources={[]}
        search={search}
        loadTranscript={loadTranscript}
        onJump={onJump}
        onClose={() => {}}
      />,
    );
    const option = await screen.findByRole("option", { name: /Saved chat · Koneksi/ });
    await act(async () => {
      fireEvent.click(option);
    });
    expect(loadTranscript).toHaveBeenCalledWith("t_old");
    expect(onJump).not.toHaveBeenCalled();
    const preview = await screen.findByLabelText("Transcript preview");
    const current = preview.querySelector(".search-hit-current");
    expect(current?.textContent).toBe("login");
    expect(preview.querySelectorAll("mark")).toHaveLength(2);
    expect(preview.querySelectorAll("mark")[1]).toBe(current);
  });
});
