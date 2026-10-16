// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_CHAT } from "../terminal/chatEntries";

const writes: [string, string][] = [];
vi.mock("../bridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../bridge")>()),
  ptyWrite: vi.fn(async (id: string, data: string) => {
    writes.push([id, data]);
  }),
}));
vi.mock("../terminal/chatEntriesStore", () => ({ useChatEntries: () => EMPTY_CHAT }));

const { dialogDetector } = await import("../terminal/permissionDialog");
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
  forgetComposerDraft("c1");
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

  it("falls back to the banner when no dialog is seen", () => {
    view();
    expect(screen.queryByRole("region", { name: "Permission" })).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("Claude is waiting for you in the terminal");
  });
});
