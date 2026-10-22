// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../bridge", () => ({
  clickupIntakeCheck: vi.fn(),
  clickupIntakePull: vi.fn(),
}));

import { clickupIntakeCheck, clickupIntakePull } from "../bridge";
import { changedText, TicketsSinceIntake } from "./TicketsSinceIntake";

describe("Changed since intake (C2)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows nothing for a run with no snapshot or no changes", async () => {
    vi.mocked(clickupIntakeCheck).mockResolvedValue(null);
    const { container, rerender } = render(<TicketsSinceIntake runId="ee_1" />);
    await vi.waitFor(() => expect(clickupIntakeCheck).toHaveBeenCalledWith("ee_1"));
    expect(container.textContent).toBe("");
    vi.mocked(clickupIntakeCheck).mockResolvedValue({ checkedAt: "t", tickets: 3, changed: [] });
    rerender(<TicketsSinceIntake runId="ee_2" />);
    await vi.waitFor(() => expect(clickupIntakeCheck).toHaveBeenCalledWith("ee_2"));
    expect(container.textContent).toBe("");
  });

  it("lists the changed tickets and Pull again re-reads them", async () => {
    vi.mocked(clickupIntakeCheck).mockResolvedValue({
      checkedAt: "t",
      tickets: 3,
      changed: [
        { id: "86b1aa001", title: "Sync stalls", dateUpdated: "2026-10-22T10:00:00.000Z" },
        { id: "86b1aa002", title: "Duplicate log lines", missing: true },
      ],
    });
    vi.mocked(clickupIntakePull).mockResolvedValue({ checkedAt: "t", tickets: 3, changed: [] });
    render(<TicketsSinceIntake runId="ee_1" />);
    expect(await screen.findByText("2 tickets changed since intake")).toBeTruthy();
    expect(screen.getByText(/no longer in ClickUp/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pull again" }));
    await vi.waitFor(() => expect(clickupIntakePull).toHaveBeenCalledWith("ee_1", ["86b1aa001", "86b1aa002"]));
    await vi.waitFor(() => expect(screen.queryByText(/changed since intake/)).toBeNull());
  });

  it("says when the check could not reach ClickUp", async () => {
    vi.mocked(clickupIntakeCheck).mockRejectedValue("Could not reach ClickUp. Check your connection.");
    render(<TicketsSinceIntake runId="ee_1" />);
    expect(await screen.findByText(/Could not check the ClickUp tickets: Could not reach ClickUp/)).toBeTruthy();
  });

  it("counts in words", () => {
    expect(changedText(1)).toBe("1 ticket changed since intake");
    expect(changedText(4)).toBe("4 tickets changed since intake");
  });
});
