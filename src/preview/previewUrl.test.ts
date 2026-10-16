import { describe, expect, it } from "vitest";
import { isLocalPreviewUrl, isWebUrl, previewAddress } from "./previewUrl";

describe("localhost preview addresses", () => {
  it("loads plain-http localhost and 127.0.0.1 on any port", () => {
    for (const ok of [
      "http://localhost",
      "http://localhost:5173",
      "http://localhost:5173/",
      "http://127.0.0.1:8080/app?x=1#top",
      "HTTP://LOCALHOST:3000/Path",
      "  http://localhost:1  ",
    ]) {
      expect(isLocalPreviewUrl(ok), ok).toBe(true);
    }
  });

  it("refuses every other address", () => {
    for (const bad of [
      "https://localhost:5173",
      "http://localhost.evil.com",
      "http://localhost:80@evil.com",
      "http://localhost@evil.com",
      "http://user:pw@localhost:3000",
      "http://127.0.0.10:80",
      "http://0x7f.0.0.1:80",
      "http://2130706433/",
      "http://[::1]:3000",
      "http://localhost:99999",
      "http://example.com",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "http://localhost:5173/a b",
      "",
    ]) {
      expect(isLocalPreviewUrl(bad), bad).toBe(false);
    }
  });

  it("never frames the app's own origin (a dev build on localhost)", () => {
    expect(isLocalPreviewUrl("http://localhost:1420/", "http://localhost:1420")).toBe(false);
    expect(isLocalPreviewUrl("http://localhost:5173/", "http://localhost:1420")).toBe(true);
    expect(isLocalPreviewUrl("http://localhost:5173/", "tauri://localhost")).toBe(true);
  });

  it("adds http:// to a typed host and port", () => {
    expect(previewAddress("localhost:3000")).toBe("http://localhost:3000");
    expect(previewAddress(" 127.0.0.1:8080/docs ")).toBe("http://127.0.0.1:8080/docs");
    expect(previewAddress("example.com")).toBe("http://example.com");
    expect(previewAddress("https://example.com")).toBe("https://example.com");
    expect(previewAddress("javascript:alert(1)")).toBe("javascript:alert(1)");
    expect(previewAddress("  ")).toBe("");
  });

  it("offers only web addresses to the browser", () => {
    expect(isWebUrl("https://example.com")).toBe(true);
    expect(isWebUrl("http://localhost:3000")).toBe(true);
    expect(isWebUrl("javascript:alert(1)")).toBe(false);
    expect(isWebUrl("file:///etc/passwd")).toBe(false);
    expect(isWebUrl("not a url")).toBe(false);
  });
});
