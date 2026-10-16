// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEntry } from "../bridge";
import { EMPTY_CHAT, type ChatEntriesState } from "../terminal/chatEntries";

const writes: [string, string][] = [];
vi.mock("../bridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../bridge")>()),
  // No Tauri bridge: a channel that never delivers.
  createPtyChannel: () => ({ onmessage: () => {} }),
  ptyWrite: vi.fn(async (id: string, data: string) => {
    writes.push([id, data]);
  }),
}));
let chat: ChatEntriesState = EMPTY_CHAT;
vi.mock("../terminal/chatEntriesStore", () => ({ useChatEntries: () => chat }));

const { dialogDetector } = await import("../terminal/permissionDialog");
const { beginLivePty, dropLivePty } = await import("../terminal/live");
const { TerminalComposer, composerDraft, forgetComposerDraft } = await import("./TerminalChatControls");
const { TerminalChatView } = await import("./TerminalChatView");

const PROCEED =
  "Bash command\r\n  touch x\r\nDo you want to proceed?\r\n❯ 1. Yes\r\n  2. Yes, and don't ask again\r\n  3. No\r\n";

function composer(props: Partial<Parameters<typeof TerminalComposer>[0]> = {}) {
  return (
    <TerminalComposer
      tabId="c1"
      platform="windows"
      working={false}
      exited={false}
      onShowTerminal={() => {}}
      {...props}
    />
  );
}

const flush = () => act(async () => {});

beforeEach(() => {
  writes.length = 0;
  chat = EMPTY_CHAT;
  forgetComposerDraft("c1");
  forgetComposerDraft("p1");
});

afterEach(() => {
  cleanup();
  dialogDetector.forget("p1");
  vi.useRealTimers();
});

describe("chat view composer", () => {
  it("sends multi-line text as one bracketed paste and Enter, then clears", async () => {
    const onSent = vi.fn();
    render(composer({ onSent }));
    const field = screen.getByRole("textbox", { name: "Message Claude" });
    fireEvent.change(field, { target: { value: "first line\nsecond line" } });
    expect(screen.getByText("Ctrl+Enter")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await flush();
    expect(writes).toEqual([["c1", "\x1b[200~first line\nsecond line\x1b[201~\r"]]);
    expect(onSent).toHaveBeenCalledWith("first line\nsecond line");
    expect((field as HTMLTextAreaElement).value).toBe("");
  });

  it("sends with Mod+Enter", async () => {
    render(composer());
    const field = screen.getByRole("textbox", { name: "Message Claude" });
    fireEvent.change(field, { target: { value: "go" } });
    fireEvent.keyDown(field, { key: "Enter", ctrlKey: true });
    await flush();
    expect(writes).toEqual([["c1", "\x1b[200~go\x1b[201~\r"]]);
  });

  it("queues while Claude works, and Stop sends Esc", async () => {
    render(composer({ working: true }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "next" } });
    expect(screen.getByRole("button", { name: "Queue" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await flush();
    expect(writes).toEqual([["c1", "\x1b"]]);
  });

  it("keeps the draft across a view switch", () => {
    const { unmount } = render(composer());
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "half written" } });
    unmount();
    expect(composerDraft("c1")).toBe("half written");
    render(composer());
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("half written");
  });

  it("walks earlier sends with ArrowUp", () => {
    render(composer({ history: ["newest", "older"] }));
    const field = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.keyDown(field, { key: "ArrowUp" });
    expect(field.value).toBe("newest");
    // A multi-line draft keeps ArrowUp for the caret until it is at the start.
    field.setSelectionRange(0, 0);
    fireEvent.keyDown(field, { key: "ArrowUp" });
    expect(field.value).toBe("older");
  });

  it("offers the terminal instead once Claude Code exited", () => {
    const onShowTerminal = vi.fn();
    render(composer({ exited: true, onShowTerminal }));
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show terminal" }));
    expect(onShowTerminal).toHaveBeenCalled();
  });
});

describe("composer while Claude waits on a dialog", () => {
  const AT = "2026-10-16T10:00:00.000Z";
  const plan = (status: "running" | "done"): ChatEntry => ({
    seq: 0, rev: 1, at: AT, kind: "plan", toolId: "p", plan: "# Plan", status, endedAt: status === "done" ? AT : null,
  });
  const question = (status: "running" | "done"): ChatEntry => ({
    seq: 0, rev: 1, at: AT, kind: "question", toolId: "q", status, endedAt: status === "done" ? AT : null,
    questions: [{ header: "DB", question: "Which DB?", options: ["Postgres"], multiSelect: false }],
  });
  const view = (needsYou: boolean) => (
    <TerminalChatView tabId="p1" needsYou={needsYou} onShowTerminal={() => {}} platform="windows" />
  );

  /** Types a reply and tries Ctrl+Enter and the button: nothing may reach the PTY. */
  async function expectBlocked() {
    const field = screen.getByRole("textbox", { name: "Message Claude" }) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "no, change step 2 first" } });
    fireEvent.keyDown(field, { key: "Enter", ctrlKey: true });
    const send = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(send);
    await flush();
    expect(writes).toEqual([]);
    expect(screen.getByText("Answer the question above, or in the terminal, first.")).toBeTruthy();
    expect(field.value).toBe("no, change step 2 first");
  }

  async function expectSends() {
    expect(screen.queryByText("Answer the question above, or in the terminal, first.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await flush();
    expect(writes).toEqual([["p1", "\x1b[200~no, change step 2 first\x1b[201~\r"]]);
  }

  it("holds while the tab is Needs you, and sends once it clears", async () => {
    const { rerender } = render(view(true));
    await expectBlocked();
    rerender(view(false));
    await expectSends();
  });

  it("holds while a permission dialog is seen", async () => {
    dialogDetector.feed("p1", new TextEncoder().encode(PROCEED));
    render(view(false));
    await expectBlocked();
    act(() => dialogDetector.clear("p1"));
    await expectSends();
  });

  it("holds while a plan approval is open", async () => {
    chat = { sessionId: "s", revision: 1, entries: [plan("running")] };
    const { rerender } = render(view(false));
    await expectBlocked();
    chat = { sessionId: "s", revision: 2, entries: [plan("done")] };
    rerender(view(false));
    await expectSends();
  });

  it("does not hold for a plan an earlier Claude Code left open (crash, then --continue)", async () => {
    // The PTY (re)started after the plan was asked: that process is gone.
    beginLivePty("p1").startedAt = Date.parse(AT) + 60_000;
    chat = { sessionId: "s", revision: 1, entries: [plan("running")] };
    render(view(false));
    const field = screen.getByRole("textbox", { name: "Message Claude" });
    fireEvent.change(field, { target: { value: "no, change step 2 first" } });
    expect(screen.queryByRole("button", { name: "Show terminal" })).toBeNull();
    await expectSends();
    dropLivePty("p1");
  });

  it("holds while a question is open", async () => {
    chat = { sessionId: "s", revision: 1, entries: [question("running")] };
    const { rerender } = render(view(false));
    await expectBlocked();
    chat = { sessionId: "s", revision: 2, entries: [question("done")] };
    rerender(view(false));
    await expectSends();
  });
});

describe("permission card", () => {
  const view = (onShowTerminal = vi.fn()) =>
    render(<TerminalChatView tabId="p1" needsYou onShowTerminal={onShowTerminal} platform="mac" />);

  it("shows the dialog's options as buttons instead of the banner, and presses the digit", async () => {
    dialogDetector.feed("p1", new TextEncoder().encode(PROCEED));
    view();
    const card = screen.getByRole("region", { name: "Permission" });
    expect(card.textContent).toContain("Do you want to proceed?");
    expect(card.textContent).toContain("touch x");
    expect(screen.queryByText("Claude is waiting for you in the terminal.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Yes, and don't ask again/ }));
    await flush();
    expect(writes).toEqual([["p1", "2"]]);
  });

  it("says when the answer did not go through, with a way to the terminal", async () => {
    vi.useFakeTimers();
    dialogDetector.feed("p1", new TextEncoder().encode(PROCEED));
    const onShowTerminal = vi.fn();
    view(onShowTerminal);
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    await act(async () => {
      await Promise.resolve();
    });
    // Claude Code draws the same dialog again: the key did not land.
    dialogDetector.feed("p1", new TextEncoder().encode(PROCEED));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(screen.getByRole("alert").textContent).toContain("Didn't go through");
    fireEvent.click(screen.getAllByRole("button", { name: "Show terminal" })[0]);
    expect(onShowTerminal).toHaveBeenCalled();
  });

  it("says it couldn't confirm when the dialog went by the timer and the PTY drew nothing", async () => {
    vi.useFakeTimers();
    dialogDetector.feed("p1", new TextEncoder().encode(PROCEED));
    const onShowTerminal = vi.fn();
    render(<TerminalChatView tabId="p1" needsYou={false} onShowTerminal={onShowTerminal} platform="mac" />);
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    await act(async () => {
      await Promise.resolve();
    });
    // Claude Code ignored the digit: no output, and the detector's hide timer runs out.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(screen.queryByRole("region", { name: "Permission" })).toBeNull();
    const note = screen.getByRole("alert");
    expect(note.textContent).toContain("Couldn't confirm — check the terminal.");
    fireEvent.click(within(note).getByRole("button", { name: "Show terminal" }));
    expect(onShowTerminal).toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows no note when Claude Code drew after the answer", async () => {
    vi.useFakeTimers();
    dialogDetector.feed("p1", new TextEncoder().encode(PROCEED));
    render(<TerminalChatView tabId="p1" needsYou={false} onShowTerminal={() => {}} platform="mac" />);
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    await act(async () => {
      await Promise.resolve();
    });
    dialogDetector.feed("p1", new TextEncoder().encode("⏺ Bash(touch x)\r\n"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(screen.queryByRole("region", { name: "Permission" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("falls back to the banner when no dialog is seen", () => {
    view();
    expect(screen.queryByRole("region", { name: "Permission" })).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("Claude is waiting for you in the terminal");
  });
});
