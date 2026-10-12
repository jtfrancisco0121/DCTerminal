import { Dialog } from "./Dialog";
import { Fragment, useEffect, useMemo, useState } from "react";
import { detectPlatform, shortcutLabel, type Platform } from "../keymap";
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
  /** The active role's hand-off targets (adds "Hand off to <name>…" for unlisted ones). */
  handoffTargets?: readonly { id: string; name: string }[];
  /** Text to start with, e.g. "use model " from Change model…. */
  initialQuery?: string;
  platform?: Platform;
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
  handoffTargets,
  initialQuery = "",
  platform = detectPlatform(typeof navigator === "undefined" ? "" : navigator.platform),
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
          handoffTargets,
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
      handoffTargets,
      query,
    ],
  );

  useEffect(() => {
    setIndex(0);
  }, [query]);

  return (
    <Dialog
      title="Command palette"
      hideTitle
      placement="top"
      className="overlay-panel-palette"
      onClose={onClose}
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
        <ul className="palette-list" aria-label="Commands">
          {commands.map((command, i) => {
            const shortcut = shortcutLabel(command.id, platform);
            const showGroup = i === 0 || commands[i - 1].group !== command.group;
            return (
              <Fragment key={command.id}>
                {showGroup && (
                  <li className="palette-group" role="presentation">
                    {command.group}
                  </li>
                )}
                <li role="presentation">
                  <button
                    type="button"
                    aria-current={i === index ? "true" : undefined}
                    className={i === index ? "palette-item palette-item-active" : "palette-item"}
                    onClick={() => onRun(command.id)}
                  >
                    <span>{command.title}</span>{" "}
                    <span className="hint">
                      {command.hint}
                      {command.hint && shortcut ? " · " : ""}
                      {shortcut && <kbd>{shortcut}</kbd>}
                    </span>
                  </button>
                </li>
              </Fragment>
            );
          })}
          {commands.length === 0 && <li className="hint">No matching commands</li>}
        </ul>
    </Dialog>
  );
}
