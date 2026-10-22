// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClickUpIntakePreview } from "../bridge";

vi.mock("../bridge", () => ({
  clickupIntakeStatus: vi.fn(),
  clickupIntakePreview: vi.fn(),
}));

import { clickupIntakePreview, clickupIntakeStatus } from "../bridge";
import { EMPTY_INTAKE, intakeStart, type IntakeDraft } from "../clickup/intakeModel";
import { ClickUpIntake } from "./ClickUpIntake";

const preview: ClickUpIntakePreview = {
  parents: [{ kind: "task", id: "7xk2epic01", title: "QA 1.2.8 Medium/Low fixes", url: "u", tickets: 3 }],
  tickets: [
    { id: "86b1aa001", customId: "QA-129", title: "Sync stalls", priority: "high", status: "to do", statusType: "open", url: "u1" },
    { id: "86b1aa002", title: "Duplicate log lines", priority: "normal", status: "qa failed", statusType: "custom", url: "u2" },
  ],
  excluded: [
    { id: "86b1aa003", title: "Lock files", priority: "none", status: "closed", statusType: "closed", url: "u3", reason: "Status is \"closed\" (closed)" },
  ],
  problems: [{ line: 2, message: "ClickUp has no task with that id, or this account can't see it." }],
  seenStatuses: ["to do", "qa failed"],
  seenTags: ["desktop"],
};

function renderBox(onOpenIntegrations = vi.fn()) {
  const draftRef = { current: EMPTY_INTAKE as IntakeDraft };
  render(<ClickUpIntake draftRef={draftRef} onOpenIntegrations={onOpenIntegrations} />);
  return { draftRef, onOpenIntegrations };
}

describe("Tickets from ClickUp (C2)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("points to Settings › Integrations when this window's account has no ClickUp", async () => {
    vi.mocked(clickupIntakeStatus).mockResolvedValue({ accountId: "home", accountName: "Home", configured: false });
    const { onOpenIntegrations } = renderBox();
    fireEvent.click(await screen.findByRole("button", { name: "Open Settings › Integrations" }));
    expect(onOpenIntegrations).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/set up ClickUp for Home/)).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Tickets from ClickUp" })).toBeNull();
  });

  it("fetches what you paste, shows the tickets and the excluded ones, and Start takes the ticked ones", async () => {
    vi.mocked(clickupIntakeStatus).mockResolvedValue({
      accountId: "default",
      accountName: "Work",
      configured: true,
      workspaceName: "Koneksi QA",
    });
    vi.mocked(clickupIntakePreview).mockResolvedValue(preview);
    const { draftRef } = renderBox();
    const box = await screen.findByRole("textbox", { name: /Tickets from ClickUp/ });
    fireEvent.change(box, {
      target: { value: "https://app.clickup.com/t/7xk2epic01\n86zzzz999\nsee the epic" },
    });
    expect(screen.getByText("Line 3 is not a ClickUp task or list link.")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "High" }));
    fireEvent.click(screen.getByRole("button", { name: "Fetch" }));
    await screen.findByRole("table", { name: "Tickets to start with" });
    expect(clickupIntakePreview).toHaveBeenCalledWith(
      [
        { kind: "task", id: "7xk2epic01", line: 1 },
        { kind: "task", id: "86zzzz999", line: 2 },
      ],
      { priorities: ["high"], statuses: [], tags: [] },
    );
    expect(screen.getByText("Line 2: ClickUp has no task with that id, or this account can't see it.")).toBeTruthy();
    const excluded = screen.getByRole("list", { name: "Excluded tickets" });
    expect(within(excluded).getByText(/Status is "closed" \(closed\)/)).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("2 of 2 tickets ticked · 1 excluded");

    fireEvent.click(screen.getByRole("checkbox", { name: "Take 86b1aa002: Duplicate log lines" }));
    expect(screen.getByRole("status").textContent).toBe("1 of 2 tickets ticked · 1 excluded");
    // Lines it could not read were shown; Start takes the ticked tickets of the rest.
    expect(intakeStart(draftRef.current)).toMatchObject({ kind: "ready", ticketIds: ["86b1aa001"], filters: { priorities: ["high"] } });
  });

  it("asks for a new Fetch once the links change", async () => {
    vi.mocked(clickupIntakeStatus).mockResolvedValue({ accountId: "default", accountName: "Work", configured: true });
    vi.mocked(clickupIntakePreview).mockResolvedValue({ ...preview, problems: [] });
    const { draftRef } = renderBox();
    const box = await screen.findByRole("textbox", { name: /Tickets from ClickUp/ });
    fireEvent.change(box, { target: { value: "https://app.clickup.com/t/7xk2epic01" } });
    fireEvent.click(screen.getByRole("button", { name: "Fetch" }));
    await screen.findByRole("table", { name: "Tickets to start with" });
    expect(intakeStart(draftRef.current)).toMatchObject({ kind: "ready", ticketIds: ["86b1aa001", "86b1aa002"] });
    fireEvent.change(box, { target: { value: "https://app.clickup.com/t/7xk2epic01\n86b1aa009" } });
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText(/changed since Fetch/)).toBeTruthy();
    expect(intakeStart(draftRef.current).kind).toBe("blocked");
  });

  it("offers the statuses and tags Fetch saw as filters, and sends them on the next Fetch", async () => {
    vi.mocked(clickupIntakeStatus).mockResolvedValue({ accountId: "default", accountName: "Work", configured: true });
    vi.mocked(clickupIntakePreview).mockResolvedValue({ ...preview, problems: [] });
    renderBox();
    fireEvent.change(await screen.findByRole("textbox", { name: /Tickets from ClickUp/ }), {
      target: { value: "https://app.clickup.com/t/7xk2epic01" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Fetch" }));
    await screen.findByRole("table", { name: "Tickets to start with" });
    fireEvent.click(screen.getByRole("checkbox", { name: "qa failed" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "desktop" }));
    expect(screen.getByText(/changed since Fetch/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Fetch" }));
    await vi.waitFor(() =>
      expect(clickupIntakePreview).toHaveBeenLastCalledWith([{ kind: "task", id: "7xk2epic01", line: 1 }], {
        priorities: [],
        statuses: ["qa failed"],
        tags: ["desktop"],
      }),
    );
  });

  it("asks again when the window comes back, so setting ClickUp up shows at once", async () => {
    vi.mocked(clickupIntakeStatus).mockResolvedValueOnce({ accountId: "default", accountName: "Work", configured: false });
    vi.mocked(clickupIntakeStatus).mockResolvedValue({ accountId: "default", accountName: "Work", configured: true });
    renderBox();
    await screen.findByRole("button", { name: "Open Settings › Integrations" });
    window.dispatchEvent(new Event("focus"));
    expect(await screen.findByRole("textbox", { name: /Tickets from ClickUp/ })).toBeTruthy();
    expect(clickupIntakeStatus).toHaveBeenCalledTimes(2);
  });

  it("shows a Fetch error as ClickUp said it", async () => {
    vi.mocked(clickupIntakeStatus).mockResolvedValue({ accountId: "default", accountName: "Work", configured: true });
    vi.mocked(clickupIntakePreview).mockRejectedValue("ClickUp rejected the token. Check it under Settings › Integrations.");
    renderBox();
    fireEvent.change(await screen.findByRole("textbox", { name: /Tickets from ClickUp/ }), { target: { value: "86b1aa001" } });
    fireEvent.click(screen.getByRole("button", { name: "Fetch" }));
    await waitFor(() => expect(screen.getByText(/ClickUp rejected the token/)).toBeTruthy());
  });
});
