import { describe, expect, it } from "vitest";
import { escapeHtml, highlightCode, languageFor } from "./highlight";

describe("file preview highlighting", () => {
  it("picks a language from the extension or file name", () => {
    expect(languageFor("src/main.rs")).toBe("rust");
    expect(languageFor("App.tsx")).toBe("typescript");
    expect(languageFor("Cargo.toml")).toBe("ini");
    expect(languageFor("Dockerfile")).toBe("bash");
    expect(languageFor("LICENSE")).toBeNull();
  });

  it("escapes markup, highlighted or not", () => {
    const plain = highlightCode("<script>alert(1)</script>", "notes.unknown");
    expect(plain.language).toBeNull();
    expect(plain.html).not.toContain("<script>");
    const code = highlightCode('const x = "<b>";', "a.ts");
    expect(code.language).toBe("typescript");
    expect(code.html).toContain("hljs-");
    expect(code.html).not.toContain("<b>");
    expect(escapeHtml(`a&"'`)).toBe("a&amp;&quot;&#39;");
  });
});
