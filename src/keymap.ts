/**
 * One keymap for the whole app. Bindings use `KeyboardEvent.code` so a
 * different layout does not retarget them. Plain Ctrl (Cmd on macOS) is
 * for chat. Ctrl+Shift (Cmd+Shift on macOS) is for the terminal, except
 * Ctrl+Shift+Tab, which is the previous tab.
 */

export type ShortcutAction =
  | "send"
  | "transferPad"
  | "focusPad"
  | "focusInput"
  | "newTab"
  | "closeTab"
  | "nextTab"
  | "prevTab"
  | "goToTab"
  | "reopenClosedTab"
  | "tabSwitcher"
  | "commandPalette"
  | "shortcutsHelp"
  | "splitRight"
  | "splitDown"
  | "closeSplit"
  | "renameTab"
  | "settings"
  | "closeDialog";

export type Platform = "mac" | "windows" | "linux";

export type Chord = {
  code: string;
  mod: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
};

export type ShortcutDef = {
  action: ShortcutAction;
  label: string;
  description: string;
  code: string;
  shift?: boolean;
  alt?: boolean;
  /** When true, Digit1–Digit9 are generated for this action. */
  digits?: boolean;
  mod?: boolean;
};

export const SHORTCUTS: ShortcutDef[] = [
  {
    action: "send",
    label: "Send",
    description: "Send the composer. The next step waits for the ACP turn to end.",
    code: "Enter",
  },
  {
    action: "transferPad",
    label: "Transfer scratch pad",
    description: "Copy the selection, or the whole pad, into the composer.",
    code: "Period",
  },
  {
    action: "focusPad",
    label: "Focus scratch pad",
    description: "Move focus to the scratch pad.",
    code: "KeyJ",
  },
  {
    action: "focusInput",
    label: "Focus input",
    description: "Move focus to the composer.",
    code: "KeyL",
  },
  {
    action: "newTab",
    label: "New tab",
    description: "Open a new role tab. Other sessions keep running.",
    code: "KeyT",
  },
  {
    action: "closeTab",
    label: "Close tab",
    description: "Close the active tab. Asks first when that tab is busy.",
    code: "KeyW",
  },
  {
    action: "nextTab",
    label: "Next tab",
    description: "Switch to the next tab.",
    code: "PageDown",
  },
  {
    action: "prevTab",
    label: "Previous tab",
    description: "Switch to the previous tab.",
    code: "PageUp",
  },
  {
    action: "goToTab",
    label: "Go to tab 1–9",
    description: "Jump to a tab by position.",
    code: "Digit1",
    digits: true,
  },
  {
    action: "reopenClosedTab",
    label: "Reopen closed tab",
    description: "Reopen the most recently closed tab.",
    code: "F6",
    mod: false,
  },
  {
    action: "tabSwitcher",
    label: "Tab switcher",
    description: "Search open tabs by name or folder.",
    code: "KeyP",
  },
  {
    action: "commandPalette",
    label: "Command palette",
    description: "Run a command by name.",
    code: "KeyK",
  },
  {
    action: "shortcutsHelp",
    label: "Keyboard shortcuts",
    description: "Show this list.",
    code: "Slash",
  },
  {
    action: "splitRight",
    label: "Split right",
    description: "View the active tab beside another tab.",
    code: "Backslash",
  },
  {
    action: "splitDown",
    label: "Split down",
    description: "View the active tab above another tab.",
    code: "Backslash",
    alt: true,
  },
  {
    action: "closeSplit",
    label: "Close split",
    description: "Return to a single pane.",
    code: "Backslash",
    shift: false,
    alt: false,
    mod: false,
  },
  {
    action: "settings",
    label: "Settings",
    description: "Open settings.",
    code: "Comma",
  },
  {
    action: "renameTab",
    label: "Rename tab",
    description: "Rename the active tab.",
    code: "F2",
    mod: false,
  },
];

/** closeSplit without a modifier would steal `\`. It is palette-only. */
const PALETTE_ONLY = new Set<ShortcutAction>(["closeSplit"]);

export type Binding = Chord & {
  action: ShortcutAction;
  tabIndex?: number;
};

export type KeyEventLike = {
  code: string;
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  targetTag?: string;
};

export type MatchContext = {
  platform: Platform;
  dialogOpen?: boolean;
};

const TEXT_EDIT_CODES = new Set([
  "KeyA",
  "KeyC",
  "KeyV",
  "KeyX",
  "KeyZ",
  "KeyY",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Backspace",
  "Delete",
  "Home",
  "End",
]);

export function detectPlatform(uaPlatform?: string): Platform {
  const value = (uaPlatform ?? "").toLowerCase();
  if (value.includes("mac")) return "mac";
  if (value.includes("win")) return "windows";
  return "linux";
}

export function isImeEvent(event: KeyEventLike): boolean {
  return (
    !!event.isComposing ||
    event.keyCode === 229 ||
    event.key === "Process" ||
    event.key === "Unidentified"
  );
}

export function isTextEditingChord(chord: Chord, targetIsField: boolean): boolean {
  if (!targetIsField || !chord.mod || chord.alt || chord.shift) return false;
  return TEXT_EDIT_CODES.has(chord.code);
}

/** Windows (and cross-platform) system chords the app must never bind. */
export function isSystemChord(chord: Chord): boolean {
  if (chord.code === "F4" && chord.alt && !chord.mod) return true;
  if (chord.code === "Escape" && chord.mod && !chord.alt && !chord.shift) return true;
  if (chord.code === "Delete" && chord.mod && chord.alt) return true;
  if (chord.code === "Tab" && chord.alt) return true;
  if (chord.code === "F10" && !chord.mod && !chord.alt && !chord.shift) return true;
  if (chord.meta && !chord.mod && chord.code !== "MetaLeft" && chord.code !== "MetaRight") {
    return false;
  }
  return false;
}

/** Mod+Shift belongs to the terminal. Tab is the previous-tab exception. */
export function isReservedForTerminal(chord: Chord): boolean {
  return chord.mod && chord.shift && !chord.alt && chord.code !== "Tab";
}

export function defaultBindings(): Binding[] {
  const bindings: Binding[] = [];
  for (const def of SHORTCUTS) {
    if (PALETTE_ONLY.has(def.action)) continue;
    if (def.digits) {
      for (let n = 1; n <= 9; n += 1) {
        bindings.push({
          action: def.action,
          code: `Digit${n}`,
          mod: true,
          shift: false,
          alt: false,
          meta: false,
          tabIndex: n - 1,
        });
      }
      continue;
    }
    bindings.push({
      action: def.action,
      code: def.code,
      mod: def.mod !== false,
      shift: !!def.shift,
      alt: !!def.alt,
      meta: false,
    });
  }
  // Pair of the terminal's Ctrl+Tab / Ctrl+Shift+Tab. PageUp/PageDown stay.
  bindings.push({
    action: "nextTab",
    code: "Tab",
    mod: true,
    shift: false,
    alt: false,
    meta: false,
  });
  bindings.push({
    action: "prevTab",
    code: "Tab",
    mod: true,
    shift: true,
    alt: false,
    meta: false,
  });
  return bindings;
}

export function bindingConflicts(bindings: Binding[]): string[] {
  const seen = new Map<string, ShortcutAction>();
  const conflicts: string[] = [];
  for (const binding of bindings) {
    const key = `${binding.code}|${binding.mod}|${binding.shift}|${binding.alt}`;
    const prev = seen.get(key);
    if (prev && prev !== binding.action) {
      conflicts.push(`${prev} and ${binding.action} both use ${formatChord(binding, "windows")}`);
    }
    seen.set(key, binding.action);
    if (isReservedForTerminal(binding)) {
      conflicts.push(`${binding.action} uses Ctrl+Shift, which is reserved`);
    }
    if (isSystemChord(binding)) {
      conflicts.push(`${binding.action} uses a system shortcut`);
    }
    if (isTextEditingChord(binding, true)) {
      conflicts.push(`${binding.action} conflicts with text editing`);
    }
  }
  return conflicts;
}

function isSettingsEvent(event: KeyEventLike, platform: Platform): boolean {
  if (event.code !== "Comma" || event.shiftKey || event.altKey || event.repeat) return false;
  return platform === "mac" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

function modPressed(event: KeyEventLike, platform: Platform): boolean {
  return platform === "mac" ? event.metaKey : event.ctrlKey;
}

function targetIsField(tag: string | undefined): boolean {
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export type ShortcutMatch = {
  action: ShortcutAction;
  tabIndex?: number;
};

export function matchShortcut(
  event: KeyEventLike,
  ctx: MatchContext,
): ShortcutMatch | null {
  if (isImeEvent(event)) return null;
  if (ctx.dialogOpen) {
    if (event.code === "Escape" && !event.ctrlKey && !event.metaKey && !event.altKey) {
      return { action: "closeDialog" };
    }
    if (isSettingsEvent(event, ctx.platform)) return { action: "settings" };
    return null;
  }
  const chord: Chord = {
    code: event.code,
    mod: modPressed(event, ctx.platform),
    shift: event.shiftKey,
    alt: event.altKey,
    meta: event.metaKey,
  };
  if (!chord.mod && event.code !== "F2" && event.code !== "F6" && event.code !== "Escape") {
    return null;
  }
  if (isSystemChord(chord) || isReservedForTerminal(chord)) return null;
  if (isTextEditingChord(chord, targetIsField(event.targetTag))) return null;
  // The other modifier (Ctrl on mac, Cmd on Windows) is not our Mod key.
  if (ctx.platform === "mac" && event.ctrlKey && !event.metaKey) return null;
  if (ctx.platform !== "mac" && event.metaKey && !event.ctrlKey) return null;

  for (const binding of defaultBindings()) {
    if (binding.code !== chord.code) continue;
    if (binding.mod !== chord.mod) continue;
    if (binding.shift !== chord.shift) continue;
    if (binding.alt !== chord.alt) continue;
    if (event.repeat && (binding.action === "send" || binding.action === "transferPad")) {
      return null;
    }
    return { action: binding.action, tabIndex: binding.tabIndex };
  }
  return null;
}

export function formatChord(chord: Chord, platform: Platform): string {
  const parts: string[] = [];
  if (chord.mod) parts.push(platform === "mac" ? "⌘" : "Ctrl");
  if (chord.alt) parts.push(platform === "mac" ? "⌥" : "Alt");
  if (chord.shift) parts.push("Shift");
  parts.push(codeLabel(chord.code));
  return parts.join("+");
}

function codeLabel(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code === "Period") return ".";
  if (code === "Slash") return "/";
  if (code === "Backslash") return "\\";
  if (code === "PageUp") return "PageUp";
  if (code === "PageDown") return "PageDown";
  return code;
}

export type ShortcutRow = {
  action: ShortcutAction;
  label: string;
  description: string;
  keys: string;
};

export type TerminalAction =
  | "togglePane"
  | "transferToTerminal"
  | "search"
  | "copy"
  | "paste";

export type KeySurface = "chat" | "terminal";

export type RoutedKey =
  | { kind: "app"; match: ShortcutMatch }
  | { kind: "terminal"; action: TerminalAction }
  | { kind: "shell" }
  | { kind: "none" };

const TERMINAL_GLOBALS = new Set<ShortcutAction>([
  "newTab",
  "closeTab",
  "goToTab",
  "nextTab",
  "prevTab",
  "tabSwitcher",
  "settings",
]);

const TERMINAL_BY_CODE: Record<string, TerminalAction> = {
  Backquote: "togglePane",
  Period: "transferToTerminal",
  KeyF: "search",
  KeyC: "copy",
  KeyV: "paste",
};

function terminalActionFor(chord: Chord): TerminalAction | null {
  if (!chord.mod || !chord.shift || chord.alt) return null;
  return TERMINAL_BY_CODE[chord.code] ?? null;
}

/**
 * Chat keeps plain Ctrl. A focused terminal keeps the shell's keys, except
 * the global tab shortcuts and the Ctrl+Shift terminal chords.
 */
export function routeKey(
  event: KeyEventLike,
  ctx: MatchContext & { surface: KeySurface },
): RoutedKey {
  if (isImeEvent(event)) return { kind: "none" };
  if (ctx.dialogOpen) {
    const match = matchShortcut(event, ctx);
    return match ? { kind: "app", match } : { kind: "none" };
  }
  const chord: Chord = {
    code: event.code,
    mod: modPressed(event, ctx.platform),
    shift: event.shiftKey,
    alt: event.altKey,
    meta: event.metaKey,
  };
  const terminalAction = terminalActionFor(chord);
  if (ctx.surface === "terminal") {
    const match = matchShortcut(event, ctx);
    if (match && TERMINAL_GLOBALS.has(match.action)) return { kind: "app", match };
    if (terminalAction) return { kind: "terminal", action: terminalAction };
    return { kind: "shell" };
  }
  if (terminalAction === "togglePane" || terminalAction === "transferToTerminal") {
    return { kind: "terminal", action: terminalAction };
  }
  const match = matchShortcut(event, ctx);
  return match ? { kind: "app", match } : { kind: "none" };
}

export function shortcutRows(platform: Platform): ShortcutRow[] {
  const rows = SHORTCUTS.filter((def) => !PALETTE_ONLY.has(def.action)).map((def) => {
    if (def.digits) {
      const mod = platform === "mac" ? "⌘" : "Ctrl";
      return {
        action: def.action,
        label: def.label,
        description: def.description,
        keys: `${mod}+1…9`,
      };
    }
    const chord: Chord = {
      code: def.code,
      mod: def.mod !== false,
      shift: !!def.shift,
      alt: !!def.alt,
      meta: false,
    };
    return {
      action: def.action,
      label: def.label,
      description: def.description,
      keys: formatChord(chord, platform),
    };
  });
  const mod = platform === "mac" ? "⌘" : "Ctrl";
  rows.push(
    {
      action: "nextTab",
      label: "Next tab",
      description: "Switch to the next tab. Also works while the terminal has focus.",
      keys: `${mod}+Tab`,
    },
    {
      action: "prevTab",
      label: "Previous tab",
      description: "Switch to the previous tab. Also works while the terminal has focus.",
      keys: `${mod}+Shift+Tab`,
    },
    {
      action: "transferPad",
      label: "Toggle terminal pane",
      description: "Show or hide the shell pane beside the chat.",
      keys: `${mod}+Shift+\``,
    },
    {
      action: "transferPad",
      label: "Transfer to terminal",
      description: "Send the scratch selection, or the whole pad, to the terminal.",
      keys: `${mod}+Shift+.`,
    },
    {
      action: "focusInput",
      label: "Copy terminal selection",
      description: "Copy the selected terminal text. Ctrl+C still goes to the shell.",
      keys: `${mod}+Shift+C`,
    },
    {
      action: "focusInput",
      label: "Paste into terminal",
      description: "Paste into the terminal.",
      keys: `${mod}+Shift+V`,
    },
    {
      action: "focusInput",
      label: "Search terminal",
      description: "Search the terminal scrollback.",
      keys: `${mod}+Shift+F`,
    },
  );
  return rows;
}
