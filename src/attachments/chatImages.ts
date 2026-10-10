/**
 * Images pasted or dropped into a Claude chat. The same limits are checked
 * again in Rust (`src-tauri/src/attachments.rs`).
 */

export const IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES = 5;

export type ChatImage = {
  /** Staged id from `attachmentAdd`. */
  id: string;
  name: string;
  mime: string;
  bytes: number;
  /** `data:` URL for the thumbnail chip. */
  previewUrl: string;
};

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

export function isSupportedImage(mime: string): boolean {
  return (IMAGE_MIMES as readonly string[]).includes(mime.toLowerCase());
}

/** Clipboard screenshots arrive as "image.png"; give them a clearer name. */
export function imageName(file: File): string {
  const name = file.name?.trim();
  if (name && name !== "image.png") return name;
  return `screenshot.${EXT[file.type.toLowerCase()] ?? "png"}`;
}

/**
 * Split candidate files into the ones to stage and a message for the rest.
 * `already` is how many images the message has now.
 */
export function pickImages(
  files: File[],
  already: number,
): { accepted: File[]; error: string | null } {
  const accepted: File[] = [];
  const problems: string[] = [];
  for (const file of files) {
    if (!isSupportedImage(file.type)) {
      problems.push(`${file.name || "That file"} is not a PNG, JPEG, GIF or WebP image.`);
    } else if (file.size > MAX_IMAGE_BYTES) {
      problems.push(`${imageName(file)} is larger than 5 MB.`);
    } else if (already + accepted.length >= MAX_IMAGES) {
      problems.push(`At most ${MAX_IMAGES} images can go with one message.`);
      break;
    } else {
      accepted.push(file);
    }
  }
  return { accepted, error: problems.length ? problems.join(" ") : null };
}

/** Image files from a paste or drop. Other items (text) are left alone. */
export function imageFilesFrom(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files: File[] = [];
  if (data.files?.length) {
    for (const file of Array.from(data.files)) {
      if (file.type.startsWith("image/")) files.push(file);
    }
  }
  if (files.length === 0 && data.items) {
    for (const item of Array.from(data.items)) {
      if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  return files;
}

/** Transcripts are text: an image is kept as `[image: name.png]`. */
export function imageMarker(name: string): string {
  return `[image: ${name}]`;
}

export function withImageMarkers(text: string, images: Pick<ChatImage, "name">[]): string {
  if (images.length === 0) return text;
  const markers = images.map((image) => imageMarker(image.name)).join("\n");
  return text ? `${text}\n\n${markers}` : markers;
}

/** Backslash-escape Markdown punctuation so a file name renders literally. */
function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!<>|~]/g, "\\$&");
}

/** User bubble: show each `[image: x]` marker line as its own "🖼 x" paragraph. */
export function renderImageMarkers(text: string): string {
  return text.replace(/^\[image: (.+)\]$/gm, (_, name: string) => `🖼 ${escapeMarkdown(name)}\n`);
}

/** Base64 body of a file (no `data:` prefix) and a `data:` URL for the chip. */
export function readImage(file: File): Promise<{ base64: string; dataUrl: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("could not read the image"));
    reader.onload = () => {
      const dataUrl = String(reader.result ?? "");
      const comma = dataUrl.indexOf(",");
      resolve({ base64: comma >= 0 ? dataUrl.slice(comma + 1) : "", dataUrl });
    };
    reader.readAsDataURL(file);
  });
}
