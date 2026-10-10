// The Files side panel (src/components/FilePanel.tsx).
import type { Page } from "@playwright/test";
import type { FileContent, FileEntry } from "../../src/bridge";
import { CWD } from "./fixtures/data";
import { expect, test, type TauriApp } from "./fixtures/tauri";

// 1×1 transparent PNG.
const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const MAIN_TS = 'import { run } from "./run";\n\nexport const answer: number = 42;\n\nfunction hello(name: string) {\n  return `hi ${name}`;\n}\n';

type Tree = Record<string, FileEntry[]>;
type Contents = Record<string, Omit<FileContent, "path" | "absPath" | "mtimeMs"> | { error: string }>;

const TREE: Tree = {
  "": [
    { name: "src", path: "src", isDir: true, size: 0 },
    { name: "big.log", path: "big.log", isDir: false, size: 12 * 1024 * 1024 },
    { name: "blob.bin", path: "blob.bin", isDir: false, size: 2048 },
    { name: "gone.txt", path: "gone.txt", isDir: false, size: 5 },
    { name: "logo.png", path: "logo.png", isDir: false, size: 68 },
  ],
  src: [{ name: "main.ts", path: "src/main.ts", isDir: false, size: MAIN_TS.length }],
};

const CONTENTS: Contents = {
  "src/main.ts": { size: MAIN_TS.length, kind: "text", text: MAIN_TS, dataBase64: null, mime: null },
  "logo.png": { size: 68, kind: "image", text: null, dataBase64: PNG_1PX, mime: "image/png" },
  "blob.bin": { size: 2048, kind: "binary", text: null, dataBase64: null, mime: null },
  "big.log": { size: 12 * 1024 * 1024, kind: "tooLarge", text: null, dataBase64: null, mime: null },
  "gone.txt": { error: "No such file or directory (os error 2)" },
};

const fileHandlers = {
  files_list: (args: any) => {
    const tree = (window as any).__panelsFiles.tree;
    if (!tree[args.path]) throw new Error(`not a folder: ${args.path}`);
    return { root: "/Users/e2e/Projects/demo", path: args.path, entries: tree[args.path], truncated: false };
  },
  files_read: (args: any) => {
    const content = (window as any).__panelsFiles.contents[args.path];
    if (!content || content.error) throw new Error(content?.error ?? "missing");
    return {
      ...content,
      path: args.path,
      absPath: `/Users/e2e/Projects/demo/${args.path}`,
      mtimeMs: (window as any).__panelsFiles.mtime,
    };
  },
};

const folderItem = (page: Page, path: string) =>
  page.getByRole("treeitem").filter({ has: page.locator(`[data-path="${path}"]`) }).first();

async function openWithFiles(app: TauriApp, page: Page, extra: Record<string, (args: any, state: any) => unknown> = {}) {
  await page.addInitScript(
    (d) => {
      (window as any).__panelsFiles = d;
    },
    { tree: TREE, contents: CONTENTS, mtime: 1000 },
  );
  await app.open({
    handlers: {
      ...fileHandlers,
      // The layout saved last time had the file panel open.
      get_layout: (_args: any, state: any) => {
        state.layout.filePanelOpen = true;
        return state.layout;
      },
      ...extra,
    },
  });
  const panel = page.getByRole("complementary", { name: "Files" });
  await expect(panel).toBeVisible();
  return panel;
}

test("Mod+B toggles the file panel and the choice is saved with the layout", async ({ app, page }) => {
  await page.addInitScript(
    (d) => {
      (window as any).__panelsFiles = d;
    },
    { tree: TREE, contents: CONTENTS, mtime: 1000 },
  );
  await app.open({ handlers: fileHandlers });
  const turn = await app.start("tab-1");
  await turn.reply("Ready.");
  const panel = page.getByRole("complementary", { name: "Files" });
  await expect(panel).toBeHidden();

  await page.getByRole("textbox", { name: "Follow-up message" }).press("ControlOrMeta+b");
  await expect(panel).toBeVisible();
  await app.waitForCall("set_layout", (args: any) => args.layout.filePanelOpen === true);
  const listed = await app.waitForCall("files_list");
  expect(listed.args).toEqual({ tabId: "tab-1", path: "" });
  await expect(panel.locator(".file-panel-root")).toHaveText("demo");
  await expect(panel.getByRole("tree").getByRole("treeitem")).toHaveCount(5);

  await panel.getByRole("button", { name: "Close file panel" }).click();
  await expect(panel).toBeHidden();
  await app.waitForCall("set_layout", (args: any) => args.layout.filePanelOpen === false);
});

test("opening a source file shows it syntax-highlighted", async ({ app, page }) => {
  const panel = await openWithFiles(app, page);
  const src = folderItem(page, "src");
  await expect(src).toHaveAttribute("aria-expanded", "false");
  await src.locator('[data-path="src"]').click();
  await expect(src).toHaveAttribute("aria-expanded", "true");
  await app.waitForCall("files_list", (args) => args.path === "src");
  await panel.getByRole("button", { name: "main.ts" }).click();

  const read = await app.waitForCall("files_read");
  expect(read.args).toEqual({ tabId: "tab-1", path: "src/main.ts" });
  await expect(panel.locator(".file-preview-name")).toHaveText("src/main.ts");
  await expect(panel.locator(".file-preview-name")).toHaveAttribute("title", `${CWD}/src/main.ts`);
  await expect(panel.locator(".file-preview-bar .hint")).toHaveText(`${MAIN_TS.length} B`);
  const code = panel.locator("pre.file-code code");
  await expect(code).toHaveClass("language-typescript");
  await expect(code.locator(".hljs-keyword").first()).toHaveText("import");
  await expect(code.locator(".hljs-string").first()).toHaveText('"./run"');
  await expect(code.locator(".hljs-number")).toHaveText("42");
  await expect(code).toContainText("function hello(name: string)");
  // Keywords are colored differently from plain text.
  const colors = await code.evaluate((el) => {
    const kw = el.querySelector(".hljs-keyword")!;
    return [getComputedStyle(kw).color, getComputedStyle(el).color];
  });
  expect(colors[0]).not.toBe(colors[1]);

  // Collapse the folder again.
  await src.locator('[data-path="src"]').click();
  await expect(src).toHaveAttribute("aria-expanded", "false");
  await expect(panel.getByRole("button", { name: "main.ts" })).toBeHidden();
});

test("image, binary, too-large, and unreadable files", async ({ app, page }) => {
  const panel = await openWithFiles(app, page);

  await panel.getByRole("button", { name: "logo.png" }).click();
  const img = panel.getByRole("img", { name: "logo.png" });
  await expect(img).toBeVisible();
  await expect(img).toHaveAttribute("src", `data:image/png;base64,${PNG_1PX}`);
  expect(await img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(1);
  // Images and binaries cannot be edited.
  await expect(panel.getByRole("button", { name: "Edit" })).toHaveCount(0);

  await panel.getByRole("button", { name: "blob.bin" }).click();
  await expect(panel.getByText("Binary file. No preview.")).toBeVisible();
  await expect(panel.locator(".file-preview-bar .hint")).toHaveText("2.0 KB");
  await expect(img).toHaveCount(0);

  await panel.getByRole("button", { name: "big.log" }).click();
  await expect(panel.getByText("This file is too large to preview (12.0 MB).")).toBeVisible();
  await expect(panel.locator("pre.file-code")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Edit" })).toHaveCount(0);

  await panel.getByRole("button", { name: "gone.txt" }).click();
  await expect(panel.getByText("No such file or directory (os error 2)")).toBeVisible();
  await expect(panel.locator(".file-preview")).toHaveCount(0);
});

test("dragging the edge resizes the panel within its limits and saves the width", async ({ app, page }) => {
  const panel = await openWithFiles(app, page);
  const shell = page.locator(".file-panel-shell");
  const handle = page.getByRole("separator", { name: "Resize file panel" });
  await expect(shell).toHaveCSS("width", "280px");

  const drag = async (dx: number) => {
    const box = (await handle.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx / 2, y, { steps: 2 });
    await page.mouse.move(x + dx, y, { steps: 2 });
    await page.mouse.up();
  };

  await drag(120);
  await expect(shell).toHaveCSS("width", "400px");
  await app.waitForCall("set_layout", (args: any) => args.layout.filePanelWidth === 400);

  // Never wider than 900 px or narrower than 160 px.
  await drag(800);
  await expect(shell).toHaveCSS("width", "900px");
  await drag(-1200);
  await expect(shell).toHaveCSS("width", "160px");
  await app.waitForCall("set_layout", (args: any) => args.layout.filePanelWidth === 160);
  await expect(panel).toBeVisible();
});

test("a saved width is restored from the layout", async ({ app, page }) => {
  await openWithFiles(app, page, {
    get_layout: (_args: any, state: any) => {
      state.layout.filePanelOpen = true;
      state.layout.filePanelWidth = 520;
      return state.layout;
    },
  });
  await expect(page.locator(".file-panel-shell")).toHaveCSS("width", "520px");
});

test("Edit and Save; a file changed on disk asks to overwrite or reload", async ({ app, page }) => {
  const panel = await openWithFiles(app, page, {
    files_write: (args: any) => {
      const files = (window as any).__panelsFiles;
      if (!args.force && args.expectedMtimeMs !== files.mtime) {
        throw new Error("CONFLICT: the file changed on disk");
      }
      files.mtime += 1;
      files.contents[args.path].text = args.text;
      return { mtimeMs: files.mtime, size: args.text.length };
    },
  });
  await folderItem(page, "src").locator('[data-path="src"]').click();
  await panel.getByRole("button", { name: "main.ts" }).click();
  await panel.getByRole("button", { name: "Edit" }).click();
  const editor = panel.getByRole("textbox", { name: "Edit src/main.ts" });
  await expect(editor).toBeFocused();
  await expect(panel.getByRole("button", { name: "Save" })).toBeDisabled();
  await editor.fill("export const answer = 43;\n");
  await expect(panel.locator(".file-preview-name")).toHaveText("src/main.ts •");
  await panel.getByRole("button", { name: "Save" }).click();
  const write = await app.waitForCall("files_write");
  expect(write.args).toEqual({
    tabId: "tab-1",
    path: "src/main.ts",
    text: "export const answer = 43;\n",
    expectedMtimeMs: 1000,
    force: false,
  });
  await expect(panel.getByText("Saved.")).toBeVisible();
  await expect(panel.locator(".file-preview-name")).toHaveText("src/main.ts");

  // Someone else writes the file.
  await page.evaluate(() => {
    (window as any).__panelsFiles.mtime = 5000;
  });
  await editor.fill("export const answer = 44;\n");
  await panel.getByRole("button", { name: "Save" }).click();
  const conflict = panel.getByRole("alert");
  await expect(conflict).toContainText("This file changed on disk after you opened it.");
  await conflict.getByRole("button", { name: "Overwrite" }).click();
  await app.waitForCall("files_write", (args) => args.force === true);
  await expect(conflict).toBeHidden();
  await expect(panel.getByText("Saved.")).toBeVisible();

  await panel.getByRole("button", { name: "View" }).click();
  await expect(panel.locator("pre.file-code")).toContainText("answer = 44");
});
