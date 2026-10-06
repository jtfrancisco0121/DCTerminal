/** Picking a recent or favorite folder only fills the field. */
export function folderPickFillsField(path: string): {
  cwd: string;
  startsSession: false;
} {
  return { cwd: path, startsSession: false };
}

export function projectRowLabel(path: string, available: boolean): string {
  return available ? path : `${path} (unavailable)`;
}

/** Compare folder paths the same way the star button does: slashes and case. */
export function normalizeFolderPath(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}
