import type { SessionUpdateEvent } from "../bridge";

/** One Claude Code command or skill from `available_commands_update`. */
export type SlashCommand = {
  name: string;
  description: string;
  /** Argument hint (`input.hint`), when the command takes one. */
  hint: string | null;
};

/**
 * Commands that would fight DCTerminal's own model and account handling.
 * They are never offered, and a typed one is refused before it is sent.
 */
const BLOCKED: Record<string, string> = {
  model: "/model is not sent from DCTerminal. Use the model picker.",
  login: "/login is not available in chat tabs. DCTerminal uses the signed-in Claude account.",
  logout: "/logout is not available in chat tabs. DCTerminal uses the signed-in Claude account.",
};

export function isBlockedCommand(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(BLOCKED, name.replace(/^\//, "").toLowerCase());
}

/** Warning for a prompt that starts with a blocked command, otherwise null. */
export function blockedSlashCommand(text: string): string | null {
  const match = /^\/([^\s/]+)(?=\s|$)/.exec(text.trimStart());
  if (!match) return null;
  const name = match[1].toLowerCase();
  return isBlockedCommand(name) ? BLOCKED[name] : null;
}

/** First blocked command among several prompts (scratch pad chain steps). */
export function blockedSlashCommandIn(prompts: string[]): string | null {
  for (const prompt of prompts) {
    const warning = blockedSlashCommand(prompt);
    if (warning) return warning;
  }
  return null;
}

function parseCommand(value: unknown): SlashCommand | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.name !== "string") return null;
  const name = obj.name.trim().replace(/^\//, "");
  if (!name || /\s/.test(name)) return null;
  const input = obj.input as Record<string, unknown> | null | undefined;
  const hint = input && typeof input.hint === "string" && input.hint.trim() ? input.hint.trim() : null;
  return {
    name,
    description: typeof obj.description === "string" ? obj.description.trim() : "",
    hint,
  };
}

/**
 * The command list from an `available_commands_update` session update, or
 * null when the event is something else. Blocked commands are dropped.
 */
export function parseAvailableCommands(evt: SessionUpdateEvent): SlashCommand[] | null {
  if (evt.kind !== "available_commands_update") return null;
  let update: Record<string, unknown>;
  try {
    const raw = JSON.parse(evt.rawJson) as Record<string, unknown>;
    update = (raw?.update as Record<string, unknown>) ?? raw;
  } catch {
    return [];
  }
  const list = update?.availableCommands;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const commands: SlashCommand[] = [];
  for (const entry of list) {
    const cmd = parseCommand(entry);
    if (!cmd || isBlockedCommand(cmd.name) || seen.has(cmd.name)) continue;
    seen.add(cmd.name);
    commands.push(cmd);
  }
  return commands;
}

/** Name prefix matches first, then other name or description matches. */
export function filterSlashCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const q = query.toLowerCase();
  const allowed = commands.filter((cmd) => !isBlockedCommand(cmd.name));
  if (!q) return allowed;
  const prefix: SlashCommand[] = [];
  const other: SlashCommand[] = [];
  for (const cmd of allowed) {
    const name = cmd.name.toLowerCase();
    if (name.startsWith(q)) prefix.push(cmd);
    else if (name.includes(q) || cmd.description.toLowerCase().includes(q)) other.push(cmd);
  }
  return [...prefix, ...other];
}

/**
 * The `/word` being typed at the caret, when it starts its line.
 * `start` is the index of the slash.
 */
export function slashQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const lineStart = text.lastIndexOf("\n", caret - 1) + 1;
  const typed = text.slice(lineStart, caret);
  const match = /^\/(\S*)$/.exec(typed);
  if (!match) return null;
  return { start: lineStart, query: match[1] };
}

/** Replace the `/word` at the caret with `/name ` and return the new caret. */
export function insertSlashCommand(
  text: string,
  caret: number,
  name: string,
): { text: string; caret: number } {
  const at = slashQueryAt(text, caret);
  if (!at) return { text, caret };
  let end = caret;
  while (end < text.length && !/\s/.test(text[end])) end += 1;
  // Reuse a following space instead of doubling it.
  const rest = text.slice(end).replace(/^ /, "");
  const inserted = `/${name} `;
  return {
    text: text.slice(0, at.start) + inserted + rest,
    caret: at.start + inserted.length,
  };
}
