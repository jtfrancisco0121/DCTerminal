// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const storageStatus = vi.fn(async () => ({ appDataDir: "/tmp/dct", bytes: 5 * 1024 * 1024 }));
const storageCleanup = vi.fn(async () => ({ bytesFreed: 1536, bytes: 1024 }));

vi.mock("../bridge", () => ({
  storageStatus: () => storageStatus(),
  storageCleanup: () => storageCleanup(),
}));

import { formatBytes, StorageRow } from "./StorageRow";

describe("formatBytes", () => {
  it("uses binary units with one decimal", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });
});

describe("StorageRow", () => {
  it("shows the folder size and reports what Clean up now freed", async () => {
    render(<StorageRow />);
    expect(await screen.findByText("5.0 MB")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clean up now" }));
    expect(await screen.findByText("Freed 1.5 KB.")).toBeTruthy();
    expect(screen.getByText("1.0 KB")).toBeTruthy();
    expect(storageCleanup).toHaveBeenCalledTimes(1);
  });

  it("says when there was nothing to clean up", async () => {
    storageCleanup.mockResolvedValueOnce({ bytesFreed: 0, bytes: 10 });
    render(<StorageRow />);
    fireEvent.click(screen.getByRole("button", { name: "Clean up now" }));
    expect(await screen.findByText("Nothing to clean up.")).toBeTruthy();
  });
});
