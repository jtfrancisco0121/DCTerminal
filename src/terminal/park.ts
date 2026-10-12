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
import { detectPlatform } from "../keymap";
import { findPathLinks, isLinkModifier } from "./links";

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

let optionAsMeta = true;

/** macOS: Option acts as Meta. Applies live to every open terminal. */
export function setOptionAsMeta(value: boolean): void {
  optionAsMeta = value;
  for (const entry of parked.values()) entry.term.options.macOptionIsMeta = value;
}

let copyOnSelect = false;

/** Copy a finished selection to the clipboard. Off by default. */
export function setCopyOnSelect(value: boolean): void {
  copyOnSelect = value;
}

type FileOpener = (id: string, path: string, line: number) => void;
let fileOpener: FileOpener | null = null;

/** The app opens `path:line` links from terminal output in the Files panel. */
export function setTerminalFileOpener(open: FileOpener | null): void {
  fileOpener = open;
}

/** Terminal font size steps for Cmd+= / Cmd+- (the Rust side clamps to 8–32). */
export const TERMINAL_FONT_MIN = 8;
export const TERMINAL_FONT_MAX = 32;
export const TERMINAL_FONT_DEFAULT = 14;

/** The font size after a zoom step, kept inside the supported range. */
export function zoomedFontSize(current: number, action: "zoomIn" | "zoomOut" | "zoomReset"): number {
  if (action === "zoomReset") return TERMINAL_FONT_DEFAULT;
  const step = action === "zoomIn" ? 1 : -1;
  return Math.min(TERMINAL_FONT_MAX, Math.max(TERMINAL_FONT_MIN, current + step));
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
    macOptionIsMeta: optionAsMeta,
    rightClickSelectsWord: false,
    // The search addon's match highlights use the decoration API.
    allowProposedApi: true,
  });
  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  term.loadAddon(
    // Cmd-click (Ctrl-click elsewhere) opens a URL. A plain click only selects.
    new WebLinksAddon((event, uri) => {
      if (!isLinkModifier(event, detectPlatform(navigator.platform))) return;
      void openUrl(uri).catch(() => {});
    }),
  );
  term.registerLinkProvider({
    provideLinks(row, callback) {
      const line = term.buffer.active.getLine(row - 1);
      const links = line ? findPathLinks(line.translateToString(true)) : [];
      callback(
        links.length === 0
          ? undefined
          : links.map((link) => ({
              text: link.text,
              range: {
                start: { x: link.start + 1, y: row },
                end: { x: link.end, y: row },
              },
              activate: (event) => {
                if (!isLinkModifier(event, detectPlatform(navigator.platform))) return;
                fileOpener?.(id, link.path, link.line);
              },
            })),
      );
    },
  });
  let copyTimer = 0;
  term.onSelectionChange(() => {
    if (!copyOnSelect) return;
    window.clearTimeout(copyTimer);
    // Wait for the drag to settle, then copy once.
    copyTimer = window.setTimeout(() => {
      if (!term.hasSelection()) return;
      void navigator.clipboard.writeText(term.getSelection()).catch(() => {});
    }, 200);
  });
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

/** The whole scrollback as plain text. Soft-wrapped rows are joined, so a long path stays whole. */
export function terminalScrollbackText(id: string): string {
  const term = parked.get(id)?.term;
  if (!term) return "";
  const buffer = term.buffer.active;
  const lines: string[] = [];
  for (let index = 0; index < buffer.length; index += 1) {
    const line = buffer.getLine(index);
    const text = line?.translateToString(true) ?? "";
    if (line?.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  return lines.join("\n");
}

/** Clear the screen and the scrollback; the current prompt line stays. */
export function clearTerminalScrollback(id: string): void {
  parked.get(id)?.term.clear();
}

/** Paste text as the user's own paste: bracketed when the program asked for it. */
export function pasteIntoTerminal(id: string, text: string): void {
  if (text) parked.get(id)?.term.paste(text);
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
