// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MergeQueueView } from "../bridge";

const openUrl = vi.fn();
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: (url: string) => openUrl(url) }));
vi.mock("../bridge", () => ({
  roundMergeQueue: vi.fn(async () => null),
}));

import { roundMergeQueue } from "../bridge";
import { MergeQueue } from "./MergeQueue";

const gh = (repo: string, n: number) => `https://github.com/acme/${repo}/pull/${n}`;

/** The shape of a real round: backend 1 → 2 → 4 → 3, desktop 4 → 6 → 7. */
function queue(): MergeQueueView {
  return {
    roundId: "round_1",
    checkedAt: "2026-10-22T12:00:00Z",
    repos: [
      {
        repo: "backend",
        entries: [
          { planId: "plan1", wave: 1, url: gh("backend", 11), title: "Session expiry", number: 11, state: "merged", base: "staging", next: false, warnings: [] },
          {
            planId: "plan2",
            wave: 2,
            url: gh("backend", 12),
            title: "Heartbeat",
            number: 12,
            state: "open",
            base: "staging",
            next: true,
            warnings: ["Its base (staging) has moved on since it was made: rebase it on staging before it merges."],
          },
          { planId: "plan4", wave: 2, url: gh("backend", 14), title: "Approvals", number: 14, state: "draft", base: "staging", next: false, warnings: [], waitsFor: "plan2 #12" },
          { planId: "plan3", wave: 3, title: "Timestamps", state: "parked", next: false, warnings: [] },
        ],
      },
      {
        repo: "desktop",
        entries: [
          { planId: "plan4", wave: 2, title: "Approvals", state: "missing", next: false, warnings: [] },
          { planId: "plan6", wave: 3, url: gh("desktop", 36), title: "Crashes", number: 36, state: "open", base: "staging", next: false, warnings: [], waitsFor: "plan4's pull request, which it has not opened yet" },
        ],
      },
    ],
  };
}

describe("MergeQueue (R3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openUrl.mockReset().mockResolvedValue(undefined);
  });

  it("lists each repo's pull requests in merge order with the next one highlighted", async () => {
    vi.mocked(roundMergeQueue).mockResolvedValue(queue());
    render(<MergeQueue roundKey="ee_triage" />);
    const backend = await screen.findByRole("region", { name: "Merge queue for backend" });
    const items = within(backend).getAllByRole("listitem").filter((li) => li.classList.contains("pipeline-merge-queue-entry"));
    expect(items.map((li) => li.querySelector("strong")?.textContent)).toEqual(["plan1 #11", "plan2 #12", "plan4 #14", "plan3"]);
    expect(items[1].getAttribute("aria-current")).toBe("step");
    expect(items[1].textContent).toContain("Next to merge");
    expect(items[1].textContent).toContain("rebase it on staging");
    expect(items.filter((li) => li.getAttribute("aria-current") === "step")).toHaveLength(1);
    expect(items[2].textContent).toContain("After plan2 #12.");
    expect(within(backend).getByText(/Next to merge: plan2 #12/)).toBeTruthy();
    // A repo whose first plan has no pull request yet suggests nothing.
    const desktop = screen.getByRole("region", { name: "Merge queue for desktop" });
    expect(desktop.textContent).toContain("Nothing to merge yet: plan4 has no pull request here.");
    expect(desktop.querySelector("[aria-current]")).toBeNull();
  });

  it("is read-only: it opens a pull request in the browser and has no merge, rebase or push button", async () => {
    vi.mocked(roundMergeQueue).mockResolvedValue(queue());
    render(<MergeQueue roundKey="ee_triage" />);
    const backend = await screen.findByRole("region", { name: "Merge queue for backend" });
    const buttons = screen.getAllByRole("button").map((b) => b.textContent ?? "");
    expect(buttons.every((label) => label === "Open on GitHub" || label === "Refresh")).toBe(true);
    fireEvent.click(within(backend).getAllByRole("button", { name: "Open on GitHub" })[1]);
    expect(openUrl).toHaveBeenCalledWith(gh("backend", 12));
  });

  it("reads GitHub again on Refresh and says when it could not", async () => {
    vi.mocked(roundMergeQueue).mockResolvedValueOnce(queue()).mockRejectedValueOnce(new Error("gh is not installed"));
    render(<MergeQueue roundKey="ee_triage" />);
    await screen.findByRole("region", { name: "Merge queue for backend" });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(roundMergeQueue).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/gh is not installed/)).toBeTruthy();
  });
});
