import { save } from "@tauri-apps/plugin-dialog";
import { exportTextFile, getTab, getRole, transcriptLoad } from "../bridge";
import { segmentsToPlainText, type StreamSegment } from "../transcript";
import { exportSizeWarning, formatTranscriptMarkdown } from "./transcriptMd";

export type ExportTranscriptInput = {
  tabId: string;
  liveSegments?: StreamSegment[];
};

export type ExportTranscriptResult =
  | { ok: true; path: string }
  | { ok: false; reason: "empty" | "cancelled" | "error"; message: string };

function defaultFileName(label: string): string {
  const base = label
    .replace(/[^\w\s-]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60);
  return `${base || "transcript"}.md`;
}

/** Load transcript text, pick a path, and write Markdown to disk. */
export async function runTranscriptExport(
  input: ExportTranscriptInput,
): Promise<ExportTranscriptResult> {
  const { tab } = await getTab(input.tabId);
  const loaded = await transcriptLoad(input.tabId);
  const live = (input.liveSegments ?? []).length > 0
    ? segmentsToPlainText(input.liveSegments ?? [])
    : "";
  const body = live.trim() || loaded.text.trim();
  if (!body) {
    return { ok: false, reason: "empty", message: "This tab has no transcript to export yet." };
  }
  const role = await getRole(tab.roleId);
  const markdown = formatTranscriptMarkdown(
    {
      label: tab.label,
      roleName: role.name,
      cwd: tab.cwd || loaded.cwd,
      exportedAt: new Date().toISOString(),
    },
    body,
  );
  const sizeNote = exportSizeWarning(markdown.length);
  const path = await save({
    defaultPath: defaultFileName(tab.label),
    filters: [{ name: "Markdown", extensions: ["md"] }],
    title: "Export transcript",
  });
  if (!path) return { ok: false, reason: "cancelled", message: "Export cancelled." };
  try {
    await exportTextFile(path, markdown);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: "error", message };
  }
  return {
    ok: true,
    path: sizeNote ? `${path} (${sizeNote})` : path,
  };
}
