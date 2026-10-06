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
    fireEvent.click(button);
    fireEvent.change(screen.getByLabelText("Search models"), { target: { value: "gpt" } });
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    fireEvent.click(options[0]);
    expect(onChange).toHaveBeenCalledWith("gpt-5");
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
});
