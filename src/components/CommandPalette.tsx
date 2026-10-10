import { useEffect, useMemo, useState } from "react";
import { buildPalette, filterCommands, type PaletteModelOptions } from "../tabChrome";

type Props = {
  tabs: { id: string; label: string; cwd?: string }[];
  canReopen: boolean;
  splitOpen: boolean;
  gridOpen?: boolean;
  canAddToGrid?: boolean;
  canSendPlan?: boolean;
  sendPlanTargets?: readonly string[];
  canExportTranscript?: boolean;
  canSendImplementerToReviewer?: boolean;
  canRemoveWorktree?: boolean;
  /** The active tab is on an Eagle-Eye chain. */
  canOpenChainOverview?: boolean;
  /** The active tab's model choices; absent when it has no model. */
  model?: PaletteModelOptions | null;
  /** Text to start with, e.g. "use model " from Change model…. */
  initialQuery?: string;
  onRun: (id: string) => void;
  onClose: () => void;
};

export function CommandPalette({
  tabs,
  canReopen,
  splitOpen,
  gridOpen = false,
  canAddToGrid = false,
  canSendPlan = false,
  sendPlanTargets,
  canExportTranscript = false,
  canSendImplementerToReviewer = false,
  canRemoveWorktree = false,
  canOpenChainOverview = false,
  model = null,
  initialQuery = "",
  onRun,
  onClose,
}: Props) {
  const [query, setQuery] = useState(initialQuery);
  const [index, setIndex] = useState(0);
  const commands = useMemo(
    () =>
      filterCommands(
        buildPalette({
          tabs,
          canReopen,
          splitOpen,
          gridOpen,
          canAddToGrid,
          canSendPlan,
          sendPlanTargets,
          canExportTranscript,
          canSendImplementerToReviewer,
          canRemoveWorktree,
          canOpenChainOverview,
          model,
        }),
        query,
      ),
    [
      tabs,
      canReopen,
      splitOpen,
      gridOpen,
      canAddToGrid,
      canSendPlan,
      sendPlanTargets,
      canExportTranscript,
      canSendImplementerToReviewer,
      canRemoveWorktree,
      canOpenChainOverview,
      model,
      query,
    ],
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
                <span className="hint">
                  {command.hint ? `${command.hint} · ` : ""}
                  {command.group}
                </span>
              </button>
            </li>
          ))}
          {commands.length === 0 && <li className="hint">No matching commands</li>}
        </ul>
      </div>
    </div>
  );
}
