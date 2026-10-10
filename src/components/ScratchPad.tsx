import { forwardRef, useRef, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { splitChainSteps, type ChainCursor } from "../scratch/pad";
import { useSlashAutocomplete } from "../composer/SlashCommandMenu";
import { blockedSlashCommandIn, type SlashCommand } from "../composer/slashCommands";
import type { ChatImagesProps } from "../attachments/useChatImages";
import { AttachmentChips, imageInputHandlers } from "./AttachmentChips";

type Props = {
  content: string;
  truncated: boolean;
  persistError: string | null;
  chain: ChainCursor | null;
  disabled: boolean;
  /** Terminal tabs send into the PTY. Chat tabs transfer and chain. */
  mode?: "chat" | "terminal";
  modLabel?: string;
  collapsed?: boolean;
  onChange: (value: string) => void;
  onTransfer: () => void;
  onTransferTerminal?: () => void;
  onPasteTerminal?: () => void;
  onSend: () => void;
  onStopChain: () => void;
  onBlur?: () => void;
  onFocus?: () => void;
  onEscape?: () => void;
  onToggle?: () => void;
  /** F6: open the prompt library (saved prompts and recent sends). */
  onOpenLibrary?: () => void;
  /** U2: editor height in px; null keeps the 3-row default. */
  height?: number | null;
  /** U2: live height while the handle is dragged. */
  onHeightChange?: (height: number) => void;
  /** U2: final height after a drag or a keyboard step (save it). */
  onHeightCommit?: (height: number) => void;
  /** Chat tabs: Claude commands and skills offered by `/` autocomplete. */
  slashCommands?: SlashCommand[];
  /**
   * Pasted images for the next send (Claude chats that take images only).
   * A `---` chain sends them with its first step only.
   */
  images?: ChatImagesProps | null;
};

export const PAD_MIN_HEIGHT = 40;
export const PAD_MAX_HEIGHT = 600;
const PAD_KEY_STEP = 24;

export function clampPadHeight(height: number): number {
  return Math.round(Math.min(PAD_MAX_HEIGHT, Math.max(PAD_MIN_HEIGHT, height)));
}

export const ScratchPad = forwardRef<HTMLTextAreaElement, Props>(function ScratchPad(
  {
    content,
    truncated,
    persistError,
    chain,
    disabled,
    mode = "chat",
    modLabel = "Ctrl",
    collapsed = false,
    onChange,
    onTransfer,
    onTransferTerminal,
    onPasteTerminal,
    onSend,
    onStopChain,
    onBlur,
    onFocus,
    onEscape,
    onToggle,
    onOpenLibrary,
    height = null,
    onHeightChange,
    onHeightCommit,
    slashCommands = [],
    images = null,
  },
  ref,
) {
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const setEditor = (node: HTMLTextAreaElement | null) => {
    editorRef.current = node;
    if (typeof ref === "function") ref(node);
    else if (ref) ref.current = node;
  };
  const resizable = !!onHeightChange && !collapsed;
  const currentHeight = () => height ?? (editorRef.current?.offsetHeight || 64);

  const startResize = (event: ReactMouseEvent) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = currentHeight();
    let last = startHeight;
    const onMove = (move: MouseEvent) => {
      // Dragging up (smaller clientY) grows the pad.
      last = clampPadHeight(startHeight + (startY - move.clientY));
      onHeightChange?.(last);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      onHeightCommit?.(last);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const onHandleKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const next = clampPadHeight(currentHeight() + (event.key === "ArrowUp" ? PAD_KEY_STEP : -PAD_KEY_STEP));
    onHeightChange?.(next);
    onHeightCommit?.(next);
  };
  const terminal = mode === "terminal";
  const chained = !terminal && content.split(/\r?\n/).some((line) => /^\s*-{3,}\s*$/.test(line));
  const running = !terminal && (chain?.phase === "inFlight" || chain?.phase === "paused");
  const slash = useSlashAutocomplete({
    value: content,
    commands: terminal ? [] : slashCommands,
    onChange,
    textareaRef: editorRef,
  });
  const blockedWarning = terminal ? null : blockedSlashCommandIn(splitChainSteps(content));

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (slash.onKeyDown(event)) return;
    if (event.key === "Escape" && terminal && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      event.stopPropagation();
      onEscape?.();
      return;
    }
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.shiftKey) {
      event.preventDefault();
      if (!disabled && !blockedWarning) onSend();
    }
  };

  return (
    <section className="scratch-pad" aria-label="Scratch pad">
      {resizable && (
        <div
          className="scratch-pad-handle"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize scratch pad"
          aria-valuenow={height ?? undefined}
          aria-valuemin={PAD_MIN_HEIGHT}
          aria-valuemax={PAD_MAX_HEIGHT}
          tabIndex={0}
          title="Drag to resize the scratch pad"
          onMouseDown={startResize}
          onKeyDown={onHandleKey}
        />
      )}
      <div className="scratch-pad-bar">
        <span className="scratch-pad-title">Scratch pad</span>
        <span className="hint scratch-pad-hint">
          {terminal
            ? `${modLabel}+Shift+. send · ${modLabel}+J focus · Esc terminal`
            : `Ctrl+. transfer · Ctrl+Enter send${
                chained ? " · --- starts the next step after the turn ends" : ""
              }`}
        </span>
        <div className="scratch-pad-actions">
          {onOpenLibrary && (
            <button
              type="button"
              className="secondary-button"
              onMouseDown={terminal ? (event) => event.preventDefault() : undefined}
              onClick={onOpenLibrary}
              title="Prompt library: insert a saved prompt or a recent send, or save this pad"
            >
              Prompts
            </button>
          )}
          {onToggle && (
            <button
              type="button"
              className="secondary-button"
              aria-expanded={!collapsed}
              onClick={onToggle}
            >
              {collapsed ? "Show pad" : "Hide pad"}
            </button>
          )}
          {!terminal && (
            <button type="button" className="secondary-button" onClick={onTransfer} disabled={disabled}>
              Transfer
            </button>
          )}
          {!terminal && onTransferTerminal && (
            <button
              type="button"
              className="secondary-button"
              onClick={onTransferTerminal}
              disabled={disabled}
              title="Send the selection, or the whole pad, to the terminal"
            >
              To terminal
            </button>
          )}
          {terminal && (
            <button
              type="button"
              className="secondary-button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={onPasteTerminal}
              disabled={disabled || !content.trim()}
            >
              Paste to terminal
            </button>
          )}
          <button
            type="button"
            className="primary-button"
            onMouseDown={terminal ? (event) => event.preventDefault() : undefined}
            onClick={onSend}
            disabled={disabled || (terminal && !content.trim()) || !!blockedWarning}
          >
            {chained ? "Send steps" : "Send"}
          </button>
          {running && (
            <button type="button" className="secondary-button" onClick={onStopChain}>
              Stop chain
            </button>
          )}
        </div>
      </div>
      {!terminal && chain?.phase === "paused" && (
        <p className="hint scratch-pad-status">
          Chain paused until the permission request finishes. The next step is not sent yet.
        </p>
      )}
      {!terminal && chain?.phase === "inFlight" && (
        <p className="hint scratch-pad-status">
          Waiting for this turn to end ({chain.nextIndex}/{chain.steps.length}).
        </p>
      )}
      {!terminal && chain?.phase === "stopped" && (
        <p className="error scratch-pad-status">
          Chain stopped ({chain.reason ?? "cancelled"}).
        </p>
      )}
      {truncated && (
        <p className="error scratch-pad-status">
          Scratch pad was truncated at 1,000,000 characters.
        </p>
      )}
      {persistError && (
        <p className="error scratch-pad-status">Could not save the scratch pad: {persistError}</p>
      )}
      {blockedWarning && !collapsed && (
        <p className="error scratch-pad-status" role="alert">{blockedWarning}</p>
      )}
      {!collapsed && slash.menu}
      {!terminal && images && !collapsed && <AttachmentChips images={images} />}
      <textarea
        ref={setEditor}
        className="scratch-pad-input"
        value={content}
        onChange={(event) => {
          slash.onCaret(event);
          onChange(event.target.value);
        }}
        onSelect={slash.onCaret}
        onBlur={onBlur}
        onFocus={onFocus}
        onKeyDown={onKeyDown}
        rows={3}
        style={height ? { height } : undefined}
        spellCheck={false}
        placeholder={
          terminal
            ? "Draft a prompt for this terminal. Newlines stay in the prompt."
            : "Draft a long prompt. Separate steps with a line that is only ---."
        }
        aria-label="Scratch pad editor"
        hidden={collapsed}
        {...slash.inputProps}
        {...imageInputHandlers(terminal ? null : images)}
      />
    </section>
  );
});
