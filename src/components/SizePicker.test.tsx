// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SizePicker } from "./SizePicker";

describe("SizePicker (F3)", () => {
  it("shows the size picked, the suggestion and why, and your pick wins", () => {
    const onPick = vi.fn();
    render(<SizePicker value="M" suggestion={{ size: "L", why: 'it mentions "new tab"' }} onPick={onPick} />);
    const group = screen.getByRole("radiogroup", { name: "Run size" });
    const radios = screen.getAllByRole("radio");
    expect(radios.map((radio) => radio.textContent)).toEqual(["S", "M", "L (suggested)"]);
    expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
    expect(radios[2].getAttribute("title")).toBe("Eagle-Eye L: Brief, PRD and architecture first, then M");
    expect(group.textContent).toContain('Suggested L: it mentions "new tab".');
    expect(group.textContent).toContain("M starts Eagle-Eye 1.");
    fireEvent.click(radios[0]);
    expect(onPick).toHaveBeenCalledWith("S");
  });

  it("is disabled while busy", () => {
    render(<SizePicker value="S" suggestion={{ size: "S", why: "x" }} onPick={vi.fn()} disabled />);
    expect(screen.getAllByRole("radio").every((radio) => (radio as HTMLButtonElement).disabled)).toBe(true);
  });
});
