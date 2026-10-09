/** Per-provider UI facts and the Claude account indicator text. */
import type { LoginStatus, ModelEntry } from "../bridge";
import type { ConfigDirInfo, ProviderId } from "./types";

export type ProviderDescriptor = {
  id: ProviderId;
  label: string;
  /** Plain terminal tile and role-terminal label. */
  terminalLabel: string;
  historyTitle: string;
  /** Default model id for new tabs. */
  defaultModel: string;
};

export const PROVIDERS: Record<ProviderId, ProviderDescriptor> = {
  claude: {
    id: "claude",
    label: "Claude",
    terminalLabel: "Claude Code",
    historyTitle: "Claude Code history",
    defaultModel: "default",
  },
  cursor: {
    id: "cursor",
    label: "Cursor",
    terminalLabel: "Cursor CLI",
    historyTitle: "Cursor CLI history",
    defaultModel: "composer-2.5",
  },
};

export function providerLabel(id: ProviderId | null | undefined): string {
  return PROVIDERS[id ?? "cursor"].label;
}

/**
 * Claude models before the adapter reports its own list (Phase 5 adds the
 * live list and the cache).
 */
export const CLAUDE_FALLBACK_MODELS: ModelEntry[] = [
  { id: "default", label: "Default (account)", fast: false },
  { id: "opus", label: "Opus", fast: false },
  { id: "sonnet", label: "Sonnet", fast: false },
  { id: "haiku", label: "Haiku", fast: true },
];

/** Model list for the Start card picker, following the provider chip. */
export function modelsForProvider(provider: ProviderId, cursorModels: ModelEntry[]): ModelEntry[] {
  return provider === "claude" ? CLAUDE_FALLBACK_MODELS : cursorModels;
}

/** Signed-in account to show, or null. */
export function accountLabel(login: LoginStatus | null | undefined): string | null {
  if (!login || login.state !== "loggedIn") return null;
  return login.account || login.organization || "signed in";
}

/**
 * Status bar text: "Claude · ~/.claude-account2 · jt@…" (short) and the
 * tooltip with the full path. Cursor is just "Cursor".
 */
export function providerIndicator(
  provider: ProviderId,
  claude?: { configDir: ConfigDirInfo | null; login: LoginStatus | null } | null,
): { text: string; title: string } {
  if (provider !== "claude") {
    return { text: "Cursor", title: "Provider: Cursor CLI" };
  }
  const dir = claude?.configDir ?? null;
  const login = claude?.login ?? null;
  const account = accountLabel(login);
  const signedOut = login && login.state !== "loggedIn" && login.state !== "unknown";
  const parts = ["Claude"];
  if (dir) parts.push(dir.display);
  if (account) parts.push(shortAccount(account));
  else if (signedOut) parts.push("not signed in");
  const title = [
    "Provider: Claude Code",
    dir ? `Config folder: ${dir.path}${dir.exists ? "" : " (not found)"}` : null,
    account ? `Account: ${account}` : signedOut ? "Not signed in for this folder" : null,
    login?.method ? `Login: ${login.method}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  return { text: parts.join(" · "), title };
}

/** "jt@koneksi.co.kr" → "jt@…" keeps the status bar short. */
export function shortAccount(account: string): string {
  const at = account.indexOf("@");
  return at > 0 ? `${account.slice(0, at)}@…` : account;
}

/** The hint for a Claude folder that is not signed in. Nothing is run for JT. */
export function claudeLoginHint(dir: ConfigDirInfo | null): string {
  const folder = dir?.display ?? "~/.claude";
  return `Run CLAUDE_CONFIG_DIR=${folder} claude (your claude2) in a terminal and use /login.`;
}

export function configSourceLabel(dir: ConfigDirInfo, envValue: string | null): string {
  switch (dir.source) {
    case "env":
      return `set by DCT_CLAUDE_CONFIG_DIR${envValue ? ` (${envValue})` : ""}`;
    case "setting":
      return "from Settings";
    default:
      return "default (~/.claude)";
  }
}

/** Tab tooltip line: provider, full config folder, full account. */
export function providerTooltipLine(
  provider: ProviderId,
  claude?: { configDir: ConfigDirInfo | null; login: LoginStatus | null } | null,
): string {
  if (provider !== "claude") return "Cursor";
  const parts = ["Claude"];
  if (claude?.configDir) parts.push(claude.configDir.path);
  const account = accountLabel(claude?.login);
  if (account) parts.push(account);
  else if (claude?.login && claude.login.state !== "loggedIn" && claude.login.state !== "unknown")
    parts.push("not signed in");
  return parts.join(" · ");
}

/** Tabs that run an agent (shell terminals have no provider). */
export function tabHasProvider(tab: {
  kind?: string;
  terminalLaunch?: string | null;
}): boolean {
  if (tab.kind !== "terminal") return true;
  return tab.terminalLaunch === "role" || tab.terminalLaunch === "cursor-cli";
}
