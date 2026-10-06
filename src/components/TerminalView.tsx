import { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { ptyOpen, ptyResize, ptyWrite, type TerminalLaunch } from "../bridge";
import { detectPlatform, routeKey } from "../keymap";
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
  pasteTerminalText,
  releaseParkedTerminal,
  setTerminalSearchOpener,
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
};

export function readTerminalHandoff(ptyId: string): { selection: string; tail: string } {
  return { selection: terminalSelection(ptyId), tail: terminalTailText(ptyId) };
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
}: Props) {
  const slotRef = useRef<HTMLDivElement>(null);
  const [exitCode, setExitCode] = useState<number | null>(livePty(ptyId)?.exitCode ?? null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
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
    if (autoFocus) {
      parked.term.focus();
      focusParkedTerminal(ptyId);
    }

    const live = livePty(ptyId);
    const detach = live?.buffer.attach({
      data: (bytes) => parked.term.write(bytes),
      exit: (code) => setExitCode(code),
    });
    if (live?.exitCode != null) setExitCode(live.exitCode);

    const onData = parked.term.onData((data) => {
      void ptyWrite(ptyId, data).catch(() => {});
    });
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
      parked.fit.fit();
      const cols = parked.term.cols;
      const rows = parked.term.rows;
      if (cols >= 2 && rows >= 1) {
        void ptyResize(ptyId, cols, rows).catch(() => {});
      }
    };
    const observer = new ResizeObserver(() => fitNow());
    observer.observe(slot);
    const timer = window.setTimeout(fitNow, 0);

    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
      onData.dispose();
      detach?.();
      blurParkedTerminal(ptyId);
      const root = document.getElementById("terminal-park");
      if (root && parked.host.parentElement !== root) root.appendChild(parked.host);
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
    const live = beginLivePty(ptyId);
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

  const runSearch = (previous: boolean) => {
    const search = ensureParkedTerminal(ptyId, fontSize).search;
    if (!query) return;
    if (previous) search.findPrevious(query);
    else search.findNext(query);
  };

  return (
    <div
      className="terminal-view"
      onContextMenu={(event) => {
        event.preventDefault();
        setMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      {searchOpen && (
        <form
          className="terminal-search"
          onSubmit={(event) => {
            event.preventDefault();
            runSearch(false);
          }}
        >
          <input
            className="text-input"
            aria-label="Search terminal"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            autoFocus
          />
          <button type="submit" className="secondary-button">
            Next
          </button>
          <button type="button" className="secondary-button" onClick={() => runSearch(true)}>
            Previous
          </button>
          <button type="button" className="secondary-button" onClick={() => setSearchOpen(false)}>
            Close
          </button>
        </form>
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
