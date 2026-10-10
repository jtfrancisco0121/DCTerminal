import { Fragment, useId, type ReactNode } from "react";
import type { RoleSummary } from "../bridge";

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

function TileRow({ label, children }: { label: string; children: ReactNode }) {
  const labelId = useId();
  return (
    <div className="role-tile-row" role="group" aria-labelledby={labelId}>
      <span className="role-tile-row-label" id={labelId}>
        {label}
      </span>
      <div className="role-tile-row-tiles">{children}</div>
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
  const roleTile = (item: RoleSummary) => (
    <button
      key={item.id}
      type="button"
      className="role-tile"
      aria-pressed={pickedRoleId === item.id && !launchChoice}
      onClick={() => onChooseRole(item.id)}
      disabled={busy}
    >
      <span className="role-dot" style={{ background: item.color }} aria-hidden />
      {item.name}
    </button>
  );
  return (
    <div className="role-tile-grid" role="group" aria-label="Role">
      {pipeline.length > 0 && (
        <TileRow label="Pipeline">
          {pipeline.map((item, index) => (
            <Fragment key={item.id}>
              {index > 0 && (
                <span className="role-tile-arrow" aria-hidden>
                  →
                </span>
              )}
              {roleTile(item)}
            </Fragment>
          ))}
        </TileRow>
      )}
      {other.length > 0 && <TileRow label="Other roles">{other.map(roleTile)}</TileRow>}
      <TileRow label="Terminals">
        <button
          type="button"
          className="role-tile"
          aria-pressed={launchChoice === "shell"}
          onClick={onLaunchShell}
          disabled={busy}
        >
          Terminal
        </button>
        {onLaunchClaudeCli && (
          <button
            type="button"
            className="role-tile"
            aria-pressed={launchChoice === "claude-cli"}
            onClick={onLaunchClaudeCli}
            disabled={busy}
          >
            Claude Code
          </button>
        )}
        <button
          type="button"
          className="role-tile"
          aria-pressed={launchChoice === "cursor-cli"}
          onClick={onLaunchCursorCli}
          disabled={busy}
        >
          Cursor CLI
        </button>
      </TileRow>
    </div>
  );
}
