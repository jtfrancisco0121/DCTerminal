// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef, type Ref } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../bridge", () => ({
  scratchLoad: vi.fn(async () => ({ pads: [] })),
  scratchSave: vi.fn(async () => {}),
}));

import { scratchLoad, scratchSave } from "../bridge";
import { useScratchPads } from "../useScratchPads";
import { TerminalScratchPad, type TerminalPadHandle } from "./TerminalScratchPad";

const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";

function renderPad(
  overrides: Partial<{
    tabId: string;
    ptyId: string;
    content: string;
    platform: "mac" | "windows";
    bracketedPaste: boolean;
    write: (ptyId: string, data: string) => Promise<void>;
    onFocusTerminal: () => void;
    onFocusPad: () => void;
    onChange: (value: string) => void;
    onOpenChange: (open: boolean) => void;
    onSent: (text: string) => void;
    onOpenLibrary: () => void;
  }> = {},
  ref?: Ref<TerminalPadHandle>,
) {
  const write = overrides.write ?? vi.fn(async () => {});
  const onFocusTerminal = overrides.onFocusTerminal ?? vi.fn();
  const view = render(
    <TerminalScratchPad
      ref={ref}
      tabId={overrides.tabId ?? "tab-1"}
      ptyId={overrides.ptyId ?? "pty-1"}
      content={overrides.content ?? "line1\nline2"}
      truncated={false}
      persistError={null}
      platform={overrides.platform ?? "mac"}
      onChange={overrides.onChange ?? (() => {})}
      write={write}
      bracketedPaste={overrides.bracketedPaste ?? true}
      onFocusTerminal={onFocusTerminal}
      onFocusPad={overrides.onFocusPad}
      onOpenChange={overrides.onOpenChange}
      onSent={overrides.onSent}
      onOpenLibrary={overrides.onOpenLibrary}
    />,
  );
  return { write, onFocusTerminal, ...view };
}

function editor(): HTMLTextAreaElement {
  return screen.getByLabelText("Scratch pad editor") as HTMLTextAreaElement;
}

describe("terminal scratch pad", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("renders under a terminal tab and hides chat-only actions", () => {
    renderPad();
    expect(screen.getByRole("region", { name: "Scratch pad" })).toBeTruthy();
    expect(screen.getByText(/⌘\+Shift\+\. send/)).toBeTruthy();
    expect(screen.getByText(/⌘\+J focus/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Paste to terminal" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Transfer" })).toBeNull();
    expect(screen.queryByRole("button", { name: "To terminal" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Send steps" })).toBeNull();
    expect(screen.queryByText(/---/)).toBeNull();
    expect(editor().closest(".terminal-slot, .xterm")).toBeNull();
  });

  it("uses Ctrl in the hint off macOS", () => {
    renderPad({ platform: "windows" });
    expect(screen.getByText(/Ctrl\+Shift\+\. send/)).toBeTruthy();
    expect(screen.queryByText(/⌘/)).toBeNull();
  });

  it("sends the whole pad as one bracketed prompt plus a single Enter", () => {
    const { write } = renderPad({ ptyId: "pty-cli" });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(
      "pty-cli",
      `${PASTE_START}line1\nline2${PASTE_END}\r`,
    );
  });

  it("pastes without Enter and keeps a selection instead of the whole pad", () => {
    const { write } = renderPad({ ptyId: "pty-cli", content: "alpha\nbeta" });
    editor().setSelectionRange(0, 5);
    fireEvent.click(screen.getByRole("button", { name: "Paste to terminal" }));
    expect(write).toHaveBeenCalledWith("pty-cli", `${PASTE_START}alpha${PASTE_END}`);
    const data = vi.mocked(write).mock.calls[0]?.[1] ?? "";
    expect(data).not.toContain("\r");
  });

  it("does not wrap or submit when bracketed paste is off", () => {
    const { write } = renderPad({ bracketedPaste: false });
    fireEvent.click(screen.getByRole("button", { name: "Paste to terminal" }));
    expect(write).toHaveBeenCalledWith("pty-1", "line1\nline2");
  });

  it("does not write keystrokes or Escape, and Escape returns to the terminal", () => {
    const leak = vi.fn();
    const helper = document.createElement("textarea");
    helper.className = "xterm-helper";
    helper.addEventListener("keydown", (event) => {
      if (document.activeElement === helper) leak(event.key);
    });
    document.body.appendChild(helper);
    helper.focus();
    const onFocusTerminal = vi.fn();
    const { write } = renderPad({
      onFocusTerminal,
      onFocusPad: () => helper.blur(),
    });
    fireEvent.focus(editor());
    expect(document.activeElement).not.toBe(helper);
    fireEvent.keyDown(editor(), { key: "a" });
    fireEvent.change(editor(), { target: { value: "a" } });
    fireEvent.keyDown(editor(), { key: "Escape" });
    expect(onFocusTerminal).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
    expect(leak).not.toHaveBeenCalled();
    helper.remove();
  });

  it("reopens a collapsed pad and focuses it", () => {
    const ref = createRef<TerminalPadHandle>();
    renderPad({}, ref);
    fireEvent.click(screen.getByRole("button", { name: "Hide pad" }));
    const hiddenEditor = document.querySelector(
      ".scratch-pad-input",
    ) as HTMLTextAreaElement;
    expect(hiddenEditor.hidden).toBe(true);
    act(() => {
      ref.current?.focus();
    });
    expect(editor().hidden).toBe(false);
    expect(document.activeElement).toBe(editor());
  });

  it("asks the terminal to refit when the pad is hidden or shown, not on mount", () => {
    const onOpenChange = vi.fn();
    const ref = createRef<TerminalPadHandle>();
    renderPad({ onOpenChange }, ref);
    expect(onOpenChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Hide pad" }));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByRole("button", { name: "Show pad" }));
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    expect(onOpenChange).toHaveBeenCalledTimes(2);
    act(() => {
      ref.current?.focus();
    });
    expect(onOpenChange).toHaveBeenCalledTimes(2);
  });

  it("can share Hide/Show and the pad height with the chat pad (U2)", () => {
    const onOpenToggle = vi.fn();
    const onHeightCommit = vi.fn();
    const { rerender } = render(
      <TerminalScratchPad
        tabId="tab-1"
        ptyId="pty-1"
        content="x"
        truncated={false}
        persistError={null}
        platform="mac"
        onChange={() => {}}
        write={vi.fn(async () => {})}
        bracketedPaste
        onFocusTerminal={() => {}}
        open
        onOpenToggle={onOpenToggle}
        height={120}
        onHeightChange={() => {}}
        onHeightCommit={onHeightCommit}
      />,
    );
    expect(editor().style.height).toBe("120px");
    fireEvent.keyDown(screen.getByRole("separator", { name: "Resize scratch pad" }), { key: "ArrowUp" });
    expect(onHeightCommit).toHaveBeenCalledWith(144);
    fireEvent.click(screen.getByRole("button", { name: "Hide pad" }));
    expect(onOpenToggle).toHaveBeenCalledWith(false);
    // Controlled: stays open until the parent says otherwise.
    expect(editor().hidden).toBe(false);
    rerender(
      <TerminalScratchPad
        tabId="tab-1"
        ptyId="pty-1"
        content="x"
        truncated={false}
        persistError={null}
        platform="mac"
        onChange={() => {}}
        write={vi.fn(async () => {})}
        bracketedPaste
        onFocusTerminal={() => {}}
        open={false}
        onOpenToggle={onOpenToggle}
      />,
    );
    expect((document.querySelector(".scratch-pad-input") as HTMLTextAreaElement).hidden).toBe(true);
  });

  it("keeps a separate pad for each tab", async () => {
    vi.mocked(scratchLoad).mockResolvedValue({
      pads: [
        {
          tabId: "tab-a",
          content: "saved a",
          updatedAt: "2026-10-06T00:00:00Z",
          history: [],
        },
        {
          tabId: "tab-b",
          content: "saved b",
          updatedAt: "2026-10-06T00:00:00Z",
          history: [],
        },
      ],
    });
    const write = vi.fn(async () => {});

    function Harness({ tabId }: { tabId: string }) {
      const scratch = useScratchPads(tabId);
      return (
        <TerminalScratchPad
          tabId={tabId}
          ptyId={tabId}
          content={scratch.content}
          truncated={scratch.truncated}
          persistError={scratch.persistError}
          platform="mac"
          onChange={(value) => scratch.setContent(tabId, value)}
          onBlur={() => scratch.flush()}
          write={write}
          bracketedPaste
          onFocusTerminal={() => {}}
        />
      );
    }

    const view = render(<Harness tabId="tab-a" />);
    expect(await screen.findByDisplayValue("saved a")).toBeTruthy();
    view.rerender(<Harness tabId="tab-b" />);
    expect(await screen.findByDisplayValue("saved b")).toBeTruthy();
    fireEvent.change(editor(), { target: { value: "edited b" } });
    view.rerender(<Harness tabId="tab-a" />);
    expect(await screen.findByDisplayValue("saved a")).toBeTruthy();
    fireEvent.change(editor(), { target: { value: "edited a" } });
    fireEvent.blur(editor());
    await waitFor(() => {
      expect(scratchSave).toHaveBeenCalledWith("tab-a", "edited a", []);
    });
    expect(scratchSave).toHaveBeenCalledWith("tab-b", "edited b", []);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(write).toHaveBeenCalledWith(
      "tab-a",
      `${PASTE_START}edited a${PASTE_END}\r`,
    );
  });
});

describe("terminal scratch pad and the prompt library (F6)", () => {
  it("records Send and Paste for recent sends and empties the pad after each", async () => {
    const onSent = vi.fn();
    const onChange = vi.fn();
    const ref = createRef<TerminalPadHandle>();
    renderPad({ content: "  run the tests  ", onSent, onChange }, ref);
    fireEvent.click(screen.getByRole("button", { name: "Paste to terminal" }));
    await waitFor(() => expect(onSent).toHaveBeenCalledWith("  run the tests  "));
    expect(onChange).toHaveBeenLastCalledWith("");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(2));
    expect(ref.current?.field()).toBe(editor());
  });

  it("sends only the selection and keeps the rest of the pad", async () => {
    const onChange = vi.fn();
    const write = vi.fn(async (_ptyId: string, _data: string) => {});
    renderPad({ content: "keep me\nrun this\nkeep too", onChange, write });
    const field = editor();
    field.setSelectionRange(8, 16);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("keep me\nkeep too"));
    expect(write.mock.calls[0][1]).toContain("run this");
  });

  it("keeps the pad when the write fails", async () => {
    const onChange = vi.fn();
    const onSent = vi.fn();
    renderPad({
      content: "npm test",
      onChange,
      onSent,
      write: vi.fn(async () => {
        throw new Error("pty closed");
      }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onChange).not.toHaveBeenCalled();
    expect(onSent).not.toHaveBeenCalled();
  });

  it("opens the prompt library from the pad", () => {
    const onOpenLibrary = vi.fn();
    renderPad({ onOpenLibrary });
    fireEvent.click(screen.getByRole("button", { name: "Prompts" }));
    expect(onOpenLibrary).toHaveBeenCalledTimes(1);
  });
});
