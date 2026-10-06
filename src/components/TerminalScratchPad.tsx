import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { Platform } from "../keymap";
import { encodeTerminalPaste } from "../terminal/paste";
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
  bracketedPaste: boolean;
  onFocusTerminal: () => void;
  /** Blur a parked xterm so pad keystrokes cannot reach the PTY. */
  onFocusPad?: () => void;
  /** Called after the pad is hidden or shown so the terminal can refit. */
  onOpenChange?: (open: boolean) => void;
  /** F6: a prompt was sent with Enter (feeds Recent sends). */
  onSent?: (text: string) => void;
  /** F6: open the prompt library. */
  onOpenLibrary?: () => void;
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
    },
    ref,
  ) {
    const fieldRef = useRef<HTMLTextAreaElement>(null);
    const [open, setOpen] = useState(true);
    const [focusTick, setFocusTick] = useState(0);
    const modLabel = platform === "mac" ? "⌘" : "Ctrl";

    const deliver = (submit: boolean) => {
      const text = padText(fieldRef.current, content);
      if (!text.trim()) return;
      const data = encodeTerminalPaste(text, { bracketedPaste, submit });
      void write(ptyId, data);
      if (submit) onSent?.(text);
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
          onToggle={() => setOpen((value) => !value)}
          onOpenLibrary={onOpenLibrary}
        />
      </div>
    );
  },
);
