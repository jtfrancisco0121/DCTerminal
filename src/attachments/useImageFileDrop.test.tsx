// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";
import { noteDomImageDrop, useImageFileDrop, filesFromDroppedPaths } from "./useImageFileDrop";
import type { ChatImagesProps } from "./useChatImages";

const handlers: Array<(e: { payload: unknown }) => void> = [];
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: async (fn: (e: { payload: unknown }) => void) => {
      handlers.push(fn);
      return () => {};
    },
  }),
}));
const readFile = vi.fn();
vi.mock("../bridge", () => ({ attachmentReadFile: (p: string) => readFile(p) }));

function Host({ images }: { images: ChatImagesProps }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useImageFileDrop(ref, images);
  return <textarea ref={ref} data-testid="box" />;
}

const props = (): ChatImagesProps => ({ items: [], error: null, onAddFiles: vi.fn(), onRemove: vi.fn(), onError: vi.fn() });
const drop = (paths: string[]) => ({ payload: { type: "drop", paths, position: { x: 5, y: 5 } } });
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

describe("image file drop through Tauri's drag-drop event", () => {
  beforeEach(() => {
    handlers.length = 0;
    readFile.mockReset();
    readFile.mockResolvedValue({ name: "a.png", mime: "image/png", data: btoa("abc") });
    document.elementFromPoint = vi.fn();
  });

  it("attaches dropped image paths when the drop lands on the box", async () => {
    const images = props();
    const { getByTestId } = render(<Host images={images} />);
    await flush();
    (document.elementFromPoint as ReturnType<typeof vi.fn>).mockReturnValue(getByTestId("box"));
    handlers[0](drop(["/x/a.png", "/x/notes.txt"]));
    await flush();
    expect(readFile).toHaveBeenCalledTimes(1);
    expect(readFile).toHaveBeenCalledWith("/x/a.png");
    const files = (images.onAddFiles as ReturnType<typeof vi.fn>).mock.calls[0][0] as File[];
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe("a.png");
    expect(files[0].type).toBe("image/png");
    expect(files[0].size).toBe(3);
  });

  it("hit-tests the drop position unscaled on a 2x Mac screen", async () => {
    const dpr = window.devicePixelRatio;
    Object.defineProperty(window, "devicePixelRatio", { value: 2, configurable: true });
    Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
    try {
      const images = props();
      const { getByTestId } = render(<Host images={images} />);
      await flush();
      const efp = document.elementFromPoint as ReturnType<typeof vi.fn>;
      efp.mockReturnValue(getByTestId("box"));
      handlers[0]({ payload: { type: "drop", paths: ["/x/a.png"], position: { x: 1000, y: 700 } } });
      await flush();
      expect(efp).toHaveBeenCalledWith(1000, 700);
      expect(images.onAddFiles).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, "devicePixelRatio", { value: dpr, configurable: true });
      delete (navigator as unknown as Record<string, unknown>).platform;
    }
  });

  it("ignores drops elsewhere", async () => {
    const images = props();
    render(<Host images={images} />);
    await flush();
    (document.elementFromPoint as ReturnType<typeof vi.fn>).mockReturnValue(document.body);
    handlers[0](drop(["/x/a.png"]));
    await flush();
    expect(images.onAddFiles).not.toHaveBeenCalled();
  });

  it("skips a drop the DOM handler already took, so no image is attached twice", async () => {
    const images = props();
    const { getByTestId } = render(<Host images={images} />);
    await flush();
    const box = getByTestId("box");
    (document.elementFromPoint as ReturnType<typeof vi.fn>).mockReturnValue(box);
    noteDomImageDrop(box);
    handlers[0](drop(["/x/a.png"]));
    await flush();
    expect(images.onAddFiles).not.toHaveBeenCalled();
  });

  it("reports an unreadable file", async () => {
    readFile.mockRejectedValue("big.png is empty or larger than 5 MB.");
    const onError = vi.fn();
    expect(await filesFromDroppedPaths(["/x/big.png"], onError)).toEqual([]);
    expect(onError).toHaveBeenCalledWith("big.png is empty or larger than 5 MB.");
  });
});
