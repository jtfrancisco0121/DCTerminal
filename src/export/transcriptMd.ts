/** FR-071: format a saved or live chat transcript as Markdown for export. */

export type TranscriptExportMeta = {
  label: string;
  roleName: string;
  cwd: string;
  exportedAt: string;
};

const EXPORT_CHAR_WARN = 500_000;

export function formatTranscriptMarkdown(meta: TranscriptExportMeta, body: string): string {
  const trimmed = body.trim();
  const lines = [
    `# ${meta.label}`,
    "",
    `- **Role:** ${meta.roleName}`,
    meta.cwd ? `- **Folder:** \`${meta.cwd}\`` : null,
    `- **Exported:** ${meta.exportedAt}`,
    "",
    "---",
    "",
    trimmed || "_No messages in this transcript._",
    "",
  ].filter((line) => line !== null);
  return lines.join("\n");
}

export function exportSizeWarning(charCount: number): string | null {
  if (charCount <= EXPORT_CHAR_WARN) return null;
  return `This transcript is ${charCount.toLocaleString()} characters. The export may be large.`;
}
