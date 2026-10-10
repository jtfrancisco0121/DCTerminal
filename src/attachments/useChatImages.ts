import { useCallback, useMemo, useRef, useState } from "react";
import { attachmentAdd, attachmentRemove } from "../bridge";
import { imageName, pickImages, readImage, type ChatImage } from "./chatImages";

/** What the composer and the scratch pad need to show and edit the chips. */
export type ChatImagesProps = {
  items: ChatImage[];
  error: string | null;
  onAddFiles: (files: File[]) => void;
  onRemove: (id: string) => void;
};

/**
 * Pasted images per tab, waiting for that tab's next send. The composer and
 * the scratch pad share one set: whichever sends first takes them.
 */
export function useChatImages() {
  const itemsRef = useRef<Record<string, ChatImage[]>>({});
  // Images still being read or staged count toward the per-message limit.
  const pendingRef = useRef<Record<string, number>>({});
  const [byTab, setByTab] = useState<Record<string, ChatImage[]>>({});
  const [errors, setErrors] = useState<Record<string, string | null>>({});

  const actions = useMemo(() => {
    const setItems = (tabId: string, items: ChatImage[]) => {
      itemsRef.current = { ...itemsRef.current, [tabId]: items };
      setByTab(itemsRef.current);
    };
    const setError = (tabId: string, error: string | null) =>
      setErrors((prev) => (prev[tabId] === error ? prev : { ...prev, [tabId]: error }));
    return {
      has(tabId: string): boolean {
        return (itemsRef.current[tabId]?.length ?? 0) > 0;
      },
      async addFiles(tabId: string, files: File[]): Promise<void> {
        const count = (itemsRef.current[tabId]?.length ?? 0) + (pendingRef.current[tabId] ?? 0);
        const { accepted, error } = pickImages(files, count);
        setError(tabId, error);
        pendingRef.current[tabId] = (pendingRef.current[tabId] ?? 0) + accepted.length;
        for (const file of accepted) {
          try {
            const { base64, dataUrl } = await readImage(file);
            const staged = await attachmentAdd(tabId, file.type.toLowerCase(), base64);
            setItems(tabId, [
              ...(itemsRef.current[tabId] ?? []),
              {
                id: staged.id,
                name: imageName(file),
                mime: staged.mime,
                bytes: staged.bytes,
                previewUrl: dataUrl,
              },
            ]);
          } catch (err: unknown) {
            setError(tabId, err instanceof Error ? err.message : String(err));
          } finally {
            pendingRef.current[tabId] -= 1;
          }
        }
      },
      remove(tabId: string, id: string) {
        setItems(tabId, (itemsRef.current[tabId] ?? []).filter((item) => item.id !== id));
        setError(tabId, null);
        void attachmentRemove(tabId, id).catch(() => {});
      },
      /** Hand the chips to a send and clear them. Rust deletes the files after the turn. */
      take(tabId: string): ChatImage[] {
        const items = itemsRef.current[tabId] ?? [];
        if (items.length) setItems(tabId, []);
        setError(tabId, null);
        return items;
      },
      /** A send that never reached the agent gives its images back. */
      restore(tabId: string, items: ChatImage[]) {
        if (items.length === 0) return;
        setItems(tabId, [...items, ...(itemsRef.current[tabId] ?? [])]);
      },
    };
  }, []);

  const propsFor = useCallback(
    (tabId: string): ChatImagesProps => ({
      items: byTab[tabId] ?? [],
      error: errors[tabId] ?? null,
      onAddFiles: (files) => void actions.addFiles(tabId, files),
      onRemove: (id) => actions.remove(tabId, id),
    }),
    [actions, byTab, errors],
  );

  return { actions, propsFor };
}
