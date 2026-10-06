import { useEffect, useRef, type KeyboardEvent } from "react";

type Props = {
  query: string;
  /** 0-based current hit, or -1. */
  index: number;
  count: number;
  /** Changes when the bar is asked to take focus again. */
  focusKey: number;
  onQuery: (query: string) => void;
  onStep: (delta: 1 | -1) => void;
  onClose: () => void;
  onSearchAll?: (query: string) => void;
};

/** F5 find bar for one chat. Enter / Shift+Enter step, Esc closes. */
export function ChatFindBar({
  query,
  index,
  count,
  focusKey,
  onQuery,
  onStep,
  onClose,
  onSearchAll,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusKey]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === "Enter") {
      event.preventDefault();
      onStep(event.shiftKey ? -1 : 1);
    }
  };

  const status = !query.trim() ? "" : count === 0 ? "No results" : `${index + 1} of ${count}`;

  return (
    <div className="chat-find" role="search">
      <input
        ref={inputRef}
        type="search"
        className="text-input"
        aria-label="Find in chat"
        placeholder="Find in chat"
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <span className="search-status" aria-live="polite">
        {status}
      </span>
      <button
        type="button"
        className="search-nav"
        aria-label="Previous match"
        title="Previous match (Shift+Enter)"
        disabled={count === 0}
        onClick={() => onStep(-1)}
      >
        ↑
      </button>
      <button
        type="button"
        className="search-nav"
        aria-label="Next match"
        title="Next match (Enter)"
        disabled={count === 0}
        onClick={() => onStep(1)}
      >
        ↓
      </button>
      {onSearchAll && (
        <button
          type="button"
          className="secondary-button"
          onClick={() => onSearchAll(query)}
          title="Search every chat, closed tab, and saved transcript"
        >
          Search all chats
        </button>
      )}
      <button
        type="button"
        className="search-nav"
        aria-label="Close find"
        title="Close (Esc)"
        onClick={onClose}
      >
        ×
      </button>
    </div>
  );
}
