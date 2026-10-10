import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type RefObject,
  type SyntheticEvent,
} from "react";
import {
  filterSlashCommands,
  insertSlashCommand,
  slashQueryAt,
  type SlashCommand,
} from "./slashCommands";

type Options = {
  value: string;
  commands: SlashCommand[];
  onChange: (value: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
};

/**
 * `/` autocomplete for a chat textarea. Wire `onKeyDown` first in the
 * textarea's key handler (it returns true when it used the key), `onCaret`
 * to onChange / onSelect, spread `inputProps`, and render `menu`.
 */
export function useSlashAutocomplete({ value, commands, onChange, textareaRef }: Options) {
  const listId = useId();
  const [caret, setCaret] = useState<number | null>(null);
  const [active, setActive] = useState({ query: "", index: 0 });
  // Esc hides the menu until the text changes.
  const [dismissed, setDismissed] = useState<string | null>(null);
  const pendingCaret = useRef<number | null>(null);

  const query =
    caret === null || caret > value.length || commands.length === 0
      ? null
      : (slashQueryAt(value, caret)?.query ?? null);
  const matches = useMemo(
    () => (query === null ? [] : filterSlashCommands(commands, query)),
    [query, commands],
  );
  const open = query !== null && matches.length > 0 && dismissed !== value;
  const index = open && active.query === query ? Math.min(active.index, matches.length - 1) : 0;

  useLayoutEffect(() => {
    const next = pendingCaret.current;
    const el = textareaRef.current;
    if (next === null || !el || el.value !== value) return;
    pendingCaret.current = null;
    el.setSelectionRange(next, next);
    setCaret(next);
  }, [value, textareaRef]);

  const onCaret = (event: SyntheticEvent<HTMLTextAreaElement>) => {
    const el = event.currentTarget;
    setCaret(el.selectionStart === el.selectionEnd ? el.selectionStart : null);
  };

  const choose = (cmd: SlashCommand) => {
    if (caret === null) return;
    const next = insertSlashCommand(value, caret, cmd.name);
    pendingCaret.current = next.caret;
    onChange(next.text);
    textareaRef.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || event.altKey || event.ctrlKey || event.metaKey) return false;
    const move = (delta: number) =>
      setActive({ query: query ?? "", index: (index + delta + matches.length) % matches.length });
    switch (event.key) {
      case "ArrowDown":
        move(1);
        break;
      case "ArrowUp":
        move(-1);
        break;
      case "Enter":
      case "Tab":
        if (event.shiftKey) return false;
        choose(matches[index]);
        break;
      case "Escape":
        setDismissed(value);
        break;
      default:
        return false;
    }
    event.preventDefault();
    event.stopPropagation();
    return true;
  };

  const optionId = (i: number) => `${listId}-opt-${i}`;
  const inputProps = {
    "aria-autocomplete": "list" as const,
    "aria-controls": open ? listId : undefined,
    "aria-activedescendant": open ? optionId(index) : undefined,
  };

  const menu = open ? (
    <SlashCommandList
      id={listId}
      optionId={optionId}
      commands={matches}
      activeIndex={index}
      anchor={textareaRef}
      onHover={(i) => setActive({ query: query ?? "", index: i })}
      onChoose={choose}
    />
  ) : null;

  return { open, onKeyDown, onCaret, inputProps, menu };
}

type ListProps = {
  id: string;
  optionId: (index: number) => string;
  commands: SlashCommand[];
  activeIndex: number;
  anchor: RefObject<HTMLTextAreaElement | null>;
  onHover: (index: number) => void;
  onChoose: (cmd: SlashCommand) => void;
};

/** Fixed above the textarea so a scrolling or clipped parent cannot hide it. */
function SlashCommandList({ id, optionId, commands, activeIndex, anchor, onHover, onChoose }: ListProps) {
  const listRef = useRef<HTMLUListElement>(null);
  const [style, setStyle] = useState<CSSProperties>({});

  useLayoutEffect(() => {
    const el = anchor.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setStyle({
      left: rect.left,
      bottom: window.innerHeight - rect.top + 4,
      width: Math.max(240, Math.min(rect.width, 560)),
    });
  }, [anchor, commands.length]);

  useEffect(() => {
    const option = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    option?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);

  return (
    <ul
      ref={listRef}
      id={id}
      className="slash-menu"
      role="listbox"
      aria-label="Slash commands"
      style={style}
    >
      {commands.map((cmd, i) => (
        <li
          key={cmd.name}
          id={optionId(i)}
          data-index={i}
          role="option"
          aria-selected={i === activeIndex}
          className={`slash-menu-option${i === activeIndex ? " slash-menu-option-active" : ""}`}
          // Keep focus (and the caret) in the textarea.
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => onHover(i)}
          onClick={() => onChoose(cmd)}
        >
          <span className="slash-menu-name">
            /{cmd.name}
            {cmd.hint && <span className="slash-menu-hint"> {cmd.hint}</span>}
          </span>
          {cmd.description && <span className="slash-menu-description">{cmd.description}</span>}
        </li>
      ))}
    </ul>
  );
}
