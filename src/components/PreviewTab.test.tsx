// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));
vi.mock("../bridge", () => ({ setPreviewUrl: vi.fn(async () => {}) }));

import { openUrl } from "@tauri-apps/plugin-opener";
import { setPreviewUrl } from "../bridge";
import { PreviewTab } from "./PreviewTab";

const frame = () => document.querySelector("iframe");

describe("PreviewTab", () => {
  afterEach(() => {
    cleanup();
    vi.mocked(openUrl).mockClear();
    vi.mocked(setPreviewUrl).mockClear();
  });

  it("shows the saved localhost address in a sandboxed frame", () => {
    render(<PreviewTab tabId="t1" url="http://127.0.0.1:3000/docs" onNotice={() => {}} />);
    expect(frame()?.getAttribute("src")).toBe("http://127.0.0.1:3000/docs");
    expect(frame()?.getAttribute("sandbox")).toBe("allow-scripts allow-forms allow-same-origin");
    expect((screen.getByLabelText("Address") as HTMLInputElement).value).toBe(
      "http://127.0.0.1:3000/docs",
    );
  });

  it("loads and saves a typed localhost address", () => {
    render(<PreviewTab tabId="t1" url={null} onNotice={() => {}} />);
    expect(frame()?.getAttribute("src")).toBe("http://localhost:5173");
    fireEvent.change(screen.getByLabelText("Address"), { target: { value: "localhost:8080" } });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(frame()?.getAttribute("src")).toBe("http://localhost:8080");
    expect(setPreviewUrl).toHaveBeenCalledWith("t1", "http://localhost:8080");
  });

  it("does not load another address and offers the browser instead", () => {
    render(<PreviewTab tabId="t1" url="http://localhost:5173" onNotice={() => {}} />);
    fireEvent.change(screen.getByLabelText("Address"), {
      target: { value: "https://example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(frame()).toBeNull();
    expect(screen.getByText("This address opens in your browser.")).toBeTruthy();
    expect(setPreviewUrl).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open https://example.com" }));
    expect(openUrl).toHaveBeenCalledWith("https://example.com");
  });

  it("offers no browser button for a non-web address", () => {
    render(<PreviewTab tabId="t1" url="http://localhost:5173" onNotice={() => {}} />);
    fireEvent.change(screen.getByLabelText("Address"), {
      target: { value: "javascript:alert(1)" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(frame()).toBeNull();
    expect(screen.queryByRole("button", { name: /^Open javascript/ })).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Open in browser" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
