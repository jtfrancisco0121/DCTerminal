// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../bridge", () => ({
  filesList: vi.fn(),
  filesRead: vi.fn(),
  filesWrite: vi.fn(),
  filesReveal: vi.fn(),
}));

import { filesList, filesRead, filesWrite } from "../bridge";
import { FilePanel } from "./FilePanel";

const listMock = vi.mocked(filesList);
const readMock = vi.mocked(filesRead);
const writeMock = vi.mocked(filesWrite);

describe("FilePanel", () => {
  beforeEach(() => {
    listMock.mockReset();
    readMock.mockReset();
    writeMock.mockReset();
    listMock.mockImplementation(async (_tab, path = "") => ({
      root: "/work/app",
      path,
      truncated: false,
      entries:
        path === ""
          ? [
              { name: "src", path: "src", isDir: true, size: 0 },
              { name: "README.md", path: "README.md", isDir: false, size: 12 },
            ]
          : [{ name: "main.ts", path: "src/main.ts", isDir: false, size: 20 }],
    }));
    readMock.mockResolvedValue({
      path: "README.md",
      absPath: "/work/app/README.md",
      size: 12,
      mtimeMs: 100,
      kind: "text",
      text: "# Hello\n",
      dataBase64: null,
      mime: null,
    });
  });

  it("lists lazily, previews, and inserts an @file reference", async () => {
    const onInsert = vi.fn();
    render(
      <FilePanel tabId="t1" cwd="/work/app" platform="mac" onInsertReference={onInsert} onClose={() => {}} />,
    );
    expect(await screen.findByText("README.md")).toBeTruthy();
    expect(listMock).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("src"));
    expect(await screen.findByText("main.ts")).toBeTruthy();
    expect(listMock).toHaveBeenLastCalledWith("t1", "src");
    fireEvent.click(screen.getByText("README.md"));
    await waitFor(() => expect(readMock).toHaveBeenCalledWith("t1", "README.md"));
    expect(await screen.findByText("Reveal in Finder")).toBeTruthy();
    fireEvent.click(screen.getByText("Insert @file"));
    expect(onInsert).toHaveBeenCalledWith("README.md");
  });

  it("saves with the opened mtime and shows a conflict bar", async () => {
    writeMock.mockRejectedValueOnce(new Error("CONFLICT: changed on disk"));
    writeMock.mockResolvedValueOnce({ mtimeMs: 200, size: 9 });
    render(
      <FilePanel tabId="t1" cwd="/work/app" platform="linux" onInsertReference={() => {}} onClose={() => {}} />,
    );
    fireEvent.click(await screen.findByText("README.md"));
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const editor = screen.getByLabelText("Edit README.md");
    fireEvent.change(editor, { target: { value: "# Hello!\n" } });
    await act(async () => {
      fireEvent.keyDown(editor, { key: "s", code: "KeyS", ctrlKey: true });
    });
    expect(writeMock).toHaveBeenCalledWith("t1", "README.md", "# Hello!\n", 100, false);
    expect(await screen.findByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Overwrite" }));
    await waitFor(() =>
      expect(writeMock).toHaveBeenLastCalledWith("t1", "README.md", "# Hello!\n", 100, true),
    );
    expect(await screen.findByText("Saved.")).toBeTruthy();
  });

  it("reveals a file from the diff panel: expands its folders, opens it, and takes focus", async () => {
    readMock.mockResolvedValueOnce({
      path: "src/main.ts",
      absPath: "/work/app/src/main.ts",
      size: 20,
      mtimeMs: 5,
      kind: "text",
      text: "export {};\n",
      dataBase64: null,
      mime: null,
    });
    render(
      <FilePanel
        tabId="t1"
        cwd="/work/app"
        platform="mac"
        focusFile={{ path: "src/main.ts", nonce: 1 }}
        onInsertReference={() => {}}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(readMock).toHaveBeenCalledWith("t1", "src/main.ts"));
    expect(listMock).toHaveBeenCalledWith("t1", "src");
    const item = await screen.findByRole("button", { name: /main\.ts/ });
    expect(item.className).toContain("file-tree-item-selected");
    await waitFor(() => expect(document.activeElement).toBe(item));
  });
});
