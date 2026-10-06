import { forwardRef, type KeyboardEvent } from "react";
import type { ChainCursor } from "../scratch/pad";

type Props = {
  content: string;
  truncated: boolean;
  persistError: string | null;
  chain: ChainCursor | null;
  disabled: boolean;
  onChange: (value: string) => void;
  onTransfer: () => void;
  onTransferTerminal?: () => void;
  onSend: () => void;
  onStopChain: () => void;
  onBlur?: () => void;
};

export const ScratchPad = forwardRef<HTMLTextAreaElement, Props>(function ScratchPad(
  {
    content,
    truncated,
    persistError,
    chain,
    disabled,
    onChange,
    onTransfer,
    onTransferTerminal,
    onSend,
    onStopChain,
    onBlur,
  },
  ref,
) {
  const chained = content.split(/\r?\n/).some((line) => /^\s*-{3,}\s*$/.test(line));
  const running = chain?.phase === "inFlight" || chain?.phase === "paused";

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.shiftKey) {
      event.preventDefault();
      if (!disabled) onSend();
    }
  };

  return (
    <section className="scratch-pad" aria-label="Scratch pad">
      <div className="scratch-pad-bar">
        <span className="scratch-pad-title">Scratch pad</span>
        <span className="hint scratch-pad-hint">
          Ctrl+. transfer · Ctrl+Enter send
          {chained ? " · --- starts the next step after the turn ends" : ""}
        </span>
        <div className="scratch-pad-actions">
          <button type="button" className="secondary-button" onClick={onTransfer} disabled={disabled}>
            Transfer
          </button>
          {onTransferTerminal && (
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
          <button type="button" className="primary-button" onClick={onSend} disabled={disabled}>
            {chained ? "Send steps" : "Send"}
          </button>
          {running && (
            <button type="button" className="secondary-button" onClick={onStopChain}>
              Stop chain
            </button>
          )}
        </div>
      </div>
      {chain?.phase === "paused" && (
        <p className="hint scratch-pad-status">
          Chain paused until the permission request finishes. The next step is not sent yet.
        </p>
      )}
      {chain?.phase === "inFlight" && (
        <p className="hint scratch-pad-status">
          Waiting for this turn to end ({chain.nextIndex}/{chain.steps.length}).
        </p>
      )}
      {chain?.phase === "stopped" && (
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
      <textarea
        ref={ref}
        className="scratch-pad-input"
        value={content}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        rows={6}
        spellCheck={false}
        placeholder="Draft a long prompt. Separate steps with a line that is only ---."
        aria-label="Scratch pad editor"
      />
    </section>
  );
});
