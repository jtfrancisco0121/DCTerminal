// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../bridge", () => ({
  changesList: vi.fn(),
  changesSnapshot: vi.fn(),
  changesFileDiff: vi.fn(),
  changesRevert: vi.fn(),
}));

import { changesFileDiff, changesList, changesRevert, changesSnapshot } from "../bridge";
import { ChangesPanel } from "./ChangesPanel";

const base = "a".repeat(40);
const now = "f".repeat(40);
const changed = (path: string, status: string, cwdPath: string | null = path) => ({
  path,
  cwdPath,
  status,
  oldBlob: "1".repeat(40),
  newBlob: `${path.length}`.repeat(40).slice(0, 40),
  additions: 2,
  deletions: 1,
  binary: false,
});
const okSet = (files = [changed("src/app.ts", "modified"), changed("src/new.ts", "added"), changed("../other.md", "deleted", null)]) => ({
  state: "ok",
  scope: "turn" as const,
  repoRoot: "/r",
  baseTree: base,
  nowTree: now,
  baselineAt: "2026-10-06T10:00:00Z",
  files,
});
const patch = "@@ -1,2 +1,2 @@\n keep\n-old line\n+new line\n";

function Harness(props: { busy?: boolean; onOpen?: (p: string) => void }) {
  const [accepted, setAccepted] = useState<Set<string>>(new Set());
  return (
    <ChangesPanel
      tabId="t1"
      tabLabel="Dev"
      busy={props.busy ?? false}
      accepted={accepted}
      onAccept={(key) => setAccepted((prev) => new Set(prev).add(key))}
      onOpenInFilePanel={props.onOpen ?? (() => {})}
      onClose={() => {}}
    />
  );
}

describe("ChangesPanel", () => {
  beforeEach(() => {
    vi.mocked(changesList).mockReset().mockResolvedValue(okSet());
    vi.mocked(changesFileDiff).mockReset().mockResolvedValue({
      path: "src/app.ts",
      binary: false,
      text: patch,
      truncated: false,
    });
    vi.mocked(changesRevert).mockReset().mockResolvedValue({ reverted: [], skipped: [] });
    vi.mocked(changesSnapshot).mockReset();
  });

  it("lists changed files and shows a unified or side-by-side diff", async () => {
    render(<Harness />);
    const list = await screen.findByRole("listbox", { name: "Changed files" });
    expect(within(list).getAllByRole("option").map((o) => o.textContent)).toEqual([
      expect.stringContaining("src/app.ts"),
      expect.stringContaining("src/new.ts"),
      expect.stringContaining("../other.md"),
    ]);
    expect(vi.mocked(changesList)).toHaveBeenCalledWith("t1", "turn");
    await waitFor(() =>
      expect(vi.mocked(changesFileDiff)).toHaveBeenCalledWith("t1", base, now, "src/app.ts"),
    );
    const table = await screen.findByRole("table", { name: "Diff of src/app.ts" });
    expect(table.textContent).toContain("old line");
    expect(table.textContent).toContain("new line");
    expect(table.getAttribute("data-view")).toBe("unified");

    fireEvent.click(screen.getByRole("radio", { name: "Side by side" }));
    const split = screen.getByRole("table", { name: "Diff of src/app.ts" });
    expect(split.getAttribute("data-view")).toBe("split");
    const row = within(split).getByText("old line").closest("tr")!;
    expect(row.textContent).toContain("new line");

    fireEvent.click(screen.getByRole("radio", { name: "Whole tab" }));
    await waitFor(() => expect(vi.mocked(changesList)).toHaveBeenLastCalledWith("t1", "tab"));
  });

  it("reverts one file only after confirming, and reports skipped files", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValue(true);
    render(<Harness />);
    await screen.findByRole("table", { name: "Diff of src/app.ts" });
    fireEvent.click(screen.getByRole("button", { name: "Revert file" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(changesRevert).not.toHaveBeenCalled();

    vi.mocked(changesRevert).mockResolvedValueOnce({
      reverted: [],
      skipped: [{ path: "src/app.ts", reason: "changed after you looked at it; refresh and review again" }],
    });
    fireEvent.click(screen.getByRole("button", { name: "Revert file" }));
    await waitFor(() =>
      expect(changesRevert).toHaveBeenCalledWith(
        "t1",
        base,
        [{ path: "src/app.ts", newBlob: changed("src/app.ts", "modified").newBlob }],
        true,
      ),
    );
    expect(await screen.findByText(/changed after you looked at it/)).toBeTruthy();
    confirm.mockRestore();
  });

  it("Revert all skips accepted files", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Harness />);
    await screen.findByRole("table", { name: "Diff of src/app.ts" });
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(screen.getByRole("option", { name: /src\/app\.ts/ }).textContent).toContain("Accepted");
    fireEvent.click(screen.getByRole("button", { name: "Revert all…" }));
    expect(confirm.mock.calls[0][0]).toContain("Revert 2 files");
    expect(confirm.mock.calls[0][0]).toContain("1 accepted file is kept");
    await waitFor(() => expect(changesRevert).toHaveBeenCalled());
    const sent = vi.mocked(changesRevert).mock.calls[0][2].map((f) => f.path);
    expect(sent).toEqual(["src/new.ts", "../other.md"]);
    confirm.mockRestore();
  });

  it("will not revert while the agent is working", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<Harness busy />);
    await screen.findByRole("table", { name: "Diff of src/app.ts" });
    expect((screen.getByRole("button", { name: "Revert file" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Revert all…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/still working/)).toBeTruthy();
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it("opens a file in the file panel by its folder-relative path", async () => {
    const onOpen = vi.fn();
    render(<Harness onOpen={onOpen} />);
    await screen.findByRole("table", { name: "Diff of src/app.ts" });
    fireEvent.click(screen.getByRole("button", { name: "Open in file panel" }));
    expect(onOpen).toHaveBeenCalledWith("src/app.ts");
    fireEvent.click(screen.getByRole("option", { name: /other\.md/ }));
    expect((screen.getByRole("button", { name: "Open in file panel" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("explains a folder outside git and a tab without a snapshot", async () => {
    vi.mocked(changesList).mockResolvedValueOnce({ ...okSet([]), state: "noRepo" });
    const { unmount } = render(<Harness />);
    expect(await screen.findByText(/not in a git repository/)).toBeTruthy();
    unmount();

    vi.mocked(changesList).mockResolvedValueOnce({ ...okSet([]), state: "noBaseline" });
    vi.mocked(changesSnapshot).mockResolvedValueOnce(okSet([]));
    render(<Harness />);
    fireEvent.click(await screen.findByRole("button", { name: "Snapshot now" }));
    await waitFor(() => expect(changesSnapshot).toHaveBeenCalledWith("t1"));
    expect(await screen.findByText(/No changes since/)).toBeTruthy();
  });
});
