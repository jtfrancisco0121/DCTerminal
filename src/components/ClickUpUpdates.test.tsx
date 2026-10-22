// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClickUpProposal, ClickUpWritebackView } from "../bridge";

vi.mock("../bridge", () => ({
  clickupWritebackLoad: vi.fn(),
  clickupWritebackEdit: vi.fn(),
  clickupWritebackSend: vi.fn(),
  clickupListStatuses: vi.fn(),
  clickupStatusMapSet: vi.fn(),
}));
const { confirmMock } = vi.hoisted(() => ({ confirmMock: vi.fn(async (_options: unknown) => true) }));
vi.mock("./confirm", () => ({ useConfirm: () => confirmMock }));

import {
  clickupListStatuses,
  clickupStatusMapSet,
  clickupWritebackEdit,
  clickupWritebackLoad,
  clickupWritebackSend,
} from "../bridge";
import { ClickUpUpdates, rowsToSend, sendResultText, sendRows, sentAsIs } from "./ClickUpUpdates";

const LIST = { id: "901800112233", name: "QA 1.2.8" };

function proposal(id: string, extra: Partial<ClickUpProposal> = {}): ClickUpProposal {
  return {
    ticket: { id, title: `Ticket ${id}`, url: `https://app.clickup.com/t/${id}`, list: LIST },
    comment: `Update from DCTerminal for ${id}.`,
    status: "QA PASSED",
    verified: true,
    ticked: false,
    edited: false,
    ...extra,
  };
}

function view(proposals: ClickUpProposal[], extra: Partial<ClickUpWritebackView> = {}): ClickUpWritebackView {
  return {
    runId: "ee_1",
    accountId: "default",
    accountName: "Work",
    proposals,
    lists: [{ ...LIST, verified: "QA PASSED" }],
    ...extra,
  };
}

function row(name: string) {
  return screen.getByRole("listitem", { name: `ClickUp update for ${name}` });
}

describe("ClickUp updates on the chain overview (C3)", () => {
  beforeEach(() => {
    vi.mocked(clickupListStatuses).mockResolvedValue({
      ...LIST,
      statuses: [
        { status: "to do", kind: "open" },
        { status: "QA PASSED", kind: "custom" },
        { status: "complete", kind: "closed" },
      ],
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows nothing for a run with no ClickUp updates", async () => {
    vi.mocked(clickupWritebackLoad).mockResolvedValue(null);
    const { container } = render(<ClickUpUpdates runId="ee_1" refreshKey="a" />);
    await waitFor(() => expect(clickupWritebackLoad).toHaveBeenCalledWith("ee_1"));
    expect(container.textContent).toBe("");
  });

  it("lists one unticked row per ticket and never sends without a tick", async () => {
    vi.mocked(clickupWritebackLoad).mockResolvedValue(view([proposal("t1"), proposal("t2")]));
    render(<ClickUpUpdates runId="ee_1" refreshKey="a" />);
    await screen.findByRole("region", { name: "ClickUp updates" });
    expect(screen.getByText(/sent with Work's ClickUp/)).toBeTruthy();
    for (const name of ["t1", "t2"]) {
      expect(within(row(name)).getByRole("checkbox")).toHaveProperty("checked", false);
    }
    const send = screen.getByRole("button", { name: "Send ticked (0)" });
    expect(send).toHaveProperty("disabled", true);
    fireEvent.click(send);
    expect(clickupWritebackSend).not.toHaveBeenCalled();
  });

  it("a tick is saved, then Send ticked posts and says what happened", async () => {
    vi.mocked(clickupWritebackLoad).mockResolvedValue(view([proposal("t1"), proposal("t2")]));
    vi.mocked(clickupWritebackEdit).mockResolvedValue(view([proposal("t1", { ticked: true }), proposal("t2")]));
    vi.mocked(clickupWritebackSend).mockResolvedValue({
      view: view([
        proposal("t1", { sent: { at: "2026-10-22T12:00:00Z", comment: "Update from DCTerminal for t1.", status: "QA PASSED" } }),
        proposal("t2"),
      ]),
      sent: 1,
      failed: 0,
      notSent: [],
    });
    render(<ClickUpUpdates runId="ee_1" refreshKey="a" />);
    await screen.findByRole("region", { name: "ClickUp updates" });
    fireEvent.click(within(row("t1")).getByRole("checkbox"));
    await waitFor(() => expect(clickupWritebackEdit).toHaveBeenCalledWith("ee_1", "t1", { ticked: true }));
    const send = await screen.findByRole("button", { name: "Send ticked (1)" });
    fireEvent.click(send);
    await waitFor(() =>
      expect(clickupWritebackSend).toHaveBeenCalledWith("ee_1", [
        { ticketId: "t1", comment: "Update from DCTerminal for t1.", status: "QA PASSED" },
      ]),
    );
    expect(await screen.findByText("Sent 1 update.")).toBeTruthy();
    expect(within(row("t1")).getByText(/Sent .*status QA PASSED/)).toBeTruthy();
    // Sent and unchanged: it cannot be ticked again until you edit it.
    expect(within(row("t1")).getByRole("checkbox")).toHaveProperty("disabled", true);
  });

  it("edits the comment on blur, the status from the list's real statuses, and skips a row", async () => {
    vi.mocked(clickupWritebackLoad).mockResolvedValue(view([proposal("t1")]));
    vi.mocked(clickupWritebackEdit).mockResolvedValue(view([proposal("t1", { comment: "Mine.", edited: true })]));
    render(<ClickUpUpdates runId="ee_1" refreshKey="a" />);
    await screen.findByRole("region", { name: "ClickUp updates" });
    const comment = screen.getByLabelText("Comment for t1");
    fireEvent.change(comment, { target: { value: "Mine." } });
    fireEvent.blur(comment);
    await waitFor(() => expect(clickupWritebackEdit).toHaveBeenCalledWith("ee_1", "t1", { comment: "Mine." }));
    await waitFor(() => expect(clickupListStatuses).toHaveBeenCalledWith("default", LIST.id));
    const status = screen.getByLabelText("Status for t1") as HTMLSelectElement;
    await waitFor(() => expect(within(status).getByRole("option", { name: "complete" })).toBeTruthy());
    expect(Array.from(status.options).map((o) => o.text)).toEqual(["No status change", "to do", "QA PASSED", "complete"]);
    fireEvent.change(status, { target: { value: "" } });
    await waitFor(() =>
      expect(clickupWritebackEdit).toHaveBeenCalledWith("ee_1", "t1", { setStatus: true, status: null }),
    );
    fireEvent.click(within(row("t1")).getByRole("button", { name: "Skip" }));
    await waitFor(() => expect(clickupWritebackEdit).toHaveBeenCalledWith("ee_1", "t1", { skipped: true }));
  });

  it("maps a list's verified status, then reloads the proposals", async () => {
    vi.mocked(clickupWritebackLoad).mockResolvedValue(
      view([proposal("t1", { status: undefined, statusNote: 'Map a verified status for the list "QA 1.2.8" to propose one.' })], {
        lists: [LIST],
      }),
    );
    vi.mocked(clickupStatusMapSet).mockResolvedValue([{ ...LIST, verified: "QA PASSED" }]);
    render(<ClickUpUpdates runId="ee_1" refreshKey="a" />);
    expect(await screen.findByText(/Map a verified status for the list/)).toBeTruthy();
    const map = screen.getByLabelText("Verified status for QA 1.2.8") as HTMLSelectElement;
    await waitFor(() => expect(map.disabled).toBe(false));
    fireEvent.change(map, { target: { value: "QA PASSED" } });
    await waitFor(() => expect(clickupStatusMapSet).toHaveBeenCalledWith("default", LIST.id, "QA PASSED"));
    await waitFor(() => expect(clickupWritebackLoad).toHaveBeenCalledTimes(2));
  });

  it("shows a failed row's error and reloads when the run changes", async () => {
    vi.mocked(clickupWritebackLoad).mockResolvedValue(
      view([proposal("t1", { ticked: true, error: "Could not reach ClickUp. Check your connection." })]),
    );
    const { rerender } = render(<ClickUpUpdates runId="ee_1" refreshKey="a" />);
    expect(await screen.findByText("Not sent: Could not reach ClickUp. Check your connection.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send ticked (1)" })).toHaveProperty("disabled", false);
    rerender(<ClickUpUpdates runId="ee_1" refreshKey="b" />);
    await waitFor(() => expect(clickupWritebackLoad).toHaveBeenCalledTimes(2));
  });

  it("a row that may have been posted asks you to confirm before it is ticked again", async () => {
    vi.mocked(clickupWritebackLoad).mockResolvedValue(
      view([proposal("t1", { sentMaybe: true, error: "ClickUp did not answer in time, so it may have posted the comment anyway." })]),
    );
    vi.mocked(clickupWritebackEdit).mockResolvedValue(view([proposal("t1", { ticked: true })]));
    render(<ClickUpUpdates runId="ee_1" refreshKey="a" />);
    expect(await screen.findByText(/May have been posted: check the ticket/)).toBeTruthy();
    confirmMock.mockResolvedValueOnce(false);
    fireEvent.click(within(row("t1")).getByRole("checkbox"));
    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    expect(clickupWritebackEdit).not.toHaveBeenCalled();
    confirmMock.mockResolvedValueOnce(true);
    fireEvent.click(within(row("t1")).getByRole("checkbox"));
    await waitFor(() =>
      expect(clickupWritebackEdit).toHaveBeenCalledWith("ee_1", "t1", { ticked: true, confirmResend: true }),
    );
  });

  it("says which ticked rows were not sent because they changed, and marks follow-ups", async () => {
    vi.mocked(clickupWritebackLoad).mockResolvedValue(view([proposal("t1", { ticked: true, followUp: true })]));
    vi.mocked(clickupWritebackSend).mockResolvedValue({
      view: view([proposal("t1", { followUp: true })]),
      sent: 0,
      failed: 0,
      notSent: [{ ticketId: "t1", reason: "Changed since you ticked it. Review it and tick it again." }],
    });
    render(<ClickUpUpdates runId="ee_1" refreshKey="a" />);
    expect(await screen.findByText(/Follow-up/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Send ticked (1)" }));
    expect(
      await screen.findByText("Sent 0 updates. t1 not sent: Changed since you ticked it. Review it and tick it again."),
    ).toBeTruthy();
  });

  it("a Send clicked right after editing a comment carries the saved edit", async () => {
    vi.mocked(clickupWritebackLoad).mockResolvedValue(view([proposal("t1", { ticked: true })]));
    vi.mocked(clickupWritebackEdit).mockResolvedValue(
      view([proposal("t1", { ticked: true, comment: "Mine.", edited: true })]),
    );
    vi.mocked(clickupWritebackSend).mockResolvedValue({ view: view([proposal("t1")]), sent: 1, failed: 0, notSent: [] });
    render(<ClickUpUpdates runId="ee_1" refreshKey="a" />);
    await screen.findByRole("region", { name: "ClickUp updates" });
    const comment = screen.getByLabelText("Comment for t1");
    fireEvent.change(comment, { target: { value: "Mine." } });
    fireEvent.blur(comment);
    fireEvent.click(screen.getByRole("button", { name: "Send ticked (1)" }));
    await waitFor(() =>
      expect(clickupWritebackSend).toHaveBeenCalledWith("ee_1", [{ ticketId: "t1", comment: "Mine.", status: "QA PASSED" }]),
    );
  });

  it("counts rows to send and says results in words", () => {
    const sent = proposal("t1", { ticked: true, sent: { at: "t", comment: "Update from DCTerminal for t1.", status: "QA PASSED" } });
    expect(sentAsIs(sent)).toBe(true);
    expect(sentAsIs({ ...sent, comment: "Edited." })).toBe(false);
    const rows = [
      sent,
      proposal("t2", { ticked: true }),
      proposal("t3", { ticked: true, skipped: true }),
      proposal("t4"),
      proposal("t5", { ticked: true, sentMaybe: true }),
    ];
    expect(rowsToSend(rows).map((p) => p.ticket.id)).toEqual(["t2"]);
    expect(sendRows(rows)).toEqual([{ ticketId: "t2", comment: "Update from DCTerminal for t2.", status: "QA PASSED" }]);
    // A status-only send recorded no comment: the row is not sent as it is.
    expect(sentAsIs({ ...sent, sent: { at: "t", status: "QA PASSED" } })).toBe(false);
    expect(sendResultText(2, 0)).toBe("Sent 2 updates.");
    expect(sendResultText(1, 1)).toBe("Sent 1 update. 1 failed: see its row.");
    expect(sendResultText(0, 2)).toBe("Sent 0 updates. 2 failed: see their rows.");
  });
});
