import { detectPlatform, type Platform } from "./keymap";

/**
 * Tauri types the drag-drop position as a PhysicalPosition, but wry 0.57
 * passes its platform value through unscaled:
 * - macOS: `draggingLocation` in view points, which are already CSS pixels.
 * - Linux: WebKitGTK `drag-motion` x/y in widget (logical) coordinates.
 * - Windows: `ScreenToClient` device pixels, so divide by devicePixelRatio.
 *   (The native handler is off there today; see tauri.windows.conf.json.)
 */
export function dropPointToCss(
  position: { x: number; y: number },
  platform: Platform,
  scale: number,
): { x: number; y: number } {
  if (platform !== "windows") return { x: position.x, y: position.y };
  const s = scale || 1;
  return { x: position.x / s, y: position.y / s };
}

/** The element under a Tauri drag-drop position, or null. */
export function elementAtDropPosition(position: { x: number; y: number }): Element | null {
  const { x, y } = dropPointToCss(position, detectPlatform(navigator.platform), window.devicePixelRatio || 1);
  return document.elementFromPoint(x, y);
}
