/**
 * xterm instances live outside React. Tab switches reparent the host node
 * into a hidden park so the scrollback survives an unmount.
 */

import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { lastLines, TERMINAL_TAIL_LINES } from "./text";

export type ParkedTerminal = {
  host: HTMLDivElement;
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
};

const parked = new Map<string, ParkedTerminal>();
let parkRoot: HTMLDivElement | null = null;
let focusedId = "";
const searchOpeners = new Map<string, () => void>();

const THEME = {
  background: "#0d1117",
  foreground: "#e6edf3",
  cursor: "#58a6ff",
  cursorAccent: "#0d1117",
  selectionBackground: "#264f78",
  black: "#484f58",
  red: "#ff7b72",
  green: "#3fb950",
  yellow: "#d29922",
  blue: "#58a6ff",
  magenta: "#bc8cff",
  cyan: "#39c5cf",
  white: "#b1bac4",
  brightBlack: "#6e7681",
  brightRed: "#ffa198",
  brightGreen: "#56d364",
  brightYellow: "#e3b341",
  brightBlue: "#79c0ff",
  brightMagenta: "#d2a8ff",
  brightCyan: "#56d4dd",
  brightWhite: "#f0f6fc",
};

function parkHost(): HTMLDivElement {
  if (parkRoot && parkRoot.isConnected) return parkRoot;
  const root = document.createElement("div");
  root.id = "terminal-park";
  root.setAttribute("aria-hidden", "true");
  root.style.cssText = "position:fixed;left:-10000px;top:0;width:0;height:0;overflow:hidden;";
  document.body.appendChild(root);
  parkRoot = root;
  return root;
}

export function parkedTerminal(id: string): ParkedTerminal | undefined {
  return parked.get(id);
}

export function ensureParkedTerminal(id: string, fontSize: number): ParkedTerminal {
  const existing = parked.get(id);
  if (existing) {
    existing.term.options.fontSize = fontSize;
    return existing;
  }
  const host = document.createElement("div");
  host.className = "xterm-host";
  const term = new Terminal({
    fontFamily: '"Cascadia Code", "Cascadia Mono", Consolas, ui-monospace, monospace',
    fontSize,
    scrollback: 10000,
    theme: THEME,
    cursorBlink: true,
    rightClickSelectsWord: false,
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(
    new WebLinksAddon((_event, uri) => {
      const open = window.confirm(`Open this link?\n${uri}`);
      if (open) void openUrl(uri).catch(() => {});
    }),
  );
  term.open(host);
  parkHost().appendChild(host);
  const created = { host, term, fit, search };
  parked.set(id, created);
  return created;
}

export function releaseParkedTerminal(id: string): void {
  const entry = parked.get(id);
  if (!entry) return;
  entry.term.dispose();
  entry.host.remove();
  parked.delete(id);
  searchOpeners.delete(id);
  if (focusedId === id) focusedId = "";
}

export function focusParkedTerminal(id: string): void {
  focusedId = id;
}

/** A parked terminal must not keep keyboard focus after its tab is hidden. */
export function blurParkedTerminal(id: string): void {
  const entry = parked.get(id);
  entry?.term.blur();
  if (focusedId === id) focusedId = "";
}

export function focusedTerminalId(): string {
  return focusedId;
}

export function setTerminalSearchOpener(id: string, open: () => void): () => void {
  searchOpeners.set(id, open);
  return () => {
    if (searchOpeners.get(id) === open) searchOpeners.delete(id);
  };
}

export function requestTerminalSearch(): void {
  const id = focusedId || parked.keys().next().value;
  if (id) searchOpeners.get(id)?.();
}

export function terminalSelection(id: string): string {
  return parked.get(id)?.term.getSelection().trim() ?? "";
}

export function terminalTailText(id: string): string {
  const term = parked.get(id)?.term;
  if (!term) return "";
  const buffer = term.buffer.active;
  const start = Math.max(0, buffer.length - TERMINAL_TAIL_LINES);
  const lines: string[] = [];
  for (let index = start; index < buffer.length; index += 1) {
    lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
  }
  return lastLines(lines.join("\n"));
}

export async function copyTerminalSelection(id: string): Promise<void> {
  const text = parked.get(id)?.term.getSelection() ?? "";
  if (!text) return;
  await navigator.clipboard.writeText(text);
}

export async function pasteTerminalText(id: string): Promise<void> {
  const text = await navigator.clipboard.readText();
  if (!text) return;
  parked.get(id)?.term.paste(text);
}
