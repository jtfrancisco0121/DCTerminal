// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Kbd } from "./Kbd";

describe("Kbd", () => {
  it("shows ⌘ on macOS", () => {
    const { container } = render(<Kbd action="send" platform="mac" />);
    expect(container.textContent).toBe("⌘+Enter");
  });

  it("shows Ctrl on Windows and Linux", () => {
    const { container, rerender } = render(<Kbd action="send" platform="windows" />);
    expect(container.textContent).toBe("Ctrl+Enter");
    rerender(<Kbd action="focusPad" platform="linux" />);
    expect(container.textContent).toBe("Ctrl+J");
  });

  it("renders nothing for an unknown action", () => {
    const { container } = render(<Kbd action="noSuchAction" platform="mac" />);
    expect(container.innerHTML).toBe("");
  });

  it("keeps a button's accessible name plain", () => {
    render(
      <button type="button">
        Send <Kbd action="send" platform="mac" />
      </button>,
    );
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
  });
});
