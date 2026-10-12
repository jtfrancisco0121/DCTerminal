import { Fragment, useId, type ReactNode } from "react";
import type { RoleSummary } from "../bridge";
import { isTabStop, onRadioKeyDown, radioProps } from "./RadioGroup";

type LaunchChoice = "shell" | "cursor-cli" | "claude-cli" | null;

type Props = {
  roles: RoleSummary[];
  pickedRoleId: string | null;
  launchChoice: LaunchChoice;
  busy: boolean;
  onChooseRole: (id: string) => void;
  onLaunchShell: () => void;
  onLaunchCursorCli: () => void;
  /** Plain `claude` with the configured `CLAUDE_CONFIG_DIR` (your `claude2`). */
  onLaunchClaudeCli?: () => void;
};

/** The Eagle-Eye 1 chain, in hand-off order. */
export const PIPELINE_ROLE_IDS = [
  "role_planner",
  "role_plan_reviewer",
  "role_implementer",
  "role_pr_reviewer",
] as const;

/** Pipeline roles in chain order; every other role (custom ones included) keeps its order. */
export function groupRoleTiles(roles: RoleSummary[]): {
  pipeline: RoleSummary[];
  other: RoleSummary[];
} {
  const pipelineIds: readonly string[] = PIPELINE_ROLE_IDS;
  const pipeline = PIPELINE_ROLE_IDS.map((id) => roles.find((role) => role.id === id)).filter(
    (role): role is RoleSummary => !!role,
  );
  const other = roles.filter((role) => !pipelineIds.includes(role.id));
  return { pipeline, other };
}

type Tile = {
  key: string;
  checked: boolean;
  onClick: () => void;
  content: ReactNode;
};

/** One labelled row of tiles. The choice spans rows, but each row is one tab stop. */
function TileRow({ label, tiles, busy }: { label: string; tiles: Tile[]; busy: boolean }) {
  const labelId = useId();
  const anyChecked = tiles.some((tile) => tile.checked);
  return (
    <div
      className="role-tile-row"
      role="radiogroup"
      aria-labelledby={labelId}
      onKeyDown={onRadioKeyDown}
    >
      <span className="role-tile-row-label" id={labelId}>
        {label}
      </span>
      <div className="role-tile-row-tiles">
        {tiles.map((tile, index) => (
          <Fragment key={tile.key}>
            {label === "Pipeline" && index > 0 && (
              <span className="role-tile-arrow" aria-hidden>
                →
              </span>
            )}
            <button
              type="button"
              className="role-tile"
              {...radioProps(tile.checked, isTabStop(tile.checked, anyChecked, index))}
              onClick={tile.onClick}
              disabled={busy}
            >
              {tile.content}
            </button>
          </Fragment>
        ))}
      </div>
    </div>
  );
}

/** Role and launch targets for the blank-tab start card, in labelled rows. */
export function RoleTiles({
  roles,
  pickedRoleId,
  launchChoice,
  busy,
  onChooseRole,
  onLaunchShell,
  onLaunchCursorCli,
  onLaunchClaudeCli,
}: Props) {
  const { pipeline, other } = groupRoleTiles(roles);
  const roleTile = (item: RoleSummary): Tile => ({
    key: item.id,
    checked: pickedRoleId === item.id && !launchChoice,
    onClick: () => onChooseRole(item.id),
    content: (
      <>
        <span className="role-dot" style={{ background: item.color }} aria-hidden />
        {item.name}
      </>
    ),
  });
  const terminals: Tile[] = [
    { key: "shell", checked: launchChoice === "shell", onClick: onLaunchShell, content: "Terminal" },
  ];
  if (onLaunchClaudeCli) {
    terminals.push({
      key: "claude-cli",
      checked: launchChoice === "claude-cli",
      onClick: onLaunchClaudeCli,
      content: "Claude Code",
    });
  }
  terminals.push({
    key: "cursor-cli",
    checked: launchChoice === "cursor-cli",
    onClick: onLaunchCursorCli,
    content: "Cursor CLI",
  });
  return (
    <div className="role-tile-grid" role="group" aria-label="Role">
      {pipeline.length > 0 && <TileRow label="Pipeline" tiles={pipeline.map(roleTile)} busy={busy} />}
      {other.length > 0 && <TileRow label="Other roles" tiles={other.map(roleTile)} busy={busy} />}
      <TileRow label="Terminals" tiles={terminals} busy={busy} />
    </div>
  );
}
