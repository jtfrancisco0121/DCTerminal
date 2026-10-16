// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mermaidMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}));
vi.mock("mermaid", () => ({ default: mermaidMock }));

import { currentDiagramTheme, renderMermaid, sanitizeSvg } from "./mermaid";

describe("sanitizeSvg", () => {
  it("keeps shapes, text and Mermaid's scoped style", () => {
    const out = sanitizeSvg(
      '<svg id="m"><style>#m .node{fill:red}</style><g class="node"><rect width="4"/><text>Hi</text></g></svg>',
    );
    expect(out).toContain("<rect");
    expect(out).toContain("<text>Hi</text>");
    expect(out).toContain("<style>");
  });

  it("drops script, event handlers, javascript: links and foreignObject HTML", () => {
    const out = sanitizeSvg(
      '<svg onload="alert(1)"><script>alert(2)</script>' +
        '<a href="javascript:alert(3)"><text>x</text></a>' +
        '<foreignObject><div><img src="x" onerror="alert(4)"></div></foreignObject></svg>',
    );
    expect(out).not.toMatch(/onload|onerror|<script|javascript:|foreignObject|<img/i);
  });
});

describe("renderMermaid", () => {
  beforeEach(() => {
    mermaidMock.initialize.mockClear();
    mermaidMock.render.mockReset();
  });
  afterEach(() => {
    delete document.documentElement.dataset.theme;
  });

  it("renders in strict mode with the matching theme and sanitizes the result", async () => {
    mermaidMock.render.mockResolvedValue({ svg: "<svg><script>x</script><rect/></svg>" });
    const svg = await renderMermaid("graph TD; A-->B", "light");
    expect(mermaidMock.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ securityLevel: "strict", theme: "default", startOnLoad: false }),
    );
    expect(svg).toContain("<rect");
    expect(svg).not.toContain("script");

    await renderMermaid("graph TD; A-->B", "dark");
    expect(mermaidMock.initialize).toHaveBeenLastCalledWith(
      expect.objectContaining({ theme: "dark" }),
    );
  });

  it("rejects with Mermaid's error and keeps the next render working", async () => {
    mermaidMock.render.mockRejectedValueOnce(new Error("Parse error on line 1"));
    await expect(renderMermaid("nonsense", "dark")).rejects.toThrow("Parse error");
    mermaidMock.render.mockResolvedValueOnce({ svg: "<svg><rect/></svg>" });
    await expect(renderMermaid("graph TD; A", "dark")).resolves.toContain("<rect");
  });

  it("reads light vs dark from the app theme attribute", () => {
    expect(currentDiagramTheme()).toBe("dark");
    document.documentElement.dataset.theme = "github-light";
    expect(currentDiagramTheme()).toBe("light");
  });
});
