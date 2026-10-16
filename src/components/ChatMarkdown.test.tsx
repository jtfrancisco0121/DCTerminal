// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatMarkdown } from "./ChatMarkdown";

describe("ChatMarkdown code blocks", () => {
  it("highlights a known language and copies the source", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<ChatMarkdown>{"```ts\nconst x = 1;\n```"}</ChatMarkdown>);
    expect(document.querySelector("code.hljs .hljs-keyword")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("const x = 1;"));
    expect(await screen.findByText("Copied")).toBeTruthy();
  });

  it("shows an unknown language as plain text, still with a copy button", () => {
    render(<ChatMarkdown>{"```\n<b>raw</b>\n```"}</ChatMarkdown>);
    expect(document.querySelector("code")!.textContent).toBe("<b>raw</b>");
    expect(screen.getByRole("button", { name: "Copy code" })).toBeTruthy();
  });
});

const mermaidMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}));
vi.mock("mermaid", () => ({ default: mermaidMock }));

describe("ChatMarkdown mermaid fences", () => {
  it("draws a mermaid fence as a sanitized diagram", async () => {
    mermaidMock.render.mockResolvedValueOnce({
      svg: '<svg onload="alert(1)"><rect/></svg>',
    });
    render(<ChatMarkdown>{"```mermaid\ngraph TD; A-->B\n```"}</ChatMarkdown>);
    const figure = await screen.findByRole("img", { name: "Diagram" });
    expect(figure.querySelector("rect")).toBeTruthy();
    expect(figure.innerHTML).not.toContain("onload");
    expect(mermaidMock.render).toHaveBeenCalledWith(expect.any(String), "graph TD; A-->B");
  });

  it("falls back to the code block with a note when the diagram does not parse", async () => {
    mermaidMock.render.mockRejectedValueOnce(new Error("Parse error on line 1:\n...more"));
    render(<ChatMarkdown>{"```mermaid\nnot a diagram\n```"}</ChatMarkdown>);
    expect(
      await screen.findByText("Couldn’t draw this diagram: Parse error on line 1:"),
    ).toBeTruthy();
    expect(document.querySelector("code")!.textContent).toBe("not a diagram");
  });
});
