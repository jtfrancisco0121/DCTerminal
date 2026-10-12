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
