import { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { ptyOpen, ptyResize, ptyWrite, terminalSessionLog, type TerminalLaunch } from "../bridge";
import { detectPlatform, routeKey } from "../keymap";
import { isShiftEnter, SHIFT_ENTER_SEQUENCE, shiftEnterSendsNewline } from "../terminal/keys";
import { TerminalSearchBar } from "./TerminalSearchBar";
import { TerminalExitStrip, lastFiftyLines, lastOutputLine } from "./TerminalExitStrip";
import { TerminalContextMenu, type ContextMenuItem } from "./TerminalContextMenu";
import { formatDroppedPaths } from "../terminal/drop";
import { elementAtDropPosition } from "../dragDropPosition";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { reportError } from "../uiErrors";
import {
  beginLivePty,
  clearPtyOpening,
  isPtyOpening,
  livePty,
  markPtyOpening,
  notePtyInput,
  restartLivePty,
  subscribeLivePty,
} from "../terminal/live";
import {
  clearTerminalScrollback,
  copyTerminalSelection,
  pasteIntoTerminal,
  ensureParkedTerminal,
  type ParkedTerminal,
  measuredTerminalSize,
  noteTerminalSize,
  blurParkedTerminal,
  focusParkedTerminal,
  isParkedHost,
  pasteTerminalText,
  releaseParkedTerminal,
  setTerminalRefitter,
  setTerminalSearchOpener,
  terminalScrollbackText,
  terminalSelection,
  terminalTailText,
} from "../terminal/park";

export type TerminalMenuAction = {
  id: string;
  label: string;
  onSelect: () => void;
};

type Props = {
  ptyId: string;
  cwd: string;
  launch: TerminalLaunch;
  roleId?: string;
  fontSize: number;
  /** Open a fresh PTY when this view has no live session yet. */
  autoOpen?: boolean;
  /** A side pane does not take focus away from the composer. */
  autoFocus?: boolean;
  /** Restored tabs omit the startup prompt so /resume still works. */
  prompt?: string | null;
  /** When set, the process is `agent --resume <id>`. */
  resumeSessionId?: string | null;
  /** A Claude Code terminal: an exit offers Resume session instead of Restart. */
  claudeSession?: boolean;
  menuActions?: TerminalMenuAction[];
  /** Right-click, before the menu shows (e.g. read a reviewer's verdict). */
  onMenuOpen?: () => void;
};

/**
 * True when keyboard focus is in a place that must keep it: the scratch pad,
 * the file panel, a model picker, or the other split pane.
 */
export function focusBelongsElsewhere(slot: HTMLElement): boolean {
  const active = document.activeElement;
  if (!active || active === document.body) return false;
  if (active.closest(".scratch-pad, .file-panel, .model-picker, .model-picker-popover")) return true;
  const otherPane = active.closest("[data-pane]");
  return !!otherPane && otherPane !== slot.closest("[data-pane]");
}

/** How long a rejected keystroke waits for the PTY's exit event before it is shown. */
export const KEYSTROKE_SETTLE_MS = 300;

/**
 * Keystrokes to the PTY (a drop or paste reaches it the same way, through
 * xterm). A failed write is shown once per terminal, not per keystroke. An
 * exited or still-opening terminal refusing them is expected, not news.
 */
function sendInput(ptyId: string, data: string): void {
  void ptyWrite(ptyId, data).catch((err: unknown) => {
    // A PTY that just died rejects the write before its exit event lands, so
    // decide once that event has had time to arrive. A restart in between
    // replaces the session, and the old process's refusal is not news either.
    const rejectedBy = livePty(ptyId);
    window.setTimeout(() => {
      const live = livePty(ptyId);
      if (!live || live !== rejectedBy || live.exited || isPtyOpening(ptyId)) return;
      reportError("Keystrokes not sent", err, { notify: true, once: `Keystrokes not sent:${ptyId}` });
    }, KEYSTROKE_SETTLE_MS);
  });
}

export function readTerminalHandoff(ptyId: string): {
  selection: string;
  tail: string;
  scrollback: string;
} {
  return {
    selection: terminalSelection(ptyId),
    tail: terminalTailText(ptyId),
    scrollback: terminalScrollbackText(ptyId),
  };
}

/**
 * The size to open a PTY at: the mounted slot, measured now, so the program
 * draws its first screen at the right width. Before any slot exists, the last
 * measured terminal (else 80x24); the next fit corrects it.
 */
function openSize(parked: ParkedTerminal): { cols: number; rows: number } {
  const slot = parked.host.parentElement;
  if (parked.host.isConnected && slot && slot.clientWidth > 0 && slot.clientHeight > 0) {
    try {
      parked.fit.fit();
    } catch {
      // Fall through to whatever xterm currently has.
    }
    if (parked.term.cols >= 2 && parked.term.rows >= 1) {
      noteTerminalSize(parked.term.cols, parked.term.rows);
      return { cols: parked.term.cols, rows: parked.term.rows };
    }
  }
  return measuredTerminalSize();
}

export function TerminalView({
  ptyId,
  cwd,
  launch,
  roleId,
  fontSize,
  autoOpen = false,
  autoFocus = true,
  prompt = null,
  resumeSessionId = null,
  claudeSession = false,
  menuActions = [],
  onMenuOpen,
}: Props) {
  const slotRef = useRef<HTMLDivElement>(null);
  const [exitCode, setExitCode] = useState<number | null>(livePty(ptyId)?.exitCode ?? null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; hasSelection: boolean } | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [dropOver, setDropOver] = useState(false);
  const viewRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const [resumeId, setResumeId] = useState<string | null | undefined>(undefined);
  const [lastLine, setLastLine] = useState("");
  const [copied, setCopied] = useState(false);

  // Once a Claude terminal exits: is there a session to resume, and what did
  // it print last.
  useEffect(() => {
    if (!claudeSession || exitCode == null) return;
    let current = true;
    setResumeId(undefined);
    setCopied(false);
    setLastLine(lastOutputLine(terminalScrollbackText(ptyId)));
    terminalSessionLog(ptyId)
      .then((log) => current && setResumeId(log?.sessionId ?? null))
      .catch(() => current && setResumeId(null));
    return () => {
      current = false;
    };
  }, [claudeSession, exitCode, ptyId]);

  // Escape closes the right-click menu. Capture it so the program in the
  // terminal does not also see the key.
  useEffect(() => {
    if (!menu) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setMenu(null);
      focusParkedTerminal(ptyId);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [menu, ptyId]);

  // The menu has no Tab trap. When focus moves outside the menu and its
  // dismiss button (Shift+Tab or a second Tab), close it so Escape is never
  // left half-owned by a closed menu. Unlike ModelPicker and the header menu,
  // which close on mousedown outside, this is deliberate: Tab closes a menu
  // (WAI-ARIA menu convention).
  useEffect(() => {
    if (!menu) return;
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target as Element | null;
      if (target?.closest?.(".terminal-menu, .terminal-menu-dismiss")) return;
      setMenu(null);
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, [menu]);

  // Files dropped from the OS paste their quoted paths, like a paste. Tauri
  // reports the drop for the whole window, so each view checks the position.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    const over = (position: { x: number; y: number }) => {
      const target = elementAtDropPosition(position);
      return !!target && !!viewRef.current?.contains(target);
    };
    try {
      void getCurrentWebview()
        .onDragDropEvent((event) => {
          const payload = event.payload;
          if (payload.type === "leave") {
            setDropOver(false);
          } else if (payload.type === "drop") {
            setDropOver(false);
            if (!over(payload.position)) return;
            const text = formatDroppedPaths(payload.paths, detectPlatform(navigator.platform) === "windows");
            pasteIntoTerminal(ptyId, text);
            ensureParkedTerminal(ptyId, fontSize).term.focus();
            focusParkedTerminal(ptyId);
          } else {
            setDropOver(over(payload.position));
          }
        })
        .then((fn) => {
          if (disposed) fn();
          else unlisten = fn;
        })
        // Background: dropping files then does nothing, so say why in the log.
        .catch((err: unknown) => reportError("File drop unavailable", err, { once: true }));
    } catch {
      // Not running inside Tauri (unit tests, a plain browser).
    }
    return () => {
      disposed = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ptyId]);

  // Cmd+V with only an image on the clipboard types nothing; say how to attach it.
  useEffect(() => {
    if (detectPlatform(navigator.platform) !== "mac") return;
    const host = ensureParkedTerminal(ptyId, fontSize).host;
    let timer = 0;
    const onPaste = (event: ClipboardEvent) => {
      const data = event.clipboardData;
      if (!data || data.getData("text/plain")) return;
      const hasImage = Array.from(data.items ?? []).some(
        (item) => item.kind === "file" && item.type.startsWith("image/"),
      );
      if (!hasImage) return;
      setHint("Press Ctrl+V to attach images in Claude Code");
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setHint(null), 5000);
    };
    host.addEventListener("paste", onPaste, true);
    return () => {
      window.clearTimeout(timer);
      host.removeEventListener("paste", onPaste, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ptyId]);

  useEffect(() => subscribeLivePty(() => setGeneration((value) => value + 1)), []);

  useEffect(() => {
    return setTerminalSearchOpener(ptyId, () => setSearchOpen(true));
  }, [ptyId]);

  useEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    const parked = ensureParkedTerminal(ptyId, fontSize);
    slot.appendChild(parked.host);
    parked.term.options.fontSize = fontSize;
    // A focused scratch pad must keep the keystrokes. Refitting the terminal
    // must not move focus back onto xterm.
    if (autoFocus && !focusBelongsElsewhere(slot)) {
      parked.term.focus();
      focusParkedTerminal(ptyId);
    }

    const live = livePty(ptyId);
    // Subscribe before replaying. ConPTY's first bytes are often a cursor
    // query, and xterm answers that only through onData.
    const onData = parked.term.onData((data) => {
      notePtyInput(ptyId, data);
      sendInput(ptyId, data);
    });
    const detach = live?.buffer.attach({
      data: (bytes) => parked.term.write(bytes),
      exit: (code) => setExitCode(code),
    });
    if (live?.exitCode != null) setExitCode(live.exitCode);
    const platform = detectPlatform(navigator.platform);
    const newlineOnShiftEnter = shiftEnterSendsNewline(launch);
    parked.term.attachCustomKeyEventHandler((event) => {
      if (newlineOnShiftEnter && isShiftEnter(event)) {
        // Handle keydown only; swallow keypress and keyup so xterm sends no CR.
        if (event.type === "keydown" && !event.repeat) {
          notePtyInput(ptyId, SHIFT_ENTER_SEQUENCE);
          sendInput(ptyId, SHIFT_ENTER_SEQUENCE);
        }
        return false;
      }
      const routed = routeKey(
        {
          code: event.code,
          key: event.key,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          repeat: event.repeat,
          altGraph: event.getModifierState?.("AltGraph"),
        },
        { platform, surface: "terminal" },
      );
      return routed.kind === "shell";
    });

    const fitNow = () => {
      // A hidden or collapsed slot has no size. Fitting then would shrink
      // the PTY to the minimum and garble the program's output.
      if (!parked.host.isConnected || slot.clientWidth === 0 || slot.clientHeight === 0) return;
      parked.fit.fit();
      const cols = parked.term.cols;
      const rows = parked.term.rows;
      if (cols >= 2 && rows >= 1) {
        noteTerminalSize(cols, rows);
        void ptyResize(ptyId, cols, rows).catch(() => {});
      }
    };
    // Coalesce bursts (window drags, split drags, the pad toggling) into one
    // fit per frame, after layout has settled.
    let frame = 0;
    const scheduleFit = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        fitNow();
      });
    };
    const observer = new ResizeObserver(() => scheduleFit());
    observer.observe(slot);
    window.addEventListener("resize", scheduleFit);
    const unregisterRefit = setTerminalRefitter(ptyId, scheduleFit);
    const timer = window.setTimeout(fitNow, 0);

    return () => {
      window.clearTimeout(timer);
      if (frame) window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", scheduleFit);
      unregisterRefit();
      onData.dispose();
      detach?.();
      blurParkedTerminal(ptyId);
      const root = document.getElementById("terminal-park");
      // A closed tab already released its terminal; don't park the disposed host.
      if (root && isParkedHost(ptyId, parked.host) && parked.host.parentElement !== root) {
        root.appendChild(parked.host);
      }
    };
  }, [autoFocus, ptyId, fontSize, generation, launch]);

  useEffect(() => {
    if (!autoOpen || !cwd) return;
    if (livePty(ptyId) || isPtyOpening(ptyId)) return;
    if (!markPtyOpening(ptyId)) return;
    const live = beginLivePty(ptyId);
    const parked = ensureParkedTerminal(ptyId, fontSize);
    const size = openSize(parked);
    void ptyOpen({
      id: ptyId,
      cwd,
      launch,
      roleId,
      prompt,
      resumeSessionId,
      cols: size.cols,
      rows: size.rows,
      // A stage the run actor started with no view (engine 2) is attached to, not restarted.
      attach: true,
      onOutput: live.channel,
    }).catch((err: unknown) => {
      clearPtyOpening(ptyId);
      setFailed(err instanceof Error ? err.message : String(err));
    });
  }, [autoOpen, cwd, fontSize, launch, prompt, ptyId, resumeSessionId, roleId]);

  const restart = (resume?: string | null) => {
    setExitCode(null);
    setFailed(null);
    const parked = ensureParkedTerminal(ptyId, fontSize);
    parked.term.reset();
    const live = restartLivePty(ptyId);
    void ptyOpen({
      id: ptyId,
      cwd,
      launch,
      roleId,
      prompt: null,
      // Start fresh on a Claude terminal drops the conversation on purpose.
      resumeSessionId: claudeSession ? (resume ?? null) : resumeSessionId,
      cols: openSize(parked).cols,
      rows: openSize(parked).rows,
      onOutput: live.channel,
    }).catch((err: unknown) => {
      setFailed(err instanceof Error ? err.message : String(err));
    });
  };

  const mac = detectPlatform(navigator.platform) === "mac";
  const menuItems = (hasSelection: boolean): ContextMenuItem[] => {
    const close = (run: () => void) => () => {
      setMenu(null);
      run();
    };
    const items: ContextMenuItem[] = [
      {
        id: "copy",
        label: "Copy",
        shortcut: mac ? "⌘⇧C" : "Ctrl+Shift+C",
        disabled: !hasSelection,
        onSelect: close(() => void copyTerminalSelection(ptyId)),
      },
      {
        id: "paste",
        label: "Paste",
        shortcut: mac ? "⌘⇧V" : "Ctrl+Shift+V",
        onSelect: close(() => void pasteTerminalText(ptyId)),
      },
      {
        id: "clear",
        label: "Clear scrollback",
        divider: true,
        onSelect: close(() => clearTerminalScrollback(ptyId)),
      },
    ];
    menuActions.forEach((action, index) =>
      items.push({
        id: action.id,
        label: action.label,
        divider: index === 0,
        onSelect: close(action.onSelect),
      }),
    );
    return items;
  };

  return (
    <div
      ref={viewRef}
      className={dropOver ? "terminal-view terminal-drop-over" : "terminal-view"}
      onContextMenu={(event) => {
        event.preventDefault();
        onMenuOpen?.();
        setMenu({
          x: event.clientX,
          y: event.clientY,
          hasSelection: terminalSelection(ptyId).length > 0,
        });
      }}
    >
      {claudeSession && (failed || exitCode != null) && (
        <TerminalExitStrip
          exitCode={exitCode}
          lastLine={lastLine}
          failed={failed}
          resumeId={resumeId}
          copied={copied}
          onResume={() => restart(resumeId)}
          onFresh={() => restart(null)}
          onCopy={() => {
            void navigator.clipboard
              .writeText(lastFiftyLines(terminalScrollbackText(ptyId)))
              .then(() => setCopied(true))
              .catch((err: unknown) => reportError("Copy failed", err, { notify: true }));
          }}
        />
      )}
      {searchOpen && (
        <TerminalSearchBar
          search={ensureParkedTerminal(ptyId, fontSize).search}
          onClose={() => {
            setSearchOpen(false);
            ensureParkedTerminal(ptyId, fontSize).term.focus();
            focusParkedTerminal(ptyId);
          }}
        />
      )}
      <div
        ref={slotRef}
        className="terminal-slot"
        onMouseDown={() => focusParkedTerminal(ptyId)}
      />
      {!claudeSession && (failed || exitCode != null) && (
        <div className="terminal-exit">
          {failed && <p className="error">{failed}</p>}
          {exitCode != null && <p>Process exited ({exitCode}).</p>}
          <button type="button" className="primary-button" onClick={() => restart()}>
            Restart
          </button>
        </div>
      )}
      {hint && (
        <div className="terminal-hint" role="status">
          {hint}
        </div>
      )}
      {menu && (
        <TerminalContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.hasSelection)}
        />
      )}
      {menu && (
        <button
          type="button"
          className="terminal-menu-dismiss"
          aria-label="Close menu"
          // Tab from the last item lands here; Escape closes the menu, not a turn.
          // Focus moving past it closes the menu (see the focusin effect).
          data-own-escape=""
          onClick={() => setMenu(null)}
        />
      )}
    </div>
  );
}

export function destroyTerminal(ptyId: string): void {
  releaseParkedTerminal(ptyId);
  releaseParkedTerminal(`${ptyId}::pane`);
}
