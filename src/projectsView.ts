export const CHOOSE_FOLDER_PROMPT = "Choose a folder";

/**
 * A new tab has no folder until the user chooses one.
 * Restored tabs keep the path already saved on the tab.
 * There is no hardcoded default.
 */
export function folderForTab(savedCwd: string | null | undefined): string {
  return (savedCwd ?? "").trim();
}

/** Picking a recent or favorite folder only fills the field. */
export function folderPickFillsField(path: string): {
  cwd: string;
  startsSession: false;
} {
  return { cwd: path, startsSession: false };
}

/** Last path segment, ignoring a trailing slash. */
export function folderName(path: string): string {
  const trimmed = path.trim().replace(/[\\/]+$/, "");
  if (!trimmed) return "";
  const parts = trimmed.split(/[\\/]+/).filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? trimmed;
}

/** `open({ directory: true })` returns a string, a list, or null on cancel. */
export function nativeDialogPath(
  result: string | string[] | null | undefined,
): string | null {
  if (typeof result === "string") {
    const path = result.trim();
    return path || null;
  }
  if (Array.isArray(result)) {
    const first = result.find((item) => item.trim().length > 0);
    return first?.trim() ?? null;
  }
  return null;
}

/** Empty paste is rejected here. Existence is checked by the same folder validator. */
export function pastedFolderPath(raw: string): string | null {
  const path = raw.trim();
  return path || null;
}

export function projectRowLabel(path: string, available: boolean): string {
  return available ? path : `${path} (unavailable)`;
}

/** Compare folder paths the same way the star button does: slashes and case. */
export function normalizeFolderPath(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}
