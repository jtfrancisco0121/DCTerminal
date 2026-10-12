// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { isTabStop, RadioGroup, radioProps } from "./RadioGroup";

function Demo({ checked, onPick }: { checked: string | null; onPick: (id: string) => void }) {
  const ids = ["a", "b", "c"];
  return (
    <RadioGroup label="Letters">
      {ids.map((id, index) => (
        <button
          key={id}
          type="button"
          {...radioProps(checked === id, isTabStop(checked === id, checked !== null, index))}
          disabled={id === "b" && checked === "c"}
          onClick={() => onPick(id)}
        >
          {id}
        </button>
      ))}
    </RadioGroup>
  );
}

describe("RadioGroup", () => {
  it("exposes radio semantics with one tab stop", () => {
    render(<Demo checked="b" onPick={() => {}} />);
    expect(screen.getByRole("radiogroup", { name: "Letters" })).toBeTruthy();
    const radios = screen.getAllByRole("radio");
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
    expect(radios.map((r) => r.getAttribute("tabindex"))).toEqual(["-1", "0", "-1"]);
  });

  it("gives the first radio the tab stop when nothing is checked", () => {
    render(<Demo checked={null} onPick={() => {}} />);
    expect(screen.getAllByRole("radio").map((r) => r.getAttribute("tabindex"))).toEqual([
      "0",
      "-1",
      "-1",
    ]);
  });

  it("moves with the arrows, wraps, skips disabled radios, and honours Home and End", () => {
    const onPick = vi.fn();
    render(<Demo checked="a" onPick={onPick} />);
    const [a, , c] = screen.getAllByRole("radio");
    a.focus();
    fireEvent.keyDown(a, { key: "ArrowRight" });
    expect(onPick).toHaveBeenLastCalledWith("b");
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowLeft" });
    expect(onPick).toHaveBeenLastCalledWith("a");
    fireEvent.keyDown(a, { key: "ArrowLeft" });
    expect(onPick).toHaveBeenLastCalledWith("c");
    c.focus();
    fireEvent.keyDown(c, { key: "Home" });
    expect(onPick).toHaveBeenLastCalledWith("a");
    fireEvent.keyDown(document.activeElement as Element, { key: "End" });
    expect(onPick).toHaveBeenLastCalledWith("c");
  });
});
