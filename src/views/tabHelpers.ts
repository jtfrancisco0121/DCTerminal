import type { Role, TabSummary, TerminalLaunch } from "../bridge";
import { fieldsForForm } from "../startupFields";

/** Plain shells have no model; chats, role terminals, and the CLI tiles do. */
export function tabHasModel(tab: TabSummary): boolean {
  return !(
    tab.kind === "terminal" &&
    tab.terminalLaunch !== "role" &&
    tab.terminalLaunch !== "cursor-cli" &&
    tab.terminalLaunch !== "claude-cli"
  );
}

/** PTY launch kind for a terminal tab. */
export function terminalLaunchOf(tab: TabSummary): TerminalLaunch {
  switch (tab.terminalLaunch) {
    case "cursor-cli":
    case "claude-cli":
    case "role":
      return tab.terminalLaunch;
    default:
      return "shell";
  }
}

export type CliLaunch = "cursor-cli" | "claude-cli";
export const CLI_LABEL: Record<CliLaunch, string> = {
  "cursor-cli": "Cursor CLI",
  "claude-cli": "Claude Code",
};

export function fieldVisible(
  role: Role,
  fieldKey: string,
  values: Record<string, string>,
): boolean {
  const field = role.fields.find((f) => f.key === fieldKey);
  if (!field?.showWhen) return true;
  const current = (values[field.showWhen.fieldKey] ?? "").trim();
  return field.showWhen.equals.includes(current);
}

export function visibleFields(role: Role, values: Record<string, string>) {
  return fieldsForForm(role).filter((field) => fieldVisible(role, field.key, values));
}

/** Shared scratch pad size props (U2: one pad size for chat and terminal tabs). */
export type PadSizeProps = {
  height: number | null;
  onHeightChange: (height: number) => void;
  onHeightCommit: (height: number) => void;
};
