// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
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
