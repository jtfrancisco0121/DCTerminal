import { readFileSync } from "node:fs";
import type { Role, TabSummary } from "../../../src/bridge";

export const CWD = "/Users/e2e/Projects/demo";

/** Built-in roles from the seed the app ships (`seed/roles.seed.json`). */
export function builtInRoles(): Role[] {
  const seed = JSON.parse(
    readFileSync(new URL("../../../seed/roles.seed.json", import.meta.url), "utf8"),
  ) as { roles: Role[] };
  return seed.roles;
}

export function roleTab(id: string, roleId: string, label: string, extra: Partial<TabSummary> = {}): TabSummary {
  return {
    id,
    label,
    roleId,
    cwd: CWD,
    phase: "draft",
    mergedPromptChars: 0,
    startupPromptSent: false,
    hasTranscript: false,
    folderStatus: "ok",
    color: "",
    kind: "role",
    terminalLaunch: "",
    acpSessionId: null,
    model: null,
    provider: "claude",
    chain: null,
    ...extra,
  };
}
