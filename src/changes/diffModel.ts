import type { ChangedFile } from "../bridge";

export type DiffLine = {
  kind: "context" | "add" | "del";
  oldNo: number | null;
  newNo: number | null;
  text: string;
};

export type DiffHunk = { header: string; lines: DiffLine[] };

export type SplitRow = { left: DiffLine | null; right: DiffLine | null };

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Hunks of one file's `git diff` output. File headers are skipped. */
export function parseUnifiedDiff(text: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  for (const line of text.split("\n")) {
    const head = HUNK.exec(line);
    if (head) {
      current = { header: line, lines: [] };
      hunks.push(current);
      oldNo = Number(head[1]);
      newNo = Number(head[2]);
      continue;
    }
    if (!current) continue;
    const sign = line[0];
    const body = line.slice(1);
    if (sign === " ") {
      current.lines.push({ kind: "context", oldNo: oldNo++, newNo: newNo++, text: body });
    } else if (sign === "-") {
      current.lines.push({ kind: "del", oldNo: oldNo++, newNo: null, text: body });
    } else if (sign === "+") {
      current.lines.push({ kind: "add", oldNo: null, newNo: newNo++, text: body });
    }
    // "\ No newline at end of file" and blank trailing lines are dropped.
  }
  return hunks;
}

/** Side-by-side rows: a run of removals pairs with the additions after it. */
export function toSplitRows(hunk: DiffHunk): SplitRow[] {
  const rows: SplitRow[] = [];
  const lines = hunk.lines;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.kind === "context") {
      rows.push({ left: line, right: line });
      i += 1;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i].kind === "del") dels.push(lines[i++]);
    while (i < lines.length && lines[i].kind === "add") adds.push(lines[i++]);
    for (let k = 0; k < Math.max(dels.length, adds.length); k += 1) {
      rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
    }
  }
  return rows;
}

export function statusLetter(status: string): string {
  switch (status) {
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "typeChanged":
      return "T";
    default:
      return "M";
  }
}

export function statusWord(status: string): string {
  switch (status) {
    case "added":
      return "Added";
    case "deleted":
      return "Deleted";
    case "typeChanged":
      return "Type changed";
    default:
      return "Modified";
  }
}

/** Accept is tied to the exact content, so a later edit shows up again. */
export function acceptKey(file: Pick<ChangedFile, "path" | "newBlob">): string {
  return `${file.path}\u0000${file.newBlob}`;
}

export function unaccepted(files: ChangedFile[], accepted: ReadonlySet<string>): ChangedFile[] {
  return files.filter((file) => !accepted.has(acceptKey(file)));
}

function effect(file: ChangedFile): string {
  if (file.status === "added") return `This deletes ${file.path}, which was created after the snapshot.`;
  if (file.status === "deleted") return `This brings back ${file.path}.`;
  return `The current contents of ${file.path} are replaced.`;
}

/** Text for the revert confirmation. */
export function revertConfirmText(files: ChangedFile[], acceptedKept: number): string {
  const kept =
    acceptedKept > 0
      ? `\n\n${acceptedKept} accepted file${acceptedKept === 1 ? " is" : "s are"} kept.`
      : "";
  if (files.length === 1) {
    return `Revert ${files[0].path} to the snapshot?\n\n${effect(files[0])}${kept}`;
  }
  const names = files.slice(0, 10).map((file) => `• ${file.path} (${statusWord(file.status)})`);
  const more = files.length > 10 ? `\n…and ${files.length - 10} more` : "";
  return (
    `Revert ${files.length} files to the snapshot?\n\n${names.join("\n")}${more}\n\n` +
    `New files are deleted, deleted files come back, and edits are undone.${kept}`
  );
}
