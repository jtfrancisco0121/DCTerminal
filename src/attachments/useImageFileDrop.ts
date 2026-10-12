import { useEffect, useRef, type RefObject } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { attachmentReadFile } from "../bridge";
import { elementAtDropPosition } from "../dragDropPosition";
import type { ChatImagesProps } from "./useChatImages";

/**
 * With Tauri's native drag-drop handler on (needed for terminal file drops),
 * macOS and Linux no longer deliver the page's own `drop` event for files, so
 * the composer and scratch pad also take images from the Tauri drop event.
 * Windows keeps the handler off and still uses the DOM `drop`.
 */

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
const DOM_DROP_WINDOW_MS = 1000;
let lastDomDrop: { el: EventTarget | null; at: number } | null = null;

/** A DOM drop was handled on this element; the Tauri event for it is skipped. */
export function noteDomImageDrop(el: EventTarget | null) {
  lastDomDrop = { el, at: Date.now() };
}

function base64ToFile(data: string, name: string, mime: string): File {
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], name, { type: mime });
}

/** Image paths among the dropped ones, read into Files; failures go to `onError`. */
export async function filesFromDroppedPaths(
  paths: readonly string[],
  onError?: (message: string) => void,
): Promise<File[]> {
  const files: File[] = [];
  for (const path of paths.filter((p) => IMAGE_EXT.test(p))) {
    try {
      const image = await attachmentReadFile(path);
      files.push(base64ToFile(image.data, image.name, image.mime));
    } catch (err: unknown) {
      onError?.(err instanceof Error ? err.message : String(err));
    }
  }
  return files;
}

export function useImageFileDrop(
  ref: RefObject<HTMLElement | null>,
  images: ChatImagesProps | null | undefined,
) {
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const enabled = !!images;
  useEffect(() => {
    if (!enabled) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    try {
      void getCurrentWebview()
        .onDragDropEvent((event) => {
          const payload = event.payload;
          if (payload.type !== "drop") return;
          const el = ref.current;
          const current = imagesRef.current;
          if (!el || !current) return;
          const target = elementAtDropPosition(payload.position);
          if (!target || !el.contains(target)) return;
          if (lastDomDrop && lastDomDrop.el === el && Date.now() - lastDomDrop.at < DOM_DROP_WINDOW_MS) return;
          void filesFromDroppedPaths(payload.paths, current.onError).then((files) => {
            if (files.length > 0) current.onAddFiles(files);
          });
        })
        .then((fn) => {
          if (disposed) fn();
          else unlisten = fn;
        })
        .catch(() => {});
    } catch {
      // Not running inside Tauri (unit tests, a plain browser).
    }
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [enabled, ref]);
}
