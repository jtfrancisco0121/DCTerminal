// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../bridge", () => ({
  filesList: vi.fn(),
  filesRead: vi.fn(),
  filesWrite: vi.fn(),
  filesReveal: vi.fn(),
}));

import { filesList, filesRead, filesWrite } from "../bridge";
import { ConfirmHost } from "./confirm";
import { FilePanel, type FileDiscardGuard } from "./FilePanel";

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

  // The discard question is the app's shared confirm dialog (useConfirm).
  const withHost = (ui: ReactElement) => (
    <>
      {ui}
      <ConfirmHost />
    </>
  );

  it("asks before dropping unsaved edits when opening another file", async () => {
    render(
      withHost(
        <FilePanel tabId="t1" cwd="/work/app" platform="mac" onInsertReference={() => {}} onClose={() => {}} />,
      ),
    );
    fireEvent.click(await screen.findByText("README.md"));
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Edit README.md"), { target: { value: "changed" } });
    readMock.mockClear();
    fireEvent.click(screen.getByText("src"));
    fireEvent.click(await screen.findByText("main.ts"));
    expect(await screen.findByRole("alertdialog", { name: "Discard unsaved edits" })).toBeTruthy();
    expect(readMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(readMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("main.ts"));
    fireEvent.click(await screen.findByRole("button", { name: "Discard edits" }));
    await waitFor(() => expect(readMock).toHaveBeenCalledWith("t1", "src/main.ts"));
  });

  const editReadme = async () => {
    fireEvent.click(await screen.findByText("README.md"));
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Edit README.md"), { target: { value: "changed" } });
  };

  it("asks before the close button drops unsaved edits", async () => {
    const onClose = vi.fn();
    render(
      withHost(
        <FilePanel tabId="t1" cwd="/work/app" platform="mac" onInsertReference={() => {}} onClose={onClose} />,
      ),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Close file panel" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    await editReadme();
    fireEvent.click(screen.getByRole("button", { name: "Close file panel" }));
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Close file panel" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard edits" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(2));
  });

  it("lets the parent ask before it closes or swaps the panel", async () => {
    const guardRef: { current: FileDiscardGuard | null } = { current: null };
    const { rerender } = render(
      withHost(
        <FilePanel
          tabId="t1"
          cwd="/work/app"
          platform="mac"
          onInsertReference={() => {}}
          onClose={() => {}}
          discardGuardRef={guardRef}
        />,
      ),
    );
    await screen.findByText("README.md");
    expect(guardRef.current?.dirty()).toBe(false);
    await expect(guardRef.current!.confirm()).resolves.toBe(true);
    await editReadme();
    expect(guardRef.current?.dirty()).toBe(true);

    let kept = guardRef.current!.confirm();
    fireEvent.click(await screen.findByRole("button", { name: "Keep editing" }));
    await expect(kept).resolves.toBe(false);
    const dropped = guardRef.current!.confirm();
    fireEvent.click(await screen.findByRole("button", { name: "Discard edits" }));
    await expect(dropped).resolves.toBe(true);

    // The panel goes away while it asks: the edits count as kept.
    kept = guardRef.current!.confirm();
    rerender(withHost(<></>));
    await expect(kept).resolves.toBe(false);
    expect(guardRef.current).toBeNull();
  });

  it("asks before a folder change drops unsaved edits", async () => {
    const props = { tabId: "t1", platform: "mac" as const, onInsertReference: () => {}, onClose: () => {} };
    const { rerender } = render(withHost(<FilePanel {...props} cwd="/work/app" />));
    await editReadme();
    listMock.mockClear();
    rerender(withHost(<FilePanel {...props} cwd="/work/other" />));
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    expect(listMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep my edits" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect((screen.getByLabelText("Edit README.md") as HTMLTextAreaElement).value).toBe("changed");
    expect(listMock).not.toHaveBeenCalled();

    rerender(withHost(<FilePanel {...props} cwd="/work/third" />));
    fireEvent.click(await screen.findByRole("button", { name: "Discard edits" }));
    await waitFor(() => expect(listMock).toHaveBeenCalledWith("t1", ""));
    expect(screen.queryByLabelText("Edit README.md")).toBeNull();
  });

  it("uses the shared panel header", async () => {
    render(
      <FilePanel tabId="t1" cwd="/work/app" platform="mac" onInsertReference={() => {}} onClose={() => {}} />,
    );
    expect(await screen.findByRole("heading", { name: "Files" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close file panel" })).toBeTruthy();
  });

  it("shows a markdown file rendered, with a switch to its highlighted source", async () => {
    render(
      <FilePanel tabId="t1" cwd="/work/app" platform="mac" onInsertReference={() => {}} onClose={() => {}} />,
    );
    fireEvent.click(await screen.findByText("README.md"));
    expect(await screen.findByRole("heading", { name: "Hello" })).toBeTruthy();
    const rendered = screen.getByRole("radio", { name: "Rendered" }) as HTMLInputElement;
    expect(rendered.checked).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "Source" }));
    expect(screen.queryByRole("heading", { name: "Hello" })).toBeNull();
    expect(document.querySelector("pre.file-code")!.textContent).toContain("# Hello");
    // Editing always shows the raw text, so the switch steps aside.
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.queryByRole("radiogroup", { name: "Show markdown as" })).toBeNull();
  });

  it("offers no markdown switch for other text files", async () => {
    readMock.mockResolvedValue({
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
      <FilePanel tabId="t1" cwd="/work/app" platform="mac" onInsertReference={() => {}} onClose={() => {}} />,
    );
    fireEvent.click(await screen.findByText("src"));
    fireEvent.click(await screen.findByText("main.ts"));
    await screen.findByRole("button", { name: "Edit" });
    expect(screen.queryByRole("radiogroup", { name: "Show markdown as" })).toBeNull();
  });
});
