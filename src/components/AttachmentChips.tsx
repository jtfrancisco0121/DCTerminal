import type { ClipboardEvent, DragEvent } from "react";
import { imageFilesFrom } from "../attachments/chatImages";
import type { ChatImagesProps } from "../attachments/useChatImages";

/** Thumbnails of the images going with the next message, each with ×. */
export function AttachmentChips({ images }: { images: ChatImagesProps }) {
  if (images.items.length === 0 && !images.error) return null;
  return (
    <div className="attachment-chips">
      {images.items.length > 0 && (
        <ul className="attachment-chip-list" aria-label="Attached images">
          {images.items.map((item) => (
            <li key={item.id} className="attachment-chip" title={item.name}>
              <img src={item.previewUrl} alt="" className="attachment-chip-thumb" />
              <span className="attachment-chip-name">{item.name}</span>
              <button
                type="button"
                className="attachment-chip-remove"
                aria-label={`Remove ${item.name}`}
                onClick={() => images.onRemove(item.id)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {images.error && (
        <p className="error attachment-chips-error" role="alert">
          {images.error}
        </p>
      )}
    </div>
  );
}

/**
 * Paste and drop handlers for a chat textarea. Only image files are taken;
 * pasted text keeps its default behaviour. Without `images` (Cursor or
 * terminal tabs, agents without image support) nothing is attached.
 */
export function imageInputHandlers(images: ChatImagesProps | null | undefined) {
  if (!images) return {};
  return {
    onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const files = imageFilesFrom(event.clipboardData);
      if (files.length === 0) return;
      event.preventDefault();
      images.onAddFiles(files);
    },
    onDragOver: (event: DragEvent<HTMLTextAreaElement>) => {
      if (Array.from(event.dataTransfer?.types ?? []).includes("Files")) event.preventDefault();
    },
    onDrop: (event: DragEvent<HTMLTextAreaElement>) => {
      const files = imageFilesFrom(event.dataTransfer);
      if (files.length === 0) return;
      event.preventDefault();
      images.onAddFiles(files);
    },
  };
}
