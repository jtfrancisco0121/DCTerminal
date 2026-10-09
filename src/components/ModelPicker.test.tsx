// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ModelPicker } from "./ModelPicker";

const models = [
  { id: "composer-2.5", label: "Composer 2.5", fast: false },
  { id: "composer-2.5-fast", label: "Composer 2.5 Fast", fast: true },
  { id: "gpt-5", label: "GPT-5", fast: false },
];

describe("ModelPicker", () => {
  it("shows the inherited model and lets the user search and pick", () => {
    const onChange = vi.fn();
    render(
      <ModelPicker
        models={models}
        value={null}
        inherited={{ model: "composer-2.5", label: "Default" }}
        ariaLabel="Model for tab"
        onChange={onChange}
      />,
    );
    const button = screen.getByRole("button", { name: "Model for tab" });
    expect(button.textContent).toContain("Composer 2.5");
    expect(button.textContent).toContain("default");
    fireEvent.click(button);
    const dialog = screen.getByRole("dialog");
    expect(dialog.className).toContain("model-picker-popover");
    // Portaled to document.body so overflow parents cannot clip it.
    expect(dialog.parentElement).toBe(document.body);
    fireEvent.change(screen.getByLabelText("Search models"), { target: { value: "gpt" } });
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0].className).toContain("model-option");
    expect(options[0].querySelector(".hint")).toBeNull();
    fireEvent.click(options[0]);
    expect(onChange).toHaveBeenCalledWith("gpt-5");
  });

  it("shows a badge on models that carry one", () => {
    render(
      <ModelPicker
        models={[{ id: "claude-fable-5[1m]", label: "Fable 5", fast: false, badge: "may use usage credits" }]}
        value="claude-fable-5[1m]"
        ariaLabel="Model"
        onChange={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Model" }).textContent).toContain(
      "may use usage credits",
    );
  });

  it("flags fast models and can go back to the default", () => {
    const onChange = vi.fn();
    render(
      <ModelPicker
        models={models}
        value="composer-2.5-fast"
        inherited={{ model: "composer-2.5", label: "Default" }}
        ariaLabel="Model for tab"
        onChange={onChange}
      />,
    );
    const button = screen.getByRole("button", { name: "Model for tab" });
    expect(button.textContent).toContain("Fast");
    fireEvent.click(button);
    const input = screen.getByLabelText("Search models");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("closes on Escape without choosing", () => {
    const onChange = vi.fn();
    render(<ModelPicker models={models} value="gpt-5" ariaLabel="Model" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    expect(screen.getByRole("dialog").hasAttribute("data-own-escape")).toBe(true);
    fireEvent.keyDown(screen.getByLabelText("Search models"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("renders each option as one full-width row with label and id", () => {
    render(
      <ModelPicker
        models={models}
        value="composer-2.5"
        ariaLabel="Model"
        onChange={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    const options = screen.getAllByRole("option");
    expect(options.length).toBeGreaterThanOrEqual(3);
    for (const option of options) {
      expect(option.tagName).toBe("BUTTON");
      expect(option.querySelector(".model-option-label")).not.toBeNull();
      expect(option.querySelector(".model-option-main")).not.toBeNull();
    }
    const fast = options.find((o) => o.textContent?.includes("Composer 2.5 Fast"));
    expect(fast?.querySelector(".model-badge")?.textContent).toBe("Fast");
  });
});
