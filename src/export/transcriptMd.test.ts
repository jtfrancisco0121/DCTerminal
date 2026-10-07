import { describe, expect, it } from "vitest";
import { exportSizeWarning, formatTranscriptMarkdown } from "./transcriptMd";

describe("formatTranscriptMarkdown", () => {
  it("formats metadata and body as a golden markdown document", () => {
    const md = formatTranscriptMarkdown(
      {
        label: "Implementer · Login",
        roleName: "Implementer",
        cwd: "C:\\Repos\\Demo",
        exportedAt: "2026-10-07T12:00:00.000Z",
      },
      "\nYou › Fix the bug\n\nPatched the handler.\n",
    );
    expect(md).toBe(
      `# Implementer · Login

- **Role:** Implementer
- **Folder:** \`C:\\Repos\\Demo\`
- **Exported:** 2026-10-07T12:00:00.000Z

---

You › Fix the bug

Patched the handler.
`,
    );
  });

  it("warns on very large exports", () => {
    expect(exportSizeWarning(1000)).toBeNull();
    expect(exportSizeWarning(600_000)).toMatch(/600,000/);
  });
});
