// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClickUpAccountStatus } from "../bridge";

vi.mock("../bridge", () => ({
  clickupStatus: vi.fn(),
  clickupTokenSet: vi.fn(),
  clickupTokenClear: vi.fn(),
  clickupTest: vi.fn(),
  clickupStatusMaps: vi.fn(async () => []),
  clickupStatusMapSet: vi.fn(),
  clickupListStatuses: vi.fn(),
}));

import {
  clickupListStatuses,
  clickupStatus,
  clickupStatusMaps,
  clickupStatusMapSet,
  clickupTest,
  clickupTokenClear,
  clickupTokenSet,
} from "../bridge";
import { IntegrationsSettings } from "./IntegrationsSettings";

const work: ClickUpAccountStatus = {
  accountId: "default",
  accountName: "Work",
  configured: false,
  source: "none",
};
const personal: ClickUpAccountStatus = {
  accountId: "personal",
  accountName: "Personal",
  configured: true,
  source: "keychain",
  workspaceId: "9055555555",
  workspaceName: "Home",
};

const TOKEN = "pk_81234567_LEAKCHECK";

function row(name: string) {
  return screen.getByRole("group", { name: `ClickUp for ${name}` });
}

describe("Settings › Integrations › ClickUp", () => {
  beforeEach(() => {
    vi.mocked(clickupStatus).mockResolvedValue([work, personal]);
    vi.mocked(clickupStatusMaps).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("shows one row per Claude account and says where tokens are kept", async () => {
    render(<IntegrationsSettings />);
    await screen.findByRole("group", { name: "ClickUp for Work" });
    expect(screen.getByRole("heading", { name: "Integrations", level: 3 })).toBeTruthy();
    expect(screen.getByText(/kept in the system keychain and never shown to Claude/)).toBeTruthy();
    expect(screen.getByText(/first account \(Work\) only/)).toBeTruthy();
    expect(within(row("Work")).getByText(/No token yet/)).toBeTruthy();
    expect(within(row("Work")).getByRole("button", { name: "Test" })).toHaveProperty("disabled", true);
    expect(within(row("Personal")).getByText(/Workspace: Home/)).toBeTruthy();
    expect(within(row("Personal")).getByRole("button", { name: "Remove" })).toHaveProperty(
      "disabled",
      false,
    );
  });

  it("saves a token for that account only, clears the field, and tests it", async () => {
    vi.mocked(clickupTokenSet).mockResolvedValue({ ...work, configured: true, source: "keychain" });
    vi.mocked(clickupTest).mockResolvedValue({
      status: {
        ...work,
        configured: true,
        source: "keychain",
        workspaceId: "9012345678",
        workspaceName: "Koneksi QA",
      },
      workspaces: [
        { id: "9012345678", name: "Koneksi QA" },
        { id: "9087654321", name: "Sandbox" },
      ],
    });
    render(<IntegrationsSettings />);
    const field = (await screen.findByLabelText("ClickUp token for Work")) as HTMLInputElement;
    expect(field.type).toBe("password");
    fireEvent.change(field, { target: { value: TOKEN } });
    fireEvent.click(within(row("Work")).getByRole("button", { name: "Save" }));
    expect(await within(row("Work")).findByText("Saved. Connected to Koneksi QA.")).toBeTruthy();
    expect(clickupTokenSet).toHaveBeenCalledWith("default", TOKEN);
    expect(clickupTest).toHaveBeenCalledWith("default");
    expect(field.value).toBe("");
    expect(document.body.textContent).not.toContain(TOKEN);
    expect(within(row("Personal")).getByText(/Workspace: Home/)).toBeTruthy();

    // More than one workspace: pick another, which tests with that id.
    fireEvent.change(within(row("Work")).getByRole("combobox"), {
      target: { value: "9087654321" },
    });
    await waitFor(() => expect(clickupTest).toHaveBeenCalledWith("default", "9087654321"));
  });

  it("shows a failed test inline", async () => {
    vi.mocked(clickupTest).mockRejectedValue(
      "ClickUp rejected the token. Check it under Settings › Integrations.",
    );
    render(<IntegrationsSettings />);
    await screen.findByRole("group", { name: "ClickUp for Personal" });
    fireEvent.click(within(row("Personal")).getByRole("button", { name: "Test" }));
    const alert = await within(row("Personal")).findByRole("alert");
    expect(alert.textContent).toContain("ClickUp rejected the token");
  });

  it("asks before Remove, and does nothing when cancelled", async () => {
    const ask = vi.spyOn(window, "confirm").mockReturnValue(false);
    vi.mocked(clickupTokenClear).mockResolvedValue({
      ...personal,
      configured: false,
      source: "none",
      workspaceId: undefined,
      workspaceName: undefined,
    });
    render(<IntegrationsSettings />);
    await screen.findByRole("group", { name: "ClickUp for Personal" });
    fireEvent.click(within(row("Personal")).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(ask).toHaveBeenCalled());
    expect(clickupTokenClear).not.toHaveBeenCalled();

    ask.mockReturnValue(true);
    fireEvent.click(within(row("Personal")).getByRole("button", { name: "Remove" }));
    expect(await within(row("Personal")).findByText("Removed.")).toBeTruthy();
    expect(clickupTokenClear).toHaveBeenCalledWith("personal");
    expect(within(row("Personal")).getByText(/No token yet/)).toBeTruthy();
  });

  it("a token from the environment cannot be replaced or removed here", async () => {
    vi.mocked(clickupStatus).mockResolvedValue([
      { ...work, configured: true, source: "env" },
      personal,
    ]);
    render(<IntegrationsSettings />);
    await screen.findByRole("group", { name: "ClickUp for Work" });
    expect(within(row("Work")).getByText(/Token from DCT_CLICKUP_TOKEN/)).toBeTruthy();
    expect(within(row("Work")).getByRole("button", { name: "Remove" })).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("ClickUp token for Work")).toHaveProperty("disabled", true);
    expect(within(row("Work")).getByRole("button", { name: "Test" })).toHaveProperty("disabled", false);
  });

  it("says when DCT_CLICKUP_TOKEN is set but is not a token", async () => {
    vi.mocked(clickupStatus).mockResolvedValue([{ ...work, envRejected: true }, personal]);
    render(<IntegrationsSettings />);
    await screen.findByRole("group", { name: "ClickUp for Work" });
    expect(
      within(row("Work")).getByText(/DCT_CLICKUP_TOKEN is set but is not a valid token/),
    ).toBeTruthy();
    expect(within(row("Personal")).queryByText(/is not a valid token/)).toBeNull();
    // The keychain field stays usable.
    expect(screen.getByLabelText("ClickUp token for Work")).toHaveProperty("disabled", false);
  });

  it("lists each account's mapped verified statuses and changes or removes one (C3)", async () => {
    vi.mocked(clickupStatusMaps).mockResolvedValue([
      { accountId: "default", accountName: "Work", lists: [{ id: "901800112233", name: "QA 1.2.8", verified: "QA PASSED" }] },
      { accountId: "personal", accountName: "Personal", lists: [] },
    ]);
    vi.mocked(clickupListStatuses).mockResolvedValue({
      id: "901800112233",
      name: "QA 1.2.8",
      statuses: [
        { status: "to do", kind: "open" },
        { status: "QA PASSED", kind: "custom" },
        { status: "complete", kind: "closed" },
      ],
    });
    vi.mocked(clickupStatusMapSet).mockResolvedValueOnce([
      { id: "901800112233", name: "QA 1.2.8", verified: "complete" },
    ]);
    vi.mocked(clickupStatusMapSet).mockResolvedValueOnce([]);
    render(<IntegrationsSettings />);
    const item = await screen.findByRole("listitem", { name: "Verified status for QA 1.2.8" });
    expect(item.textContent).toContain("QA 1.2.8 → QA PASSED");
    fireEvent.click(within(item).getByRole("button", { name: "Change" }));
    const select = await within(item).findByLabelText("New verified status for QA 1.2.8");
    expect(clickupListStatuses).toHaveBeenCalledWith("default", "901800112233");
    fireEvent.change(select, { target: { value: "complete" } });
    await waitFor(() => expect(clickupStatusMapSet).toHaveBeenCalledWith("default", "901800112233", "complete"));
    await waitFor(() => expect(item.textContent).toContain("QA 1.2.8 → complete"));
    fireEvent.click(within(item).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(clickupStatusMapSet).toHaveBeenLastCalledWith("default", "901800112233", null));
    expect(await screen.findByText("No lists mapped yet.")).toBeTruthy();
  });
});
