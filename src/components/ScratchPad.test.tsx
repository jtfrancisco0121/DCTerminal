// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { PAD_MAX_HEIGHT, PAD_MIN_HEIGHT, ScratchPad } from "./ScratchPad";

const base = {
  content: "",
  truncated: false,
  persistError: null,
  chain: null,
  disabled: false,
  onChange: () => {},
  onTransfer: () => {},
  onSend: () => {},
  onStopChain: () => {},
};

const editor = () => screen.getByLabelText("Scratch pad editor") as HTMLTextAreaElement;

describe("ScratchPad size (U2)", () => {
  it("starts at three rows with no fixed height", () => {
    render(<ScratchPad {...base} />);
    expect(editor().rows).toBe(3);
    expect(editor().style.height).toBe("");
  });

  it("grows when the handle is dragged up and saves the size on release", () => {
    const onHeightChange = vi.fn();
    const onHeightCommit = vi.fn();
    render(
      <ScratchPad
        {...base}
        height={80}
        onHeightChange={onHeightChange}
        onHeightCommit={onHeightCommit}
      />,
    );
    expect(editor().style.height).toBe("80px");
    const handle = screen.getByRole("separator", { name: "Resize scratch pad" });
    fireEvent.mouseDown(handle, { clientY: 500 });
    fireEvent.mouseMove(window, { clientY: 440 });
    expect(onHeightChange).toHaveBeenLastCalledWith(140);
    fireEvent.mouseMove(window, { clientY: -5000 });
    expect(onHeightChange).toHaveBeenLastCalledWith(PAD_MAX_HEIGHT);
    fireEvent.mouseMove(window, { clientY: 5000 });
    expect(onHeightChange).toHaveBeenLastCalledWith(PAD_MIN_HEIGHT);
    fireEvent.mouseUp(window);
    expect(onHeightCommit).toHaveBeenCalledWith(PAD_MIN_HEIGHT);
    fireEvent.mouseMove(window, { clientY: 100 });
    expect(onHeightChange).toHaveBeenCalledTimes(3);
  });

  it("resizes from the keyboard too", () => {
    const onHeightCommit = vi.fn();
    render(
      <ScratchPad {...base} height={80} onHeightChange={() => {}} onHeightCommit={onHeightCommit} />,
    );
    const handle = screen.getByRole("separator", { name: "Resize scratch pad" });
    fireEvent.keyDown(handle, { key: "ArrowUp" });
    expect(onHeightCommit).toHaveBeenLastCalledWith(104);
    fireEvent.keyDown(handle, { key: "ArrowDown" });
    expect(onHeightCommit).toHaveBeenLastCalledWith(56);
  });

  it("has Hide and Show in chat tabs as well", () => {
    const onToggle = vi.fn();
    const { rerender } = render(<ScratchPad {...base} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole("button", { name: "Hide pad" }));
    expect(onToggle).toHaveBeenCalledOnce();
    rerender(<ScratchPad {...base} onToggle={onToggle} collapsed />);
    expect(editor().hidden).toBe(true);
    expect(screen.queryByRole("separator", { name: "Resize scratch pad" })).toBeNull();
    expect(screen.getByRole("button", { name: "Show pad" })).toBeTruthy();
  });
});

describe("ScratchPad Send (one composer)", () => {
  it("a plain chat pad has no Send button but Ctrl+Enter still sends", () => {
    const onSend = vi.fn();
    render(<ScratchPad {...base} content="hello" onSend={onSend} />);
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Send steps" })).toBeNull();
    expect(screen.getByRole("button", { name: "Transfer" })).toBeTruthy();
    fireEvent.keyDown(editor(), { key: "Enter", ctrlKey: true });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("a chained chat pad keeps only the Send steps entry", () => {
    const onSend = vi.fn();
    render(<ScratchPad {...base} content={"one\n---\ntwo"} onSend={onSend} />);
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send steps" }));
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("a terminal pad keeps its Send button", () => {
    render(<ScratchPad {...base} mode="terminal" content="ls" />);
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
  });
});

describe("ScratchPad compact paste", () => {
  const log = Array.from({ length: 200 }, (_, i) => `  fetched chunk ${i} of 200`).join("\n");

  function Controlled() {
    const [content, setContent] = useState("");
    return <ScratchPad {...base} content={content} onChange={setContent} />;
  }

  it("offers to compact a large paste, never applies it silently, and undoes", async () => {
    render(<Controlled />);
    fireEvent.paste(editor(), { clipboardData: { getData: () => log } });
    fireEvent.change(editor(), { target: { value: log } });
    const compact = await screen.findByRole("button", { name: "Compact this paste" });
    expect(editor().value).toBe(log);
    fireEvent.click(compact);
    expect(editor().value).toBe("  fetched chunk 199 of 200 [×200]");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(editor().value).toBe(log);
    expect(screen.queryByRole("button", { name: "Compact this paste" })).toBeNull();
  });

  it("offers nothing for a short paste", async () => {
    render(<Controlled />);
    fireEvent.paste(editor(), { clipboardData: { getData: () => "short" } });
    fireEvent.change(editor(), { target: { value: "short" } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(screen.queryByRole("button", { name: "Compact this paste" })).toBeNull();
  });

  it("shows the send shortcut on the Send button", () => {
    render(<ScratchPad {...base} mode="terminal" platform="mac" content="hi" />);
    expect(screen.getByRole("button", { name: "Send" }).textContent).toContain("⌘+Enter");
  });
});
