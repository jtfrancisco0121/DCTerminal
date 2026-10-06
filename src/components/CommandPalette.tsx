import { useEffect, useMemo, useState } from "react";
import { buildPalette, filterCommands } from "../tabChrome";

type Props = {
  tabs: { id: string; label: string }[];
  canReopen: boolean;
  splitOpen: boolean;
  canSendPlan?: boolean;
  onRun: (id: string) => void;
  onClose: () => void;
};

export function CommandPalette({
  tabs,
  canReopen,
  splitOpen,
  canSendPlan = false,
  onRun,
  onClose,
}: Props) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const commands = useMemo(
    () => filterCommands(buildPalette({ tabs, canReopen, splitOpen, canSendPlan }), query),
    [tabs, canReopen, splitOpen, canSendPlan, query],
  );

  useEffect(() => {
    setIndex(0);
  }, [query]);

  return (
    <div className="overlay-backdrop" role="presentation" onClick={onClose}>
      <div
        className="overlay-panel overlay-panel-palette"
        role="dialog"
        aria-label="Command palette"
        onClick={(event) => event.stopPropagation()}
      >
        <input
          className="text-input"
          autoFocus
          placeholder="Type a command"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setIndex((current) => Math.min(current + 1, Math.max(commands.length - 1, 0)));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setIndex((current) => Math.max(current - 1, 0));
            } else if (event.key === "Enter" && commands[index]) {
              event.preventDefault();
              onRun(commands[index].id);
            }
          }}
        />
        <ul className="palette-list" role="listbox">
          {commands.map((command, i) => (
            <li key={command.id}>
              <button
                type="button"
                className={i === index ? "palette-item palette-item-active" : "palette-item"}
                onClick={() => onRun(command.id)}
              >
                <span>{command.title}</span>
                <span className="hint">{command.group}</span>
              </button>
            </li>
          ))}
          {commands.length === 0 && <li className="hint">No matching commands</li>}
        </ul>
      </div>
    </div>
  );
}
