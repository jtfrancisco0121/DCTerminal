import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { Platform } from "../keymap";
import { encodeTerminalPaste } from "../terminal/paste";
import { padAfterSend, padSelection } from "../scratch/pad";
import { ScratchPad } from "./ScratchPad";

export type TerminalPadHandle = {
  focus: () => void;
  /** true submits with one Enter after the paste. */
  send: (submit: boolean) => void;
  /** The pad's editor, for inserting a library prompt at the cursor. */
  field: () => HTMLTextAreaElement | null;
};

type Props = {
  tabId: string;
  ptyId: string;
  content: string;
  truncated: boolean;
  persistError: string | null;
  platform: Platform;
  onChange: (value: string) => void;
  onBlur?: () => void;
  write: (ptyId: string, data: string) => Promise<void>;
  /** Read at send time: a TUI can switch bracketed paste on without a re-render. */
  bracketedPaste: () => boolean;
  onFocusTerminal: () => void;
  /** Blur a parked xterm so pad keystrokes cannot reach the PTY. */
  onFocusPad?: () => void;
  /** Called after the pad is hidden or shown so the terminal can refit. */
  onOpenChange?: (open: boolean) => void;
  /** F6: text left the pad for the terminal, by Send or Paste (feeds Recent sends). */
  onSent?: (text: string) => void;
  /** F6: open the prompt library. */
  onOpenLibrary?: () => void;
  /** Runs before a Send (submit) writes, e.g. the "This turn" snapshot.
   * Must resolve quickly and never reject; the paste waits for it. */
  beforeSubmit?: (tabId: string) => Promise<void>;
  /** U2: Hide/Show shared with chat tabs. Uncontrolled when omitted. */
  open?: boolean;
  onOpenToggle?: (open: boolean) => void;
  /** U2: shared pad height (px; null = 3 rows). */
  height?: number | null;
  onHeightChange?: (height: number) => void;
  onHeightCommit?: (height: number) => void;
};

function padText(field: HTMLTextAreaElement | null, content: string): string {
  if (field && field.selectionStart !== field.selectionEnd) {
    return field.value.slice(field.selectionStart, field.selectionEnd);
  }
  return content;
}

export const TerminalScratchPad = forwardRef<TerminalPadHandle, Props>(
  function TerminalScratchPad(
    {
      tabId,
      ptyId,
      content,
      truncated,
      persistError,
      platform,
      onChange,
      onBlur,
      write,
      bracketedPaste,
      onFocusTerminal,
      onFocusPad,
      onOpenChange,
      onSent,
      onOpenLibrary,
      beforeSubmit,
      open: openProp,
      onOpenToggle,
      height = null,
      onHeightChange,
      onHeightCommit,
    },
    ref,
  ) {
    const fieldRef = useRef<HTMLTextAreaElement>(null);
    const [openState, setOpenState] = useState(true);
    const open = openProp ?? openState;
    const setOpen = (next: boolean) => {
      if (openProp === undefined) setOpenState(next);
      onOpenToggle?.(next);
    };
    const [focusTick, setFocusTick] = useState(0);
    const modLabel = platform === "mac" ? "⌘" : "Ctrl";

    const deliver = (submit: boolean) => {
      const sent = padSelection(fieldRef.current);
      const text = padText(fieldRef.current, content);
      if (!text.trim()) return;
      const before = content;
      const data = encodeTerminalPaste(text, { bracketedPaste: bracketedPaste(), submit });
      let written: Promise<void>;
      if (submit && beforeSubmit) {
        written = beforeSubmit(tabId)
          .catch(() => {})
          .then(() => write(ptyId, data));
      } else {
        try {
          written = Promise.resolve(write(ptyId, data));
        } catch {
          return;
        }
      }
      void written
        .then(() => {
          // The text is in the terminal now: it leaves the pad (only the
          // selection, when one was sent) unless the pad changed meanwhile.
          if ((fieldRef.current?.value ?? before) === before) onChange(padAfterSend(before, sent));
          onSent?.(text);
        })
        .catch(() => {});
    };

    useImperativeHandle(ref, () => ({
      focus: () => {
        setOpen(true);
        setFocusTick((tick) => tick + 1);
      },
      send: (submit: boolean) => deliver(submit),
      field: () => fieldRef.current,
    }));

    const onOpenChangeRef = useRef(onOpenChange);
    onOpenChangeRef.current = onOpenChange;
    const firstOpenRef = useRef(true);
    useEffect(() => {
      if (firstOpenRef.current) {
        firstOpenRef.current = false;
        return;
      }
      onOpenChangeRef.current?.(open);
    }, [open]);

    useEffect(() => {
      if (focusTick === 0 || !open) return;
      fieldRef.current?.focus();
    }, [focusTick, open]);

    return (
      <div className="terminal-scratch" data-tab-id={tabId}>
        <ScratchPad
          ref={fieldRef}
          mode="terminal"
          modLabel={modLabel}
          collapsed={!open}
          content={content}
          truncated={truncated}
          persistError={persistError}
          chain={null}
          disabled={false}
          onChange={(value) => onChange(value)}
          onTransfer={() => {}}
          onPasteTerminal={() => deliver(false)}
          onSend={() => deliver(true)}
          onStopChain={() => {}}
          onBlur={onBlur}
          onFocus={onFocusPad}
          onEscape={onFocusTerminal}
          onToggle={() => setOpen(!open)}
          onOpenLibrary={onOpenLibrary}
          height={height}
          onHeightChange={onHeightChange}
          onHeightCommit={onHeightCommit}
        />
      </div>
    );
  },
);
