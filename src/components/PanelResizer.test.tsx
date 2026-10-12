// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PanelResizer, resizeKey } from "./PanelResizer";

describe("resizeKey", () => {
  it("steps, jumps and clamps", () => {
    expect(resizeKey("ArrowRight", 280, 160, 900, 16)).toBe(296);
    expect(resizeKey("ArrowLeft", 280, 160, 900, 16, true)).toBe(216);
    expect(resizeKey("ArrowLeft", 170, 160, 900, 16)).toBe(160);
    expect(resizeKey("Home", 280, 160, 900, 16)).toBe(160);
    expect(resizeKey("End", 280, 160, 900, 16)).toBe(900);
    expect(resizeKey("a", 280, 160, 900, 16)).toBeNull();
  });
});

describe("PanelResizer", () => {
  it("is a focusable separator that resizes with the arrow keys", () => {
    const onChange = vi.fn();
    render(<PanelResizer label="Resize file panel" value={280} min={160} max={900} onChange={onChange} />);
    const handle = screen.getByRole("separator", { name: "Resize file panel" });
    expect(handle.getAttribute("tabindex")).toBe("0");
    expect(handle.getAttribute("aria-valuenow")).toBe("280");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith(296);
  });
});
