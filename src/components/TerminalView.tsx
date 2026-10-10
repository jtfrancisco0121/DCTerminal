import { useEffect, useRef, useState } from "react";
import { isUserInput, terminalActivity } from "../terminal/activity";
import "@xterm/xterm/css/xterm.css";
import { ptyOpen, ptyResize, ptyWrite, type TerminalLaunch } from "../bridge";
import { detectPlatform, routeKey } from "../keymap";
import { TerminalSearchBar } from "./TerminalSearchBar";
import {
  beginLivePty,
  clearPtyOpening,
  isPtyOpening,
  livePty,
  markPtyOpening,
  subscribeLivePty,
} from "../terminal/live";
import {
  copyTerminalSelection,
  ensureParkedTerminal,
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
  menuActions = [],
  onMenuOpen,
}: Props) {
  const slotRef = useRef<HTMLDivElement>(null);
  const [exitCode, setExitCode] = useState<number | null>(livePty(ptyId)?.exitCode ?? null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);

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
      if (isUserInput(data)) terminalActivity.input(ptyId);
      void ptyWrite(ptyId, data).catch(() => {});
    });
    const detach = live?.buffer.attach({
      data: (bytes) => parked.term.write(bytes),
      exit: (code) => setExitCode(code),
    });
    if (live?.exitCode != null) setExitCode(live.exitCode);
    const platform = detectPlatform(navigator.platform);
    parked.term.attachCustomKeyEventHandler((event) => {
      const routed = routeKey(
        {
          code: event.code,
          key: event.key,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          repeat: event.repeat,
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
  }, [autoFocus, ptyId, fontSize, generation]);

  useEffect(() => {
    if (!autoOpen || !cwd) return;
    if (livePty(ptyId) || isPtyOpening(ptyId)) return;
    if (!markPtyOpening(ptyId)) return;
    const live = beginLivePty(ptyId);
    const parked = ensureParkedTerminal(ptyId, fontSize);
    void ptyOpen({
      id: ptyId,
      cwd,
      launch,
      roleId,
      prompt,
      resumeSessionId,
      cols: Math.max(parked.term.cols, 80),
      rows: Math.max(parked.term.rows, 24),
      onOutput: live.channel,
    }).catch((err: unknown) => {
      clearPtyOpening(ptyId);
      setFailed(err instanceof Error ? err.message : String(err));
    });
  }, [autoOpen, cwd, fontSize, launch, prompt, ptyId, resumeSessionId, roleId]);

  const restart = () => {
    setExitCode(null);
    setFailed(null);
    const parked = ensureParkedTerminal(ptyId, fontSize);
    parked.term.reset();
    // Same tab, same run: plan files written before the restart still count.
    const firstStart = livePty(ptyId)?.startedAt;
    const live = beginLivePty(ptyId);
    if (firstStart) live.startedAt = firstStart;
    void ptyOpen({
      id: ptyId,
      cwd,
      launch,
      roleId,
      prompt: null,
      resumeSessionId,
      cols: Math.max(parked.term.cols, 80),
      rows: Math.max(parked.term.rows, 24),
      onOutput: live.channel,
    }).catch((err: unknown) => {
      setFailed(err instanceof Error ? err.message : String(err));
    });
  };

  return (
    <div
      className="terminal-view"
      onContextMenu={(event) => {
        event.preventDefault();
        onMenuOpen?.();
        setMenu({ x: event.clientX, y: event.clientY });
      }}
    >
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
      {(failed || exitCode != null) && (
        <div className="terminal-exit">
          {failed && <p className="error">{failed}</p>}
          {exitCode != null && <p>Process exited ({exitCode}).</p>}
          <button type="button" className="primary-button" onClick={restart}>
            Restart
          </button>
        </div>
      )}
      {menu && (
        <div
          className="terminal-menu"
          style={{ left: menu.x, top: menu.y }}
          role="menu"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(null);
              void copyTerminalSelection(ptyId);
            }}
          >
            Copy
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(null);
              void pasteTerminalText(ptyId);
            }}
          >
            Paste
          </button>
          {menuActions.map((action) => (
            <button
              key={action.id}
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(null);
                action.onSelect();
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
      {menu && (
        <button
          type="button"
          className="terminal-menu-dismiss"
          aria-label="Close menu"
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
