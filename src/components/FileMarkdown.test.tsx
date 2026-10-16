// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../bridge", () => ({ filesMarkdownImage: vi.fn() }));
vi.mock("./MermaidDiagram", () => ({ MermaidDiagram: () => null }));

import { filesMarkdownImage } from "../bridge";
import { FileMarkdown } from "./FileMarkdown";

const PNG = "data:image/png;base64,iVBORw==";

describe("FileMarkdown images", () => {
  beforeEach(() => {
    // Braces: a function returned from beforeEach runs as its teardown.
    vi.mocked(filesMarkdownImage).mockReset();
  });

  it("loads a relative image through the backend, relative to the file", async () => {
    vi.mocked(filesMarkdownImage).mockResolvedValue(PNG);
    render(<FileMarkdown tabId="t1" path="docs/guide.md">{"![Diagram](img/flow.png)"}</FileMarkdown>);
    const img = await screen.findByRole("img", { name: "Diagram" });
    expect(img.getAttribute("src")).toBe(PNG);
    expect(filesMarkdownImage).toHaveBeenCalledWith("t1", "docs/guide.md", "img/flow.png");
  });

  it("an image the backend refuses shows its alt text instead of a broken image", async () => {
    vi.mocked(filesMarkdownImage).mockImplementation(async () => {
      throw new Error("that path leads outside the tab's folder");
    });
    render(<FileMarkdown tabId="t1" path="README.md">{"![Logo](../logo.png)"}</FileMarkdown>);
    const placeholder = await screen.findByText("Logo (image not shown)");
    expect(placeholder.getAttribute("title")).toContain("outside");
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("a remote image is a placeholder with a link that opens it in the browser", () => {
    render(<FileMarkdown tabId="t1" path="README.md">{"![Build badge](https://example.com/badge.svg)"}</FileMarkdown>);
    expect(screen.getByText("Build badge")).toBeTruthy();
    const link = screen.getByRole("link", { name: "Open image" });
    expect(link.getAttribute("href")).toBe("https://example.com/badge.svg");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(screen.queryByRole("img")).toBeNull();
    expect(filesMarkdownImage).not.toHaveBeenCalled();
  });
});
