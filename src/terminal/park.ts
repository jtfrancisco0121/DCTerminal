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
import { cachedTheme, terminalTheme } from "../theme";

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
const refitters = new Map<string, () => void>();

let currentTheme = terminalTheme(cachedTheme());

/** U8: repaint every terminal (and future ones) in the app theme. */
export function setTerminalTheme(id: string): void {
  currentTheme = terminalTheme(id);
  for (const entry of parked.values()) entry.term.options.theme = currentTheme;
}

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

/** True after the program has sent CSI ? 2004 h. xterm tracks that mode. */
export function terminalBracketedPaste(id: string): boolean {
  return parked.get(id)?.term.modes.bracketedPasteMode === true;
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
    theme: currentTheme,
    cursorBlink: true,
    rightClickSelectsWord: false,
    // The search addon's match highlights use the decoration API.
    allowProposedApi: true,
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

/** False once the terminal was released (its tab closed). */
export function isParkedHost(id: string, host: HTMLElement): boolean {
  return parked.get(id)?.host === host;
}

export function releaseParkedTerminal(id: string): void {
  const entry = parked.get(id);
  if (!entry) return;
  entry.term.dispose();
  entry.host.remove();
  parked.delete(id);
  searchOpeners.delete(id);
  refitters.delete(id);
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

/** The mounted view registers how to refit its xterm to the slot. */
export function setTerminalRefitter(id: string, refit: () => void): () => void {
  refitters.set(id, refit);
  return () => {
    if (refitters.get(id) === refit) refitters.delete(id);
  };
}

/**
 * Refit a mounted terminal after a sibling changed size, for example when the
 * scratch pad is hidden or shown. A parked terminal has no slot, so this is a
 * no-op until its tab is visible again.
 */
export function refitTerminal(id: string): void {
  refitters.get(id)?.();
}

/** Open the search bar of terminal `id`, or the focused (else first) one. */
export function requestTerminalSearch(target?: string | null): void {
  const id = target || focusedId || parked.keys().next().value;
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
