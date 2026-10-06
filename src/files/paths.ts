/** `@path` for the scratch pad. Paths with spaces are quoted. */
export function atReference(path: string): string {
  const clean = path.replace(/\\/g, "/").replace(/^\.\//, "");
  return /\s/.test(clean) ? `@"${clean}"` : `@${clean}`;
}

/** Append a reference on its own word, without doubling spaces. */
export function appendReference(content: string, path: string): string {
  const ref = atReference(path);
  if (!content) return `${ref} `;
  const sep = /\s$/.test(content) ? "" : " ";
  return `${content}${sep}${ref} `;
}

/** Absolute path for Copy path. `root` comes from the backend listing. */
export function joinRoot(root: string, rel: string): string {
  if (!rel) return root;
  const windows = /^[A-Za-z]:[\\/]/.test(root) || root.startsWith("\\\\");
  const sep = windows ? "\\" : "/";
  const base = root.replace(/[\\/]+$/, "");
  return `${base}${sep}${windows ? rel.replace(/\//g, "\\") : rel}`;
}

export function isSaveChord(
  event: { code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean },
  mac: boolean,
): boolean {
  if (event.code !== "KeyS" || event.altKey || event.shiftKey) return false;
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
